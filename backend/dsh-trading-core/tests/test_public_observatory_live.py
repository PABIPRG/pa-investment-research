"""公开观察室直读持仓与估算历史的回归用例。"""

import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.testclient import TestClient

from adapter.portfolio_performance import record_holdings_snapshot
from adapter.public_observatory import _quote_prices, public_live, public_history, public_activities, register_public_observatory_routes
from adapter.store import JsonStore


SHANGHAI = ZoneInfo("Asia/Shanghai")


class PublicLiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonStore(Path(self.tmp.name))
        self.store.set("holdings", "default", [
            {"ticker": "600519", "quantity": 2, "cost_price": 100, "private_note": "secret"},
            {"ticker": "000001", "quantity": 3, "cost_price": 10},
        ])
        self.quotes = lambda codes: {"600519": {"name": "甲", "price": 120, "private_token": "secret"}}

    def test_current_holdings_without_account_snapshot_and_partial_quotes(self):
        with patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS": "[]"}):
            before = self.store.all("holdings")
            result = public_live(self.store, "2026-09-29", today=date(2026, 9, 29), quote_loader=self.quotes)
        self.assertEqual(result["availability"], "available")
        self.assertEqual(result["summary"]["holdings_cost"], "230.00")
        self.assertIsNone(result["summary"]["market_value"])
        self.assertEqual(result["items"][0]["market_value"], None)
        self.assertEqual(result["items"][1]["market_value"], "240.00")
        self.assertNotIn("secret", str(result))
        self.assertEqual(self.store.all("holdings"), before)

    def test_complete_prices_keep_total_equal_to_details(self):
        result = public_live(self.store, "2026-09-29", today=date(2026, 9, 29), quote_loader=lambda codes: {
            "600519": {"price": 120}, "000001": {"price": 12},
        })
        self.assertEqual(result["summary"]["market_value"], "276.00")
        self.assertEqual(result["summary"]["floating_profit_loss"], "46.00")
        self.assertEqual(result["summary"]["cost_return"], "0.20000000")
        self.assertEqual(sum(float(row["market_value"]) for row in result["items"]), 276)
        self.assertIsNone(result["summary"]["cash"])
        self.assertIsNone(result["summary"]["total_equity"])

    def test_current_quotes_use_existing_bounded_batch_api(self):
        response = Mock()
        response.json.return_value = {"items": [
            {"code": "600519", "name": "甲", "price": 120},
            {"code": "999999", "name": "非请求证券", "price": 1},
        ]}
        session = Mock()
        session.post.return_value = response
        with patch("requests.Session", return_value=session), patch("adapter.config.settings.mw_url", "http://127.0.0.1:8100"):
            prices = _quote_prices(["600519"])
        session.post.assert_called_once_with(
            "http://127.0.0.1:8100/quotes/batch", json={"codes": ["600519"]}, timeout=2,
        )
        self.assertFalse(session.trust_env)
        session.close.assert_called_once()
        self.assertEqual(prices, {"600519": {"code": "600519", "name": "甲", "price": 120}})

    def test_historical_date_never_uses_current_positions(self):
        record_holdings_snapshot(self.store, [{"ticker": "600519", "quantity": 1, "cost_price": 90}], "manual", datetime(2026, 9, 27, 10, tzinfo=SHANGHAI))
        result = public_live(self.store, "2026-09-27", today=date(2026, 9, 29), price_loader=lambda *_: [{"date": "2026-09-27", "close": 100}])
        self.assertEqual(result["items"][0]["quantity"], "1")
        self.assertEqual(len(result["items"]), 1)
        between = public_live(self.store, "2026-09-28", today=date(2026, 9, 29), price_loader=lambda *_: [])
        self.assertEqual(between["holdings_as_of"], "2026-09-27")
        self.assertEqual(between["items"][0]["quantity"], "1")
        self.assertIsNone(between["items"][0]["market_value"])
        self.assertEqual(public_live(self.store, "2026-09-26", today=date(2026, 9, 29))["availability"], "unavailable")

    def test_history_adjusts_for_position_flows_and_does_not_write_seed(self):
        record_holdings_snapshot(self.store, [{"ticker": "600519", "quantity": 1, "cost_price": 100}], "manual", datetime(2026, 9, 27, 10, tzinfo=SHANGHAI))
        record_holdings_snapshot(self.store, [{"ticker": "600519", "quantity": 2, "cost_price": 100}], "manual", datetime(2026, 9, 28, 10, tzinfo=SHANGHAI))
        before = self.store.all("holdings")
        result = public_history(self.store, "2026-09-27", "2026-09-28", lambda *_: [
            {"date": "2026-09-27", "close": 100}, {"date": "2026-09-28", "close": 100},
        ])
        self.assertEqual(result["points"][-1]["profit_loss"], "0.00")
        self.assertEqual(self.store.all("holdings"), before)

    def test_research_activity_projects_only_fixed_safe_fields_and_revokes(self):
        self.store.set("reports", "a" * 32, {
            "task_type": "stock", "created_at": "2026-09-29T10:00:00+08:00",
            "title": "PRIVATE ACCOUNT", "subject": "PRIVATE ACCOUNT", "reports": {"body": "SECRET"},
            "params": {"token": "SECRET"},
        })
        with patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE": "2026-09-23T00:00:00+08:00"}):
            rows = public_activities(self.store, "2026-09-29", category="research")["items"]
            self.assertEqual(len(rows), 1)
            self.assertNotIn("PRIVATE", str(rows))
            self.assertNotIn("SECRET", str(rows))
        with patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE": ""}):
            self.assertEqual(public_activities(self.store, "2026-09-29", category="research")["items"], [])

    def test_public_get_uses_strict_projection_and_never_writes_business_data(self):
        app = FastAPI()
        register_public_observatory_routes(app, store_factory=lambda: self.store, price_loader=lambda *_: [],
                                           quote_loader=lambda _: {"600519": {"price": 120, "secret": "DO_NOT_PUBLISH"}})
        before = self.store.all("holdings")
        response = TestClient(app).get("/public/performance/v1/live?date=2026-09-29")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("DO_NOT_PUBLISH", response.text)
        self.assertEqual(self.store.all("holdings"), before)
        self.assertEqual(TestClient(app).post("/public/performance/v1/live?date=2026-09-29").status_code, 405)


if __name__ == "__main__":
    unittest.main()
