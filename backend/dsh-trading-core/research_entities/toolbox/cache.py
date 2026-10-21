# -*- coding: utf-8 -*-
"""进程内工具结果缓存：按数据类型设置 TTL，减少重复外部请求。

只缓存不依赖用户授权、且结果可由参数完全决定的数据。缓存命中仍会生成
新的证据记录，但保留原始 ``fetched_at`` 并标记 ``cache_hit``。
"""

from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict

from .contracts import ToolRequest, ToolResult

DEFAULT_TTL_SECONDS = 600
EMPTY_TTL_SECONDS = 300

# 用户事实与本地实体库查询不走缓存：前者会随持仓/自选变化，后者随导入变化。
NON_CACHEABLE_TOOLS = {
    "security_lookup",
    "industry_lookup",
    "theme_lookup",
    "benchmark_lookup",
    "peer_group_builder",
    "portfolio_lookup",
    "portfolio_risk_analysis",
    "watchlist_lookup",
    "event_monitor_setup",
    # 自进化状态与待确认预案会随闭环运行变化，缓存会把旧预案当成当前结论。
    "strategy_pool_lookup",
    "strategy_attribution_lookup",
    "strategy_evolution_preview",
}

_TTL_BY_TOOL = {
    # 行情与资金：分钟级
    "quote_history": 300,
    "capital_flow_lookup": 300,
    "margin_balance_lookup": 300,
    "dragon_tiger_lookup": 300,
    "index_performance_lookup": 300,
    "fund_performance_lookup": 300,
    "style_performance_lookup": 300,
    "industry_performance_lookup": 300,
    "benchmark_performance_lookup": 300,
    "convertible_bond_lookup": 300,
    "bond_terms_lookup": 300,
    "index_constituents_lookup": 300,
    "style_constituents_lookup": 300,
    "fund_holdings_lookup": 300,
    # 新闻与公告：十几分钟
    "announcement_search": 900,
    "event_timeline_lookup": 900,
    "macro_event_search": 900,
    "policy_search": 900,
    "regional_policy_search": 900,
    # 财务、公司资料与产业链：小时到天级
    "financials_lookup": 21600,
    "company_profile": 21600,
    "company_governance_lookup": 21600,
    "company_relationship_lookup": 21600,
    "industry_chain_lookup": 3600,
    "theme_constituents_lookup": 3600,
    "shareholder_count_lookup": 21600,
    "dividend_history_lookup": 21600,
    "restricted_release_lookup": 3600,
    "institution_survey_lookup": 3600,
    "macro_series_lookup": 3600,
    "commodity_price_lookup": 3600,
    "inventory_lookup": 3600,
    "official_document_search": 21600,
}


def cache_key(request: ToolRequest) -> str:
    params = json.dumps(
        request.params, ensure_ascii=False, sort_keys=True, default=str
    )
    return "|".join(
        (
            request.tool_id,
            ",".join(sorted(request.entity_ids)),
            params,
        )
    )


def ttl_for(tool_id: str, status: str) -> int:
    ttl = _TTL_BY_TOOL.get(tool_id, DEFAULT_TTL_SECONDS)
    if status == "empty":
        ttl = min(ttl, EMPTY_TTL_SECONDS)
    return ttl


def is_cacheable(tool_id: str) -> bool:
    return tool_id not in NON_CACHEABLE_TOOLS


class TTLCache:
    def __init__(self, *, max_entries: int = 512, clock=time.monotonic) -> None:
        self.max_entries = max_entries
        self._clock = clock
        self._items: OrderedDict[str, tuple[float, ToolResult]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> ToolResult | None:
        now = self._clock()
        with self._lock:
            entry = self._items.get(key)
            if entry is None:
                self.misses += 1
                return None
            expires_at, value = entry
            if expires_at <= now:
                del self._items[key]
                self.misses += 1
                return None
            self._items.move_to_end(key)
            self.hits += 1
            return value.model_copy(deep=True)

    def put(self, key: str, value: ToolResult, ttl: int) -> None:
        if ttl <= 0:
            return
        with self._lock:
            self._items[key] = (self._clock() + ttl, value.model_copy(deep=True))
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def stats(self) -> dict:
        with self._lock:
            return {
                "entries": len(self._items),
                "max_entries": self.max_entries,
                "hits": self.hits,
                "misses": self.misses,
            }
