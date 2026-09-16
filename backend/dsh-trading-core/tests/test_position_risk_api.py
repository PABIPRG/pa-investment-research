# -*- coding: utf-8 -*-
"""持仓止盈止损 FastAPI 边界与内部认证契约。"""

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

os.environ["ADAPTER_RUNNER"] = "fake"

from adapter.app import create_app
from adapter.config import settings
from adapter.store import JsonStore


class FakeRulePort:
    def __init__(self):
        self.upserts = []
        self.disabled = []

    def upsert(self, rule):
        self.upserts.append(rule)

    def disable(self, rule_id):
        self.disabled.append(rule_id)


class PositionRiskApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100, "cost_price": 10}])
        self.port = FakeRulePort()
        self.old_token = settings.position_risk_token
        settings.position_risk_token = "position-risk-test-token"
        self.store_patch = patch("adapter.app.JsonStore", return_value=self.store)
        self.store_patch.start()
        self.client = TestClient(create_app(position_risk_rule_port=self.port))

    def tearDown(self):
        self.client.close()
        self.store_patch.stop()
        settings.position_risk_token = self.old_token
        self.temporary.cleanup()

    def test_global_save_and_effective_read(self):
        suggestion = self.client.get("/position-risk/config/global").json()["suggestion"]
        self.assertIsNone(suggestion)
        response = self.client.put("/position-risk/config/global", json={
            "take_profit": {"enabled": True, "mode": "percent", "value": 0.2},
            "stop_loss": {"enabled": True, "mode": "percent", "value": 0.1},
            "confirmed": True,
        })
        self.assertEqual(response.status_code, 200)
        result = self.client.get("/position-risk/effective").json()
        self.assertEqual(result["items"][0]["targets"]["take_profit"]["resolved_price"], 12)
        self.assertEqual(result["items"][0]["source"], "global")

    def test_price_hit_requires_shared_internal_token(self):
        self.client.put("/position-risk/config/global", json={
            "take_profit": {"enabled": True, "mode": "percent", "value": 0.2},
            "stop_loss": {"enabled": True, "mode": "percent", "value": 0.1},
            "confirmed": True,
        })
        rule = next(item for item in self.port.upserts if item["kind"] == "take_profit")
        payload = {
            "event_id": "position-risk-hit:1234", "ticker": "600519", "kind": "take_profit",
            "rule_id": rule["id"], "config_scope": rule["config_scope"],
            "config_version": rule["config_version"], "generation": rule["generation"],
            "price": 12.1, "observed_at": "2026-09-15T10:00:00+08:00",
            "quote_source": "fixture", "freshness": "fresh",
        }
        denied = self.client.post("/internal/position-risk/price-hits", json=payload)
        self.assertEqual(denied.status_code, 403, denied.text)
        accepted = self.client.post(
            "/internal/position-risk/price-hits",
            json=payload,
            headers={"X-Position-Risk-Token": "position-risk-test-token"},
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertTrue(accepted.json()["accepted"])


if __name__ == "__main__":
    unittest.main()
