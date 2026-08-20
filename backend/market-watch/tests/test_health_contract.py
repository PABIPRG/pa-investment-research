import os
import unittest


os.environ["MW_SCHEDULE_ENABLED"] = "false"

from market_watch.app import health


class HealthContractTests(unittest.TestCase):
    def test_health_identifies_market_watch(self):
        payload = health()

        self.assertEqual(payload["service"], "market-watch")
        self.assertTrue(payload["ok"])
