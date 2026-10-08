# -*- coding: utf-8 -*-
"""公开观察室的权威账户快照和固定字段只读投影。"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Any, Callable, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from fastapi import FastAPI, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from .store import JsonStore
from .public_holdings_operations import _timestamp
from . import holdings_operation_index as operation_index
from .portfolio_performance import portfolio_performance


SHANGHAI = ZoneInfo("Asia/Shanghai")
MONEY_QUANTUM = Decimal("0.01")
RATE_QUANTUM = Decimal("0.00000001")
MONEY_TOLERANCE = Decimal("0.01")
SNAPSHOT_ID_LENGTH = 32
MAX_PUBLISHED_SNAPSHOTS = 366
MAX_WRITE_BYTES = 512 * 1024
MAX_PUBLIC_DOCUMENT_BYTES = 8 * 1024 * 1024
MAX_PUBLIC_POSITIONS = 1000


class _HoldingsView:
    """一次有界读取的不可变持仓文档视图，供现有历史计算复用。"""

    def __init__(self, store: JsonStore):
        self.document = store.read_bounded_snapshot("holdings", max_bytes=MAX_PUBLIC_DOCUMENT_BYTES)

    def get(self, collection: str, key: str, default: Any = None) -> Any:
        if collection != "holdings":
            raise ValueError("公开读取只能访问持仓文档")
        return self.document.get(key, default)


def _public_positions(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) > MAX_PUBLIC_POSITIONS:
        raise ValueError("持仓列表无效或超限")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("持仓记录无效")
        ticker = item.get("ticker")
        if not isinstance(ticker, str) or re.fullmatch(r"\d{6}", ticker) is None or ticker in seen:
            raise ValueError("证券代码无效或重复")
        seen.add(ticker)
        try:
            quantity = Decimal(str(item["quantity"]))
            cost_price = Decimal(str(item["cost_price"]))
        except (KeyError, ValueError, ArithmeticError) as exc:
            raise ValueError("持仓数值无效") from exc
        if not quantity.is_finite() or not cost_price.is_finite() or quantity <= 0 or cost_price <= 0 or quantity >= Decimal("1e16") or cost_price >= Decimal("1e16"):
            raise ValueError("持仓数值超限")
        result.append({"ticker": ticker, "quantity": quantity, "cost_price": cost_price})
    return sorted(result, key=lambda row: row["ticker"])


def _quote_prices(codes: list[str]) -> dict[str, dict]:
    """通过既有 market-watch 批量行情服务获取当前报价；失败时保留持仓事实。"""
    import requests
    from .config import settings

    result: dict[str, dict] = {}
    requested = set(codes)

    def batch(batch_codes: list[str]) -> list[dict]:
        session = requests.Session()
        session.trust_env = False
        try:
            response = session.post(
                f"{settings.mw_url.rstrip('/')}/quotes/batch",
                json={"codes": batch_codes}, timeout=2,
            )
            response.raise_for_status()
            payload = response.json()
            rows = payload.get("items", []) if isinstance(payload, dict) else []
            return rows if isinstance(rows, list) else []
        except (requests.RequestException, ValueError, TypeError):
            return []
        finally:
            session.close()

    batches = [codes[offset:offset + 100] for offset in range(0, len(codes), 100)]
    if not batches:
        return result
    with ThreadPoolExecutor(max_workers=min(8, len(batches))) as executor:
        for future in as_completed([executor.submit(batch, part) for part in batches]):
            for row in future.result():
                if isinstance(row, dict) and row.get("code") in requested:
                    result[row["code"]] = row
    return result


def public_live(
    store: JsonStore, requested: str, *, today: date | None = None,
    quote_loader: Callable[[list[str]], dict[str, dict]] = _quote_prices,
    price_loader: Callable[[str, str, str], list[dict]] | None = None,
) -> dict:
    """指定日持仓直读；今日用批量报价，历史只沿用此前已记录持仓。"""
    target = _parse_date(requested)
    current_day = today or datetime.now(SHANGHAI).date()
    if target > current_day:
        raise ValueError("日期不能晚于今天")
    view = _HoldingsView(store)
    if target == current_day:
        raw = view.get("holdings", "default", []) or []
        source = "current_holdings"
        holdings_as_of = requested
    else:
        snapshots = [item for item in view.get("holdings", "snapshots", []) or []
                     if isinstance(item, dict) and str(item.get("effective_at", ""))[:10] <= requested
                     and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(item.get("effective_at", ""))[:10])]
        if not snapshots:
            return {"availability": "unavailable", "reason_code": "no-historical-holdings", "message": "所选日期没有持仓记录。"}
        snapshot = max(enumerate(snapshots), key=lambda entry: (str(entry[1].get("effective_at", "")), entry[0]))[1]
        raw = snapshot.get("positions", [])
        source = "recorded_holdings"
        holdings_as_of = str(snapshot["effective_at"])[:10]
    positions = _public_positions(raw)
    codes = [row["ticker"] for row in positions]
    prices: dict[str, dict] = {}
    if target == current_day:
        try:
            prices = quote_loader(codes) if codes else {}
        except Exception:
            prices = {}
    elif price_loader is not None:
        def historical_quote(code: str) -> tuple[str, dict | None]:
            try:
                rows = price_loader(code, requested, requested)
                matched = next((row for row in rows if str(row.get("date", ""))[:10] == requested), None)
                return code, {"price": matched.get("close")} if matched is not None else None
            except Exception:
                return code, None

        if codes:
            with ThreadPoolExecutor(max_workers=min(8, len(codes))) as executor:
                for code, quote in executor.map(historical_quote, codes):
                    if quote is not None:
                        prices[code] = quote
    items: list[dict] = []
    total_cost = Decimal(0)
    total_value = Decimal(0)
    complete = True
    for position in positions:
        ticker = position["ticker"]
        quantity = position["quantity"]
        cost = position["cost_price"]
        position_cost = _money(quantity * cost)
        total_cost += position_cost
        quote = prices.get(ticker, {})
        try:
            price = Decimal(str(quote.get("price")))
            if not price.is_finite() or price <= 0 or price >= Decimal("1e16"):
                raise ValueError("无效报价")
        except (ValueError, TypeError, ArithmeticError):
            price = None
            complete = False
        value = _money(quantity * price) if price is not None else None
        if value is not None:
            total_value += value
        profit = value - position_cost if value is not None else None
        name = quote.get("name")
        items.append({
            "ticker": ticker,
            "name": name.strip()[:80] if isinstance(name, str) else "",
            "quantity": _decimal_text(quantity),
            "cost_price": _decimal_text(cost),
            "market_price": _decimal_text(price) if price is not None else None,
            "market_value": _money_text(value) if value is not None else None,
            "profit_loss": _money_text(profit) if profit is not None else None,
            "return_rate": _rate_text(_ratio(profit, quantity * cost)) if profit is not None else None,
        })
    cost_total = _money(total_cost)
    market_total = _money(total_value) if complete else None
    floating = market_total - cost_total if market_total is not None else None
    return {
        "availability": "available", "date": requested, "currency": "CNY", "source": source,
        "holdings_as_of": holdings_as_of,
        "summary": {
            "holdings_cost": _money_text(cost_total),
            "market_value": _money_text(market_total) if market_total is not None else None,
            "floating_profit_loss": _money_text(floating) if floating is not None else None,
            "cost_return": _rate_text(_ratio(floating, cost_total)) if floating is not None and cost_total > 0 else None,
            "cash": None, "initial_capital": None, "total_equity": None,
        },
        "items": items,
        "freshness": {"stale": not complete, "message": "部分持仓缺少报价，汇总市值与浮盈暂不可计算。" if not complete else None},
    }


def public_history(store: JsonStore, from_date: str, to_date: str,
                   price_loader: Callable[[str, str, str], list[dict]]) -> dict:
    """公开历史复用资金流估算，不执行旧数据迁移写入。"""
    start = _parse_date(from_date, "开始日期")
    end = _parse_date(to_date, "结束日期")
    if start > end or (end - start).days >= 366 or end > datetime.now(SHANGHAI).date():
        raise ValueError("历史日期范围无效")
    view = _HoldingsView(store)
    known_dates = [str(item.get("effective_at", ""))[:10] for item in view.get("holdings", "snapshots", []) or []
                   if isinstance(item, dict) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(item.get("effective_at", ""))[:10])]
    if known_dates and min(known_dates) > to_date:
        return {"from": from_date, "to": to_date, "currency": "CNY", "quality": "unavailable",
                "limitations": ["所选区间早于首份持仓记录。"], "available_since": min(known_dates), "points": []}
    result = portfolio_performance(view, start, end, price_loader)
    return {
        "from": from_date, "to": to_date, "currency": "CNY",
        "quality": result["quality"], "limitations": result["limitations"],
        "available_since": result["available_since"],
        "points": [{
            "date": row["date"],
            "value": _money_text(Decimal(str(row["value"]))) if row["value"] is not None else None,
            "profit_loss": _money_text(Decimal(str(row["profit_loss"]))) if row["profit_loss"] is not None else None,
        } for row in result["series"]],
    }


class PublicSnapshotNotFound(LookupError):
    """请求的公开账户快照不存在。"""


class PublicLiveHolding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticker: str
    name: str
    quantity: str
    cost_price: str
    market_price: str | None
    market_value: str | None
    profit_loss: str | None
    return_rate: str | None


class PublicLiveSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    holdings_cost: str
    market_value: str | None
    floating_profit_loss: str | None
    cost_return: str | None
    cash: None
    initial_capital: None
    total_equity: None


class PublicLiveFreshness(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stale: bool
    message: str | None


class PublicLiveAvailable(BaseModel):
    model_config = ConfigDict(extra="forbid")
    availability: Literal["available"]
    date: str
    currency: Literal["CNY"]
    source: Literal["current_holdings", "recorded_holdings"]
    holdings_as_of: str
    summary: PublicLiveSummary
    items: list[PublicLiveHolding]
    freshness: PublicLiveFreshness


class PublicLiveUnavailable(BaseModel):
    model_config = ConfigDict(extra="forbid")
    availability: Literal["unavailable"]
    reason_code: str
    message: str


class PublicHistoryPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: str
    value: str | None
    profit_loss: str | None


class PublicHistoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_date: str = Field(alias="from")
    to_date: str = Field(alias="to")
    currency: Literal["CNY"]
    quality: Literal["unavailable", "partial", "estimated"]
    limitations: list[str]
    available_since: str | None
    points: list[PublicHistoryPoint]


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


RESEARCH_TITLES = {
    "stock": "个股研究报告", "holdings": "持仓研究报告", "brief": "市场简报",
    "backtest": "回测研究报告", "strategy": "策略研究报告", "shadow": "影子验证报告",
}


def _research_activities(store: JsonStore) -> list[dict]:
    """只投影报告时间与固定类型摘要，不读取原始参数和正文。"""
    configured = os.environ.get("DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE", "").strip()
    if not configured:
        return []
    since = operation_index.micros(_timestamp(configured))
    document = store.read_bounded_snapshot("reports", max_bytes=MAX_PUBLIC_DOCUMENT_BYTES)
    if len(document) > 2000:
        raise ValueError("研究活动数量超限")
    rows = []
    for identity, report in document.items():
        if not isinstance(identity, str) or re.fullmatch(r"[a-f0-9]{32}", identity) is None or not isinstance(report, dict):
            continue
        kind = report.get("task_type")
        if not isinstance(kind, str) or kind not in RESEARCH_TITLES:
            continue
        try:
            occurred = _timestamp(report.get("created_at"))
        except RuntimeError:
            continue
        if operation_index.micros(occurred) < since:
            continue
        rows.append({
            "public_id": _public_id("research", identity), "category": "research",
            "status": "completed", "occurred_at": occurred.isoformat(timespec="microseconds"),
            "title": RESEARCH_TITLES[kind],
            "summary": "研究报告已生成；这里只展示活动摘要，不公开报告正文。",
            "related_snapshot_id": None,
        })
    return rows


def _activity_order(row: dict) -> tuple[int, str]:
    return operation_index.micros(_timestamp(row["occurred_at"])), row["public_id"]


def _identified_holdings_update(row: dict, detail: dict | None, names: dict[str, str] | None = None) -> dict:
    """用已核验的公开持仓差异标出证券，兼容现有索引中的通用标题。"""
    if not _is_holdings_change(row) or detail is None:
        return row
    changes = detail.get("holdings_changes")
    if not isinstance(changes, list) or not changes:
        return row
    tickers = sorted({change["ticker"] for change in changes})
    labels = "、".join(f"{names[ticker]} · {ticker}" if names and ticker in names else ticker for ticker in tickers[:2])
    suffix = f" 等 {len(tickers)} 只" if len(tickers) > 2 else ""
    return {**row, "title": f"{row['title']}：{labels}{suffix}"}


def _activity_security_names(details: list[dict], quote_loader: Callable[[list[str]], dict[str, dict]] | None) -> dict[str, str]:
    """名称仅取公开差异代码对应的批量行情，失败不影响已核验的操作事实。"""
    if quote_loader is None:
        return {}
    tickers = sorted({change["ticker"] for detail in details
                      for change in detail.get("holdings_changes") or []})[:MAX_PUBLIC_POSITIONS]
    if not tickers:
        return {}
    try:
        quotes = quote_loader(tickers)
    except Exception:
        # 补充名称不可用时仍展示原有代码与操作，不阻断只读投影。
        return {}
    names = {}
    for ticker in tickers:
        name = quotes.get(ticker, {}).get("name")
        if isinstance(name, str) and name.strip():
            names[ticker] = name.strip()[:80]
    return names


def _is_holdings_change(row: dict) -> bool:
    return row["category"] == "operation" and any(
        action in row["title"] for action in ("持仓数据更新", "持仓数据导入", "持仓数据重置")
    )


def public_activities(
    store: JsonStore,
    as_of: str,
    *,
    category: str = "all",
    status: str = "all",
    cursor: str | None = None,
    limit: int = 20,
    quote_loader: Callable[[list[str]], dict[str, dict]] | None = None,
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
    research = _research_activities(store)
    if since is None and not systems and not research:
        if cursor is not None:
            raise operation_index.CursorExpired()
        return {"as_of": as_of, "items": [], "next_cursor": None}
    # 使用本地自然日边界，统一按 UTC 微秒排序，避免字符串精度／时区差异。
    cutoff_us = operation_index.micros(datetime.combine(cutoff, time.min, SHANGHAI)) + 86400 * 1_000_000
    context = hashlib.blake2s(json.dumps([
        as_of, category, status, since, sorted(row["public_id"] for row in [*systems, *research]),
    ], separators=(",", ":")).encode(), digest_size=16).digest()
    with operation_index.reader(store) as projection:
        highwater, anchor = projection.open_cursor(cursor, context) if cursor is not None else (projection.highwater, None)
        rows = projection.page(since, cutoff_us, status, highwater, anchor, limit + 1) if since is not None and category in {"all", "operation"} else []
        rows += sorted((row for row in [*systems, *research]
                        if category in {"all", row["category"]} and status in {"all", "completed"}
                        and _activity_order(row)[0] < cutoff_us
                        and (anchor is None or _activity_order(row) < anchor)), key=_activity_order, reverse=True)[:limit + 1]
        rows.sort(key=_activity_order, reverse=True)
        page = rows[:limit]
        details = {item["public_id"]: projection.detail(item["public_id"], since)
                   for item in page if since is not None and _is_holdings_change(item)}
        next_cursor = projection.cursor(highwater, _activity_order(page[-1]), context) if len(rows) > limit else None
    names = _activity_security_names([item for item in details.values() if item is not None], quote_loader)
    page = [_identified_holdings_update(item, details.get(item["public_id"]), names) for item in page]
    return {
        "as_of": as_of,
        "items": [{key: item[key] for key in operation_index.SUMMARY_FIELDS} for item in page],
        "next_cursor": next_cursor,
    }


def public_activity_detail(store: JsonStore, public_id: str, *,
                           quote_loader: Callable[[list[str]], dict[str, dict]] | None = None) -> dict:
    """按服务端生成的 ID 返回一条经批准的活动详情。"""
    if len(public_id) != 24 or any(char not in "0123456789abcdef" for char in public_id):
        raise ValueError("public_id 无效")
    item = next((row for row in [*_system_activities(store), *_research_activities(store)] if row["public_id"] == public_id), None)
    configured = os.environ.get("DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE", "").strip()
    if item is None and configured:
        since = operation_index.micros(_timestamp(configured))
        with operation_index.reader(store) as projection:
            item = projection.detail(public_id, since)
    if item is None:
        raise PublicSnapshotNotFound(public_id)
    names = _activity_security_names([item], quote_loader)
    result = _identified_holdings_update(dict(item), item, names)
    if "holdings_changes" in result and result["holdings_changes"] is not None and quote_loader is not None:
        result["holdings_changes"] = [{**change, "name": names.get(change["ticker"], "")}
                                     for change in result["holdings_changes"]]
    return result


def register_public_observatory_routes(
    app: FastAPI,
    *,
    store_factory: Callable[[], JsonStore] | None = None,
    price_loader: Callable[[str, str, str], list[dict]] | None = None,
    quote_loader: Callable[[list[str]], dict[str, dict]] = _quote_prices,
) -> None:
    """注册内部账户快照写入与固定公开读取路由。"""
    write_store = store_factory or JsonStore
    read_store = store_factory or (lambda: JsonStore(create=False))
    from .portfolio_price_cache import run_price_read

    @app.get("/public/performance/v1/live", response_model=PublicLiveAvailable | PublicLiveUnavailable)
    async def public_performance_live(requested_date: str = Query(alias="date", pattern=r"^\d{4}-\d{2}-\d{2}$")):
        try:
            return await run_price_read(lambda: public_live(read_store(), requested_date, price_loader=price_loader, quote_loader=quote_loader))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/public/performance/v1/history", response_model=PublicHistoryResponse)
    async def public_performance_history(
        from_date: str = Query(alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$"),
        to_date: str = Query(alias="to", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    ):
        if price_loader is None:
            raise HTTPException(status_code=503, detail="历史行情暂不可用")
        try:
            return await run_price_read(lambda: public_history(read_store(), from_date, to_date, price_loader))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

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
                cursor=cursor, limit=limit, quote_loader=quote_loader,
            )
        except operation_index.CursorExpired as exc:
            raise HTTPException(status_code=409, detail={"code": "cursor-expired", "message": "记录范围已更新，请重新读取。"}) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/public/performance/v1/activities/{public_id}", response_model=dict)
    def public_performance_activity_detail(public_id: str):
        try:
            return public_activity_detail(read_store(), public_id, quote_loader=quote_loader)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except PublicSnapshotNotFound as exc:
            raise HTTPException(
                status_code=404,
                detail={"code": "activity-not-found", "message": "指定活动不存在。"},
            ) from exc
