# -*- coding: utf-8 -*-
"""自进化 v2 · 事件账本 events_ledger + 同类事件标的池 symbol_pools（P0.2）。

目标：给符号迁移（P2）和先验统计（P6）提供「这类事件 × 这个方向」的历史候选股池，
把瞬态 flash news 沉淀成**有日期的历史事件账本**——否则一条策略只是"某次事件的复盘"，
只在那一两只票上证明过自己；迁移验证才能证明"这类事件下规律可复用"。

数据流：`create_candidates` 每成功落一条候选时调用 `record_candidate`，把
{event_type × direction} → 该次选中的 symbol codes（带首次/最近/次数）并入 events_ledger。
`symbol_pool` 聚合出按最近日期降序的去重候选股，供变异换票（母体现有票会先被排除）。

持久化（JsonStore）：collection `events_ledger`，key = pool_id（"type|direction"），
value = {pool_id, event_type, direction, updated_at, symbols:{code:{first,last,n}}}。
pool_id 与 collection 名均满足 store 白名单约束。
"""
from __future__ import annotations

import re
import time
from datetime import date as _date

from .store import JsonStore

_LEDGER_COLLECTION = "events_ledger"
_DEFAULT_TYPE = "unknown"

_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def event_type_of(event: dict) -> str:
    """宽容取事件类型；取不到回 'unknown'。"""
    for key in ("type", "event_type", "category"):
        val = event.get(key) if isinstance(event, dict) else None
        if isinstance(val, str) and val.strip():
            return val.strip()
    return _DEFAULT_TYPE


def event_date_of(event: dict, default_date: str | None = None) -> str:
    """从事件里尽力提取 YYYY-MM-DD；提取不到用 default_date 或今天。"""
    for key in ("time", "date", "created_at", "publish_at", "datetime"):
        val = event.get(key) if isinstance(event, dict) else None
        if isinstance(val, str):
            m = _DATE_RE.search(val)
            if m:
                return m.group(1)
    if isinstance(default_date, str) and _DATE_RE.fullmatch(default_date):
        return default_date
    return _date.today().isoformat()


def pool_id(event_type: str, direction: str) -> str:
    """生态位池 id：type|direction。direction 归一为 利好/利空/其他。"""
    t = (event_type or _DEFAULT_TYPE).strip() or _DEFAULT_TYPE
    d = str(direction or "").strip()
    d = d if d in ("利好", "利空") else "其他"
    return f"{t}|{d}"


def record_candidate(
    store: JsonStore,
    *,
    event: dict,
    direction: str,
    symbol_codes: list[str],
    date: str | None = None,
) -> str | None:
    """把一次成功候选沉淀进事件账本。返回写入的 pool_id；无可沉淀返回 None。

    symbol_codes 为该事件最终选中的标的（直接标的 + impact 扩展里真正采用的）。
    """
    codes = [str(c) for c in (symbol_codes or []) if str(c)]
    if not codes:
        return None
    ev_date = event_date_of(event, date)
    etype = event_type_of(event)
    pid = pool_id(etype, direction)

    def transform(current):
        doc = dict(current or {})
        doc["pool_id"] = pid
        doc["event_type"] = etype
        doc["direction"] = direction if direction in ("利好", "利空") else "其他"
        symbols = dict((doc.get("symbols") or {}))
        for code in codes:
            seen = dict(symbols.get(code) or {})
            first = seen.get("first") or ev_date
            n = int(seen.get("n") or 0) + 1
            symbols[code] = {
                "first": first,
                "last": max(str(seen.get("last") or ev_date), ev_date),
                "n": n,
            }
        doc["symbols"] = symbols
        doc["updated_at"] = _now()
        return doc

    store.mutate(_LEDGER_COLLECTION, pid, transform)
    return pid


def symbol_pool(
    store: JsonStore,
    *,
    event_type: str,
    direction: str,
    max_symbols: int | None = None,
    exclude: list[str] | None = None,
) -> list[str]:
    """取该生态位池的去重候选股，按最近活跃日期降序。

    exclude：变异换票时传母体现有 symbols，返回的都是"新增候选"。
    max_symbols 缺省用 config.symbol_pool_max_symbols；不传 exclude 时取全池。
    """
    from .config import settings

    pid = pool_id(event_type, direction)
    doc = store.get(_LEDGER_COLLECTION, pid) or {}
    symbols = dict((doc.get("symbols") or {}))
    if not symbols:
        return []
    limit = max_symbols
    if limit is None:
        limit = settings.symbol_pool_max_symbols
    exclude_set = {str(c) for c in (exclude or []) if str(c)}
    ranked = sorted(
        symbols.items(),
        key=lambda kv: str((kv[1] or {}).get("last") or ""),
        reverse=True,
    )
    return [code for code, _ in ranked if code not in exclude_set][: max(1, int(limit))]


def pool_stats(store: JsonStore) -> list[dict]:
    """账本总览（供看板/先验统计）。"""
    rows = []
    for pid, doc in (store.all(_LEDGER_COLLECTION) or {}).items():
        if not isinstance(doc, dict):
            continue
        symbols = doc.get("symbols") or {}
        rows.append({
            "pool_id": doc.get("pool_id") or pid,
            "event_type": doc.get("event_type"),
            "direction": doc.get("direction"),
            "symbol_count": len(symbols),
            "updated_at": doc.get("updated_at"),
        })
    rows.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
    return rows


__all__ = [
    "event_type_of",
    "event_date_of",
    "pool_id",
    "record_candidate",
    "symbol_pool",
    "pool_stats",
    "_LEDGER_COLLECTION",
]
