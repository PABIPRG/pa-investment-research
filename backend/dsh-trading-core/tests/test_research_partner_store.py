# -*- coding: utf-8 -*-
"""研究委托核心 SQLite 适配器契约测试（Slice 1）。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_store -v
"""

from __future__ import annotations

import secrets
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from research_partner.adapters import SqliteBusinessStore
from research_partner.context import RequestContext
from research_partner.errors import (
    Conflict,
    InvalidRequest,
    LeaseExpired,
    NotFound,
    Unauthorized,
)
from research_partner.models import (
    ContactDecision,
    ContactRecord,
    EventEnvelope,
    IdempotentResponse,
    Mandate,
    MandateRequirement,
    MandateRevision,
    MandateSubject,
    OutboxMessage,
    ResearchJob,
    ResearchJobResult,
    TrackingDependency,
)


def rid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(16)}"


def utc() -> datetime:
    return datetime.now(timezone.utc)


def build_mandate(
    *,
    principal_id: str = "user-1",
    instance_id: str = "instance-1",
    status: str = "tracking",
    at: datetime | None = None,
) -> tuple[Mandate, MandateRevision]:
    at = at or utc()
    mandate_id = rid("MND")
    mandate = Mandate(
        mandate_id=mandate_id,
        principal_id=principal_id,
        instance_id=instance_id,
        status=status,
        current_revision=1,
        created_at=at,
        updated_at=at,
    )
    revision = MandateRevision(
        mandate_id=mandate_id,
        revision=1,
        goal="跟踪该公司的订单与产能变化",
        scope={"type": "company"},
        triggers=[{"hook_type": "company.event_available"}],
        contact_policy={"channels": ["app"]},
        created_by=principal_id,
        created_at=at,
    )
    return mandate, revision


def build_outbox(aggregate_id: str, *, at: datetime | None = None) -> OutboxMessage:
    at = at or utc()
    return OutboxMessage(
        outbox_id=rid("OUT"),
        aggregate_type="mandate",
        aggregate_id=aggregate_id,
        event_type="mandate.created",
        payload={"mandate_id": aggregate_id},
        available_at=at,
        created_at=at,
    )


def build_job(
    mandate_id: str,
    *,
    dedupe_key: str | None = None,
    at: datetime | None = None,
    budget: dict | None = None,
) -> ResearchJob:
    at = at or utc()
    return ResearchJob(
        job_id=rid("JOB"),
        mandate_id=mandate_id,
        mandate_revision=1,
        trigger_event_id=None,
        action="research",
        next_run_at=at,
        dedupe_key=dedupe_key or rid("dedupe"),
        budget=budget or {"max_attempts": 3},
        created_at=at,
        updated_at=at,
    )


class StoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "business.db"
        self.store = SqliteBusinessStore(self.db_path)
        self.now = utc()

    def tearDown(self) -> None:
        connection = getattr(self.store._local, "connection", None)
        if connection is not None:
            connection.close()
            self.store._local.connection = None
        self._tmp.cleanup()

    def create_tracking_mandate(self, **kwargs) -> Mandate:
        mandate, revision = build_mandate(status="tracking", **kwargs)
        self.store.create_mandate(mandate, revision)
        return mandate


class MigrationTests(StoreTestCase):
    def test_schema_version_and_reopen(self) -> None:
        self.assertEqual(self.store.schema_version(), "1.0")
        connection = getattr(self.store._local, "connection", None)
        connection.close()
        self.store._local.connection = None
        reopened = SqliteBusinessStore(self.db_path)
        self.assertEqual(reopened.schema_version(), "1.0")
        migrations = reopened._connect().execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
        self.assertEqual(
            [row["version"] for row in migrations],
            [
                "001_init",
                "002_contact_decision",
                "003_schedules",
                "004_condition_state",
            ],
        )
        reopened.close()

    def test_foreign_keys_enabled(self) -> None:
        connection = self.store._connect()
        self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        self.assertEqual(
            connection.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal"
        )


