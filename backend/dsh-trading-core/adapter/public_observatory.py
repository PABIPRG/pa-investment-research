# -*- coding: utf-8 -*-
"""公开观察室的权威账户快照和固定字段只读投影。"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from calendar import monthrange
from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Callable, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from fastapi import FastAPI, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from .store import JsonStore
from .public_holdings_operations import _timestamp
from . import holdings_operation_index as operation_index


SHANGHAI = ZoneInfo("Asia/Shanghai")
MONEY_QUANTUM = Decimal("0.01")
RATE_QUANTUM = Decimal("0.00000001")
MONEY_TOLERANCE = Decimal("0.01")
SNAPSHOT_ID_LENGTH = 32
MAX_PUBLISHED_SNAPSHOTS = 366
MAX_WRITE_BYTES = 512 * 1024
MAX_PUBLIC_DOCUMENT_BYTES = 8 * 1024 * 1024


class PublicSnapshotNotFound(LookupError):
    """请求的公开账户快照不存在。"""


def _money(value: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = 64
        return value.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money_text(value: Decimal) -> str:
    return format(_money(value), ".2f")


def _rate_text(value: Decimal) -> str:
    with localcontext() as context:
        context.prec = 64
        return format(value.quantize(RATE_QUANTUM, rounding=ROUND_HALF_UP), ".8f")


def _ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = 64
        return numerator / denominator


def _decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal(1)))
    return format(normalized, "f")


def _close_money(left: Decimal, right: Decimal) -> bool:
    return abs(_money(left) - _money(right)) <= MONEY_TOLERANCE


class AccountPositionSnapshot(BaseModel):
    """账户快照中的单只持仓估值事实。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    ticker: str = Field(pattern=r"^\d{6}$")
    name: str = Field(default="", max_length=80)
    quantity: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    cost_price: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    market_price: Decimal = Field(ge=0, max_digits=24, decimal_places=8)
    market_value: Decimal = Field(ge=0, max_digits=24, decimal_places=2)
    profit_loss: Decimal = Field(max_digits=24, decimal_places=2)
    return_rate: Decimal | None = Field(default=None, max_digits=18, decimal_places=8)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_valuation(self):
        expected_value = self.quantity * self.market_price
        if not _close_money(self.market_value, expected_value):
            raise ValueError("持仓市值必须等于数量乘以市场价")
        expected_profit = self.market_value - self.quantity * self.cost_price
        if not _close_money(self.profit_loss, expected_profit):
            raise ValueError("持仓盈亏必须等于市值减去持仓成本")
        return self


