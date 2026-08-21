import asyncio
import os
import unittest


os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from adapter.app import create_app


class HealthContractTests(unittest.TestCase):
    def test_health_identifies_trading_core_and_exposes_runner_keys(self):
        app = create_app()
        health = next(route.endpoint for route in app.routes if route.path == "/health")

        payload = asyncio.run(health())

        self.assertEqual(payload.get("service"), "trading-core")
        self.assertEqual(payload["status"], "ok")
        for key in ("stock", "holdings", "brief"):
            self.assertIn(key, payload["runners"])