class MandateTests(StoreTestCase):
    def test_create_and_get_roundtrip(self) -> None:
        mandate, revision = build_mandate()
        subject = MandateSubject(
            mandate_id=mandate.mandate_id,
            revision=1,
            entity_id="company:600519",
        )
        requirement = MandateRequirement(
            requirement_id=rid("REQ"),
            mandate_id=mandate.mandate_id,
            revision=1,
            code="confirm_subject",
            detail="确认跟踪主体",
            created_at=self.now,
        )
        dependency = TrackingDependency(
            dependency_id="dep_" + secrets.token_hex(8),
            mandate_id=mandate.mandate_id,
            revision=1,
            hook_type="company.event_available",
            subject_id="company:600519",
            created_at=self.now,
        )
        outbox = build_outbox(mandate.mandate_id)
        self.store.create_mandate(
            mandate,
            revision,
            subjects=[subject],
            requirements=[requirement],
            dependencies=[dependency],
            outbox=[outbox],
        )

        loaded = self.store.get_mandate(mandate.mandate_id, principal_id="user-1")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.status, "tracking")
        self.assertEqual(loaded.current_revision, 1)
        self.assertEqual(loaded.created_at, mandate.created_at)

        loaded_revision = self.store.get_revision(mandate.mandate_id, 1)
        self.assertEqual(loaded_revision.goal, revision.goal)
        self.assertEqual(loaded_revision.triggers, revision.triggers)

        subjects = self.store.list_subjects(mandate.mandate_id, 1)
        self.assertEqual([item.entity_id for item in subjects], ["company:600519"])

        requirements = self.store.list_requirements(mandate.mandate_id)
        self.assertEqual(len(requirements), 1)
        self.assertEqual(requirements[0].status, "open")

        matches = self.store.find_active_dependencies(
            hook_type="company.event_available", subject_ids=["company:600519"]
        )
        self.assertEqual([item.dependency_id for item in matches], [dependency.dependency_id])

        claimed = self.store.claim_outbox(limit=10, now=self.now + timedelta(seconds=1))
        self.assertEqual([item.outbox_id for item in claimed], [outbox.outbox_id])

    def test_principal_isolation(self) -> None:
        mandate = self.create_tracking_mandate()
        self.assertIsNone(
            self.store.get_mandate(mandate.mandate_id, principal_id="user-2")
        )
        items, _ = self.store.list_mandates("user-2")
        self.assertEqual(items, [])
        with self.assertRaises(NotFound):
            self.store.set_status(
                mandate.mandate_id,
                principal_id="user-2",
                expected_revision=1,
                status="paused",
            )

    def test_duplicate_create_is_atomic(self) -> None:
        mandate, revision = build_mandate()
        outbox = build_outbox(mandate.mandate_id)
        self.store.create_mandate(mandate, revision, outbox=[outbox])
        with self.assertRaises(Conflict):
            self.store.create_mandate(
                mandate, revision, outbox=[build_outbox(mandate.mandate_id)]
            )
        # 第二次创建整体回滚，不应留下第二条 outbox。
        claimed = self.store.claim_outbox(limit=10, now=self.now + timedelta(seconds=1))
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0].outbox_id, outbox.outbox_id)

    def test_create_rejects_invalid_revision(self) -> None:
        mandate, revision = build_mandate()
        with self.assertRaises(InvalidRequest):
            self.store.create_mandate(
                mandate, revision.model_copy(update={"revision": 2})
            )

    def test_add_revision_bumps_and_deactivates_old_dependencies(self) -> None:
        mandate, revision = build_mandate()
        old_dep = TrackingDependency(
            dependency_id="dep_" + secrets.token_hex(8),
            mandate_id=mandate.mandate_id,
            revision=1,
            hook_type="company.event_available",
            subject_id="company:600519",
            created_at=self.now,
        )
        self.store.create_mandate(mandate, revision, dependencies=[old_dep])

        new_revision = revision.model_copy(
            update={
                "revision": 2,
                "goal": "改为跟踪订单与毛利",
                "created_at": self.now + timedelta(minutes=1),
            }
        )
        new_dep = TrackingDependency(
            dependency_id="dep_" + secrets.token_hex(8),
            mandate_id=mandate.mandate_id,
            revision=2,
            hook_type="company.event_available",
            subject_id="company:600519",
            created_at=self.now + timedelta(minutes=1),
        )
        updated = self.store.add_revision(
            new_revision,
            expected_revision=1,
            dependencies=[new_dep],
            outbox=[build_outbox(mandate.mandate_id)],
        )
        self.assertEqual(updated.current_revision, 2)
        self.assertEqual(updated.updated_at, new_revision.created_at)

        matches = self.store.find_active_dependencies(
            hook_type="company.event_available", subject_ids=["company:600519"]
        )
        self.assertEqual([item.dependency_id for item in matches], [new_dep.dependency_id])
        self.assertEqual(self.store.get_revision(mandate.mandate_id, 1).goal, revision.goal)
        self.assertEqual(
            self.store.get_revision(mandate.mandate_id, 2).goal, new_revision.goal
        )

    def test_add_revision_optimistic_conflict_rolls_back(self) -> None:
        mandate, revision = build_mandate()
        self.store.create_mandate(mandate, revision)
        second = revision.model_copy(
            update={"revision": 2, "created_at": self.now + timedelta(minutes=1)}
        )
        self.store.add_revision(second, expected_revision=1)

        # 另一个客户端仍以为当前是 v1，带着相同版本号提交 v2。
        stale = revision.model_copy(
            update={"revision": 2, "created_at": self.now + timedelta(minutes=2)}
        )
        with self.assertRaises(Conflict):
            self.store.add_revision(
                stale, expected_revision=1, outbox=[build_outbox(mandate.mandate_id)]
            )
        loaded = self.store.get_mandate(mandate.mandate_id, principal_id="user-1")
        self.assertEqual(loaded.current_revision, 2)
        self.assertEqual(
            self.store.get_revision(mandate.mandate_id, 2).created_at, second.created_at
        )
        self.assertEqual(
            self.store.claim_outbox(limit=10, now=self.now + timedelta(minutes=3)), []
        )

    def test_ended_mandate_rejects_new_revision(self) -> None:
        mandate, revision = build_mandate()
        self.store.create_mandate(mandate, revision)
        self.store.set_status(
            mandate.mandate_id,
            principal_id="user-1",
            expected_revision=1,
            status="ended",
        )
        with self.assertRaises(Conflict):
            self.store.add_revision(
                revision.model_copy(update={"revision": 2}), expected_revision=1
            )

    def test_status_machine_and_job_cancellation(self) -> None:
        mandate, revision = build_mandate(status="tracking")
        dep = TrackingDependency(
            dependency_id="dep_" + secrets.token_hex(8),
            mandate_id=mandate.mandate_id,
            revision=1,
            hook_type="company.event_available",
            subject_id="company:600519",
            created_at=self.now,
        )
        self.store.create_mandate(mandate, revision, dependencies=[dep])
        job = self.store.create_job(build_job(mandate.mandate_id, at=self.now))

        paused = self.store.set_status(
            mandate.mandate_id,
            principal_id="user-1",
            expected_revision=1,
            status="paused",
        )
        self.assertEqual(paused.status, "paused")
        self.assertEqual(self.store.get_job(job.job_id).status, "cancelled")
        self.assertEqual(
            self.store.find_active_dependencies(
                hook_type="company.event_available", subject_ids=["company:600519"]
            ),
            [],
        )

        resumed = self.store.set_status(
            mandate.mandate_id,
            principal_id="user-1",
            expected_revision=1,
            status="tracking",
        )
        self.assertEqual(resumed.status, "tracking")
        self.assertEqual(
            len(
                self.store.find_active_dependencies(
                    hook_type="company.event_available",
                    subject_ids=["company:600519"],
                )
            ),
            1,
        )

        ended = self.store.set_status(
            mandate.mandate_id,
            principal_id="user-1",
            expected_revision=1,
            status="ended",
        )
        self.assertIsNotNone(ended.ended_at)
        with self.assertRaises(Conflict):
            self.store.set_status(
                mandate.mandate_id,
                principal_id="user-1",
                expected_revision=1,
                status="tracking",
            )

    def test_stable_pagination(self) -> None:
        base = self.now - timedelta(hours=1)
        created = []
        for index in range(5):
            mandate, revision = build_mandate(at=base + timedelta(seconds=index))
            self.store.create_mandate(mandate, revision)
            created.append(mandate.mandate_id)

        seen: list[str] = []
        cursor = None
        while True:
            items, cursor = self.store.list_mandates("user-1", limit=2, cursor=cursor)
            seen.extend(item.mandate_id for item in items)
            if cursor is None:
                break
        self.assertEqual(seen, list(reversed(created)))

    def test_invalid_cursor(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.store.list_mandates("user-1", cursor="not-a-cursor")


class EventTests(StoreTestCase):
    def envelope(self, *, event_id: str | None = None, content_hash: str = "h1") -> EventEnvelope:
        return EventEnvelope(
            event_id=event_id or "evt-" + secrets.token_hex(8),
            hook_type="company.event_available",
            producer="market-watch",
            occurred_at=self.now,
            observed_at=self.now,
            subject_ids=["company:600519", "company:600519"],
            content_hash=content_hash,
            payload={"title": "公告"},
        )

    def test_dedupe_by_event_id(self) -> None:
        envelope = self.envelope()
        self.assertTrue(self.store.record_event(envelope))
        self.assertFalse(self.store.record_event(envelope))
        loaded = self.store.get_event(envelope.event_id)
        self.assertEqual(loaded.subject_ids, ["company:600519"])
        self.assertEqual(len(self.store.list_inbox()), 1)

    def test_same_id_different_content_conflicts(self) -> None:
        envelope = self.envelope()
        self.store.record_event(envelope)
        with self.assertRaises(Conflict):
            self.store.record_event(self.envelope(event_id=envelope.event_id, content_hash="h2"))

    def test_inbox_claim_and_mark(self) -> None:
        envelope = self.envelope()
        self.store.record_event(envelope)
        claimed = self.store.claim_inbox(limit=10, now=self.now)
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0].status, "processing")
        self.assertEqual(claimed[0].attempts, 1)
        self.assertEqual(self.store.claim_inbox(limit=10, now=self.now), [])
        self.store.mark_inbox(envelope.event_id, "processed")
        self.assertEqual(self.store.list_inbox(status="processed")[0].event_id, envelope.event_id)
        with self.assertRaises(NotFound):
            self.store.mark_inbox("missing-event", "processed")

    def test_outbox_claim_publish(self) -> None:
        mandate, revision = build_mandate()
        self.store.create_mandate(mandate, revision, outbox=[build_outbox(mandate.mandate_id)])
        claimed = self.store.claim_outbox(limit=10, now=self.now)
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0].status, "sending")
        self.assertEqual(claimed[0].attempts, 1)
        # 单条消息同一时刻只能被一个发布者认领。
        self.assertEqual(
            self.store.claim_outbox(limit=10, now=self.now + timedelta(seconds=1)), []
        )
        self.store.mark_outbox(claimed[0].outbox_id, "published")
        rows = self.store._connect().execute(
            "SELECT status, published_at FROM event_outbox WHERE outbox_id = ?",
            (claimed[0].outbox_id,),
        ).fetchone()
        self.assertEqual(rows["status"], "published")
        self.assertIsNotNone(rows["published_at"])