class AccountSnapshotInput(BaseModel):
    """已登录管理能力提交的完整账户权益事实。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    effective_at: datetime
    source: Literal["manual_calibration", "broker_asset", "system_close"]
    initial_capital: Decimal = Field(gt=0, max_digits=24, decimal_places=2)
    cash: Decimal = Field(ge=0, max_digits=24, decimal_places=2)
    market_value: Decimal = Field(ge=0, max_digits=24, decimal_places=2)
    total_equity: Decimal = Field(ge=0, max_digits=24, decimal_places=2)
    holdings_snapshot_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    positions: list[AccountPositionSnapshot] = Field(max_length=1000)
    price_as_of: datetime
    stale_reason: str | None = Field(default=None, max_length=240)

    @field_validator("effective_at", "price_as_of")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("时间必须包含时区")
        return value

    @field_validator("stale_reason")
    @classmethod
    def normalize_stale_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_account_equation(self):
        if not _close_money(self.cash + self.market_value, self.total_equity):
            raise ValueError("现金与持仓市值之和必须等于总权益")
        position_total = sum((item.market_value for item in self.positions), Decimal(0))
        if not _close_money(position_total, self.market_value):
            raise ValueError("持仓明细市值之和必须等于账户持仓市值")
        tickers = [item.ticker for item in self.positions]
        if len(tickers) != len(set(tickers)):
            raise ValueError("账户快照不能包含重复证券")
        return self


def _normalized_position(position: AccountPositionSnapshot) -> dict[str, str]:
    return {
        "ticker": position.ticker,
        "name": position.name,
        "quantity": _decimal_text(position.quantity),
        "cost_price": _decimal_text(position.cost_price),
        "market_price": _decimal_text(position.market_price),
        "market_value": _money_text(position.market_value),
        "profit_loss": _money_text(position.profit_loss),
        "return_rate": _rate_text(position.return_rate) if position.return_rate is not None else None,
    }


def _snapshot_payload(value: AccountSnapshotInput) -> dict:
    effective = value.effective_at.astimezone(SHANGHAI)
    price_as_of = value.price_as_of.astimezone(SHANGHAI)
    return {
        "effective_at": effective.isoformat(timespec="seconds"),
        "trade_date": effective.date().isoformat(),
        "source": value.source,
        "initial_capital": _money_text(value.initial_capital),
        "cash": _money_text(value.cash),
        "market_value": _money_text(value.market_value),
        "total_equity": _money_text(value.total_equity),
        "holdings_snapshot_id": value.holdings_snapshot_id,
        "positions": [
            _normalized_position(position)
            for position in sorted(value.positions, key=lambda item: item.ticker)
        ],
        "price_as_of": price_as_of.isoformat(timespec="seconds"),
        "stale_reason": value.stale_reason,
    }


def _snapshot_id(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.blake2s(raw, digest_size=16).hexdigest()


def list_account_snapshots(store: JsonStore) -> list[dict]:
    """读取账户权益快照副本，不创建迁移数据或触发估值。"""
    raw = store.get("holdings", "account_snapshots", []) or []
    if not isinstance(raw, list):
        return []
    snapshots = [dict(item) for item in raw if isinstance(item, dict)]
    return sorted(
        snapshots,
        key=lambda item: (str(item.get("effective_at", "")), int(item.get("data_revision", 0))),
    )


def _published_snapshots(store: JsonStore) -> list[dict]:
    """部署端逐份批准内容；备份、私有记录和未来新增快照不能授予公开权限。"""
    configured = os.environ.get("DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS", "[]")
    if len(configured) > 16_384:
        return []
    try:
        approved = json.loads(configured)
    except (ValueError, TypeError):
        return []
    if not isinstance(approved, list) or not 1 <= len(approved) <= MAX_PUBLISHED_SNAPSHOTS:
        return []
    if any(not isinstance(item, str) or re.fullmatch(r"[a-f0-9]{32}", item) is None for item in approved):
        return []
    identities = set(approved)
    raw = store.read_bounded_snapshot("holdings", max_bytes=MAX_PUBLIC_DOCUMENT_BYTES).get("account_snapshots", [])
    if not isinstance(raw, list):
        return []
    published: dict[str, dict] = {}
    for item in raw:
        # 未批准数据不参与解析、计算或排序。
        if not isinstance(item, dict) or not isinstance(item.get("snapshot_id"), str):
            continue
        identity = item["snapshot_id"]
        if identity not in identities:
            continue
        revision = item.get("data_revision")
        if type(revision) is not int or not 1 <= revision <= 9_007_199_254_740_991:
            continue
        try:
            validated = AccountSnapshotInput.model_validate({
                key: item[key] for key in AccountSnapshotInput.model_fields if key in item
            })
            payload = _snapshot_payload(validated)
        except (ValueError, TypeError, ArithmeticError):
            continue
        if _snapshot_id(payload) != identity:
            continue
        # 只从规范化且哈希匹配的事实投影，不信任导入的派生日期等字段。
        published[identity] = {**payload, "snapshot_id": identity, "data_revision": revision}
    return sorted(published.values(), key=lambda item: (item["effective_at"], item["data_revision"]))


def _daily_snapshots(snapshots: list[dict]) -> list[dict]:
    return list({item["trade_date"]: item for item in snapshots}.values())


def record_account_snapshot(store: JsonStore, value: AccountSnapshotInput) -> dict:
    """在 holdings 文档内原子追加一个不可变账户权益快照。"""
    payload = _snapshot_payload(value)
    identity = _snapshot_id(payload)
    committed: dict = {}

    def update(document: dict) -> dict:
        nonlocal committed
        holdings_snapshot = next(
            (
                item
                for item in (document.get("snapshots") or [])
                if isinstance(item, dict) and item.get("snapshot_id") == value.holdings_snapshot_id
            ),
            None,
        )
        if holdings_snapshot is None:
            raise ValueError("关联的持仓快照不存在")
        account_positions = {
            item.ticker: (_decimal_text(item.quantity), _money_text(item.cost_price))
            for item in value.positions
        }
        holdings_positions = {
            str(item.get("ticker")): (
                _decimal_text(Decimal(str(item.get("quantity")))),
                _money_text(Decimal(str(item.get("cost_price")))),
            )
            for item in (holdings_snapshot.get("positions") or [])
            if isinstance(item, dict)
        }
        if account_positions != holdings_positions:
            raise ValueError("账户持仓与持仓快照不一致")
        snapshots = [dict(item) for item in (document.get("account_snapshots") or []) if isinstance(item, dict)]
        duplicate = next((item for item in snapshots if item.get("snapshot_id") == identity), None)
        if duplicate is not None:
            committed = dict(duplicate)
            return document
        if any(
            not _close_money(Decimal(str(item.get("initial_capital"))), value.initial_capital)
            for item in snapshots
        ):
            raise ValueError("初始资金必须与既有账户快照保持一致")
        revision = max((int(item.get("data_revision", 0)) for item in snapshots), default=0) + 1
        committed = {
            "snapshot_id": identity,
            "data_revision": revision,
            **payload,
        }
        result = dict(document)
        result["account_snapshots"] = [*snapshots, committed]
        return result

    store.mutate_document("holdings", update)
    return dict(committed)


def _snapshot_for_date(snapshots: list[dict], requested: str) -> dict | None:
    parsed = _parse_date(requested)
    matches = [item for item in snapshots if item.get("trade_date") == parsed.isoformat()]
    return matches[-1] if matches else None


def public_overview(store: JsonStore, requested: str) -> dict:
    """返回指定日期的账户概览；存在历史时绝不回退到相邻日期。"""
    _parse_date(requested)
    snapshots = _published_snapshots(store)
    if not snapshots:
        return {
            "availability": "unavailable",
            "reason_code": "account-snapshot-unconfigured",
            "message": "尚未配置可公开的权威账户权益快照。",
        }
    snapshot = _snapshot_for_date(snapshots, requested)
    if snapshot is None:
        raise PublicSnapshotNotFound(requested)
    initial_capital = Decimal(str(snapshot["initial_capital"]))
    total_equity = Decimal(str(snapshot["total_equity"]))
    cumulative_profit = total_equity - initial_capital
    cumulative_return = _ratio(cumulative_profit, initial_capital)
    stale_reason = snapshot.get("stale_reason")
    return {
        "availability": "available",
        "snapshot_id": snapshot["snapshot_id"],
        "data_revision": snapshot["data_revision"],
        "date": snapshot["trade_date"],
        "currency": "CNY",
        "summary": {
            "initial_capital": _money_text(initial_capital),
            "cash": _money_text(Decimal(str(snapshot["cash"]))),
            "market_value": _money_text(Decimal(str(snapshot["market_value"]))),
            "total_equity": _money_text(total_equity),
            "cumulative_profit_loss": _money_text(cumulative_profit),
            "cumulative_return": _rate_text(cumulative_return),
        },
        "freshness": {
            "recorded_at": snapshot["effective_at"],
            "price_as_of": snapshot["price_as_of"],
            "stale": stale_reason is not None,
            "stale_reason": "行情数据可能已过期，请以记录时间为准。" if stale_reason else None,
        },
    }


def public_holdings(store: JsonStore, snapshot_id: str) -> dict:
    """返回指定账户快照的公开持仓字段白名单。"""
    if len(snapshot_id) != SNAPSHOT_ID_LENGTH or any(char not in "0123456789abcdef" for char in snapshot_id):
        raise ValueError("snapshot_id 必须是 32 位小写十六进制字符串")
    snapshot = next(
        (item for item in _published_snapshots(store) if item.get("snapshot_id") == snapshot_id),
        None,
    )
    if snapshot is None:
        raise PublicSnapshotNotFound(snapshot_id)
    allowed = (
        "ticker",
        "name",
        "quantity",
        "cost_price",
        "market_price",
        "market_value",
        "profit_loss",
        "return_rate",
    )
    return {
        "snapshot_id": snapshot["snapshot_id"],
        "data_revision": snapshot["data_revision"],
        "date": snapshot["trade_date"],
        "currency": "CNY",
        "items": [
            {key: item.get(key) for key in allowed}
            for item in snapshot.get("positions", [])
            if isinstance(item, dict)
        ],
    }


def _parse_date(value: str, label: str = "日期") -> date:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is None:
        raise ValueError(f"{label}必须使用 YYYY-MM-DD 格式")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label}必须使用 YYYY-MM-DD 格式") from exc


def public_calendar(store: JsonStore, month: str) -> dict:
    """返回账户快照与已有交易日历投影，不触发外部日历拉取。"""
    if len(month) != 7:
        raise ValueError("月份必须使用 YYYY-MM 格式")
    try:
        month_start = date.fromisoformat(f"{month}-01")
    except ValueError as exc:
        raise ValueError("月份必须使用 YYYY-MM 格式") from exc
    snapshots = _daily_snapshots(_published_snapshots(store))
    items: list[dict] = []
    for index, snapshot in enumerate(snapshots):
        trade_date = _parse_date(str(snapshot.get("trade_date", "")))
        if trade_date.year != month_start.year or trade_date.month != month_start.month:
            continue
        total_equity = Decimal(str(snapshot["total_equity"]))
        previous_equity = (
            Decimal(str(snapshots[index - 1]["total_equity"])) if index > 0 else None
        )
        daily_profit = total_equity - previous_equity if previous_equity is not None else None
        daily_return = (
            _ratio(daily_profit, previous_equity)
            if daily_profit is not None and previous_equity != 0
            else None
        )
        items.append({
            "date": snapshot["trade_date"],
            "snapshot_id": snapshot["snapshot_id"],
            "data_revision": snapshot["data_revision"],
            "total_equity": _money_text(total_equity),
            "daily_profit_loss": _money_text(daily_profit) if daily_profit is not None else None,
            "daily_return": _rate_text(daily_return) if daily_return is not None else None,
        })
    from .brief_engine import cached_trade_dates

    trading_dates = set(cached_trade_dates())
    first_known = min(trading_dates) if trading_dates else None
    last_known = max(trading_dates) if trading_dates else None
    days = []
    for day in range(1, monthrange(month_start.year, month_start.month)[1] + 1):
        current = month_start.replace(day=day)
        value = current.isoformat()
        if value in trading_dates:
            status = "trading"
        elif current.weekday() >= 5:
            status = "closed"
        elif first_known is not None and first_known <= value <= last_known:
            status = "closed"
        else:
            status = "unknown"
        days.append({"date": value, "trading_status": status})
    return {"month": month, "currency": "CNY", "items": items, "days": days}


def public_equity(store: JsonStore, from_date: str, to_date: str) -> dict:
    """返回闭区间内完整账户权益曲线，不插值、不回填缺失日期。"""
    start = _parse_date(from_date, "开始日期")
    end = _parse_date(to_date, "结束日期")
    if start > end:
        raise ValueError("开始日期不能晚于结束日期")
    if (end - start).days >= 366:
        raise ValueError("权益曲线最多查询 366 天")
    points: list[dict] = []
    for snapshot in _daily_snapshots(_published_snapshots(store)):
        trade_date = _parse_date(str(snapshot.get("trade_date", "")))
        if trade_date < start or trade_date > end:
            continue
        initial_capital = Decimal(str(snapshot["initial_capital"]))
        total_equity = Decimal(str(snapshot["total_equity"]))
        cumulative_profit = total_equity - initial_capital
        points.append({
            "date": snapshot["trade_date"],
            "snapshot_id": snapshot["snapshot_id"],
            "data_revision": snapshot["data_revision"],
            "total_equity": _money_text(total_equity),
            "cumulative_profit_loss": _money_text(cumulative_profit),
            "cumulative_return": _rate_text(_ratio(cumulative_profit, initial_capital)),
        })
    return {
        "from": from_date,
        "to": to_date,
        "currency": "CNY",
        "latest_revision": max((item["data_revision"] for item in points), default=None),
        "points": points,
    }


def _public_id(kind: str, identity: str) -> str:
    return hashlib.blake2s(f"{kind}:{identity}".encode("utf-8"), digest_size=12).hexdigest()


def _system_activities(store: JsonStore) -> list[dict]:
    rows: list[dict] = []
    for snapshot in _published_snapshots(store):
        public_id = _public_id("snapshot", str(snapshot["snapshot_id"]))
        rows.append({
            "public_id": public_id,
            "category": "system",
            "status": "completed",
            "occurred_at": snapshot["effective_at"],
            "title": "完成 · 权益快照更新",
            "summary": "账户权益与持仓估值已完成一致性记录。",
            "related_snapshot_id": snapshot["snapshot_id"],
        })
    return rows


def _activity_order(row: dict) -> tuple[int, str]:
    return operation_index.micros(_timestamp(row["occurred_at"])), row["public_id"]


def public_activities(
    store: JsonStore,
    as_of: str,
    *,
    category: str = "all",
    status: str = "all",
    cursor: str | None = None,
    limit: int = 20,
) -> dict:
    """返回字段白名单活动摘要和不透明游标。"""
    cutoff = _parse_date(as_of, "截止日期")
    if category not in {"all", "research", "operation", "system"}:
        raise ValueError("category 无效")
    if status not in {"all", "completed", "failed"}:
        raise ValueError("status 无效")
    if limit < 1 or limit > 50:
        raise ValueError("limit 必须在 1 到 50 之间")
    configured = os.environ.get("DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE", "").strip()
    since = operation_index.micros(_timestamp(configured)) if configured else None
    systems = _system_activities(store)
    if since is None and not systems:
        if cursor is not None:
            raise operation_index.CursorExpired()
        return {"as_of": as_of, "items": [], "next_cursor": None}
    # 使用本地自然日边界，统一按 UTC 微秒排序，避免字符串精度／时区差异。
    cutoff_us = operation_index.micros(datetime.combine(cutoff, time.min, SHANGHAI)) + 86400 * 1_000_000
    context = hashlib.blake2s(json.dumps([
        as_of, category, status, since, sorted(row["public_id"] for row in systems),
    ], separators=(",", ":")).encode(), digest_size=16).digest()
    with operation_index.reader(store) as projection:
        highwater, anchor = projection.open_cursor(cursor, context) if cursor is not None else (projection.highwater, None)
        rows = projection.page(since, cutoff_us, status, highwater, anchor, limit + 1) if since is not None and category in {"all", "operation"} else []
        rows += sorted((row for row in systems
                        if category in {"all", "system"} and status in {"all", "completed"}
                        and _activity_order(row)[0] < cutoff_us
                        and (anchor is None or _activity_order(row) < anchor)), key=_activity_order, reverse=True)[:limit + 1]
        rows.sort(key=_activity_order, reverse=True)
        page = rows[:limit]
        return {
            "as_of": as_of,
            "items": [{key: item[key] for key in operation_index.SUMMARY_FIELDS} for item in page],
            "next_cursor": projection.cursor(highwater, _activity_order(page[-1]), context) if len(rows) > limit else None,
        }


def public_activity_detail(store: JsonStore, public_id: str) -> dict:
    """按服务端生成的 ID 返回一条经批准的活动详情。"""
    if len(public_id) != 24 or any(char not in "0123456789abcdef" for char in public_id):
        raise ValueError("public_id 无效")
    item = next((row for row in _system_activities(store) if row["public_id"] == public_id), None)
    configured = os.environ.get("DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE", "").strip()
    if item is None and configured:
        since = operation_index.micros(_timestamp(configured))
        with operation_index.reader(store) as projection:
            item = projection.detail(public_id, since)
    if item is None:
        raise PublicSnapshotNotFound(public_id)
    return dict(item)


def register_public_observatory_routes(
    app: FastAPI,
    *,
    store_factory: Callable[[], JsonStore] | None = None,
) -> None:
    """注册内部账户快照写入与固定公开读取路由。"""
    write_store = store_factory or JsonStore
    read_store = store_factory or (lambda: JsonStore(create=False))

    @app.middleware("http")
    async def public_read_headers(request: Request, call_next):
        if not request.url.path.startswith("/public/performance/v1/"):
            return await call_next(request)
        if len(request.query_params.multi_items()) != len(request.query_params):
            response = JSONResponse({"code": "invalid-query", "message": "请求参数无效。"}, status_code=422)
        else:
            try:
                response = await call_next(request)
            except Exception:
                # 公开接口统一脱敏文件损坏、导入中和资源限额等内部错误。
                response = JSONResponse({"code": "temporarily-unavailable", "message": "公开数据暂时不可用。"}, status_code=503)
        response.headers["cache-control"] = "no-store"
        response.headers["x-content-type-options"] = "nosniff"
        return response

    @app.post("/portfolio/account-snapshots", response_model=dict)
    async def account_snapshot_create(request: Request):
        expected = os.environ.get("DSH_PUBLIC_OBSERVATORY_WRITE_TOKEN", "")
        supplied = request.headers.get("x-public-observatory-token", "")
        if not expected or not hmac.compare_digest(expected.encode(), supplied.encode()):
            raise HTTPException(status_code=403, detail="账户快照写入未授权")
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_WRITE_BYTES:
                raise HTTPException(status_code=413, detail="账户快照过大")
            body.extend(chunk)
        try:
            value = AccountSnapshotInput.model_validate_json(bytes(body))
            return await run_in_threadpool(lambda: record_account_snapshot(write_store(), value))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="账户快照格式或一致性校验失败") from exc

    @app.get("/public/performance/v1/overview", response_model=dict)
    def public_performance_overview(
        requested_date: str = Query(alias="date", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    ):
        try:
            return public_overview(read_store(), requested_date)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except PublicSnapshotNotFound as exc:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "snapshot-not-found",
                    "message": "指定日期没有账户权益快照。",
                },
            ) from exc

    @app.get("/public/performance/v1/holdings", response_model=dict)
    def public_performance_holdings(
        snapshot_id: str = Query(pattern=r"^[a-f0-9]{32}$"),
    ):
        try:
            return public_holdings(read_store(), snapshot_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except PublicSnapshotNotFound as exc:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "snapshot-not-found",
                    "message": "指定账户快照不存在。",
                },
            ) from exc

    @app.get("/public/performance/v1/calendar", response_model=dict)
    def public_performance_calendar(
        month: str = Query(pattern=r"^\d{4}-\d{2}$"),
    ):
        try:
            return public_calendar(read_store(), month)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/public/performance/v1/equity", response_model=dict)
    def public_performance_equity(
        from_date: str = Query(alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$"),
        to_date: str = Query(alias="to", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    ):
        try:
            return public_equity(read_store(), from_date, to_date)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/public/performance/v1/activities", response_model=dict)
    def public_performance_activities(
        as_of: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"),
        category: Literal["all", "research", "operation", "system"] = "all",
        status: Literal["all", "completed", "failed"] = "all",
        cursor: str | None = Query(default=None, max_length=128),
        limit: int = Query(default=20, ge=1, le=50),
    ):
        try:
            return public_activities(
                read_store(), as_of, category=category, status=status,
                cursor=cursor, limit=limit,
            )
        except operation_index.CursorExpired as exc:
            raise HTTPException(status_code=409, detail={"code": "cursor-expired", "message": "记录范围已更新，请重新读取。"}) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/public/performance/v1/activities/{public_id}", response_model=dict)
    def public_performance_activity_detail(public_id: str):
        try:
            return public_activity_detail(read_store(), public_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except PublicSnapshotNotFound as exc:
            raise HTTPException(
                status_code=404,
                detail={"code": "activity-not-found", "message": "指定活动不存在。"},
            ) from exc
