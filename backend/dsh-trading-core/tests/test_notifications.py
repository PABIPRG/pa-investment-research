# -*- coding: utf-8 -*-
"""统一通知中心的持久化、幂等、阅读状态与投递生命周期测试。"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from adapter.notifications.models import NotificationEvent, NotificationValidationError
from adapter.notifications.delivery import DeliveryError, NotificationDeliveryWorker
from adapter.notifications.repository import NotificationRepository
from adapter.notifications.service import NotificationService


NOW = datetime(2026, 9, 15, 10, 0, tzinfo=timezone.utc)


def _repository() -> NotificationRepository:
    root = Path(tempfile.mkdtemp())
    return NotificationRepository(root / "notifications.sqlite3")


def _event(
    event_id: str = "event-1",
    *,
    event_type: str = "market.price_alert.triggered.v1",
    occurred_at: datetime = NOW,
) -> NotificationEvent:
    return NotificationEvent.from_mapping(
        {
            "eventId": event_id,
            "schemaVersion": 1,
            "type": event_type,
            "producer": "market-watch",
            "occurredAt": occurred_at.isoformat(),
            "subject": {"kind": "security", "id": "600519"},
            "payload": {
                "securityName": "贵州茅台",
                "ruleName": "跌幅预警",
                "condition": "日内跌幅达到 3%",
                "price": 1510.5,
            },
        }
    )


class NotificationEventTests(unittest.TestCase):
    def test_unknown_type_and_arbitrary_action_are_rejected(self):
        with self.assertRaises(NotificationValidationError):
            NotificationEvent.from_mapping(
                {
                    "eventId": "event-unknown",
                    "schemaVersion": 1,
                    "type": "unknown.event.v1",
                    "producer": "test",
                    "occurredAt": NOW.isoformat(),
                    "subject": {"kind": "url", "id": "https://example.com"},
                    "payload": {},
                }
            )

    def test_price_alert_requires_deterministic_fields(self):
        payload = {
            "eventId": "event-invalid",
            "schemaVersion": 1,
            "type": "market.price_alert.triggered.v1",
            "producer": "market-watch",
            "occurredAt": NOW.isoformat(),
            "subject": {"kind": "security", "id": "600519"},
            "payload": {"securityName": "贵州茅台"},
        }
        with self.assertRaises(NotificationValidationError):
            NotificationEvent.from_mapping(payload)


class NotificationServiceTests(unittest.TestCase):
    def test_exact_replay_returns_existing_notification_without_new_occurrence(self):
        repository = _repository()
        service = NotificationService(repository, now=lambda: NOW)

        first = service.publish(_event())
        replay = service.publish(_event())

        self.assertEqual(replay["id"], first["id"])
        self.assertTrue(replay["duplicate"])
        self.assertEqual(replay["occurrenceCount"], 1)
        self.assertEqual(repository.count("notification_events"), 1)
        self.assertEqual(repository.count("notifications"), 1)

    def test_semantic_duplicate_is_aggregated_without_second_delivery(self):
        repository = _repository()
        service = NotificationService(
            repository,
            now=lambda: NOW,
            channel_defaults={"market_risk": {"browser": True, "macos": True}},
        )
        service.save_subscription(
            channel="browser", device_id="browser-1",
            endpoint="https://push.example.test/one",
            subscription={"endpoint": "https://push.example.test/one", "keys": {"p256dh": "a", "auth": "b"}},
        )

        first = service.publish(_event("event-1"))
        repeated = service.publish(
            _event("event-2", occurred_at=NOW + timedelta(minutes=5))
        )

        self.assertEqual(repeated["id"], first["id"])
        self.assertFalse(repeated["duplicate"])
        self.assertTrue(repeated["aggregated"])
        self.assertEqual(repeated["occurrenceCount"], 2)
        self.assertEqual(repository.count("notification_events"), 2)
        self.assertEqual(repository.count("delivery_jobs"), 2)

    def test_inbox_remains_authoritative_when_all_external_channels_are_disabled(self):
        repository = _repository()
        service = NotificationService(repository, now=lambda: NOW)

        notification = service.publish(_event())
        listing = service.list_notifications(view="unread")

        self.assertEqual(notification["deliverySummary"], {})
        self.assertEqual(listing["unreadCount"], 1)
        self.assertEqual([row["id"] for row in listing["items"]], [notification["id"]])

    def test_read_archive_filters_and_bulk_undo_are_persistent(self):
        repository = _repository()
        service = NotificationService(repository, now=lambda: NOW)
        first = service.publish(_event("event-1"))
        second = service.publish(
            _event("event-2", occurred_at=NOW + timedelta(hours=2))
        )

        service.set_read(first["id"], True)
        self.assertEqual(service.list_notifications(view="unread")["unreadCount"], 1)
        changed = service.mark_all_read()
        self.assertEqual(changed, [second["id"]])
        self.assertEqual(service.list_notifications(view="unread")["items"], [])
        service.bulk_set_read(changed, False)
        self.assertEqual(service.list_notifications(view="unread")["unreadCount"], 1)

        service.set_archived(second["id"], True)
        self.assertEqual(service.list_notifications(view="all")["items"], [service.get(first["id"])])
        self.assertEqual(
            [row["id"] for row in service.list_notifications(view="all", archived=True)["items"]],
            [second["id"]],
        )

    def test_user_preference_controls_future_jobs_only(self):
        repository = _repository()
        service = NotificationService(
            repository,
            now=lambda: NOW,
            channel_defaults={"market_risk": {"browser": True, "macos": True}},
        )
        service.save_subscription(
            channel="browser", device_id="browser-1",
            endpoint="https://push.example.test/one",
            subscription={"endpoint": "https://push.example.test/one", "keys": {"p256dh": "a", "auth": "b"}},
        )
        first = service.publish(_event("event-1"))
        service.set_preference("market_risk", "browser", False)
        second = service.publish(
            _event("event-2", occurred_at=NOW + timedelta(hours=2))
        )

        self.assertEqual(set(first["deliverySummary"]), {"browser", "macos"})
        self.assertEqual(set(second["deliverySummary"]), {"macos"})
        self.assertEqual(repository.count("delivery_jobs"), 3)

    def test_cursor_paginates_notifications_that_share_the_same_timestamp(self):
        repository = _repository()
        service = NotificationService(repository, now=lambda: NOW)
        for index in range(2):
            service.publish(NotificationEvent.from_mapping({
                "eventId": f"page-{index}",
                "schemaVersion": 1,
                "type": "market.price_alert.triggered.v1",
                "producer": "market-watch",
                "occurredAt": NOW.isoformat(),
                "subject": {"kind": "security", "id": f"60051{index}"},
                "payload": {
                    "securityName": f"证券 {index}",
                    "ruleName": "价格预警",
                    "condition": "达到阈值",
                },
            }))

        first = service.list_notifications(view="all", limit=1)
        second = service.list_notifications(view="all", limit=1, cursor=first["nextCursor"])

        self.assertIsNotNone(first["nextCursor"])
        self.assertEqual(len(second["items"]), 1)
        self.assertNotEqual(first["items"][0]["id"], second["items"][0]["id"])


class NotificationDeliveryTests(unittest.TestCase):
    def test_claim_failure_backoff_and_expired_lease_recovery(self):
        repository = _repository()
        service = NotificationService(
            repository,
            now=lambda: NOW,
            channel_defaults={"market_risk": {"browser": True}},
        )
        service.save_subscription(
            channel="browser", device_id="browser-1",
            endpoint="https://push.example.test/one",
            subscription={"endpoint": "https://push.example.test/one", "keys": {"p256dh": "a", "auth": "b"}},
        )
        service.publish(_event())

        first_claim = repository.claim_delivery_jobs(
            channels={"browser"}, now=NOW, lease_seconds=30, limit=10
        )
        self.assertEqual(len(first_claim), 1)
        self.assertEqual(first_claim[0]["status"], "leased")
        self.assertEqual(
            repository.claim_delivery_jobs(
                channels={"browser"}, now=NOW + timedelta(seconds=10), lease_seconds=30, limit=10
            ),
            [],
        )

        recovered = repository.claim_delivery_jobs(
            channels={"browser"}, now=NOW + timedelta(seconds=31), lease_seconds=30, limit=10
        )
        self.assertEqual([row["id"] for row in recovered], [first_claim[0]["id"]])
        repository.fail_delivery_job(
            recovered[0]["id"],
            recovered[0]["leaseToken"],
            now=NOW + timedelta(seconds=32),
            error_code="network_timeout",
            error_message="secret=https://example.test/token",
            retryable=True,
            outcome_uncertain=True,
            max_attempts=3,
        )
        job = repository.get_delivery_job(recovered[0]["id"])
        self.assertEqual(job["status"], "retry_wait")
        self.assertTrue(job["outcomeUncertain"])
        self.assertNotIn("example.test", job["lastErrorMessage"])
        self.assertGreater(job["nextAttemptAt"], (NOW + timedelta(seconds=32)).isoformat())

    def test_permanent_failure_enters_dead_letter_and_manual_retry_is_audited(self):
        repository = _repository()
        service = NotificationService(
            repository,
            now=lambda: NOW,
            channel_defaults={"market_risk": {"email": True}},
        )
        notification = service.publish(_event())
        claimed = repository.claim_delivery_jobs(
            channels={"email"}, now=NOW, lease_seconds=30, limit=1
        )[0]
        repository.fail_delivery_job(
            claimed["id"],
            claimed["leaseToken"],
            now=NOW,
            error_code="invalid_recipient",
            error_message="recipient rejected",
            retryable=False,
            outcome_uncertain=False,
            max_attempts=3,
        )
        self.assertEqual(repository.get_delivery_job(claimed["id"])["status"], "dead_letter")

        retried = service.retry_delivery(notification["id"], "email")
        self.assertEqual(repository.get_delivery_job(claimed["id"])["status"], "pending")
        self.assertEqual(retried["retried"], 1)
        self.assertEqual(repository.count("notification_audit"), 2)

    def test_worker_isolates_channels_and_records_each_outcome(self):
        repository = _repository()
        service = NotificationService(
            repository,
            now=lambda: NOW,
            channel_defaults={"market_risk": {"serverchan": True, "email": True}},
        )
        service.publish(_event())
        calls: list[str] = []

        class SuccessAdapter:
            def send(self, job):
                calls.append(job["channel"])

        class FailureAdapter:
            def send(self, job):
                calls.append(job["channel"])
                raise DeliveryError("temporary", retryable=True, outcome_uncertain=False)

        worker = NotificationDeliveryWorker(
            repository,
            {"serverchan": SuccessAdapter(), "email": FailureAdapter()},
            now=lambda: NOW,
        )
        result = worker.run_once()

        self.assertEqual(set(calls), {"serverchan", "email"})
        self.assertEqual(result, {"claimed": 2, "sent": 1, "failed": 1})
        jobs = repository.claim_delivery_jobs(
            channels={"serverchan", "email"},
            now=NOW + timedelta(seconds=31),
            lease_seconds=30,
            limit=10,
        )
        self.assertEqual([job["channel"] for job in jobs], ["email"])

    def test_subscription_logout_deactivates_browser_delivery_target(self):
        repository = _repository()
        service = NotificationService(repository, now=lambda: NOW)
        service.save_subscription(
            channel="browser",
            device_id="browser-device-1",
            endpoint="https://push.example.test/subscription",
            subscription={"endpoint": "https://push.example.test/subscription", "keys": {"p256dh": "a", "auth": "b"}},
        )
        self.assertEqual(len(service.active_subscriptions("browser")), 1)

        service.deactivate_subscription("browser", "browser-device-1")

        self.assertEqual(service.active_subscriptions("browser"), [])


if __name__ == "__main__":
    unittest.main()
