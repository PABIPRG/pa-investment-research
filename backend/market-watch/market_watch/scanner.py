# -*- coding: utf-8 -*-
"""盘中异动扫描：涨幅榜 / 量比异动 / 涨跌停 / 换手异动 / 成交额榜。

数据源：东财 clist 服务端排序（完整字段含量比），限流时降级新浪 Market_Center 排序。
每 kind 单请求取 top N，不再拉全市场快照分页（旧版 30s+ 卡死盯盘按钮）。
"""

import copy
import logging
import threading
import time
from collections import OrderedDict
from datetime import datetime
from zoneinfo import ZoneInfo

from . import quotes
from .config import settings
from .rules import is_limit_down, is_limit_up

logger = logging.getLogger("market_watch.scanner")

SCAN_KINDS = ("gainers", "volume_ratio", "limit", "turnover", "amount")
SCAN_CAPABILITIES = quotes.SCAN_CAPABILITIES


class MarketDataUnavailable(RuntimeError):
    pass


_SCAN_CACHE: OrderedDict[tuple[str, int, float | None], tuple[float, dict]] = OrderedDict()
_SCAN_LOCK = threading.RLock()
_SCAN_CLOCK = time.monotonic


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


def _cached_scan(
    key: tuple[str, int, float | None], now: float,
) -> tuple[dict | None, bool]:
    with _SCAN_LOCK:
        cached = _SCAN_CACHE.get(key)
        if cached is None:
            return None, False
        age = now - cached[0]
        if age > settings.scan_stale_ttl:
            _SCAN_CACHE.pop(key, None)
            return None, False
        _SCAN_CACHE.move_to_end(key)
        return copy.deepcopy(cached[1]), age <= settings.scan_cache_ttl


def _store_scan(key: tuple[str, int, float | None], result: dict, now: float) -> None:
    with _SCAN_LOCK:
        _SCAN_CACHE[key] = (now, copy.deepcopy(result))
        _SCAN_CACHE.move_to_end(key)
        capacity = max(1, settings.scan_cache_size)
        while len(_SCAN_CACHE) > capacity:
            _SCAN_CACHE.popitem(last=False)


def scan(kind: str = "gainers", top_n: int = 10, min_amount_yi: float | None = None) -> dict:
    """一次异动扫描，返回 {kind, trade_date, as_of, items|limit_up, limit_down}。"""
    if kind not in SCAN_KINDS:
        raise ValueError(f"kind 必须是 {SCAN_KINDS} 之一，收到 {kind!r}")
    started = _SCAN_CLOCK()
    key = (kind, top_n, min_amount_yi)
    cached, fresh = _cached_scan(key, started)
    if cached is not None and fresh:
        logger.info(
            "scan_cache_hit kind=%s source=%s stale=false elapsed_ms=%.1f",
            kind, cached.get("source"), (_SCAN_CLOCK() - started) * 1000,
        )
        return cached
    try:
        scan_rows = quotes._scan_rows(kind, top_n, min_amount_yi)
        result = {
            "kind": kind,
            "trade_date": quotes.latest_trade_date(),
            "as_of": _now_str(),
            "source": scan_rows.source,
            "stale": False,
            "complete": scan_rows.complete,
            "warnings": list(scan_rows.warnings),
        }
        if kind == "limit":
            up = [row for row in scan_rows.rows if is_limit_up(row)]
            down = [row for row in scan_rows.rows if is_limit_down(row)]
            up.sort(key=lambda row: row["pct_change"] or 0, reverse=True)
            down.sort(key=lambda row: row["pct_change"] or 0)
            result["limit_up"] = [_fmt(row) for row in up[:top_n]]
            result["limit_down"] = [_fmt(row) for row in down[:top_n]]
        else:
            result["items"] = [_fmt(row) for row in scan_rows.rows[:top_n]]
        _store_scan(key, result, _SCAN_CLOCK())
        logger.info(
            "scan_success kind=%s source=%s stale=false elapsed_ms=%.1f cache_hit=false",
            kind, scan_rows.source, (_SCAN_CLOCK() - started) * 1000,
        )
    except Exception as exc:
        if cached is not None:
            cached["stale"] = True
            warnings = list(cached.get("warnings") or [])
            warnings.append("实时行情源暂不可用，已返回最近成功缓存")
            cached["warnings"] = warnings
            logger.warning(
                "scan_source_unavailable kind=%s source=%s error=%s elapsed_ms=%.1f cache_hit=stale",
                kind, cached.get("source"), type(exc).__name__,
                (_SCAN_CLOCK() - started) * 1000,
            )
            return cached
        logger.warning(
            "scan_source_unavailable kind=%s source=none error=%s elapsed_ms=%.1f cache_hit=false",
            kind, type(exc).__name__, (_SCAN_CLOCK() - started) * 1000,
        )
        raise MarketDataUnavailable("行情源暂不可用，请稍后再试") from exc
    return result
