# -*- coding: utf-8 -*-
"""影子净值查询不能把组合净值冒充成单策略证据。"""

import asyncio
import os
import unittest
from unittest.mock import patch


os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from adapter.app import create_app


class _ShadowStore:
    snapshots = {
        "2026-08-26": {
            "overall_nav": 1.08,
            "strategies": {"strategy-a": {"nav": 1.03}},
        },
        "2026-08-25": {
            "overall_nav": 1.05,
            "strategies": {"strategy-b": {"nav": 0.98}},
        },
    }

    def all(self, name):
        return self.snapshots if name == "shadow_equity" else {}

    def get(self, name, key):
        return self.snapshots.get(key) if name == "shadow_equity" else None


class ShadowEquityRouteTests(unittest.TestCase):
    def test_strategy_filter_omits_dates_without_that_strategy(self):
        with patch("adapter.app.JsonStore", return_value=_ShadowStore()):
            app = create_app()
            endpoint = next(route.endpoint for route in app.routes if route.path == "/shadow/equity")
            payload = asyncio.run(endpoint(strategy_id="strategy-a", limit=30))

        self.assertEqual(payload, {
            "count": 1,
            "items": [{"date": "2026-08-26", "strategy": {"nav": 1.03}}],
        })
        self.assertNotIn("overall_nav", payload["items"][0])

    def test_unfiltered_history_keeps_portfolio_nav(self):
        with patch("adapter.app.JsonStore", return_value=_ShadowStore()):
            app = create_app()
            endpoint = next(route.endpoint for route in app.routes if route.path == "/shadow/equity")
            payload = asyncio.run(endpoint(strategy_id=None, limit=30))

        self.assertEqual([item["overall_nav"] for item in payload["items"]], [1.08, 1.05])

    def test_legacy_history_keeps_snapshot_evidence_without_fabricated_task_or_report(self):
        with patch("adapter.app.JsonStore", return_value=_ShadowStore()):
            app = create_app()
            endpoint = next(route.endpoint for route in app.routes if route.path == "/shadow/history")
            payload = asyncio.run(endpoint(strategy_id="strategy-a", limit=30))

        self.assertEqual(payload["count"], 1)
        row = payload["items"][0]
        self.assertTrue(row["legacy"])
        self.assertIsNone(row["task_id"])
        self.assertEqual(row["date"], "2026-08-26")
        self.assertEqual(row["nav"], 1.03)
        self.assertNotIn("report_id", row)


if __name__ == "__main__":
    unittest.main()
