# -*- coding: utf-8 -*-
"""成交修订：修改/撤销已有手工成交，并按最早受影响位置重算持仓。

与手工成交的关键区别：

- 修订**不新增成交**，而是在原记录上留下修订链（``revision_no`` / ``revised_at``
  / ``trade_revisions``），原请求保存在 ``request`` 里不被覆盖；
- 同时区分三个时间：``occurred_at``（成交发生）、``recorded_at``（最初记录）、
  ``revised_at``（本次修订）；
- 重算以受影响股票的全部有效成交与外部快照为依据，从最早受影响位置向后重放：
  手工成交派生出的快照只反映当时的计算结果，不作为事实锚点；券商/用户保存的
  快照才是外部事实，会重置重放状态；
- “只补记录”与“同时更新持仓”是两种明确的提交模式，记录、持仓、快照和
  ``investment.facts_revised`` 事件在同一文档事务里落盘。

文档形状（``holdings`` collection）：

    {
      "default": [...],            # 当前持仓
      "manual_trades": [...],      # 手工成交（修订后就地更新，撤销标记 voided）
      "snapshots": [...],          # 持仓快照
      "trade_revisions": [...],    # 修订审计链
      "investment_outbox": [...]   # 待投递的事实修订事件
    }
"""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .portfolio_performance import _positions, _snapshot
from .store import JsonStore

# 由手工成交直接派生出来的快照，只是当时的计算结果，不是外部事实。
# 手工成交快照带 ``manual_trade_id``，修订快照带 ``revision_id``；用户保存
# 或券商同步的快照没有这些标记，才是重放时可依赖的外部事实。
_EPSILON = 1e-9
_TRADE_TIME_FIELDS = ("side", "quantity", "price", "fees", "traded_at")


def _is_derived_snapshot(snapshot: dict) -> bool:
    return bool(snapshot.get("manual_trade_id") or snapshot.get("revision_id"))


class TradeRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    action: Literal["preview", "commit"] = "preview"
    revision_id: str = Field(min_length=8, max_length=100)
    trade_request_id: str = Field(min_length=1, max_length=100)
    operation: Literal["amend", "void"]
    ticker: str | None = Field(default=None, pattern=r"^\d{6}$")
    side: Literal["buy", "sell"] | None = None
    quantity: Decimal | None = Field(default=None, gt=0, le=Decimal("1e12"))
    price: Decimal | None = Field(default=None, gt=0, le=Decimal("1e12"))
    fees: Decimal | None = Field(default=None, ge=0, le=Decimal("1e15"))
    traded_at: datetime | None = None
    affects_holdings: bool = True
    reason: str | None = Field(default=None, max_length=500)
    version: str | None = None


def _version(document: dict) -> str:
    return hashlib.sha256(
        json.dumps(document, sort_keys=True, default=str).encode()
    ).hexdigest()


def _fingerprint(req: TradeRevisionRequest) -> str:
    """同一 revision_id 只能用在同一份修订内容上；重试必须逐字一致。"""

    payload = req.model_dump(mode="json", exclude={"action", "version"})
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _effective_trades(document: dict, ticker: str) -> list[dict]:
    trades = [
        entry
        for entry in document.get("manual_trades", []) or []
        if isinstance(entry, dict)
        and entry.get("ticker") == ticker
        and not entry.get("voided")
        and _parse_time(entry.get("traded_at")) is not None
    ]
    trades.sort(
        key=lambda item: (
            _parse_time(item["traded_at"]),
            str(item.get("request_id", "")),
        )
    )
    return trades


def _snapshot_position(snapshot: dict, ticker: str) -> dict | None:
    for item in snapshot.get("positions") or []:
        if isinstance(item, dict) and item.get("ticker") == ticker:
            try:
                return {
                    "quantity": float(item["quantity"]),
                    "cost_price": float(item["cost_price"]),
                }
            except (KeyError, TypeError, ValueError):
                return None
    return None


def _current_position(positions: list[dict], ticker: str) -> dict:
    for item in _positions(positions):
        if item["ticker"] == ticker:
            return {
                "quantity": float(item["quantity"]),
                "cost_price": float(item["cost_price"]),
            }
    return {"quantity": 0.0, "cost_price": 0.0}


