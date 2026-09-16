# -*- coding: utf-8 -*-
"""market-watch 持仓计划内部规则接口认证契约。"""

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

os.environ["MW_SCHEDULE_ENABLED"] = "false"

from market_watch.app import app
from market_watch.config import settings
from market_watch.store import JsonStore


class PositionRiskRuleApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))
        self.old_token = settings.position_risk_token
        settings.position_risk_token = "position-risk-test-token"
        self.patch = patch("market_watch.app.store", self.store)
        self.patch.start()
        self.client = TestClient(app)
        self.payload = {
            "id": "position-risk:600519:take_profit",
            "ticker": "600519",
            "kind": "take_profit",
            "operator": ">=",
            "target_price": 1800,
            "config_scope": "global",
            "config_version": 1,
            "generation": 1,
            "effective_at": None,
            "expires_at": None,
        }

    def tearDown(self):
        self.client.close()
        self.patch.stop()
        settings.position_risk_token = self.old_token
        self.temporary.cleanup()

    def test_upsert_and_delete_require_shared_token(self):
        path = "/internal/position-risk-rules/600519/take_profit"
        self.assertEqual(self.client.put(path, json=self.payload).status_code, 403)
        saved = self.client.put(
            path, json=self.payload,
            headers={"X-Position-Risk-Token": "position-risk-test-token"},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertIn(self.payload["id"], self.store.all("position_risk_rules"))
        removed = self.client.delete(
            f"/internal/position-risk-rules/{self.payload['id']}",
            headers={"X-Position-Risk-Token": "position-risk-test-token"},
        )
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertTrue(removed.json()["removed"])


if __name__ == "__main__":
    unittest.main()
