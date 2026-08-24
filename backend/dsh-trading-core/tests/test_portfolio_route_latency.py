# -*- coding: utf-8 -*-
"""非聊天持仓页的风险读取延迟、缓存与并发复用回归。"""

import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import requests

from adapter import risk_engine, strategies
from adapter.config import settings
from adapter.store import JsonStore


HEALTHY_EVENT_STATUS = {
    "degraded": False,
    "stale": False,
    "source": "fresh-cache",
    "reason": None,
    "age_seconds": 0.0,
    "deadline_seconds": 0.05,
}


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


def _seed_holdings(store: JsonStore, tickers=("600519", "000001")) -> None:
    store.set(
        "holdings",
        "default",
        [{"ticker": ticker, "quantity": 100, "cost_price": 10} for ticker in tickers],
    )


class _Response:
    def __init__(self, items):
        self.items = items

    def raise_for_status(self):
        return None

    def json(self):
        return {"items": self.items}


class PortfolioRouteLatencyTests(unittest.TestCase):
    def setUp(self):
        risk_engine._reset_risk_cache_for_tests()
        strategies._reset_event_cache_for_tests()

    def tearDown(self):
        risk_engine._reset_risk_cache_for_tests()
        strategies._reset_event_cache_for_tests()

    def test_concurrent_portfolio_and_alerts_share_one_portfolio_computation(self):
        store = _store()
        _seed_holdings(store)
        original = risk_engine._compute_portfolio_risk
        calls = 0
        calls_lock = threading.Lock()
        barrier = threading.Barrier(2)

        def slow_compute(current_store, profile_key):
            nonlocal calls
            with calls_lock:
                calls += 1
            time.sleep(0.08)
            return original(current_store, profile_key)

        def run(call):
            barrier.wait()
            return call(store)

        with (
            patch.object(risk_engine, "_compute_portfolio_risk", side_effect=slow_compute),
            patch.object(
                strategies,
                "fetch_events_with_status",
                return_value=([], HEALTHY_EVENT_STATUS),
            ),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            portfolio = executor.submit(run, risk_engine.portfolio_risk)
            alerts = executor.submit(run, risk_engine.risk_alerts)
            portfolio_result = portfolio.result(timeout=2)
            alerts_result = alerts.result(timeout=2)

        self.assertEqual(calls, 1)
        self.assertEqual(portfolio_result["summary"]["n_positions"], 2)
        self.assertTrue(any(item["source"] == "portfolio" for item in alerts_result["items"]))

    def test_holdings_revision_invalidates_portfolio_cache_without_changing_semantics(self):
        store = _store()
        _seed_holdings(store, ("600519",))
        original = risk_engine._compute_portfolio_risk
        calls = 0

        def count_compute(current_store, profile_key):
            nonlocal calls
            calls += 1
            return original(current_store, profile_key)

        with patch.object(risk_engine, "_compute_portfolio_risk", side_effect=count_compute):
            first = risk_engine.portfolio_risk(store)
            repeated = risk_engine.portfolio_risk(store)
            _seed_holdings(store, ("600519", "000001", "300750"))
            revised = risk_engine.portfolio_risk(store)

        self.assertEqual(calls, 2)
        self.assertEqual(first, repeated)
        self.assertEqual(first["summary"]["n_positions"], 1)
        self.assertEqual(revised["summary"]["n_positions"], 3)

    def test_slow_market_watch_fails_open_within_route_budget(self):
        store = _store()
        _seed_holdings(store, ("600519",))

        def fake_slow_upstream(*_args, **kwargs):
            time.sleep(float(kwargs["timeout"]))
            raise requests.Timeout("fake slow market-watch")

        with (
            patch.object(settings, "risk_event_deadline", 0.05),
            patch.object(settings, "event_cache_ttl", 0.0),
            patch.object(strategies.requests, "get", side_effect=fake_slow_upstream),
        ):
            started = time.monotonic()
            result = risk_engine.risk_alerts(store)
            elapsed = time.monotonic() - started

        self.assertLess(elapsed, 0.30)
        self.assertTrue(result["degraded"])
        self.assertEqual(result["upstreams"]["market_watch_events"]["source"], "fail-open")
        sources = {item["source"] for item in result["items"]}
        self.assertIn("portfolio", sources)
        self.assertIn("profile", sources)

    def test_stale_events_survive_timeout_and_remain_identifiable_as_degraded(self):
        store = _store()
        _seed_holdings(store, ("600519",))
        stale_event = {
            "id": "event-risk-1",
            "direction": "利空",
            "summary": "持仓公司出现可核验利空事件",
            "tickers": [{"code": "600519", "name": "贵州茅台"}],
            "industries": [],
            "time": "2026-08-24 10:00:00",
        }
        strategies._EVENTS_CACHE["events"] = (time.time() - 2, [stale_event])

        with (
            patch.object(settings, "event_cache_ttl", 0.0),
            patch.object(settings, "event_stale_ttl", 60.0),
            patch.object(strategies.requests, "get", side_effect=requests.Timeout("slow")),
        ):
            result = risk_engine.risk_alerts(store)

        event_items = [item for item in result["items"] if item["source"] == "event"]
        self.assertEqual(len(event_items), 1)
        self.assertEqual(event_items[0]["codes"], ["600519"])
        self.assertTrue(result["degraded"])
        status = result["upstreams"]["market_watch_events"]
        self.assertTrue(status["stale"])
        self.assertEqual(status["source"], "stale-cache")

    def test_event_refresh_is_single_flight_and_concurrent_reader_does_not_wait(self):
        entered = threading.Event()
        release = threading.Event()
        calls = 0

        def slow_get(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            entered.set()
            release.wait(timeout=1)
            return _Response([])

        with (
            patch.object(settings, "event_cache_ttl", 0.0),
            patch.object(strategies.requests, "get", side_effect=slow_get),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            owner = executor.submit(strategies.fetch_events_with_status, 30, 0.5)
            self.assertTrue(entered.wait(timeout=1))
            started = time.monotonic()
            events, status = strategies.fetch_events_with_status(30, 0.5)
            elapsed = time.monotonic() - started
            release.set()
            owner.result(timeout=1)

        self.assertEqual(calls, 1)
        self.assertEqual(events, [])
        self.assertTrue(status["degraded"])
        self.assertLess(elapsed, 0.05)


if __name__ == "__main__":
    unittest.main()
