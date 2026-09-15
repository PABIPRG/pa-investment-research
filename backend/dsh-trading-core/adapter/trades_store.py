# -*- coding: utf-8 -*-
"""成交明细 collection 的读写。

与 holdings 的关键差别：持仓是**状态快照**（每次读都该是同一批），成交是**事件流**
（同一笔成交会被反复读到）。所以这里的写入必须走去重合并，而不是整体覆盖——覆盖会让
每次同步都把同一批成交再记一遍，或者更糟，把已有历史换成本次读到的那一段。

文档形状：
    {
      "entries": [TradeItem.model_dump()...],   # 去重后的全部成交，按 _sort_key 稳定排序
      "imports": [{...}],                        # 批次审计，最近 MAX_IMPORTS 次
      "last_cleared": {...} | None               # 最近一次清空的可追溯记录
    }
"""

from datetime import datetime, timezone
from typing import Any

from .schemas import TradeItem
from .store import JsonStore
from .trade_dedup import MergeOutcome, TradeConflict, merge_trades

TRADES_COLLECTION = "trades"

# imports 是纯审计流水，每同步一次长一条。entries 才是数据本体，所以这里可以用一个
# 固定上限截断——审计只用于"最近发生了什么"，不需要永久保留。
MAX_IMPORTS = 100


def empty_document() -> dict[str, Any]:
    return {"entries": [], "imports": [], "last_cleared": None}


def _as_entries(value: Any) -> list[TradeItem]:
    """读回已存条目；单条损坏只丢那一条，不让整个 collection 变得不可读。"""
    if not isinstance(value, list):
        return []
    entries: list[TradeItem] = []
    for row in value:
        try:
            entries.append(TradeItem.model_validate(row))
        except Exception:  # noqa: BLE001 — 校验细节不穿透到这里，丢弃即可
            continue
    return entries


def _as_imports(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def _sort_key(trade: TradeItem) -> tuple:
    """稳定排序键。occurred 参与排序，保证键相同的多笔不会互相盖掉顺序。"""
    return (
        trade.traded_at, trade.ticker, trade.side,
        trade.price, trade.quantity, trade.occurred,
    )


def load_entries(store: JsonStore) -> list[TradeItem]:
    return _as_entries(store.all(TRADES_COLLECTION).get("entries"))


def load_imports(store: JsonStore) -> list[dict[str, Any]]:
    return _as_imports(store.all(TRADES_COLLECTION).get("imports"))


def load_document(store: JsonStore) -> dict[str, Any]:
    document = store.all(TRADES_COLLECTION)
    return {
        "entries": [trade.model_dump() for trade in _as_entries(document.get("entries"))],
        "imports": _as_imports(document.get("imports")),
        "last_cleared": document.get("last_cleared"),
    }


def _conflict_summary(conflict: TradeConflict) -> dict[str, Any]:
    return {
        "key": list(conflict.key),
        "changed_fields": sorted(conflict.changed_fields),
        "existing": conflict.existing.model_dump(),
        "incoming": conflict.incoming.model_dump(),
    }


def _batch_range(incoming: list[TradeItem]) -> tuple[str | None, str | None]:
    """这一批成交覆盖的日期区间（按成交日，取日期部分）。

    存下来是为了让"覆盖率"能算得出来：entries 是去重后的并集，无法反推某一次读取
    覆盖了哪一段；而只有知道每次读取的区间，才能区分「这段真的没成交」与
    「这段根本没有被任何一次读取覆盖过」——后者才是用户要补数据的情形。
    """
    dates = sorted(trade.traded_at[:10] for trade in incoming if len(trade.traded_at) >= 10)
    if not dates:
        return None, None
    return dates[0], dates[-1]


def apply_import(
    store: JsonStore,
    *,
    incoming: list[TradeItem],
    source: str,
    account_mode: str,
    root: str,
    fetched: int,
    read_at: datetime | None = None,
) -> dict[str, Any]:
    """合并一批成交并记账，返回**实际生效**的结果。

    整个读-改-写在一个 mutate_document 内完成：调用方（preview/commit）在提交前会先
    比对基线，若这里重新读到的条目已经变了，合并结果以存下来的为准——即"后写的赢"。
    重复的部分会去匹配已存条目并被计成 duplicates，不会变成两份数据。
    """
    read_at = read_at or datetime.now(timezone.utc)
    applied: dict[str, Any] = {}

    def update(document: dict[str, Any]) -> dict[str, Any]:
        entries = _as_entries(document.get("entries"))
        outcome: MergeOutcome = merge_trades(entries, incoming)

        merged = entries + outcome.added
        merged.sort(key=_sort_key)

        range_start, range_end = _batch_range(incoming)
        record = {
            "source": source,
            "account_mode": account_mode,
            "root": root,
            "read_at": read_at.isoformat(),
            "fetched": fetched,
            "added": len(outcome.added),
            "duplicates": outcome.duplicates,
            "unclassified": outcome.unclassified,
            "conflicts": len(outcome.conflicts),
            # 本次读取覆盖的日期区间；旧记录没有这两个键，读取侧按「未知」处理。
            "range_start": range_start,
            "range_end": range_end,
        }
        imports = _as_imports(document.get("imports")) + [record]

        applied["outcome"] = outcome
        applied["record"] = record
        return {
            "entries": [trade.model_dump() for trade in merged],
            "imports": imports[-MAX_IMPORTS:],
            "last_cleared": document.get("last_cleared"),
        }

    store.mutate_document(TRADES_COLLECTION, update)

    outcome = applied["outcome"]
    return {
        "record": applied["record"],
        "added": len(outcome.added),
        "duplicates": outcome.duplicates,
        "unclassified": outcome.unclassified,
        # 键相同但内容不同：条目保留原样，把差异报出来。
        # 静默丢弃会让"客户端数据变了/上次读错了"这类问题永远不可见。
        "conflicts": [_conflict_summary(conflict) for conflict in outcome.conflicts],
        "entries": [trade.model_dump() for trade in outcome.added],
    }


def clear_entries(store: JsonStore, *, cleared_at: datetime | None = None) -> dict[str, Any]:
    """清空成交明细，保留一条可追溯记录。

    entries 是 append-only 且无上限的，而每次写入都是整文档读-改-写，所以必须有一条
    明确的退出通道。imports 一并保留——它记录的是"当时读到过什么"，是这次清空之后
    唯一还能解释数据来源的东西。
    """
    cleared_at = cleared_at or datetime.now(timezone.utc)
    applied: dict[str, Any] = {}

    def update(document: dict[str, Any]) -> dict[str, Any]:
        entries = _as_entries(document.get("entries"))
        imports = _as_imports(document.get("imports"))
        record = {
            "cleared_at": cleared_at.isoformat(),
            "removed": len(entries),
            "last_import_at": imports[-1]["read_at"] if imports else None,
        }
        applied["record"] = record
        return {"entries": [], "imports": imports, "last_cleared": record}

    store.mutate_document(TRADES_COLLECTION, update)
    return applied["record"]
