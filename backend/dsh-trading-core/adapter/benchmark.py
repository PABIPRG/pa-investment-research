# -*- coding: utf-8 -*-
"""自进化 v2 · 基准接入（P0.3）：按板块映射基准，把日收盘落 market_index 供 fitness/regime。

决策 §9.1：采用**按板块两档基准** —— 沪深300 为全 A 默认；科创板（688/689 前缀）
优先用科创50。映射集中在此，可扩展（如加创业板指）。网络获取复用 holdings_runner
的 baostock 会话封装（_bs_hist），与引擎/影子数据源一致；科创50 若数据源暂不可得，
稳健回退沪深300，避免拉取失败影响主路径。
"""
from __future__ import annotations

from typing import Optional

# 基准代码表：(前缀, 主基准 code, 主基准名, 回退 code, 回退名)
# baostock 指数代码均 sh. 前缀。
_BOARD_INDEX = [
    # 科创板 → 科创50（如 baostock 暂无则回退沪深300）
    ("688", "sh.000688", "科创50", "sh.000300", "沪深300"),
    ("689", "sh.000688", "科创50", "sh.000300", "沪深300"),
]

_FALLBACK_CODE = "sh.000300"
_FALLBACK_NAME = "沪深300"


def _is_tech_board(symbol: str) -> bool:
    s = str(symbol).strip()
    return s.startswith(("688", "689"))


def benchmark_for_symbol(symbol: str) -> tuple[str, str]:
    """6 位 A 股代码 → 该板块主基准 (code, name)。"""
    if _is_tech_board(symbol):
        return "sh.000688", "科创50"
    return _FALLBACK_CODE, _FALLBACK_NAME


def candidate_benchmarks(symbol: str) -> list[tuple[str, str]]:
    """尝试顺序的基准列表：板块主基准 → 沪深300 兜底。科创票才有兜底差异。"""
    if _is_tech_board(symbol):
        return [("sh.000688", "科创50"), (_FALLBACK_CODE, _FALLBACK_NAME)]
    return [(_FALLBACK_CODE, _FALLBACK_NAME)]


def fetch_index_rows(code: str, start: str, end: str) -> list[dict]:
    """拉单基准前复权日线 close：[{"date","close"}...]。空/失败抛异常。

    注意：index code 本身已带市场前缀（如 "sh.000300"），直接交给 _bs_hist，
    不能再经 _a_share_code 二次加前缀。
    """
    from .holdings_runner import _bs_hist

    rows = _bs_hist(code, start, end, fields="date,close")
    if not rows:
        raise RuntimeError(f"基准 {code} 无历史数据（{start}~{end}）")
    return rows


def fetch_symbol_benchmark(
    symbol: str,
    start: str,
    end: str,
) -> tuple[str, str, list[dict]]:
    """按板块取该股基准序列，科创50 不可用时自动回退沪深300。

    返回 (code, name, rows)。rows 为 [{date,close}] 升序，close 为 float。
    """
    for code, name in candidate_benchmarks(symbol):
        try:
            rows = fetch_index_rows(code, start, end)
            if rows:
                return code, name, rows
        except Exception:  # noqa: BLE001 — 尝试下一候选
            continue
    raise RuntimeError(f"{symbol} 无可用基准序列")


def record_index_rows(store, code: str, name: str | None, rows: list[dict]) -> int:
    """把 [{date,close}] 落 market_index（幂等覆盖同日）。返回写入的日数。"""
    from . import regime

    written = 0
    for row in rows:
        d = row.get("date")
        c = row.get("close")
        if not d or c is None:
            continue
        try:
            close = float(c)
        except (TypeError, ValueError):
            continue
        if close <= 0:
            continue
        regime.record_index_close(store, code, d, close, name)
        written += 1
    return written


__all__ = [
    "benchmark_for_symbol",
    "candidate_benchmarks",
    "fetch_index_rows",
    "fetch_symbol_benchmark",
    "record_index_rows",
]
