# -*- coding: utf-8 -*-
"""组合持仓快照与确定性收益表现计算。"""

from __future__ import annotations

import hashlib
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any, Callable

from .store import JsonStore


SNAPSHOT_SOURCES = frozenset({
    "manual", "bulk_import", "api", "broker_real", "broker_simulated", "legacy_seed",
})
PRICE_WARMUP_DAYS = 31


class PortfolioPriceError(RuntimeError):
    """历史行情源无法完成组合估值。"""


def _timestamp(value: datetime | None) -> str:
    current = value or datetime.now().astimezone()
    if current.tzinfo is None:
        current = current.astimezone()
    return current.isoformat(timespec="seconds")


def _positions(value: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [
        {
            "ticker": str(item["ticker"]),
            "quantity": float(item["quantity"]),
            "cost_price": float(item["cost_price"]),
        }
        for item in value
    ]
    return sorted(normalized, key=lambda item: item["ticker"])


def _snapshot(
    positions: list[dict[str, Any]],
    source: str,
    effective_at: str,
    previous_snapshot_id: str | None,
) -> dict[str, Any]:
    payload = json.dumps(
        {"effective_at": effective_at, "positions": positions},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "snapshot_id": hashlib.blake2s(payload, digest_size=16).hexdigest(),
        "effective_at": effective_at,
        "source": source,
        "positions": positions,
        "previous_snapshot_id": previous_snapshot_id,
    }


def list_portfolio_snapshots(store: JsonStore) -> list[dict[str, Any]]:
    """按生效时间返回可识别的持仓快照副本。"""
    raw = store.get("holdings", "snapshots", []) or []
    if not isinstance(raw, list):
        return []
    items = [dict(item) for item in raw if isinstance(item, dict)]
    return sorted(items, key=lambda item: str(item.get("effective_at", "")))


def record_holdings_snapshot(
    store: JsonStore,
    positions: list[dict[str, Any]],
    source: str,
    effective_at: datetime | None = None,
) -> dict[str, Any] | None:
    """原子替换当前持仓，并在内容变化时追加不可变快照。"""
    if source not in SNAPSHOT_SOURCES:
        raise ValueError(f"不支持的持仓快照来源: {source}")
    normalized = _positions(positions)
    at = _timestamp(effective_at)
    committed: dict[str, Any] | None = None

    def update(document: dict[str, Any]) -> dict[str, Any]:
        nonlocal committed
        history = [dict(item) for item in (document.get("snapshots") or []) if isinstance(item, dict)]
        previous_positions = document.get("default") or []
        if not history and isinstance(previous_positions, list) and previous_positions:
            legacy_positions = _positions(
                [item for item in previous_positions if isinstance(item, dict)]
            )
            if legacy_positions:
                history.append(_snapshot(legacy_positions, "legacy_seed", at, None))
        latest = history[-1] if history else None
        if latest is not None and latest.get("positions") == normalized:
            committed = dict(latest)
        elif normalized or latest is not None:
            committed = _snapshot(
                normalized,
                source,
                at,
                str(latest.get("snapshot_id")) if latest is not None else None,
            )
            history.append(committed)
        result = dict(document)
        result["default"] = normalized
        if history:
            result["snapshots"] = history
        return result

    store.mutate_document("holdings", update)
    return committed


def ensure_legacy_seed(
    store: JsonStore,
    effective_at: datetime | None = None,
) -> dict[str, Any] | None:
    """为只有当前持仓的旧数据创建一次显式迁移起点。"""
    at = _timestamp(effective_at)
    committed: dict[str, Any] | None = None

    def update(document: dict[str, Any]) -> dict[str, Any]:
        nonlocal committed
        history = [dict(item) for item in (document.get("snapshots") or []) if isinstance(item, dict)]
        if history:
            committed = history[0]
            return document
        raw_positions = document.get("default") or []
        if not isinstance(raw_positions, list) or not raw_positions:
            return document
        normalized = _positions([item for item in raw_positions if isinstance(item, dict)])
        if not normalized:
            return document
        committed = _snapshot(normalized, "legacy_seed", at, None)
        result = dict(document)
        result["snapshots"] = [committed]
        return result

    store.mutate_document("holdings", update)
    return committed


def set_history_start_override(
    store: JsonStore,
    effective_date: date | None,
    *,
    corrected_at: datetime | None = None,
    today: date | None = None,
) -> dict[str, Any] | None:
    """校正首份持仓的历史起点，保留原始快照与可审计来源。"""
    snapshots = list_portfolio_snapshots(store)
    dated = [item for item in snapshots if _date(item.get("effective_at")) is not None]
    if not dated:
        raise ValueError("尚无持仓历史，不能校正历史起点")
    original_date = _date(dated[0].get("effective_at"))
    assert original_date is not None
    if effective_date is None:
        store.mutate_document(
            "holdings",
            lambda document: {
                key: value
                for key, value in document.items()
                if key != "history_start_override"
            },
        )
        return None
    current_day = today or date.today()
    if effective_date > current_day:
        raise ValueError("历史起点不能晚于今天")
    if len(dated) > 1:
        next_date = _date(dated[1].get("effective_at"))
        if next_date is not None and effective_date > next_date:
            raise ValueError("历史起点不能晚于下一次持仓变更日期")
    existing = store.get("holdings", "history_start_override") or {}
    preserved_original = _date(existing.get("original_effective_date")) or original_date
    override = {
        "effective_date": effective_date.isoformat(),
        "original_effective_date": preserved_original.isoformat(),
        "source": "user_corrected",
        "corrected_at": _timestamp(corrected_at),
    }
    store.set("holdings", "history_start_override", override)
    return override


def _performance_snapshots(store: JsonStore) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    snapshots = list_portfolio_snapshots(store)
    if not snapshots:
        return [], None
    override = store.get("holdings", "history_start_override")
    if not isinstance(override, dict) or override.get("source") != "user_corrected":
        return snapshots, None
    effective = _date(override.get("effective_date"))
    if effective is None:
        return snapshots, None
    projected = [dict(item) for item in snapshots]
    first = dict(projected[0])
    first["effective_at"] = effective.isoformat()
    projected[0] = first
    return sorted(projected, key=lambda item: str(item.get("effective_at", ""))), dict(override)


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _snapshot_positions(snapshot: dict[str, Any]) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
    for item in snapshot.get("positions") or []:
        if not isinstance(item, dict):
            continue
        ticker = str(item.get("ticker", ""))
        try:
            quantity = float(item["quantity"])
            cost_price = float(item["cost_price"])
        except (KeyError, TypeError, ValueError):
            continue
        if ticker and quantity > 0 and cost_price > 0:
            result[ticker] = {"quantity": quantity, "cost_price": cost_price}
    return result


def _active_positions(
    snapshots: list[dict[str, Any]], target: date
) -> dict[str, dict[str, float]]:
    active: dict[str, dict[str, float]] = {}
    for snapshot in snapshots:
        effective = _date(snapshot.get("effective_at"))
        if effective is not None and effective <= target:
            active = _snapshot_positions(snapshot)
    return active


def _value(
    positions: dict[str, dict[str, float]],
    prices: dict[str, dict[date, float]],
    target: date,
) -> float | None:
    total = 0.0
    for ticker, item in positions.items():
        price = prices.get(ticker, {}).get(target)
        if price is None:
            return None
        total += item["quantity"] * price
    return total


def _xirr(cash_flows: list[tuple[date, float]]) -> float | None:
    if len(cash_flows) < 2:
        return None
    combined: dict[date, float] = {}
    for flow_date, amount in cash_flows:
        combined[flow_date] = combined.get(flow_date, 0.0) + amount
    flows = sorted((flow_date, amount) for flow_date, amount in combined.items() if amount)
    if len(flows) < 2 or not any(amount < 0 for _, amount in flows) or not any(
        amount > 0 for _, amount in flows
    ):
        return None
    origin = flows[0][0]

    def npv(rate: float) -> float:
        return sum(
            amount / ((1.0 + rate) ** ((flow_date - origin).days / 365.0))
            for flow_date, amount in flows
        )

    low = -0.9999
    high = 1.0
    try:
        low_value = npv(low)
        high_value = npv(high)
        while low_value * high_value > 0 and high < 1_000_000_000:
            high = high * 2 + 1
            high_value = npv(high)
    except (OverflowError, ZeroDivisionError):
        return None
    if not math.isfinite(low_value) or not math.isfinite(high_value) or low_value * high_value > 0:
        return None
    for _ in range(200):
        middle = (low + high) / 2
        value = npv(middle)
        if abs(value) < 1e-7:
            return middle
        if low_value * value <= 0:
            high = middle
            high_value = value
        else:
            low = middle
            low_value = value
    candidate = (low + high) / 2
    return candidate if math.isfinite(candidate) else None


def _round(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(value, digits)


def _empty_performance(end_date: date, reason: str) -> dict[str, Any]:
    unavailable = {"value": None, "annualized": False, "quality": "unavailable", "reason": reason}
    return {
        "available_since": None,
        "history_start_origin": "unavailable",
        "history_start_original": None,
        "history_start_corrected_at": None,
        "start_date": None,
        "end_date": end_date.isoformat(),
        "as_of": None,
        "price_basis": "forward_adjusted_close",
        "quality": "unavailable",
        "limitations": [reason],
        "summary": {
            "start_value": None,
            "end_value": None,
            "net_flow": None,
            "profit_loss": None,
            "current_cost": None,
            "current_profit_loss": None,
            "cost_return": None,
        },
        "returns": {
            "twr": unavailable,
            "xirr": {**unavailable, "annualized": True},
        },
        "series": [],
        "contributions": [],
        "cash_flows": [],
        "missing_tickers": [],
        "coverage_ratio": 0.0,
    }


def portfolio_performance(
    store: JsonStore,
    start_date: date | None,
    end_date: date,
    price_loader: Callable[[str, str, str], list[dict[str, Any]]],
) -> dict[str, Any]:
    """从持仓快照与前复权收盘价计算一个时间窗口的组合表现。"""
    snapshots, history_override = _performance_snapshots(store)
    dated_snapshots = [item for item in snapshots if _date(item.get("effective_at")) is not None]
    if not dated_snapshots:
        return _empty_performance(end_date, "尚无持仓历史，录入持仓后开始记录。")
    available_since = _date(dated_snapshots[0]["effective_at"])
    assert available_since is not None
    requested_start = start_date
    effective_start = max(start_date or available_since, available_since)
    if effective_start > end_date:
        raise ValueError("开始日期不能晚于结束日期")

    tickers = sorted({
        *(_active_positions(dated_snapshots, effective_start).keys()),
        *(
            ticker
            for snapshot in dated_snapshots
            if (
                (snapshot_date := _date(snapshot.get("effective_at"))) is not None
                and effective_start < snapshot_date <= end_date
            )
            for ticker in _snapshot_positions(snapshot)
        ),
    })
    if not tickers:
        return _empty_performance(end_date, "所选区间没有可估值持仓。")

    raw_prices: dict[str, dict[date, float]] = {}
    history_start = effective_start - timedelta(days=PRICE_WARMUP_DAYS)
    all_dates: set[date] = {
        effective_start,
        end_date,
        *(
            snapshot_date
            for snapshot in dated_snapshots
            if (snapshot_date := _date(snapshot.get("effective_at"))) is not None
            and effective_start <= snapshot_date <= end_date
        ),
    }
    missing_tickers: list[str] = []
    with ThreadPoolExecutor(max_workers=min(8, len(tickers))) as executor:
        price_futures = {
            ticker: executor.submit(
                price_loader,
                ticker,
                history_start.isoformat(),
                end_date.isoformat(),
            )
            for ticker in tickers
        }
        loaded_rows: dict[str, list[dict[str, Any]]] = {}
        for ticker in tickers:
            try:
                loaded_rows[ticker] = price_futures[ticker].result()
            except Exception as exc:
                raise PortfolioPriceError(f"{ticker} 历史行情获取失败") from exc

    for ticker in tickers:
        rows = loaded_rows[ticker]
        values: dict[date, float] = {}
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            trade_date = _date(row.get("date"))
            try:
                close = float(row["close"])
            except (KeyError, TypeError, ValueError):
                continue
            if trade_date is not None and history_start <= trade_date <= end_date and close > 0:
                values[trade_date] = close
                if trade_date >= effective_start:
                    all_dates.add(trade_date)
        if not values:
            missing_tickers.append(ticker)
        raw_prices[ticker] = values

    valuation_dates = sorted(all_dates)
    prices: dict[str, dict[date, float]] = {ticker: {} for ticker in tickers}
    for ticker in tickers:
        prior_dates = [target for target in raw_prices[ticker] if target < effective_start]
        last: float | None = raw_prices[ticker][max(prior_dates)] if prior_dates else None
        for target in valuation_dates:
            if target in raw_prices[ticker]:
                last = raw_prices[ticker][target]
            if last is not None:
                prices[ticker][target] = last

    series: list[dict[str, Any]] = []
    total_flow = 0.0
    flow_complete = True
    twr_factor = 1.0
    twr_complete = True
    previous_positions: dict[str, dict[str, float]] | None = None
    previous_end_value: float | None = None
    start_value: float | None = None
    first_valid_date: date | None = None
    cash_flow_rows: list[dict[str, Any]] = []
    contribution_flows: dict[str, float | None] = {ticker: 0.0 for ticker in tickers}

    for target in valuation_dates:
        active = _active_positions(dated_snapshots, target)
        end_value = _value(active, prices, target)
        day_flow = 0.0
        if first_valid_date is not None and previous_positions is not None and active != previous_positions:
            before_value = _value(previous_positions, prices, target)
            if before_value is None or end_value is None:
                flow_complete = False
                day_flow = 0.0
            else:
                day_flow = end_value - before_value
                total_flow += day_flow
                cash_flow_rows.append({
                    "date": target.isoformat(),
                    "amount": _round(-day_flow, 2),
                    "kind": "estimated_external_flow",
                })
                for ticker in tickers:
                    previous_quantity = previous_positions.get(ticker, {}).get("quantity", 0.0)
                    next_quantity = active.get(ticker, {}).get("quantity", 0.0)
                    price = prices.get(ticker, {}).get(target)
                    if price is None and next_quantity != previous_quantity:
                        contribution_flows[ticker] = None
                    elif contribution_flows[ticker] is not None:
                        contribution_flows[ticker] = float(contribution_flows[ticker]) + (
                            next_quantity - previous_quantity
                        ) * float(price or 0.0)
            if previous_end_value is None or before_value is None or previous_end_value <= 0:
                twr_complete = False
            else:
                twr_factor *= before_value / previous_end_value
        elif first_valid_date is not None and previous_positions is not None:
            if previous_end_value is None or end_value is None or previous_end_value <= 0:
                twr_complete = False
            else:
                twr_factor *= end_value / previous_end_value

        if first_valid_date is None and end_value is not None:
            first_valid_date = target
            start_value = end_value
            cash_flow_rows.insert(0, {
                "date": target.isoformat(),
                "amount": _round(-end_value, 2),
                "kind": "opening_value",
            })
        profit_loss = None
        if start_value is not None and end_value is not None and flow_complete:
            profit_loss = end_value - start_value - total_flow
        series.append({
            "date": target.isoformat(),
            "value": _round(end_value, 2),
            "profit_loss": _round(profit_loss, 2),
        })
        previous_positions = active
        previous_end_value = end_value

    final_date = valuation_dates[-1]
    valid_valuation_count = sum(point["value"] is not None for point in series)
    has_return_interval = valid_valuation_count >= 2
    if not has_return_interval:
        for point in series:
            point["profit_loss"] = None
    end_positions = _active_positions(dated_snapshots, final_date)
    end_value = _value(end_positions, prices, final_date)
    current_cost = sum(
        item["quantity"] * item["cost_price"] for item in end_positions.values()
    ) or None
    current_profit = (
        end_value - current_cost
        if end_value is not None and current_cost is not None
        else None
    )
    cost_return = (
        current_profit / current_cost
        if current_profit is not None and current_cost is not None and current_cost > 0
        else None
    )
    profit_loss = (
        end_value - start_value - total_flow
        if has_return_interval
        and end_value is not None
        and start_value is not None
        and flow_complete
        else None
    )
    twr = (
        twr_factor - 1
        if has_return_interval and first_valid_date is not None and twr_complete
        else None
    )

    solver_flows: list[tuple[date, float]] = []
    for row in cash_flow_rows:
        flow_date = _date(row["date"])
        amount = row["amount"]
        if flow_date is not None and isinstance(amount, (int, float)):
            solver_flows.append((flow_date, float(amount)))
    if end_value is not None:
        cash_flow_rows.append({
            "date": final_date.isoformat(),
            "amount": _round(end_value, 2),
            "kind": "ending_value",
        })
        solver_flows.append((final_date, end_value))
    xirr = _xirr(solver_flows) if flow_complete else None

    if end_value is None:
        portfolio_as_of: date | None = None
    elif not end_positions:
        portfolio_as_of = final_date
    else:
        latest_dates = [
            max((price_date for price_date in raw_prices[ticker] if price_date <= final_date), default=None)
            for ticker in end_positions
        ]
        portfolio_as_of = (
            min(price_date for price_date in latest_dates if price_date is not None)
            if all(price_date is not None for price_date in latest_dates)
            else None
        )

    contribution_start_date = first_valid_date or effective_start
    start_positions = _active_positions(dated_snapshots, contribution_start_date)
    contributions: list[dict[str, Any]] = []
    for ticker in tickers:
        start_quantity = start_positions.get(ticker, {}).get("quantity", 0.0)
        end_quantity = end_positions.get(ticker, {}).get("quantity", 0.0)
        start_price = prices.get(ticker, {}).get(contribution_start_date)
        end_price = prices.get(ticker, {}).get(final_date)
        start_amount = start_quantity * start_price if start_price is not None else None
        end_amount = end_quantity * end_price if end_price is not None else None
        end_position = end_positions.get(ticker)
        ticker_current_cost = (
            end_position["quantity"] * end_position["cost_price"]
            if end_position is not None
            else None
        )
        ticker_current_profit = (
            end_amount - ticker_current_cost
            if end_amount is not None and ticker_current_cost is not None
            else None
        )
        ticker_cost_return = (
            ticker_current_profit / ticker_current_cost
            if ticker_current_profit is not None
            and ticker_current_cost is not None
            and ticker_current_cost > 0
            else None
        )
        ticker_cost_price = end_position.get("cost_price") if end_position is not None else None
        ticker_price_return = (
            (end_price - ticker_cost_price) / ticker_cost_price
            if end_price is not None
            and ticker_cost_price is not None
            and ticker_cost_price > 0
            else None
        )
        flow = contribution_flows[ticker]
        contribution = (
            end_amount - start_amount - flow
            if has_return_interval
            and end_amount is not None
            and start_amount is not None
            and flow is not None
            else None
        )
        contributions.append({
            "ticker": ticker,
            "start_value": _round(start_amount, 2),
            "end_value": _round(end_amount, 2),
            "net_flow": _round(flow, 2),
            "profit_loss": _round(contribution, 2),
            "current_cost": _round(ticker_current_cost, 2),
            "current_profit_loss": _round(ticker_current_profit, 2),
            "cost_return": _round(ticker_cost_return),
            "cost_price": _round(ticker_cost_price, 4),
            "end_price": _round(end_price, 4),
            "price_return": _round(ticker_price_return),
        })
    contributions.sort(
        key=lambda item: abs(item["profit_loss"]) if item["profit_loss"] is not None else -1,
        reverse=True,
    )

    incomplete_values = any(point["value"] is None for point in series)
    quality = "partial" if missing_tickers or incomplete_values else "estimated"
    limitations = ["金额加权收益率根据持仓变更日市场价值推算，不含现金、分红和费用。"]
    if history_override is not None:
        limitations.insert(0, "历史起点由用户人工校正；早于首份系统快照的表现按首份持仓估算。")
    if dated_snapshots[0].get("source") == "legacy_seed":
        limitations.insert(0, "旧持仓没有原始录入日期，历史从本次迁移快照开始。")
    if requested_start is not None and requested_start < available_since:
        limitations.append(f"所选开始日期早于可用历史，已从 {available_since.isoformat()} 计算。")
    if missing_tickers:
        limitations.append(f"以下标的缺少历史行情：{'、'.join(missing_tickers)}。")
    if twr is None:
        limitations.append("有效估值点不足，时间加权收益率不可计算。")
    if xirr is None:
        limitations.append("现金流不足或数值未收敛，金额加权收益率不可计算。")

    coverage_ratio = (len(tickers) - len(missing_tickers)) / len(tickers)
    return {
        "available_since": available_since.isoformat(),
        "history_start_origin": "user_corrected" if history_override is not None else "system_record",
        "history_start_original": (
            history_override.get("original_effective_date")
            if history_override is not None
            else available_since.isoformat()
        ),
        "history_start_corrected_at": (
            history_override.get("corrected_at") if history_override is not None else None
        ),
        "start_date": effective_start.isoformat(),
        "end_date": end_date.isoformat(),
        "as_of": portfolio_as_of.isoformat() if portfolio_as_of is not None else None,
        "price_basis": "forward_adjusted_close",
        "quality": quality,
        "limitations": limitations,
        "summary": {
            "start_value": _round(start_value, 2),
            "end_value": _round(end_value, 2),
            "net_flow": _round(total_flow, 2) if flow_complete else None,
            "profit_loss": _round(profit_loss, 2),
            "current_cost": _round(current_cost, 2),
            "current_profit_loss": _round(current_profit, 2),
            "cost_return": _round(cost_return),
        },
        "returns": {
            "twr": {
                "value": _round(twr),
                "annualized": False,
                "quality": quality if twr is not None else "unavailable",
                "reason": None if twr is not None else "有效估值点不足",
            },
            "xirr": {
                "value": _round(xirr),
                "annualized": True,
                "quality": "estimated" if xirr is not None else "unavailable",
                "reason": None if xirr is not None else "现金流不足或数值未收敛",
            },
        },
        "series": series,
        "contributions": contributions,
        "cash_flows": cash_flow_rows,
        "missing_tickers": missing_tickers,
        "coverage_ratio": _round(coverage_ratio),
    }