class JobTests(StoreTestCase):
    def test_claim_renew_complete(self) -> None:
        mandate = self.create_tracking_mandate()
        job = self.store.create_job(build_job(mandate.mandate_id, at=self.now))
        self.assertEqual(self.store.get_job_by_dedupe(job.dedupe_key).job_id, job.job_id)

        claimed = self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now)
        self.assertEqual(len(claimed), 1)
        running = claimed[0]
        self.assertEqual(running.status, "running")
        self.assertEqual(running.attempt_count, 1)
        self.assertTrue(running.lease_token)
        self.assertEqual(self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now), [])

        renewed = self.store.renew_job_lease(
            running.job_id, running.lease_token, lease_seconds=120, now=self.now
        )
        self.assertGreater(
            renewed.lease_expires_at, running.lease_expires_at
        )

        result = ResearchJobResult(
            result_id=rid("RES"),
            job_id=job.job_id,
            run_id="run-1",
            outcome="completed",
            change_summary="订单增长",
            received_at=self.now,
        )
        self.store.complete_job(
            job.job_id, running.lease_token, result, now=self.now
        )
        self.assertEqual(self.store.get_job(job.job_id).status, "completed")
        with self.assertRaises(LeaseExpired):
            self.store.complete_job(
                job.job_id, running.lease_token, result, now=self.now
            )

    def test_lease_expiry_blocks_late_completion(self) -> None:
        mandate = self.create_tracking_mandate()
        job = self.store.create_job(build_job(mandate.mandate_id, at=self.now))
        running = self.store.claim_jobs(limit=1, lease_seconds=5, now=self.now)[0]
        result = ResearchJobResult(
            result_id=rid("RES"),
            job_id=job.job_id,
            run_id="run-late",
            outcome="completed",
            received_at=self.now + timedelta(minutes=5),
        )
        with self.assertRaises(LeaseExpired):
            self.store.complete_job(
                job.job_id,
                running.lease_token,
                result,
                now=self.now + timedelta(minutes=5),
            )
        self.assertEqual(self.store.get_job(job.job_id).status, "running")

    def test_fail_retries_until_budget_exhausted(self) -> None:
        mandate = self.create_tracking_mandate()
        job = self.store.create_job(
            build_job(mandate.mandate_id, budget={"max_attempts": 2}, at=self.now)
        )
        first = self.store.claim_jobs(limit=1, lease_seconds=60, now=self.now)[0]
        retried = self.store.fail_job(
            job.job_id,
            first.lease_token,
            "timeout",
            now=self.now,
            retry_at=self.now + timedelta(minutes=1),
        )
        self.assertEqual(retried.status, "pending")
        self.assertIsNone(retried.lease_token)
        self.assertEqual(
            self.store.claim_jobs(limit=1, lease_seconds=60, now=self.now), []
        )
        second = self.store.claim_jobs(
            limit=1, lease_seconds=60, now=self.now + timedelta(minutes=2)
        )[0]
        failed = self.store.fail_job(
            job.job_id, second.lease_token, "timeout", now=self.now
        )
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.attempt_count, 2)
        with self.assertRaises(LeaseExpired):
            self.store.fail_job(job.job_id, second.lease_token, "again", now=self.now)

    def test_duplicate_dedupe_key(self) -> None:
        mandate = self.create_tracking_mandate()
        job = build_job(mandate.mandate_id, dedupe_key="dedupe-fixed-key", at=self.now)
        self.store.create_job(job)
        with self.assertRaises(Conflict):
            self.store.create_job(
                build_job(mandate.mandate_id, dedupe_key="dedupe-fixed-key", at=self.now)
            )


