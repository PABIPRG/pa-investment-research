# -*- coding: utf-8 -*-
"""机会发现首屏快讯的 deadline、缓存与显式富化契约。"""

import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import openai

if not hasattr(openai, "OpenAI"):
    openai.OpenAI = object

from market_watch import events, news


def _item(item_id: str, title: str) -> dict:
    return {
        "id": item_id,
        "time": "2026-08-24 10:00:00",
        "tag": "测试",
        "title": title,
        "content": title,
        "source": "测试",
        "url": "",
    }


class FakeClock:
    def __init__(self, now: float = 0.0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeSource:
    def __init__(self, rows: list[dict], wait_for: threading.Event | None = None):
        self.rows = rows
        self.wait_for = wait_for
        self.calls = 0

    def __call__(self, _limit: int) -> list[dict]:
        self.calls += 1
        if self.wait_for is not None:
            self.wait_for.wait(timeout=1)
        return self.rows


class SequencedSource:
    def __init__(self, refresh_gate: threading.Event):
        self.refresh_gate = refresh_gate
        self.calls = 0

    def __call__(self, _limit: int) -> list[dict]:
        self.calls += 1
        if self.calls == 1:
            return [_item("initial", "缓存快讯")]
        self.refresh_gate.wait(timeout=1)
        return [_item("refreshed", "刷新快讯")]


class FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"result": {"data": {"feed": {"list": []}}}}


class FakeSession:
    def __init__(self):
        self.timeouts: list[float] = []

    def get(self, _url, **kwargs):
        self.timeouts.append(kwargs["timeout"])
        return FakeResponse()


class OpportunityNewsLatencyTests(unittest.TestCase):
    def setUp(self):
        with news._FLASH_LOCK:
            news._FLASH_CACHE.clear()
            self.assertFalse(news._FLASH_FLIGHTS)

    def tearDown(self):
        deadline = time.monotonic() + 1
        while news._FLASH_FLIGHTS and time.monotonic() < deadline:
            time.sleep(0.01)
        with news._FLASH_LOCK:
            news._FLASH_CACHE.clear()

    def test_base_route_never_enters_llm_enrichment(self):
        source = FakeSource([_item("base", "基础快讯")])
        with (
            patch.object(news, "_FLASH_SOURCES", [{"name": "新浪财经", "fetch": source}]),
            patch.object(events, "_extract_llm", side_effect=AssertionError("LLM path")) as enrich,
        ):
            result = news.fetch_flash(limit=12)

        self.assertEqual(result["items"][0]["id"], "base")
        self.assertEqual(result["tier"], "base")
        enrich.assert_not_called()

    def test_enrichment_remains_an_explicit_route_capability(self):
        full = {"items": [], "tier": "full", "sources": [], "as_of": "", "complete": True}
        with (
            patch.object(events.news, "fetch_flash", return_value=full) as fetch,
            patch.object(events, "extract_events", return_value=[]),
            patch.object(events, "_holdings_codes", return_value=[]),
        ):
            result = events.enriched_flash(limit=12, personal=True)

        self.assertEqual(result["tier"], "full")
        fetch.assert_called_once_with(limit=12, include_slow=True)

    def test_cold_base_flash_returns_completed_source_before_slow_source(self):
        release_slow = threading.Event()
        fast = FakeSource([_item("fast", "快速来源")])
        slow = FakeSource([_item("slow", "慢来源")], release_slow)
        sources = [
            {"name": "新浪财经", "fetch": fast},
            {"name": "财联社", "fetch": slow},
        ]
        started = time.monotonic()
        try:
            with (
                patch.object(news, "_FLASH_SOURCES", sources),
                patch.object(news.settings, "flash_first_paint_deadline", 0.05),
            ):
                result = news.fetch_flash(limit=12)
        finally:
            release_slow.set()

        self.assertLess(time.monotonic() - started, 0.3)
        self.assertEqual([item["id"] for item in result["items"]], ["fast"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["tier"], "base")

    def test_stale_cache_returns_immediately_and_refresh_is_single_flight(self):
        clock = FakeClock()
        refresh_gate = threading.Event()
        source = SequencedSource(refresh_gate)
        sources = [{"name": "新浪财经", "fetch": source}]
        with (
            patch.object(news, "_FLASH_SOURCES", sources),
            patch.object(news, "_FLASH_CLOCK", clock),
            patch.object(news.settings, "flash_first_paint_deadline", 0.05),
            patch.object(news.settings, "flash_cache_ttl", 10),
            patch.object(news.settings, "flash_stale_ttl", 100),
        ):
            first = news.fetch_flash(limit=12)
            clock.advance(11)
            started = time.monotonic()
            with ThreadPoolExecutor(max_workers=6) as executor:
                results = list(executor.map(lambda _: news.fetch_flash(limit=12), range(6)))
            elapsed = time.monotonic() - started
            refresh_gate.set()
            deadline = time.monotonic() + 1
            while news._FLASH_FLIGHTS and time.monotonic() < deadline:
                time.sleep(0.01)

        self.assertEqual(first["items"][0]["id"], "initial")
        self.assertLess(elapsed, 0.3)
        self.assertTrue(all(result["stale"] for result in results))
        self.assertTrue(all(result["items"][0]["id"] == "initial" for result in results))
        self.assertEqual(source.calls, 2)

    def test_source_http_timeout_comes_from_configured_budget(self):
        session = FakeSession()
        with (
            patch.object(news.requests, "get", session.get),
            patch.object(news.settings, "flash_source_timeout", 0.25),
        ):
            self.assertEqual(news._sina_flash(5), [])

        self.assertEqual(session.timeouts, [0.25])


if __name__ == "__main__":
    unittest.main()