def _project(document: dict, ticker: str) -> dict[str, Any]:
    """从最早受影响位置重放，返回修订后的持仓、影响与缺口。

    只有外部快照（券商同步、用户保存）会重置重放状态；手工成交派生的快照被
    跳过，否则修订前算出的旧结果会把修订结果覆盖回去。
    """

    trades = _effective_trades(document, ticker)
    snapshots = [
        (snapshot, _parse_time(snapshot.get("effective_at")))
        for snapshot in document.get("snapshots", []) or []
        if isinstance(snapshot, dict)
    ]
    snapshots = sorted(
        ((snapshot, at) for snapshot, at in snapshots if at is not None),
        key=lambda item: item[1],
    )

    gaps: list[dict[str, Any]] = []
    first_trade_at = _parse_time(trades[0]["traded_at"]) if trades else None

    opening_at = None
    opening_snapshot_id = None
    opening = {"quantity": 0.0, "cost_price": 0.0}
    if first_trade_at is not None:
        earlier = [(snapshot, at) for snapshot, at in snapshots if at <= first_trade_at]
        if earlier:
            snapshot, opening_at = earlier[-1]
            opening_snapshot_id = snapshot.get("snapshot_id")
            opening = _snapshot_position(snapshot, ticker) or opening
        else:
            external = [
                (snapshot, at) for snapshot, at in snapshots if not _is_derived_snapshot(snapshot)
            ]
            if external:
                # 期初快照晚于最早成交：那段历史不在快照里，重算无法闭合。
                snapshot, at = external[0]
                gaps.append(
                    {
                        "code": "trades_before_opening_snapshot",
                        "severity": "advisory",
                        "detail": "最早成交早于第一份外部持仓快照，期初持仓无法核对；"
                        "当前持仓仍以该快照为准",
                        "first_trade_at": first_trade_at.isoformat(),
                        "opening_snapshot_id": snapshot.get("snapshot_id"),
                        "opening_snapshot_at": at.isoformat(),
                    }
                )

    # 外部快照按时间插入重放时间线；手工派生快照与期初种子跳过。
    resets = [
        (snapshot, at)
        for snapshot, at in snapshots
        if not _is_derived_snapshot(snapshot)
        and snapshot.get("source") != "legacy_seed"
        and (opening_at is None or at > opening_at)
    ]

    events: list[tuple[datetime, int, Any]] = []
    for trade in trades:
        at = _parse_time(trade["traded_at"])
        # 期初种子记录的是成交**前**的状态，同一时刻的成交必须继续重放。
        if opening_at is None or at >= opening_at:
            events.append((at, 1, trade))
    for snapshot, at in resets:
        events.append((at, 0, snapshot))
    events.sort(key=lambda item: (item[0], item[1]))

    quantity, cost = opening["quantity"], opening["cost_price"]
    replayed = 0
    reliable = True
    for at, kind, item in events:
        if kind == 0:
            position = _snapshot_position(item, ticker) or {
                "quantity": 0.0,
                "cost_price": 0.0,
            }
            quantity, cost = position["quantity"], position["cost_price"]
            continue
        replayed += 1
        amount = float(item.get("quantity") or 0)
        price = float(item.get("price") or 0)
        fees = float(item.get("fees") or 0)
        if item.get("side") == "buy":
            new_quantity = quantity + amount
            if new_quantity > 0:
                cost = (quantity * cost + amount * price + fees) / new_quantity
            quantity = new_quantity
        else:
            if amount > quantity + _EPSILON:
                reliable = False
                gaps.append(
                    {
                        "code": "negative_position",
                        "severity": "blocking",
                        "detail": "重放时卖出数量超过当时可用持仓",
                        "at": at.isoformat(),
                        "available": round(quantity, 6),
                        "requested": round(amount, 6),
                        "trade_request_id": item.get("request_id"),
                    }
                )
                amount = max(quantity, 0.0)
            quantity -= amount
            if quantity <= _EPSILON:
                quantity = 0.0
                cost = 0.0

    if quantity <= _EPSILON:
        quantity, cost = 0.0, 0.0
    return {
        "ticker": ticker,
        "projected": {"quantity": round(quantity, 6), "cost_price": round(cost, 6)},
        "opening": opening,
        "opening_snapshot_id": opening_snapshot_id,
        "replayed_trades": replayed,
        "gaps": gaps,
        "reliable": reliable,
    }


