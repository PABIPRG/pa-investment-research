import logging
import os
import unittest
import warnings
from datetime import datetime
from unittest.mock import patch

import pandas as pd


os.environ["MW_SCHEDULE_ENABLED"] = "false"

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient
    from market_watch import briefs
    from market_watch.app import app

client = TestClient(app)
logging.getLogger("httpx").setLevel(logging.WARNING)


class IndicesReliabilityTests(unittest.TestCase):
    def setUp(self):
        cache = getattr(briefs, "_INDICES_CACHE", None)
        if cache is not None:
            cache.clear()

    @patch("akshare.stock_zh_index_spot_sina")
    def test_http_response_normalizes_non_finite_values_without_dropping_indices(
        self, index_spot,
    ):
        index_spot.return_value = pd.DataFrame([
            {"代码": "sh000001", "名称": "上证指数", "最新价": float("nan"), "涨跌幅": 0.8},
            {"代码": "sz399001", "名称": "深证成指", "最新价": float("inf"), "涨跌幅": float("-inf")},
            {"代码": "sz399006", "名称": "创业板指", "最新价": 2150.25, "涨跌幅": -0.4},
            {"代码": "sh999999", "名称": "非主指数", "最新价": 1.0, "涨跌幅": 2.0},
        ])

        response = client.get("/indices")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        items = {item["code"]: item for item in payload["items"]}
        self.assertEqual(set(items), {"sh000001", "sz399001", "sz399006"})
        self.assertIsNone(items["sh000001"]["price"])
        self.assertEqual(items["sh000001"]["pct_change"], 0.8)
        self.assertIsNone(items["sz399001"]["price"])
        self.assertIsNone(items["sz399001"]["pct_change"])
        self.assertEqual(items["sz399006"]["price"], 2150.25)
        self.assertFalse(payload["stale"])
        self.assertTrue(payload["warnings"])

    @patch("akshare.stock_zh_index_spot_sina")
    def test_source_failure_returns_only_qualified_cache_with_original_fact_time(
        self, index_spot,
    ):
        index_spot.side_effect = [
            pd.DataFrame([
                {"代码": "sh000001", "名称": "上证指数", "最新价": 3210.5, "涨跌幅": 0.8},
                {"代码": "sz399001", "名称": "深证成指", "最新价": float("nan"), "涨跌幅": float("inf")},
                {"代码": "sz399006", "名称": "创业板指", "最新价": 2150.25, "涨跌幅": float("-inf")},
            ]),
            RuntimeError("source unavailable"),
        ]
        first_time = datetime(2026, 8, 31, 10, 0, 0)
        second_time = datetime(2026, 8, 31, 10, 1, 0)
        with patch.object(briefs, "datetime") as clock:
            clock.now.side_effect = [first_time, second_time]

            first = client.get("/indices").json()
            second_response = client.get("/indices")

        self.assertEqual(second_response.status_code, 200)
        second = second_response.json()
        self.assertEqual(second["as_of"], "2026-08-31 10:01:00")
        self.assertEqual(
            {item["code"] for item in second["items"]},
            {"sh000001", "sz399006"},
        )
        first_as_of = {item["code"]: item["as_of"] for item in first["items"]}
        for item in second["items"]:
            self.assertTrue(item["stale"])
            self.assertEqual(item["as_of"], first_as_of[item["code"]])
        self.assertTrue(second["stale"])
        self.assertTrue(second["warnings"])

    @patch("akshare.stock_zh_index_spot_sina")
    def test_partial_refresh_falls_back_per_code_without_rewriting_cached_time(
        self, index_spot,
    ):
        index_spot.side_effect = [
            pd.DataFrame([
                {"代码": "sh000001", "名称": "上证指数", "最新价": 3210.5, "涨跌幅": 0.8},
                {"代码": "sz399001", "名称": "深证成指", "最新价": 10500.0, "涨跌幅": 0.5},
            ]),
            pd.DataFrame([
                {"代码": "sh000001", "名称": "上证指数", "最新价": 3220.0, "涨跌幅": 1.0},
            ]),
        ]
        with patch.object(briefs, "datetime") as clock:
            clock.now.side_effect = [
                datetime(2026, 8, 31, 10, 0, 0),
                datetime(2026, 8, 31, 10, 1, 0),
            ]

            client.get("/indices")
            response = client.get("/indices")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        items = {item["code"]: item for item in payload["items"]}
        self.assertEqual(items["sh000001"]["as_of"], "2026-08-31 10:01:00")
        self.assertFalse(items["sh000001"]["stale"])
        self.assertEqual(items["sz399001"]["as_of"], "2026-08-31 10:00:00")
        self.assertTrue(items["sz399001"]["stale"])
        self.assertTrue(payload["stale"])

    @patch("akshare.stock_zh_index_spot_sina")
    def test_expired_cache_is_not_returned_after_source_failure(self, index_spot):
        index_spot.side_effect = [
            pd.DataFrame([
                {"代码": "sh000001", "名称": "上证指数", "最新价": 3210.5, "涨跌幅": 0.8},
            ]),
            RuntimeError("source unavailable"),
        ]

        with patch.object(briefs.settings, "indices_stale_ttl", -1, create=True):
            client.get("/indices")
            response = client.get("/indices")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["items"], [])
        self.assertFalse(response.json()["stale"])
        self.assertTrue(response.json()["warnings"])

    def test_indices_spot_reuses_normalized_snapshot_items(self):
        items = [{
            "code": "sh000001", "name": "上证指数", "price": 3210.5,
            "pct_change": 0.8, "as_of": "2026-08-31 10:00:00", "stale": False,
        }]
        with patch.object(briefs, "indices_snapshot", return_value={"items": items}):
            self.assertEqual(briefs.indices_spot(), items)

    def test_fallback_brief_renders_missing_normalized_numbers_as_placeholders(self):
        text = briefs._fallback_brief(
            "pre",
            [{
                "code": "sh000001", "name": "上证指数", "price": None,
                "pct_change": None, "as_of": "2026-08-31 10:00:00", "stale": False,
            }],
            [],
            [],
            [],
        )

        self.assertIn("- 上证指数 --（--）", text)


if __name__ == "__main__":
    unittest.main()
