# -*- coding: utf-8 -*-
"""成交明细的去重与合并（纯函数，不碰存储）。

持仓是「状态快照」——每次读取覆盖上一次；成交是「事件流」——同一笔会被反复读到，
而多笔真实的部分成交又可能字段完全相同。合并必须同时满足：

  1. 重读同一段区间是幂等的：已经存过的成交不会重复计入。
  2. 多笔字段完全相同的部分成交不会互相吞掉。

这两条互相拉扯，所以「键相同」不能整组判等，必须按键逐笔配对：一笔本次读到的成交，
要么消耗掉一个历史槽位（说明是重读），要么成为新的一笔。仅靠集合去重会在第 2 条上
静默丢数据——A 股一笔委托拆成多笔成交是常态，而客户端的「成交时间」常常只到分钟。

去重键有两条路径，见 trade_key()。
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .schemas import TradeItem


def _quantized(value: float) -> float:
    """把进键的数值收敛到 3 位小数。

    同一笔成交在不同取数路径下的浮点表示可能不同（Xls 走 pandas、macOS 走字符串
    清洗），不收敛就会让重读的同一笔被当成新增。这里对已解析过的 float 再做一次，
    是为了让键的正确性不依赖「构造 TradeItem 的人已经量化过」。
    """
    return round(float(value), 3)


def trade_key(trade: TradeItem) -> tuple:
    """返回一笔成交的去重键。

    优先用客户端成交编号，但它通常是**当日流水号**而非全局唯一，所以必须带上日期：
    只用 trade_id 会让第二天的导入把另一天的真实成交当重复静默丢弃。

    没有成交编号时退化为字段组合键。此时键里必须带 side——同价同量的买卖对冲
    （如可转债、ETF 申赎）在同一秒内是可能同时存在的。
    """
    trade_id = trade.trade_id.strip()
    if trade_id:
        return ("id", trade.account_mode, trade.traded_at[:10], trade_id)
    return (
        "fields",
        trade.account_mode,
        trade.ticker,
        trade.side,
        _quantized(trade.price),
        _quantized(trade.quantity),
        trade.traded_at,
    )


def economic_content(trade: TradeItem) -> tuple:
    """参与「同键是否同一笔」比对的字段：只看钱和时点。

    刻意不含 name（股票改名、戴帽摘帽是常态，拿它比对会把每次重读都报成冲突）
    和 source（同一条数据换个数据源读到并不是数据变了）。
    """
    return (
        trade.ticker,
        trade.side,
        _quantized(trade.price),
        _quantized(trade.quantity),
        _quantized(trade.amount),
        trade.traded_at,
    )


_FIELD_NAMES = ("ticker", "side", "price", "quantity", "amount", "traded_at")


@dataclass(frozen=True)
class TradeConflict:
    """同一个去重键上出现了内容不同的两笔。

    要么客户端改了数据，要么上一次读错了。两种都不该静默丢弃——所以既不并进
    skipped，也不覆盖历史，而是把两边都交给调用方上报，由用户「清除后重导」。
    """

    key: tuple
    existing: TradeItem
    incoming: TradeItem

    @property
    def changed_fields(self) -> tuple[str, ...]:
        """列出内容有差异的字段名，供提示文案直接引用。"""
        old = economic_content(self.existing)
        new = economic_content(self.incoming)
        return tuple(
            name for name, before, after in zip(_FIELD_NAMES, old, new) if before != after
        )


@dataclass
class MergeOutcome:
    """一次合并的结果。added 是真正新增的成交，其余是各种「没有被计入」的原因。"""

    added: list[TradeItem] = field(default_factory=list)
    duplicates: int = 0
    conflicts: list[TradeConflict] = field(default_factory=list)

    @property
    def unclassified(self) -> int:
        """本次新增里归不了买卖方向的笔数（送股、红利入账等）。

        单独计数而不是丢弃：它们不是成交意义上的买卖，但计进成交笔数会污染
        交易频率统计，所以调用方要把这个数字如实报出来。
        """
        return sum(1 for trade in self.added if trade.side == "unclassified")


def merge_trades(
    existing: list[TradeItem], incoming: list[TradeItem]
) -> MergeOutcome:
    """把本次读到的成交并入已有成交，返回新增与各类未计入的原因。

    `incoming` 里的 occurred 一律被忽略并按键重新编号——它是存储层的槽位序号，
    不是客户端字段，由这里统一分配才能保证重读时编号稳定。
    """
    buckets: dict[tuple, list[TradeItem]] = defaultdict(list)
    seeds: dict[tuple, int] = defaultdict(int)
    for entry in existing:
        key = trade_key(entry)
        buckets[key].append(entry)
        seeds[key] = max(seeds[key], entry.occurred)

    outcome = MergeOutcome()
    for trade in incoming:
        key = trade_key(trade)
        bucket = buckets[key]

        match = next(
            (entry for entry in bucket if economic_content(entry) == economic_content(trade)),
            None,
        )
        if match is not None:
            # 本次读到的就是这一笔：消耗掉它的槽位，不重复计入。
            bucket.remove(match)
            outcome.duplicates += 1
            continue

        if bucket:
            # 键相同、内容不同，且还有没被本次读到的历史槽位——数据对不上，
            # 保留历史不动，交给调用方上报。
            outcome.conflicts.append(
                TradeConflict(key=key, existing=bucket[0], incoming=trade)
            )
            continue

        seeds[key] += 1
        outcome.added.append(trade.model_copy(update={"occurred": seeds[key]}))
    return outcome