class ContactAndIdempotencyTests(StoreTestCase):
    def test_contact_decision_dedupe(self) -> None:
        mandate = self.create_tracking_mandate()
        decision = ContactDecision(
            decision_id=rid("DEC"),
            mandate_id=mandate.mandate_id,
            mandate_revision=1,
            decision="send",
            reason_code="condition_met",
            condition_result="met",
            dedupe_key="decision-key-001",
            created_at=self.now,
        )
        stored = self.store.save_contact_decision(decision)
        self.assertEqual(stored.decision_id, decision.decision_id)

        duplicate = decision.model_copy(update={"decision_id": rid("DEC"), "decision": "suppress"})
        stored_again = self.store.save_contact_decision(duplicate)
        self.assertEqual(stored_again.decision_id, decision.decision_id)
        self.assertEqual(stored_again.decision, "send")

        decisions = self.store.list_contact_decisions(mandate.mandate_id)
        self.assertEqual(len(decisions), 1)

    def test_contact_record_upsert(self) -> None:
        mandate = self.create_tracking_mandate()
        decision = ContactDecision(
            decision_id=rid("DEC"),
            mandate_id=mandate.mandate_id,
            mandate_revision=1,
            decision="send",
            reason_code="condition_met",
            dedupe_key="decision-key-002",
            created_at=self.now,
        )
        self.store.save_contact_decision(decision)
        record = ContactRecord(
            decision_id=decision.decision_id, channel="app", status="queued"
        )
        self.store.save_contact_record(record)
        self.store.save_contact_record(
            record.model_copy(update={"status": "delivered", "sent_at": self.now})
        )
        row = self.store._connect().execute(
            "SELECT status, sent_at FROM contact_records WHERE decision_id = ?",
            (decision.decision_id,),
        ).fetchone()
        self.assertEqual(row["status"], "delivered")
        self.assertIsNotNone(row["sent_at"])

    def test_idempotent_response(self) -> None:
        record = IdempotentResponse(
            principal_id="user-1",
            operation="mandate.create",
            idempotency_key="idem-key-0001",
            request_hash="a" * 32,
            response={"mandate_id": "MND_x"},
            created_at=self.now,
        )
        self.store.save_idempotent_response(record)
        self.store.save_idempotent_response(record)
        loaded = self.store.get_idempotent_response(
            "user-1", "mandate.create", "idem-key-0001"
        )
        self.assertEqual(loaded.response, {"mandate_id": "MND_x"})
        with self.assertRaises(Conflict):
            self.store.save_idempotent_response(
                record.model_copy(update={"request_hash": "b" * 32})
            )
        self.assertIsNone(
            self.store.get_idempotent_response("user-2", "mandate.create", "idem-key-0001")
        )


class RequestContextTests(unittest.TestCase):
    def test_system_context_and_capabilities(self) -> None:
        context = RequestContext.system("instance-1", "user-1")
        self.assertTrue(context.has("mandate:write"))
        context.require("job:run")
        with self.assertRaises(Unauthorized):
            context.require("admin")
        with self.assertRaises(Unauthorized):
            RequestContext(instance_id="", principal_id="user-1")
        with self.assertRaises(Unauthorized):
            RequestContext(instance_id="instance-1", principal_id="user-1", authenticated=False)


if __name__ == "__main__":
    unittest.main()
