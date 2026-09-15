# -*- coding: utf-8 -*-
"""成交明细的本地确定性指标（频率 / 集中度 / 覆盖度）。

第一期刻意只算这三类——它们的输入就是成交表本身，不需要任何外部假设：

  * 频率：笔数、活跃交易日数、买卖笔数比
  * 集中度：单票成交额占比、HHI
  * 覆盖度：起止日期、覆盖天数、以及**本次数据的区间是否被读取记录连续覆盖**

**不算的东西，以及为什么**（宁可返回 None / 缺席，也不半算）：

  * FIFO 已实现盈亏、平均持仓周期、胜率、盈亏比：需要完整成本基础，而分红送转/配股
    导致的数量对不上是常态；且成交表通常**不含佣金/印花税/过户费**（费用在交割单里），
    不含费用算盈亏会系统性高估。见 caveats。
  * 任何「预测」或模型打分：第一期不做，见计划文档。

集中度只统计股票：`^\\d{6}$` 会放进 204001（逆回购）、5xxxxx/1xxxxx（基金）、
可转债，这些标的的「集中度」没有持仓含义，混进去会让占比整体失真。频率不排除它们
——逆回购也是真实发生的交易笔数。
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from .schemas import TradeItem

# A 股股票代码段。刻意用白名单而不是黑名单：漏掉一个非股票品种只是少算一笔，
# 而把一个非股票品种当股票算进去会直接污染 HHI 与占比。
_STOCK_PREFIXES = ("00", "30", "60", "68", "43", "83", "87", "92")

# 集中度按成交额口径；成交额为 0 的流水（送股/红利入账）不参与占比计算。
_FREQUENCY_CAVEAT = (
    "笔数按成交表行数统计；同花顺的「买卖标志」还包括申购/中签/送股/红利入账等"
    "非买卖流水，它们计入笔数但不计入买卖比。"
)
_CONCENTRATION_CAVEAT = (
    "集中度按成交额计算，只统计 A 股股票（已排除逆回购、基金、可转债等）。"
    "它衡量的是成交分布，不是持仓集中度——两者在有买卖的情况下必然不同。"
)
_COST_CAVEAT = (
    "成交表通常不含佣金/印花税/过户费（费用在交割单里），因此不提供已实现盈亏、"
    "胜率、盈亏比：不含费用计算会系统性高估收益。"
)
_FEE_CAVEAT = "第一期不做 FIFO 已实现盈亏与持仓周期，成本基础不完整时会给出错误结论。"


def is_stock(ticker: str) -> bool:
    """是否为 A 股股票代码（排除逆回购/基金/可转债/B 股等）。"""
    return bool(re.fullmatch(r"\d{6}", ticker)) and ticker[:2] in _STOCK_PREFIXES


def _pct(part: float, whole: float) -> float | None:
    """占比；分母为 0 时返回 None（不是 0——0 会被读成「占比为零」）。"""
    if whole <= 0:
        return None
    return round(part / whole, 4)


def _frequency(entries: list[TradeItem]) -> dict[str, Any]:
    buys = sum(1 for t in entries if t.side == "buy")
    sells = sum(1 for t in entries if t.side == "sell")
    days = sorted({t.traded_at[:10] for t in entries if len(t.traded_at) >= 10})
    return {
        "trades": len(entries),
        "buy_count": buys,
        "sell_count": sells,
        "unclassified_count": sum(1 for t in entries if t.side == "unclassified"),
        "active_days": len(days),
        # 卖出为 0 时给 None 而不是 0 或 inf：没有任何卖出与「买卖完全均衡」是两回事。
        "buy_sell_ratio": round(buys / sells, 4) if sells else None,
        "trades_per_active_day": round(len(entries) / len(days), 2) if days else None,
    }


def _concentration(entries: list[TradeItem]) -> dict[str, Any]:
    by_ticker: dict[str, dict[str, Any]] = {}
    for trade in entries:
        if not is_stock(trade.ticker):
            continue
        row = by_ticker.setdefault(
            trade.ticker, {"ticker": trade.ticker, "name": trade.name, "amount": 0.0, "trades": 0}
        )
        # 名称取自最后一行：客户端偶尔对同一票在不同日期给不同简称（改名），
        # 用最新的那个比用第一次的更有用。
        if trade.name:
            row["name"] = trade.name
        row["amount"] += trade.amount
        row["trades"] += 1
    total = sum(row["amount"] for row in by_ticker.values())
    for row in by_ticker.values():
        row["amount"] = round(row["amount"], 2)
        row["share"] = _pct(row["amount"], total)
    ordered = sorted(by_ticker.values(), key=lambda row: -row["amount"])
    return {
        "amount_total": round(total, 2),
        "tickers": len(ordered),
        "hhi": round(sum((row["share"] or 0.0) ** 2 for row in ordered), 4),
        "top_share": ordered[0]["share"] if ordered else None,
        "excluded_non_stock_trades": sum(1 for t in entries if not is_stock(t.ticker)),
        "items": ordered,
    }


def _overlaps(left: tuple[str, str], right: tuple[str, str]) -> bool:
    return left[0] <= right[1] and right[0] <= left[1]


def _next_day(value: str) -> str:
    return (date.fromisoformat(value) + timedelta(days=1)).isoformat()


def _previous_day(value: str) -> str:
    return (date.fromisoformat(value) - timedelta(days=1)).isoformat()


def _coverage(entries: list[TradeItem], imports: list[dict[str, Any]]) -> dict[str, Any]:
    """数据自身跨度 + 读取记录是否把该跨度连续盖住。

    这两个问题必须分开回答：区间内某天没有成交，完全可能是那天没交易；但**如果
    没有任何一次读取覆盖过那天**，那就是真的缺数据。只有第二次导入才会暴露前者与
    后者的差别，所以这里用 imports 记录的区间去合并求并集，并报出未被覆盖的空洞。
    """
    days = sorted({t.traded_at[:10] for t in entries if len(t.traded_at) >= 10})
    if not days:
        return {
            "start": None, "end": None, "span_days": 0, "active_days": 0,
            "read_ranges": [], "uncovered": [], "status": "empty", "note": None,
        }
    start, end = days[0], days[-1]
    span = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1

    ranges: list[tuple[str, str]] = []
    for record in imports:
        first, last = record.get("range_start"), record.get("range_end")
        if isinstance(first, str) and isinstance(last, str) and first <= last:
            ranges.append((first, last))
    ranges.sort()
    merged: list[list[str]] = []
    for first, last in ranges:
        if merged and _overlaps((merged[-1][0], merged[-1][1]), (first, last)):
            merged[-1][1] = max(merged[-1][1], last)
        else:
            merged.append([first, last])

    # 空洞 = 数据跨度内、没有被任何一次读取覆盖到的区间。
    uncovered: list[dict[str, str]] = []
    cursor = start
    for first, last in merged:
        if first > cursor:
            uncovered.append({"start": cursor, "end": _previous_day(first)})
        cursor = max(cursor, _next_day(last))
    if cursor <= end:
        uncovered.append({"start": cursor, "end": end})

    if not merged:
        status, note = "unknown", (
            "没有可用的读取区间记录，无法判断数据是否覆盖了完整的日期范围。"
        )
    elif uncovered:
        status, note = "partial", (
            "下列日期区间没有任何一次读取覆盖过，可能缺少成交；"
            "请在客户端把日期范围调宽后重新导入。"
        )
    else:
        status, note = "complete", None
    return {
        "start": start,
        "end": end,
        "span_days": span,
        "active_days": len(days),
        "read_ranges": [{"start": first, "end": last} for first, last in merged],
        "uncovered": uncovered,
        "status": status,
        "note": note,
    }


def build_profile(entries: list[TradeItem], imports: list[dict[str, Any]]) -> dict[str, Any]:
    """把成交明细聚合成界面直接可渲染的指标。

    空明细返回零值结构而不是抛错：没有导入过成交是正常状态，不是故障。
    """
    if not entries:
        return {
            "frequency": {"trades": 0, "buy_count": 0, "sell_count": 0,
                          "unclassified_count": 0, "active_days": 0,
                          "buy_sell_ratio": None, "trades_per_active_day": None},
            "concentration": {"amount_total": 0.0, "tickers": 0, "hhi": 0.0,
                              "top_share": None, "excluded_non_stock_trades": 0, "items": []},
            "coverage": _coverage([], imports),
            "caveats": [_FREQUENCY_CAVEAT, _CONCENTRATION_CAVEAT, _COST_CAVEAT, _FEE_CAVEAT],
        }
    return {
        "frequency": _frequency(entries),
        "concentration": _concentration(entries),
        "coverage": _coverage(entries, imports),
        "caveats": [_FREQUENCY_CAVEAT, _CONCENTRATION_CAVEAT, _COST_CAVEAT, _FEE_CAVEAT],
    }
