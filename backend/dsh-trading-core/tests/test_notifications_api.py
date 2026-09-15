# -*- coding: utf-8 -*-
"""统一通知中心 HTTP 契约测试。"""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")
os.environ.setdefault("SHADOW_SCHEDULE_ENABLED", "false")
os.environ.setdefault("CLOSED_LOOP_ENABLED", "false")

from fastapi.testclient import TestClient

from adapter.app import create_app
from adapter.notifications.repository import NotificationRepository
from adapter.notifications.service import NotificationService


class NotificationApiTests(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.service = NotificationService(
            NotificationRepository(root / "notifications.sqlite3"),
            now=lambda: datetime(2026, 9, 15, 10, 0, tzinfo=timezone.utc),
            channel_defaults={"market_risk": {"browser": True}},
        )
        self.client = TestClient(
            create_app(notification_service=self.service, notification_internal_token="internal-secret")
        )
        self.client.headers.update({"X-Notification-Token": "internal-secret"})

    def _event(self, event_id: str = "api-event-1") -> dict:
        return {
            "eventId": event_id,
            "schemaVersion": 1,
            "type": "market.price_alert.triggered.v1",
            "producer": "market-watch",
            "occurredAt": "2026-09-15T10:00:00+00:00",
            "subject": {"kind": "security", "id": "600519"},
            "payload": {
                "securityName": "贵州茅台",
                "ruleName": "跌幅预警",
                "condition": "日内跌幅达到 3%",
            },
        }

    def test_internal_publish_requires_exact_token(self):
        self.assertEqual(
            self.client.post(
                "/internal/notification-events", json=self._event(),
                headers={"X-Notification-Token": ""},
            ).status_code,
            401,
        )
        response = self.client.post(
            "/internal/notification-events",
            json=self._event(),
            headers={"X-Notification-Token": "internal-secret"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "贵州茅台触发跌幅预警")

    def test_list_read_archive_preferences_and_retry_contracts(self):
        self.assertEqual(
            self.client.get("/notifications", headers={"X-Notification-Token": ""}).status_code,
            401,
        )
        created = self.client.post(
            "/internal/notification-events",
            json=self._event(),
            headers={"X-Notification-Token": "internal-secret"},
        ).json()
        notification_id = created["id"]

        listing = self.client.get("/notifications", params={"view": "unread"})
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["unreadCount"], 1)
        self.assertEqual(
            self.client.patch(f"/notifications/{notification_id}/read", json={"read": True}).json()["readAt"],
            "2026-09-15T10:00:00+00:00",
        )
        self.assertEqual(
            self.client.patch(f"/notifications/{notification_id}/archive", json={"archived": True}).json()["id"],
            notification_id,
        )
        preference = self.client.put(
            "/notifications/preferences",
            json={"category": "market_risk", "channel": "browser", "enabled": False},
        )
        self.assertEqual(preference.status_code, 200)
        self.assertFalse(next(
            item["enabled"] for item in preference.json()["items"]
            if item["category"] == "market_risk" and item["channel"] == "browser"
        ))

    def test_browser_subscription_is_validated_and_can_be_deactivated(self):
        invalid = self.client.post(
            "/notifications/subscriptions",
            json={"channel": "browser", "deviceId": "browser-1", "subscription": {"endpoint": "http://plain.test"}},
        )
        self.assertEqual(invalid.status_code, 422)

        saved = self.client.post(
            "/notifications/subscriptions",
            json={
                "channel": "browser",
                "deviceId": "browser-1",
                "subscription": {
                    "endpoint": "https://push.example.test/id",
                    "keys": {"p256dh": "public", "auth": "auth"},
                },
            },
        )
        self.assertEqual(saved.status_code, 200)
        self.assertTrue(saved.json()["active"])
        removed = self.client.delete("/notifications/subscriptions/browser/browser-1")
        self.assertEqual(removed.status_code, 200)
        self.assertFalse(removed.json()["active"])

    def test_native_delivery_claim_and_ack_are_internal_and_lease_guarded(self):
        created = self.client.post(
            "/internal/notification-events",
            json=self._event("native-event"),
            headers={"X-Notification-Token": "internal-secret"},
        ).json()
        # This test service only enables browser by default, so enable macOS for a future event.
        self.client.put(
            "/notifications/preferences",
            json={"category": "market_risk", "channel": "macos", "enabled": True},
        )
        self.client.post(
            "/internal/notification-events",
            json=self._event("native-event-2") | {"occurredAt": "2026-09-15T11:00:00+00:00"},
            headers={"X-Notification-Token": "internal-secret"},
        )
        self.assertEqual(
            self.client.post(
                "/internal/notification-deliveries/claim",
                json={"channel": "macos"},
                headers={"X-Notification-Token": ""},
            ).status_code,
            401,
        )
        claim = self.client.post(
            "/internal/notification-deliveries/claim",
            json={"channel": "macos", "limit": 10},
            headers={"X-Notification-Token": "internal-secret"},
        ).json()["items"]
        self.assertEqual(len(claim), 1)
        job = claim[0]
        ack = self.client.post(
            f"/internal/notification-deliveries/{job['id']}/ack",
            json={"leaseToken": job["leaseToken"]},
            headers={"X-Notification-Token": "internal-secret"},
        )
        self.assertEqual(ack.status_code, 200)
        self.assertEqual(ack.json()["status"], "sent")
        self.assertEqual(created["id"], self.service.list_notifications()["items"][-1]["id"])


if __name__ == "__main__":
    unittest.main()
