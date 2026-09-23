"""手工成交：持仓、快照和成交记录在同一文档原子落盘。"""
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .portfolio_performance import _positions, _snapshot
from .store import JsonStore
from .trades_store import load_document


class ManualTradeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    action: Literal["preview", "commit"] = "preview"
    request_id: str = Field(min_length=8, max_length=100)
    ticker: str = Field(pattern=r"^\d{6}$")
    side: Literal["buy", "sell"]
    quantity: Decimal = Field(gt=0, le=Decimal("1e12"))
    price: Decimal = Field(gt=0, le=Decimal("1e12"))
    fees: Decimal = Field(default=Decimal(0), ge=0, le=Decimal("1e15"))
    traded_at: datetime
    affects_holdings: bool = True
    version: str | None = None


def _version(document):
    return hashlib.sha256(json.dumps(document, sort_keys=True, default=str).encode()).hexdigest()


def history(store):
    manual = store.get("holdings", "manual_trades", []) or []
    broker = load_document(store)["entries"]
    return {"entries": sorted([*manual, *broker], key=lambda x: x.get("traded_at", ""), reverse=True)}


def apply_trade(store: JsonStore, req: ManualTradeRequest):
    result = {}
    payload = req.model_dump(mode="json", exclude={"action", "version"})
    def update(document):
        nonlocal result
        entries = document.get("manual_trades", []) or []
        previous = next((e for e in entries if e["request_id"] == req.request_id), None)
        if previous:
            previous_request = {**previous["request"], "affects_holdings": previous["request"].get("affects_holdings", True)}
            if previous_request != payload:
                raise ValueError("该保存编号已经用于另一笔成交，请重新录入。")
            result = {"saved": True, "entry": previous, "holdings": document.get("default", [])}
            return document
        version = _version(document)
        if req.action == "commit" and req.version != version:
            raise ValueError("持仓已发生变化，请重新预览后保存。")
        at = req.traded_at
        if at.tzinfo is None:
            raise ValueError("成交时间必须包含时区。")
        if at > datetime.now(timezone.utc):
            raise ValueError("成交时间不能晚于当前时间。")
        positions = _positions(document.get("default", []))
        current = next((p for p in positions if p["ticker"] == req.ticker), None)
        last_state = None
        backdated = False
        for snap in document.get("snapshots", []):
            state = next((p for p in snap["positions"] if p["ticker"] == req.ticker), None)
            related_trade = next((e for e in entries if e["request_id"] == snap.get("manual_trade_id")), None)
            cutoff = related_trade["traded_at"] if related_trade else snap["effective_at"]
            if state != last_state and at < datetime.fromisoformat(cutoff):
                backdated = True
            last_state = state
        if backdated and req.affects_holdings and "affects_holdings" not in req.model_fields_set:
            raise ValueError("这笔成交发生在最近一次持仓更新之前。请确认它是否已计入当前持仓，再选择只补成交记录或更新当前持仓。")
        qty = Decimal(str(current["quantity"])) if current else Decimal(0)
        cost = Decimal(str(current["cost_price"])) if current else Decimal(0)
        if req.affects_holdings and req.side == "sell" and req.quantity > qty:
            raise ValueError("卖出数量不能超过当前持仓数量。")
        after_qty = (qty + req.quantity if req.side == "buy" else qty - req.quantity) if req.affects_holdings else qty
        after_cost = (qty * cost + req.quantity * req.price + req.fees) / after_qty if req.affects_holdings and req.side == "buy" else cost
        remaining = [p for p in positions if p["ticker"] != req.ticker] if req.affects_holdings else list(positions)
        if req.affects_holdings:
            if after_qty:
                remaining.append({**(current or {}), "ticker": req.ticker, "quantity": float(after_qty), "cost_price": float(after_cost), "position_time": at.isoformat(), "time_source": "user_modified"})
            remaining = _positions(remaining)
        entry = {**payload, "quantity": float(req.quantity), "price": float(req.price), "fees": float(req.fees), "traded_at": at.isoformat(), "source": "manual", "before_quantity": float(qty), "after_quantity": float(after_qty), "after_cost_price": float(after_cost) if after_qty else None, "request": payload}
        result = {"saved": req.action == "commit", "version": version, "entry": entry, "holdings": remaining, "backdated": backdated}
        if req.action != "commit":
            return document
        if not req.affects_holdings:
            return {**document, "manual_trades": [*entries, entry]}
        snapshots = list(document.get("snapshots", []))
        if not snapshots and positions:
            snapshots.append(_snapshot(positions, "legacy_seed", at.isoformat(), None))
        snapshot = _snapshot(remaining, "manual", datetime.now(timezone.utc).isoformat(), snapshots[-1]["snapshot_id"] if snapshots else None)
        snapshot["manual_trade_id"] = req.request_id
        snapshots.append(snapshot)
        return {**document, "default": remaining, "snapshots": snapshots, "manual_trades": [*entries, entry]}
    if req.action == "preview":
        update(store.all("holdings"))
    else:
        store.mutate_document("holdings", update)
    return result
