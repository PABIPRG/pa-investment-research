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
from adapter.schemas import HoldingsRequest
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
                result = asyncio.run(endpoint(HoldingsRequest(holdings=[])))

            self.assertEqual(result, {"saved": 0})
            self.assertEqual(store.get("holdings", "default"), [])


if __name__ == "__main__":
    unittest.main()