def _apply_position(
    document: dict, ticker: str, position: dict, *, at: datetime
) -> list[dict]:
    remaining = [
        item
        for item in _positions(document.get("default", []))
        if item["ticker"] != ticker
    ]
    if position["quantity"] > 0:
        remaining.append(
            {
                "ticker": ticker,
                "quantity": float(position["quantity"]),
                "cost_price": float(position["cost_price"]),
                "position_time": at.isoformat(),
                "time_source": "user_modified",
            }
        )
    return _positions(remaining)


def _changes(previous: dict, amended: dict) -> dict[str, list[Any]]:
    changes: dict[str, list[Any]] = {}
    for field in _TRADE_TIME_FIELDS:
        if previous.get(field) != amended.get(field):
            changes[field] = [previous.get(field), amended.get(field)]
    return changes


def _facts_event(
    *, revision: dict[str, Any], entry: dict[str, Any], now: datetime
) -> dict[str, Any]:
    """事实修订事件：只描述“哪条事实被改成了什么”，不替委托决定是否复核。"""

    ticker = str(entry["ticker"])
    payload = {
        "fact_kind": "manual_trade",
        "feature_key": f"holding:{ticker}",
        "ticker": ticker,
        "trade_request_id": entry.get("request_id"),
        "revision_id": revision["revision_id"],
        "revision_no": revision["revision_no"],
        "operation": revision["operation"],
        "affects_holdings": revision["affects_holdings"],
        "occurred_at": revision.get("occurred_at"),
        "recorded_at": revision.get("recorded_at"),
        "revised_at": revision["revised_at"],
        "changes": revision.get("changes", {}),
    }
    content_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return {
        "event_id": f"facts-rev:{revision['revision_id']}",
        "hook_type": "investment.facts_revised",
        "schema_version": "1",
        "producer": "trading-core-investment-records",
        "occurred_at": now.isoformat(),
        "observed_at": now.isoformat(),
        "subject_ids": [f"company:{ticker}"],
        "content_hash": content_hash,
        "correlation_id": revision["revision_id"],
        "payload": payload,
    }


def _find_revision(document: dict, revision_id: str) -> dict | None:
    for record in document.get("trade_revisions", []) or []:
        if isinstance(record, dict) and record.get("revision_id") == revision_id:
            return record
    return None


def _amended_values(
    entry: dict, req: TradeRevisionRequest, *, now: datetime
) -> dict[str, Any]:
    amended: dict[str, Any] = {
        "side": entry.get("side"),
        "quantity": float(entry.get("quantity") or 0),
        "price": float(entry.get("price") or 0),
        "fees": float(entry.get("fees") or 0),
        "traded_at": entry.get("traded_at"),
    }
    for field in _TRADE_TIME_FIELDS:
        value = getattr(req, field)
        if value is None:
            continue
        if field == "traded_at":
            if value.tzinfo is None:
                raise ValueError("成交时间必须包含时区。")
            if value > now:
                raise ValueError("成交时间不能晚于当前时间。")
            amended[field] = value.isoformat()
        elif field in {"quantity", "price", "fees"}:
            amended[field] = float(value)
        else:
            amended[field] = value
    return amended


def revision_history(store: JsonStore, *, trade_request_id: str | None = None) -> list[dict]:
    """按时间正序返回修订链；可按原成交编号过滤。"""

    records = store.get("holdings", "trade_revisions", []) or []
    rows = [
        record
        for record in records
        if isinstance(record, dict)
        and (trade_request_id is None or record.get("trade_request_id") == trade_request_id)
    ]
    return rows


