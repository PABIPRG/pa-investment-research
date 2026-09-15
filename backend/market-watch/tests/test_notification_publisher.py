# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("MW_SCHEDULE_ENABLED", "false")

from market_watch.notification_publisher import market_event_event, price_alert_event, publish_event


class NotificationPublisherTests(unittest.TestCase):
    def test_price_alert_event_is_deterministic_and_action_is_allowlisted(self):
        trigger = {
            "rule_id": "rule-1", "code": "600519", "ts": "2026-09-15T10:00:00+08:00",
            "name": "贵州茅台", "rule_name": "跌幅预警", "condition_text": "日内跌幅达到 3%",
            "price": 1400.0, "value": -3.1,
        }
        event = price_alert_event(trigger)
        self.assertEqual(event["eventId"], "price-alert:rule-1:600519:2026-09-15T10:00:00+08:00")
        self.assertEqual(event["subject"], {"kind": "security", "id": "600519"})
        self.assertNotIn("action", event)

    def test_publish_uses_internal_token_and_never_raises(self):
        response = unittest.mock.Mock()
        response.json.return_value = {"id": "notification-1"}
        with patch("market_watch.notification_publisher.settings.notification_mode", "center"), \
             patch("market_watch.notification_publisher.settings.notification_internal_token", "secret"), \
             patch("market_watch.notification_publisher.requests.post", return_value=response) as post:
            result = publish_event({"type": "market.price_alert.triggered.v1"})
        self.assertTrue(result["ok"])
        self.assertEqual(post.call_args.kwargs["headers"]["X-Notification-Token"], "secret")

        with patch("market_watch.notification_publisher.settings.notification_mode", "center"), \
             patch("market_watch.notification_publisher.settings.notification_internal_token", "secret"), \
             patch("market_watch.notification_publisher.requests.post", side_effect=OSError("offline")):
            self.assertFalse(publish_event({"type": "market.price_alert.triggered.v1"})["ok"])

    def test_market_event_uses_stable_source_event_identity(self):
        event = market_event_event({
            "id": "event-42", "code": "600519", "summary": "公司发布回购公告",
            "source": "上交所", "hit": "hold", "url": "https://example.test/42",
        })
        self.assertEqual(event["eventId"], "market-event:event-42")
        self.assertEqual(event["subject"], {"kind": "security", "id": "600519"})
        self.assertEqual(event["payload"]["sourceName"], "上交所")


if __name__ == "__main__":
    unittest.main()
