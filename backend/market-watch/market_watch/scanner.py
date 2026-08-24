# -*- coding: utf-8 -*-
"""盘中异动扫描：涨幅榜 / 量比异动 / 涨跌停 / 换手异动 / 成交额榜。

数据源：东财 clist 服务端排序（完整字段含量比），限流时降级新浪 Market_Center 排序。
每 kind 单请求取 top N，不再拉全市场快照分页（旧版 30s+ 卡死盯盘按钮）。
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
    result = {
        "kind": kind,
        "trade_date": quotes.latest_trade_date(),
        "as_of": _now_str(),
    }

    if kind == "limit":
        try:
            up = [r for r in quotes._clist_top("f3", 100, po=1) if is_limit_up(r)]
            down = [r for r in quotes._clist_top("f3", 100, po=0) if is_limit_down(r)]
        except Exception:
            raise ValueError("行情源暂不可用，请稍后再试")
        up.sort(key=lambda r: r["pct_change"] or 0, reverse=True)
        down.sort(key=lambda r: r["pct_change"] or 0)
        result["limit_up"] = [_fmt(r) for r in up[:top_n]]
        result["limit_down"] = [_fmt(r) for r in down[:top_n]]
        return result

    try:
        rows = quotes._scan_rows(kind, top_n, min_amount_yi)
    except Exception:
        raise ValueError("行情源暂不可用，请稍后再试")
    result["items"] = [_fmt(r) for r in rows[:top_n]]
    return result
