"""同批 T+1 数据的日期、金额、读取次数及公开边界。"""
import json
import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.testclient import TestClient
from adapter import public_observatory as public
from adapter.portfolio_performance import record_holdings_snapshot
from adapter.store import JsonStore


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonStore(Path(self.tmp.name))
        record_holdings_snapshot(self.store, [{"ticker": "600519", "quantity": 2, "cost_price": 10}], "manual", datetime(2026, 9, 25, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.calls = []
        self.days = ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-09", "2026-10-12"]
        self.calendar = patch("adapter.brief_engine.cached_trade_dates", return_value=self.days)
        self.calendar.start()
        self.addCleanup(self.calendar.stop)
        self.env = patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE": "", "DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE": "", "DSH_PUBLIC_OBSERVATORY_SYSTEM_ACTIVITY_IDS": "[]"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def prices(self, ticker, start, end):
        self.calls.append((ticker, start, end))
        # 有曲线端点但无当日报价的 9/29，以及有伪报价的休市日均不能播放。
        return [{"date": day, "close": 10 + i, "secret": "PRIVATE"} for i, day in enumerate(["2026-09-25", "2026-09-27", "2026-09-28", "2026-09-30", "2026-10-01", "2026-10-09"])]

    def bundle(self, start="2026-09-25", end="2026-10-09"):
        return public.public_bundle(self.store, start, end, self.prices, today=date(2026, 10, 10))

    def test_one_range_read_per_security_and_consistent_dates_and_values(self):
        before = self.store.all("holdings")
        result = self.bundle()
        self.assertEqual(result["available_dates"], ["2026-09-25", "2026-09-28", "2026-09-30", "2026-10-09"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual([p["date"] for p in result["history"]["points"]], result["available_dates"])
        self.assertEqual([f["date"] for f in result["frames"]], result["available_dates"])
        self.assertEqual([p["date"] for c in result["calendars"] for p in c["items"]], result["available_dates"])
        for point, frame in zip(result["history"]["points"], result["frames"]):
            self.assertEqual(point["value"], frame["summary"]["market_value"])
        self.assertEqual(self.store.all("holdings"), before)
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(result["data_version"], self.bundle()["data_version"])

    def test_missing_exact_price_is_excluded_even_if_history_carries_forward(self):
        self.assertEqual(self.bundle(end="2026-09-29")["available_dates"], ["2026-09-25", "2026-09-28"])

    def test_unknown_calendar_uses_exact_quotes_but_not_synthetic_endpoints(self):
        with patch("adapter.brief_engine.cached_trade_dates", return_value=[]):
            result = self.bundle(end="2026-09-29")
        self.assertEqual(result["available_dates"], ["2026-09-25", "2026-09-28"])

    def test_calendar_does_not_label_multi_day_change_as_daily_profit(self):
        result = self.bundle()
        items = {item["date"]: item for month in result["calendars"] for item in month["items"]}
        self.assertIsNone(items["2026-09-30"]["daily_profit_loss"])
        self.assertEqual(items["2026-09-28"]["daily_profit_loss"], "4.00")

    def test_names_are_batched_and_current_quotes_never_change_historical_values(self):
        calls = []
        def quotes(tickers):
            calls.append(tickers)
            return {"600519": {"name": "证券名称", "price": 99999, "private": "PRIVATE"}}
        result = public.public_bundle(self.store, "2026-09-25", "2026-10-09", self.prices, today=date(2026, 10, 10), quote_loader=quotes)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["frames"][0]["items"][0]["name"], "证券名称")
        self.assertEqual(result["frames"][0]["summary"]["market_value"], "20.00")
        self.assertNotIn("PRIVATE", str(result))

    def test_bounds_and_t1(self):
        for start, end in [("2026-09-25", "2026-10-10"), ("2026-01-01", "2026-10-09"), ("2026-10-09", "2026-09-25")]:
            with self.assertRaises(ValueError):
                self.bundle(start, end)

    def test_empty_window_and_activity_failure_are_explicit(self):
        result = self.bundle("2026-09-01", "2026-09-02")
        self.assertEqual(result["available_dates"], [])
        with patch.object(public, "_bundle_activities", side_effect=RuntimeError("PRIVATE")):
            result = self.bundle()
        self.assertEqual(result["activities_status"], "error")
        self.assertTrue(result["frames"])
        self.assertNotIn("PRIVATE", str(result))

    def test_research_is_safe_bounded_and_t1_cutoff(self):
        for i, day in enumerate(["2026-09-28", "2026-10-09", "2026-10-10"]):
            self.store.set("reports", f"{i:032x}", {"task_type": "stock", "created_at": day + "T10:00:00+08:00", "title": "PRIVATE", "reports": {"body": "PRIVATE"}})
        with patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE": "2026-09-01T00:00:00+08:00"}):
            result = self.bundle()
            self.assertEqual(len(result["activities"]), 2)
            self.assertNotIn("PRIVATE", str(result))
            with patch.object(public, "MAX_BUNDLE_ACTIVITIES", 1):
                result = self.bundle()
            self.assertEqual(result["activities_status"], "truncated")
            self.assertEqual(len(result["activities"]), 1)

    def test_http_rejects_invalid_ranges_and_oversized_results(self):
        app = FastAPI()
        public.register_public_observatory_routes(app, store_factory=lambda: self.store, price_loader=self.prices, quote_loader=lambda _: {})
        client = TestClient(app)
        with patch.object(public, "MAX_BUNDLE_BYTES", 32):
            result = client.get("/public/performance/v1/bundle?from=2026-09-25&to=2026-09-30")
        self.assertEqual(result.status_code, 503)
        self.assertNotIn("600519", result.text)
        self.assertEqual(client.get("/public/performance/v1/bundle?from=2026-01-01&to=2026-09-30").status_code, 422)
        self.assertEqual(client.get("/public/performance/v1/bundle?from=2026-09-25&to=2026-09-30&extra=1").status_code, 422)


if __name__ == "__main__":
    unittest.main()