def apply_revision(
    store: JsonStore, req: TradeRevisionRequest, *, now: datetime | None = None
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    result: dict[str, Any] = {}

    def update(source: dict) -> dict:
        nonlocal result
        # 预演只返回原文档；所有修改都在副本上进行，不能把预览结果写回。
        document = copy.deepcopy(source)
        entries = document.get("manual_trades", []) or []
        entry = next(
            (item for item in entries if item.get("request_id") == req.trade_request_id),
            None,
        )
        if entry is None:
            raise ValueError("找不到要修订的成交记录。")
        original_ticker = str(entry.get("ticker") or "")
        if not original_ticker:
            raise ValueError("成交记录缺少股票代码，无法重算。")
        if req.ticker and req.ticker != original_ticker:
            raise ValueError("成交记录不支持修改股票代码；请撤销后重新录入。")

        existing = _find_revision(document, req.revision_id)
        if existing is not None:
            if existing.get("fingerprint") != _fingerprint(req):
                raise ValueError("该修订编号已经用于另一次修订，请重新提交。")
            result = {
                "saved": True,
                "version": _version(document),
                "revision": existing,
                "entry": entry,
                "holdings": document.get("default", []),
                "impact": existing.get("impact"),
                "gaps": (existing.get("impact") or {}).get("gaps", []),
            }
            return source

        version = _version(document)
        if req.action == "commit" and req.version != version:
            raise ValueError("持仓已发生变化，请重新预览后保存。")
        if entry.get("voided"):
            raise ValueError("该成交已经撤销，不能再次修订。")

        original = {field: entry.get(field) for field in _TRADE_TIME_FIELDS}
        amended = (
            _amended_values(entry, req, now=now) if req.operation == "amend" else None
        )
        if amended is not None:
            if not _changes(original, amended):
                raise ValueError("修订没有改变任何字段；如需撤销请选择撤销。")
            entry.update(amended)
            entry["occurred_at"] = amended["traded_at"]
            entry["recorded_at"] = entry.get("recorded_at") or original["traded_at"]
        else:
            entry["voided"] = True
            entry["voided_at"] = now.isoformat()
            entry["occurred_at"] = entry.get("occurred_at") or original["traded_at"]
            entry["recorded_at"] = entry.get("recorded_at") or original["traded_at"]

        projection = _project(document, original_ticker)
        current = _current_position(document.get("default", []), original_ticker)
        projected = projection["projected"]
        gaps = projection["gaps"]
        impact = {
            "ticker": original_ticker,
            "current": current,
            "projected": projected,
            "delta_quantity": round(projected["quantity"] - current["quantity"], 6),
            "delta_cost_price": round(projected["cost_price"] - current["cost_price"], 6),
            "opening_snapshot_id": projection["opening_snapshot_id"],
            "replayed_trades": projection["replayed_trades"],
            "reliable": projection["reliable"],
            "affects_holdings": req.affects_holdings,
            "gaps": gaps,
        }

        revision_no = int(entry.get("revision_no") or 0) + 1
        revision = {
            "revision_id": req.revision_id,
            "fingerprint": _fingerprint(req),
            "trade_request_id": req.trade_request_id,
            "revision_no": revision_no,
            "operation": req.operation,
            "previous": {"ticker": original_ticker, **original},
            "amended": amended,
            "changes": _changes(original, amended or {}),
            "occurred_at": (amended or original).get("traded_at"),
            "recorded_at": entry.get("recorded_at"),
            "revised_at": now.isoformat(),
            "affects_holdings": req.affects_holdings,
            "reason": req.reason,
            "impact": impact,
        }
        entry["revision_no"] = revision_no
        entry["revised_at"] = now.isoformat()
        entry["revision_ids"] = [
            *(entry.get("revision_ids") or []),
            req.revision_id,
        ]

        result = {
            "saved": req.action == "commit",
            "version": version,
            "revision": revision,
            "entry": entry,
            "holdings": document.get("default", []),
            "impact": impact,
            "gaps": gaps,
        }
        if req.action != "commit":
            return source

        # 重算暴露缺口时，可以只补记录，但不能把不可靠的推算写进当前持仓。
        if req.affects_holdings:
            blocking = [item for item in gaps if item.get("severity") != "advisory"]
            if not projection["reliable"] or blocking:
                codes = "、".join(item["code"] for item in blocking) or "unreliable_projection"
                raise ValueError(
                    f"重算暴露历史缺口（{codes}），请先补充期初持仓，或选择“只补记录”。"
                )
            changed = (
                abs(projected["quantity"] - current["quantity"]) > _EPSILON
                or abs(projected["cost_price"] - current["cost_price"]) > _EPSILON
            )
            if changed:
                document["default"] = _apply_position(
                    document, original_ticker, projected, at=now
                )
                snapshots = list(document.get("snapshots", []) or [])
                snapshot = _snapshot(
                    document["default"],
                    "manual_revision",
                    now.isoformat(),
                    snapshots[-1]["snapshot_id"] if snapshots else None,
                )
                snapshot["manual_trade_id"] = req.trade_request_id
                snapshot["revision_id"] = req.revision_id
                snapshots.append(snapshot)
                document["snapshots"] = snapshots
                result["holdings"] = document["default"]

        document["trade_revisions"] = [
            *(document.get("trade_revisions") or []),
            revision,
        ]
        document["investment_outbox"] = [
            *(document.get("investment_outbox") or []),
            _facts_event(revision=revision, entry=entry, now=now),
        ]
        return document

    store.mutate_document("holdings", update)
    return result
