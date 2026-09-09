# -*- coding: utf-8 -*-
"""持仓整体替换接口的空列表回归测试。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError


os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from adapter import app as adapter_app
from adapter.schemas import HoldingsRequest, HoldingsSaveRequest
from adapter.store import JsonStore


class HoldingsSaveTests(unittest.TestCase):
    def test_holdings_contract_rejects_malformed_codes_and_non_positive_costs(self):
        invalid_rows = [
            {"ticker": "abc600519xyz", "quantity": 100, "cost_price": 1500},
            {"ticker": "1234567", "quantity": 100, "cost_price": 20},
            {"ticker": "000858", "quantity": 100, "cost_price": 0},
        ]

        for row in invalid_rows:
            with self.subTest(row=row), self.assertRaises(ValidationError):
                HoldingsRequest(holdings=[row])

    def test_empty_holdings_replaces_the_saved_collection(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set(
                "holdings",
                "default",
                [{"ticker": "600519", "quantity": 100, "cost_price": 1500}],
            )
            app = adapter_app.create_app()
            endpoint = next(
                route.endpoint
                for route in app.routes
                if route.path == "/holdings/save"
            )

            with patch("adapter.app.JsonStore", return_value=store):
                result = asyncio.run(endpoint(HoldingsSaveRequest(holdings=[])))

            self.assertEqual(result["saved"], 0)
            self.assertEqual(store.get("holdings", "default"), [])
            snapshots = store.get("holdings", "snapshots")
            self.assertEqual(len(snapshots), 2)
            self.assertEqual(snapshots[0]["source"], "legacy_seed")
            self.assertEqual(snapshots[1]["positions"], [])

    def test_save_records_the_frontend_source_without_changing_analysis_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            app = adapter_app.create_app()
            endpoint = next(
                route.endpoint
                for route in app.routes
                if route.path == "/holdings/save"
            )
            request = HoldingsSaveRequest(
                holdings=[
                    {"ticker": "600519", "quantity": 100, "cost_price": 1500}
                ],
                source="bulk_import",
            )

            with patch("adapter.app.JsonStore", return_value=store):
                result = asyncio.run(endpoint(request))

            self.assertEqual(result["saved"], 1)
            self.assertRegex(result["snapshot_id"], r"^[0-9a-f]{32}$")
            self.assertIn("effective_at", result)
            self.assertEqual(
                store.get("holdings", "snapshots")[0]["source"], "bulk_import"
            )

        analysis = HoldingsRequest(
            holdings=[{"ticker": "600519", "quantity": 100, "cost_price": 1500}]
        )
        self.assertNotIn("source", analysis.model_dump())


if __name__ == "__main__":
    unittest.main()
