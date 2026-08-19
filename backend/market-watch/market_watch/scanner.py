# -*- coding: utf-8 -*-
"""盘中异动扫描：涨幅榜 / 量比异动 / 涨跌停 / 换手异动 / 成交额榜。

数据源：实时快照一次拉取全市场（QuoteCache TTL 缓存内复用）。
"""

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from . import quotes
from .config import settings
from .rules import is_limit_down, is_limit_up

logger = logging.getLogger("market_watch.scanner")

SCAN_KINDS = ("gainers", "volume_ratio", "limit", "turnover", "amount")


def _fmt(r: dict) -> dict:
    return {
        "code": r["code"],
        "name": r["name"],
        "price": r.get("price"),
        "pct_change": r.get("pct_change"),
        "volume_ratio": r.get("volume_ratio"),
        "amount_yi": r.get("amount_yi"),
        "turnover": r.get("turnover"),
    }


def _now_str() -> str:
    return datetime.now(ZoneInfo(settings.timezone)).isoformat(timespec="seconds")


def scan(kind: str = "gainers", top_n: int = 10, min_amount_yi: float | None = None) -> dict:
    """一次异动扫描，返回 {kind, trade_date, as_of, items|limit_up, limit_down}。"""
    if kind not in SCAN_KINDS:
        raise ValueError(f"kind 必须是 {SCAN_KINDS} 之一，收到 {kind!r}")
    rows = quotes.cache().all_quotes()
    result = {
        "kind": kind,
        "trade_date": quotes.latest_trade_date(),
        "as_of": _now_str(),
    }

    if kind == "limit":
        up = [r for r in rows if is_limit_up(r)]
        down = [r for r in rows if is_limit_down(r)]
        up.sort(key=lambda r: r["pct_change"] or 0, reverse=True)
        down.sort(key=lambda r: r["pct_change"] or 0)
        result["limit_up"] = [_fmt(r) for r in up[:top_n]]
        result["limit_down"] = [_fmt(r) for r in down[:top_n]]
        return result

    if kind == "volume_ratio":
        rows = [r for r in rows if r.get("volume_ratio") is not None]
        rows.sort(key=lambda r: r["volume_ratio"], reverse=True)
    elif kind == "gainers":
        rows.sort(key=lambda r: r["pct_change"] or 0, reverse=True)
    elif kind == "turnover":
        rows = [r for r in rows if r.get("turnover") is not None]
        rows.sort(key=lambda r: r["turnover"], reverse=True)
    elif kind == "amount":
        rows = [r for r in rows if r.get("amount_yi") is not None]
        if min_amount_yi is not None:
            rows = [r for r in rows if r["amount_yi"] >= min_amount_yi]
        rows.sort(key=lambda r: r["amount_yi"], reverse=True)

    result["items"] = [_fmt(r) for r in rows[:top_n]]
    return result
