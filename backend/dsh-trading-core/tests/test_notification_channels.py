"""应用内渠道快照的运行时与安全契约。"""
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pathlib import Path
from adapter.notifications.channel_settings import RuntimeNotificationChannels
from adapter.notifications.api import register_notification_routes
from adapter.notifications.service import NotificationService
from adapter.notifications.delivery import DeliverySuppressed
from adapter.notifications.repository import NotificationRepository
from adapter.notifications.delivery import NotificationDeliveryWorker


class RuntimeChannelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repository = NotificationRepository(Path(self.tmp.name) / "notifications.db")
        self.sent = []
        self.runtime = RuntimeNotificationChannels(self.repository, sender=lambda channel, fields, job: self.sent.append((channel, fields, job)))
        self.worker = NotificationDeliveryWorker(self.repository, self.runtime.adapters(), ready=lambda: self.runtime.ready)

    def snapshot(self, revision="one", key="SCTsecret-one", enabled=True):
        return {"serverchan": {"revision": revision, "enabled": enabled, "fields": {"sendkey": key}}}

    def test_dynamic_change_does_not_retarget_old_jobs_and_test_is_idempotent(self):
        self.runtime.apply(self.snapshot())
        first = self.runtime.test("serverchan", "request-one", "one")
        self.assertEqual(first["id"], self.runtime.test("serverchan", "request-one", "one")["id"])
        self.runtime.apply(self.snapshot("two", "SCTsecret-two"))
        self.worker.run_once()
        self.assertEqual(self.sent, [])
        new = self.runtime.test("serverchan", "request-two", "two")
        self.worker.run_once()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][1]["sendkey"], "SCTsecret-two")
        self.assertEqual(self.repository.get(new["id"])["deliverySummary"]["serverchan"], "sent")
        self.assertNotIn("SCTsecret", str(self.repository.get(new["id"])))

    def test_paused_until_synced_and_disabled_channel_cannot_test(self):
        self.assertEqual(self.worker.run_once()["claimed"], 0)
        self.runtime.apply(self.snapshot(enabled=False))
        with self.assertRaises(ValueError):
            self.runtime.test("serverchan", "request-one", "one")

    def test_rejects_arbitrary_webhook_and_secret_errors(self):
        with self.assertRaises(ValueError) as error:
            self.runtime.apply({"wecom": {"revision": "one", "enabled": True, "fields": {"key": "https://evil.test/secret"}}})
        self.assertNotIn("evil.test", str(error.exception))

    def test_provider_errors_are_redacted_and_test_never_automatically_retries(self):
        self.runtime.apply(self.snapshot())
        def fail(*args):
            raise RuntimeError("https://provider.invalid/SCTsecret-one")
        self.runtime.sender = fail
        notification = self.runtime.test("serverchan", "request-one", "one")
        self.worker.run_once()
        result = self.repository.get(notification["id"])
        self.assertEqual(result["deliverySummary"]["serverchan"], "dead_letter")
        self.assertNotIn("SCTsecret", str(result))
        self.assertNotIn("provider.invalid", str(result))
        self.assertEqual(self.worker.run_once()["claimed"], 0)

    def test_claimed_jobs_cannot_use_replaced_target_and_same_revision_is_immutable(self):
        self.runtime.apply(self.snapshot())
        self.runtime.test("serverchan", "request-one", "one")
        jobs = self.repository.claim_delivery_jobs(channels={"serverchan"}, now=datetime.now(timezone.utc), lease_seconds=60, limit=10)
        with self.assertRaises(ValueError):
            self.runtime.apply(self.snapshot(key="SCTchanged"))
        self.runtime.apply(self.snapshot("two", "SCTchanged"))
        with self.assertRaises(DeliverySuppressed):
            self.runtime.send("serverchan", jobs[0])
        self.assertEqual(self.sent, [])

    def test_restart_preserves_version_and_dedupes_test(self):
        self.runtime.apply(self.snapshot())
        self.runtime.test("serverchan", "request-one", "one")
        restored = RuntimeNotificationChannels(self.repository, sender=self.runtime.sender)
        restored.apply(self.snapshot())
        restored.test("serverchan", "request-one", "one")
        worker = NotificationDeliveryWorker(self.repository, restored.adapters())
        worker.run_once()
        worker.run_once()
        self.assertEqual(len(self.sent), 1)

    def test_expired_test_lease_is_uncertain_and_never_automatically_reclaimed(self):
        self.runtime.apply(self.snapshot())
        notification = self.runtime.test("serverchan", "request-one", "one")
        now = datetime.now(timezone.utc)
        jobs = self.repository.claim_delivery_jobs(channels={"serverchan"}, now=now, lease_seconds=60, limit=10)
        self.assertEqual(len(jobs), 1)
        reclaimed = self.repository.claim_delivery_jobs(channels={"serverchan"}, now=now + timedelta(seconds=61), lease_seconds=60, limit=10)
        self.assertEqual(reclaimed, [])
        self.assertEqual(self.repository.get(notification["id"])["deliverySummary"]["serverchan"], "dead_letter")
        self.assertTrue(self.repository.get_delivery_job(jobs[0]["id"])["outcomeUncertain"])

    def test_internal_routes_require_token_and_no_external_preference_before_configuration(self):
        app = FastAPI()
        service = NotificationService(self.repository)
        service.runtime_channels = self.runtime
        register_notification_routes(app, service, internal_token="internal-test-token", runtime_channels=self.runtime)
        client = TestClient(app)
        self.assertEqual(client.post("/internal/notification-channels/apply", json=self.snapshot()).status_code, 401)
        client.headers.update({"X-Notification-Token": "internal-test-token"})
        self.assertEqual(client.put("/notifications/preferences", json={"category": "research", "channel": "serverchan", "enabled": True}).status_code, 422)
        response = client.post("/internal/notification-channels/apply", json=self.snapshot())
        self.assertEqual(response.json(), {"applied": True, "deliveryEnabled": True})
        self.assertNotIn("SCTsecret", response.text)
        self.assertEqual(client.put("/notifications/preferences", json={"category": "research", "channel": "serverchan", "enabled": True}).status_code, 200)
        self.assertEqual(client.post("/internal/notification-channels/test", json={"channel": "serverchan", "revision": "one", "requestId": "request-one"}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
