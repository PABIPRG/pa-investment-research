# -*- coding: utf-8 -*-
"""工具结果缓存测试：TTL、命中标记、排除项与持久化。"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.adapters.storage_sqlite import SqliteEntityRepository
from research_entities.toolbox.cache import (
    TTLCache,
    cache_key,
    is_cacheable,
    ttl_for,
)
from research_entities.toolbox.context import ToolContext
from research_entities.toolbox.contracts import ToolRequest
from research_entities.toolbox.executor import ToolExecutor

from tests.research_entities_fixtures import seed_stocks

NOW = lambda: datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
STOCK_ID = "SEC:CN:A:600519"


class FakeAkshare:
    def __init__(self, responses: dict):
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            return self.responses[name]

        return call


class FakeClock:
    def __init__(self, value: float = 1000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


def quote_calls(fake) -> list[tuple[str, dict]]:
    """排除交易日历等辅助调用，只统计数据接口调用。"""

    return [call for call in fake.calls if call[0] == "stock_zh_a_daily"]


def quote_frame():
    return pd.DataFrame(
        [
            {"date": "2026-10-16", "close": 100.0, "volume": 10},
            {"date": "2026-10-19", "close": 110.0, "volume": 20},
        ]
    )


def build_executor(*, cache=None, use_cache=True):
    repository = InMemoryEntityRepository()
    seed_stocks(repository)
    fake = FakeAkshare({"stock_zh_a_daily": quote_frame()})
    context = ToolContext(
        repository,
        akshare_module=fake,
        timeout=5,
        now=NOW,
    )
    executor = ToolExecutor(
        context,
        audit=False,
        cache=cache if cache is not None else TTLCache(),
        use_cache=use_cache,
    )
    return executor, fake, repository


class CacheKeyTest(unittest.TestCase):
    def test_key_ignores_entity_and_param_order(self):
        first = ToolRequest(
            tool_id="quote_history",
            entity_ids=["A", "B"],
            params={"days": 30, "adjust": "qfq"},
        )
        second = ToolRequest(
            tool_id="quote_history",
            entity_ids=["B", "A"],
            params={"adjust": "qfq", "days": 30},
            request_id="REQ_OTHER",
        )
        self.assertEqual(cache_key(first), cache_key(second))

    def test_key_separates_different_params(self):
        base = ToolRequest(tool_id="quote_history", params={"days": 30})
        other = ToolRequest(tool_id="quote_history", params={"days": 90})
        self.assertNotEqual(cache_key(base), cache_key(other))

    def test_user_fact_and_local_tools_are_not_cacheable(self):
        for tool_id in (
            "security_lookup",
            "portfolio_lookup",
            "portfolio_risk_analysis",
            "watchlist_lookup",
            "event_monitor_setup",
        ):
            self.assertFalse(is_cacheable(tool_id), tool_id)
        self.assertTrue(is_cacheable("quote_history"))

    def test_ttl_policy_by_tool(self):
        self.assertEqual(ttl_for("quote_history", "ok"), 300)
        self.assertEqual(ttl_for("announcement_search", "ok"), 900)
        self.assertEqual(ttl_for("financials_lookup", "ok"), 21600)
        self.assertEqual(ttl_for("unknown_tool", "ok"), 600)
        # 空结果只短暂缓存，避免一次偶然的空响应挡住后续真实数据。
        self.assertEqual(ttl_for("financials_lookup", "empty"), 300)


class TTLCacheTest(unittest.TestCase):
    def make_result(self, tool_id="quote_history"):
        from research_entities.toolbox.contracts import ToolResult

        return ToolResult(tool_id=tool_id, status="ok", data={"records": [{"x": 1}]})

    def test_hit_within_ttl_and_expiry_after(self):
        clock = FakeClock()
        cache = TTLCache(clock=clock)
        cache.put("k", self.make_result(), ttl=300)

        clock.value += 299
        self.assertIsNotNone(cache.get("k"))
        clock.value += 2
        self.assertIsNone(cache.get("k"))
        self.assertEqual(cache.stats()["hits"], 1)
        self.assertEqual(cache.stats()["misses"], 1)

    def test_lru_eviction(self):
        cache = TTLCache(max_entries=2)
        for key in ("a", "b", "c"):
            cache.put(key, self.make_result(), ttl=300)
        self.assertIsNone(cache.get("a"))
        self.assertIsNotNone(cache.get("b"))
        self.assertIsNotNone(cache.get("c"))

    def test_get_returns_copy(self):
        cache = TTLCache()
        cache.put("k", self.make_result(), ttl=300)
        first = cache.get("k")
        first.data["records"].append({"x": 2})
        self.assertEqual(len(cache.get("k").data["records"]), 1)


class ExecutorCacheTest(unittest.TestCase):
    def test_second_identical_call_hits_cache(self):
        executor, fake, _ = build_executor()
        first = executor.execute_tool(
            "quote_history",
            entity_ids=[STOCK_ID],
            request_id="REQ_CACHE_1",
        )
        second = executor.execute_tool(
            "quote_history",
            entity_ids=[STOCK_ID],
            request_id="REQ_CACHE_2",
        )

        self.assertEqual(first.status, "ok")
        self.assertFalse(first.cache_hit)
        self.assertEqual(second.status, "ok")
        self.assertTrue(second.cache_hit)
        self.assertEqual(len(quote_calls(fake)), 1)
        self.assertEqual(second.fetched_at, first.fetched_at)
        self.assertTrue(any("命中本地缓存" in item for item in second.warnings))

    def test_cache_hit_still_persists_new_evidence(self):
        executor, _fake, repository = build_executor()
        executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], request_id="REQ_CACHE_A"
        )
        executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], request_id="REQ_CACHE_B"
        )

        items = repository.list_evidence("REQ_CACHE_B")
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0].cache_hit)
        self.assertEqual(items[0].status, "ok")

    def test_different_params_do_not_share_cache(self):
        executor, fake, _ = build_executor()
        executor.execute_tool(
            "quote_history",
            entity_ids=[STOCK_ID],
            params={"days": 30},
            request_id="REQ_PARAMS_A",
        )
        result = executor.execute_tool(
            "quote_history",
            entity_ids=[STOCK_ID],
            params={"days": 90},
            request_id="REQ_PARAMS_B",
        )
        self.assertFalse(result.cache_hit)
        self.assertEqual(len(quote_calls(fake)), 2)

    def test_expired_entry_refetches(self):
        clock = FakeClock()
        executor, fake, _ = build_executor(cache=TTLCache(clock=clock))
        executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], request_id="REQ_EXPIRE_1"
        )
        clock.value += 301
        result = executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], request_id="REQ_EXPIRE_2"
        )
        self.assertFalse(result.cache_hit)
        self.assertEqual(len(quote_calls(fake)), 2)

    def test_use_cache_false_always_refetches(self):
        executor, fake, _ = build_executor(use_cache=False)
        executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], request_id="REQ_NOCACHE_1"
        )
        result = executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], request_id="REQ_NOCACHE_2"
        )
        self.assertFalse(result.cache_hit)
        self.assertEqual(len(quote_calls(fake)), 2)

    def test_local_tool_is_not_cached(self):
        cache = TTLCache()
        executor, _fake, _ = build_executor(cache=cache)
        executor.execute_tool(
            "security_lookup", entity_ids=[STOCK_ID], request_id="REQ_LOCAL"
        )
        self.assertEqual(cache.stats()["entries"], 0)


class CachePersistenceTest(unittest.TestCase):
    def test_sqlite_roundtrip_keeps_cache_hit(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = SqliteEntityRepository(Path(folder) / "entities.db")
            seed_stocks(repository)
            try:
                executor = ToolExecutor(
                    ToolContext(repository, now=NOW),
                    audit=False,
                    cache=TTLCache(),
                )
                executor.execute_tool(
                    "quote_history", entity_ids=[STOCK_ID], request_id="REQ_SQL_CACHE_1"
                )
                executor.execute_tool(
                    "quote_history", entity_ids=[STOCK_ID], request_id="REQ_SQL_CACHE_2"
                )

                items = repository.list_evidence("REQ_SQL_CACHE_2")
                self.assertEqual(len(items), 1)
                self.assertTrue(items[0].cache_hit)
            finally:
                repository.close()


if __name__ == "__main__":
    unittest.main()
