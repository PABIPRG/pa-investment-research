# -*- coding: utf-8 -*-
"""运行恢复：租约回收、收件补偿、outbox 重试与 Hook 目录。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_recovery -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from research_partner.api import create_app
from research_partner.commands import MandateCreateRequest
from research_partner.context import RequestContext
from research_partner.factory import build_service
from research_partner.hooks import hook_catalog
from research_partner.models import (
    EventEnvelope,
    OutboxMessage,
    ResearchJob,
)
from research_partner.pipeline import PartnerPipeline
from research_partner.recovery import RecoveryService

FIXED = datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)


def key() -> str:
    return "idem_" + secrets.token_hex(8)


class RecoveryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "state.db"
        self.now = FIXED
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )
        self.mandate_id = self._create_mandate()

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def _create_mandate(self) -> str:
        response = self.service.create(
            self.ctx,
            MandateCreateRequest(
                goal="恢复测试",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available"}],
                contact_policy={"mode": "condition"},
                idempotency_key=key(),
            ),
        )
        return response["mandate"]["mandate_id"]

    def job(self, *, budget=None, dedupe=None) -> ResearchJob:
        at = self.now
        return self.store.create_job(
            ResearchJob(
                job_id="JOB_" + secrets.token_hex(16),
                mandate_id=self.mandate_id,
                mandate_revision=1,
                trigger_event_id="evt-" + secrets.token_hex(4),
                action="event_review",
                status="pending",
                budget=budget or {"max_attempts": 3},
                dedupe_key=dedupe or "job:" + secrets.token_hex(8),
                created_at=at,
                updated_at=at,
                next_run_at=at,
            )
        )

    def running_job(self, *, budget=None) -> ResearchJob:
        job = self.job(budget=budget)
        claimed = self.store.claim_jobs(limit=1, lease_seconds=60, now=self.now)
        self.assertEqual([item.job_id for item in claimed], [job.job_id])
        return claimed[0]


class LeaseRecoveryTests(RecoveryTestCase):
    def test_expired_lease_is_requeued(self) -> None:
        job = self.running_job()
        recovery = RecoveryService(self.store, now=lambda: self.now)

        before = recovery.recover()
        self.assertEqual(before["leases_reclaimed"], 0)  # 租约仍有效

        self.now = FIXED + timedelta(seconds=61)
        result = recovery.recover()
        self.assertEqual(result["leases_reclaimed"], 1)
        self.assertEqual(result["jobs_requeued"], 1)
        recovered = self.store.get_job(job.job_id)
        self.assertEqual(recovered.status, "pending")
        self.assertEqual(recovered.last_error, "lease_expired")
        self.assertIsNone(recovered.lease_token)
        self.assertEqual(recovered.next_run_at, self.now + timedelta(seconds=30))

    def test_over_budget_lease_becomes_failed(self) -> None:
        job = self.running_job(budget={"max_attempts": 1})
        self.now = FIXED + timedelta(seconds=61)
        result = RecoveryService(self.store, now=lambda: self.now).recover()

        self.assertEqual(result["jobs_failed"], [job.job_id])
        failed = self.store.get_job(job.job_id)
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.last_error, "lease_expired")

    def test_recovery_is_idempotent(self) -> None:
        self.running_job()
        self.now = FIXED + timedelta(seconds=61)
        recovery = RecoveryService(self.store, now=lambda: self.now)
        self.assertEqual(recovery.recover()["leases_reclaimed"], 1)
        second = recovery.recover()
        self.assertEqual(second["leases_reclaimed"], 0)
        self.assertEqual(second["jobs_requeued"], 0)

    def test_late_result_still_cannot_use_the_old_lease(self) -> None:
        from research_partner.errors import LeaseExpired

        job = self.running_job()
        self.now = FIXED + timedelta(seconds=61)
        RecoveryService(self.store, now=lambda: self.now).recover()

        with self.assertRaises(LeaseExpired):
            self.store.fail_job(
                job.job_id, job.lease_token or "", "late", now=self.now
            )


class InboxRecoveryTests(RecoveryTestCase):
    def test_processing_event_is_requeued_after_crash(self) -> None:
        self.store.record_event(
            EventEnvelope(
                event_id="evt-crash",
                hook_type="company.event_available",
                producer="market-watch",
                occurred_at=self.now,
                observed_at=self.now,
                subject_ids=["company:600519"],
                payload={},
            )
        )
        claimed = self.store.claim_inbox(limit=10, now=self.now)
        self.assertEqual([item.event_id for item in claimed], ["evt-crash"])

        self.now = FIXED + timedelta(seconds=301)
        recovery = RecoveryService(self.store, now=lambda: self.now)
        result = recovery.recover(inbox_stale_seconds=300)
        self.assertEqual(result["events_requeued"], 1)
        status = next(
            item
            for item in self.store.list_inbox(limit=10)
            if item.event_id == "evt-crash"
        )
        self.assertEqual(status.status, "pending")
        self.assertEqual(status.last_error, "recovered_after_crash")

    def test_recent_processing_is_left_alone(self) -> None:
        self.store.record_event(
            EventEnvelope(
                event_id="evt-fresh",
                hook_type="company.event_available",
                producer="market-watch",
                occurred_at=self.now,
                observed_at=self.now,
                subject_ids=["company:600519"],
                payload={},
            )
        )
        self.store.claim_inbox(limit=10, now=self.now)
        self.now = FIXED + timedelta(seconds=30)
        result = RecoveryService(self.store, now=lambda: self.now).recover(
            inbox_stale_seconds=300
        )
        self.assertEqual(result["events_requeued"], 0)


class OutboxRecoveryTests(RecoveryTestCase):
    def test_failed_outbox_is_retried_within_budget(self) -> None:
        message = OutboxMessage(
            outbox_id="OUT_" + secrets.token_hex(16),
            aggregate_type="mandate",
            aggregate_id=self.mandate_id,
            event_type="mandate.created",
            payload={"mandate_id": self.mandate_id, "revision": 1},
            available_at=self.now,
            created_at=self.now,
        )
        self.store.enqueue_outbox([message])
        self.store.mark_outbox(message.outbox_id, "failed", "bus down")

        result = RecoveryService(self.store, now=lambda: self.now).recover()
        self.assertEqual(result["outbox_retried"], 1)

        published = PartnerPipeline(self.store, now=lambda: self.now).publisher.publish()
        self.assertGreaterEqual(published, 1)
        self.assertIsNotNone(self.store.get_event(message.outbox_id))

    def test_exhausted_outbox_stays_failed(self) -> None:
        message = OutboxMessage(
            outbox_id="OUT_" + secrets.token_hex(16),
            aggregate_type="mandate",
            aggregate_id=self.mandate_id,
            event_type="mandate.created",
            payload={"mandate_id": self.mandate_id, "revision": 1},
            available_at=self.now,
            created_at=self.now,
        )
        self.store.enqueue_outbox([message])
        # 每次领取都会把可用时间推后 60 秒；连续失败 5 次后预算耗尽。
        for _ in range(5):
            self.store.claim_outbox(limit=10, now=self.now)
            self.now = self.now + timedelta(seconds=61)
        self.store.mark_outbox(message.outbox_id, "failed", "bus down")

        result = RecoveryService(self.store, now=lambda: self.now).recover()
        self.assertEqual(result["outbox_retried"], 0)  # max_attempts 默认 5

    def test_pipeline_exposes_recovery(self) -> None:
        pipeline = PartnerPipeline(self.store, now=lambda: self.now)
        result = pipeline.recover()
        self.assertIn("recovered_at", result)
        self.assertEqual(result["leases_reclaimed"], 0)


class HookCatalogTests(unittest.TestCase):
    def test_every_hook_has_producer_boundary_and_priority(self) -> None:
        hooks = hook_catalog()
        self.assertGreaterEqual(len(hooks), 15)
        for hook in hooks:
            self.assertTrue(hook["hook_type"])
            self.assertTrue(hook["handling"])
            self.assertTrue(hook["boundary"])
            self.assertTrue(hook["priority"])
            self.assertEqual(hook["active"], hook["producer"] is not None)

    def test_facts_revised_and_runtime_recovered_are_listed(self) -> None:
        types = {hook["hook_type"] for hook in hook_catalog(active_only=True)}
        self.assertIn("investment.facts_revised", types)
        self.assertIn("runtime.recovered", types)


class RecoveryApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "state.db"
        self._client_ctx = TestClient(create_app(store_path=path))
        self.client = self._client_ctx.__enter__()
        self.headers = {"X-Principal-Id": "user-1", "X-Instance-Id": "instance-1"}

    def tearDown(self) -> None:
        self._client_ctx.__exit__(None, None, None)
        self._tmp.cleanup()

    def test_runtime_recovered_endpoint(self) -> None:
        response = self.client.post("/research/runtime/recovered", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["leases_reclaimed"], 0)
        self.assertEqual(body["events_requeued"], 0)

    def test_hooks_endpoint(self) -> None:
        response = self.client.get("/research/hooks", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        hooks = response.json()["hooks"]
        self.assertTrue(any(item["hook_type"] == "schedule.due" for item in hooks))

        active = self.client.get(
            "/research/hooks", params={"active_only": "true"}, headers=self.headers
        ).json()["hooks"]
        self.assertTrue(all(item["producer"] for item in active))
        self.assertLess(len(active), len(hooks))


if __name__ == "__main__":
    unittest.main()
