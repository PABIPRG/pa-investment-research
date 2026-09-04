import os
import unittest
from unittest.mock import patch


os.environ["MW_SCHEDULE_ENABLED"] = "false"

from market_watch import news, quotes, scheduler
from market_watch.app import _shutdown, health


class HealthContractTests(unittest.TestCase):
    def test_health_identifies_market_watch(self):
        payload = health()

        self.assertEqual(payload["service"], "market-watch")
        self.assertTrue(payload["ok"])

    def test_shutdown_stops_scheduler_and_joins_background_workers(self):
        with (
            patch.object(scheduler, "stop_scheduler") as stop_scheduler,
            patch.object(news, "shutdown_background_workers") as stop_news,
            patch.object(quotes, "shutdown_background_workers") as stop_quotes,
        ):
            _shutdown()

        stop_scheduler.assert_called_once_with()
        stop_news.assert_called_once_with()
        stop_quotes.assert_called_once_with()

    def test_disabled_scheduler_starts_and_stops_cleanly(self):
        scheduler.stop_scheduler()
        with patch.object(scheduler.settings, "schedule_enabled", False):
            instance = scheduler.start_scheduler()
            self.assertFalse(instance.running)
            scheduler.stop_scheduler()
        self.assertIsNone(scheduler._scheduler)
