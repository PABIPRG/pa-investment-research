# -*- coding: utf-8 -*-
"""最小闭环测试（Slice 3）：委托 → 事件 → 任务 → 结果 → 联系决定。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_pipeline -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from research_partner.commands import (
    MandateCreateRequest,
    MandateReviseRequest,
    MandateStatusRequest,
    RequirementResolutionRequest,
)
from research_partner.context import RequestContext
from research_partner.factory import build_service
from research_partner.models import ContactRecord, EventEnvelope
from research_partner.pipeline import PartnerPipeline
from research_partner.worker import StubResearchRunner


def key() -> str:
    return "idem_" + secrets.token_hex(8)


def utc() -> datetime:
    return datetime.now(timezone.utc)


class RecordingDispatcher:
    def __init__(self) -> None:
        self.decisions = []

    def dispatch(self, decision) -> ContactRecord:
        self.decisions.append(decision)
        return ContactRecord(
            decision_id=decision.decision_id,
            channel="app",
            status="queued",
            sent_at=None,
            detail="recorded by test",
        )


class FailingDispatcher:
    def dispatch(self, decision) -> ContactRecord:  # pragma: no cover - 只抛错
        raise RuntimeError("channel down")


class PipelineTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "pipeline.db"
        self.now = utc()
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )
        self.dispatcher = RecordingDispatcher()
        self.pipeline = PartnerPipeline(
            self.store,
            runner=StubResearchRunner(now=lambda: self.now),
            dispatcher=self.dispatcher,
            now=lambda: self.now,
        )

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def create_mandate(self, **overrides) -> str:
        data = {
            "goal": "跟踪公告",
            "subjects": [{"entity_id": "company:600519"}],
            "triggers": [{"hook_type": "company.event_available"}],
            "idempotency_key": key(),
        }
        data.update(overrides)
        response = self.service.create(self.ctx, MandateCreateRequest(**data))
        return response["mandate"]["mandate_id"]

    def ingest(
        self,
        event_id: str,
        *,
        subject: str = "company:600519",
        event_type: str | None = None,
        hook_type: str = "company.event_available",
    ) -> bool:
        payload = {"title": "公告"}
        if event_type is not None:
            payload["event_type"] = event_type
        return self.store.record_event(
            EventEnvelope(
                event_id=event_id,
                hook_type=hook_type,
                producer="market-watch",
                occurred_at=self.now,
                observed_at=self.now,
                subject_ids=[subject],
                content_hash="hash-" + event_id,
                payload=payload,
            )
        )

    def decisions(self, mandate_id: str):
        return self.store.list_contact_decisions(mandate_id)

    def jobs(self, mandate_id: str):
        rows = self.store._connect().execute(
            "SELECT * FROM research_jobs WHERE mandate_id = ? ORDER BY created_at, job_id",
            (mandate_id,),
        ).fetchall()
        return rows


class ClosedLoopTests(PipelineTestCase):
    def test_create_ticks_through_to_contact_decision(self) -> None:
        mandate_id = self.create_mandate()
        result = self.pipeline.tick()
        self.assertEqual(result["published"], 1)
        self.assertEqual(result["jobs_created"], 1)
        self.assertEqual(result["jobs_completed"], 1)

        decisions = self.decisions(mandate_id)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].decision, "send")
        self.assertEqual(decisions[0].reason_code, "condition_met")
        self.assertEqual(decisions[0].condition_result, "met")
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_second_tick_is_idempotent(self) -> None:
        mandate_id = self.create_mandate()
        self.pipeline.tick()
        second = self.pipeline.tick()
        self.assertEqual(second["published"], 0)
        self.assertEqual(second["jobs_created"], 0)
        self.assertEqual(second["jobs_completed"], 0)
        self.assertEqual(len(self.decisions(mandate_id)), 1)
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_external_event_creates_job_and_decision(self) -> None:
        mandate_id = self.create_mandate()
        self.pipeline.tick()
        self.assertTrue(self.ingest("evt-001", event_type="announcement"))
        result = self.pipeline.tick()
        self.assertEqual(result["jobs_created"], 1)
        self.assertEqual(len(self.decisions(mandate_id)), 2)

        # 同一 event_id 重复投递不重复建任务/发消息。
        self.assertFalse(self.ingest("evt-001", event_type="announcement"))
        self.pipeline.tick()
        self.assertEqual(len(self.decisions(mandate_id)), 2)
        self.assertEqual(len(self.dispatcher.decisions), 2)

        # 新事件 ID 才产生新的复核。
        self.ingest("evt-002", event_type="announcement")
        self.pipeline.tick()
        self.assertEqual(len(self.decisions(mandate_id)), 3)

    def test_event_type_must_match_dependency(self) -> None:
        mandate_id = self.create_mandate(
            triggers=[
                {
                    "hook_type": "company.event_available",
                    "event_type": "earnings",
                }
            ]
        )
        self.pipeline.tick()
        self.ingest("evt-type-1", event_type="announcement")
        result = self.pipeline.tick()
        self.assertEqual(result["jobs_created"], 0)
        self.assertEqual(len(self.decisions(mandate_id)), 1)

        self.ingest("evt-type-2", event_type="earnings")
        result = self.pipeline.tick()
        self.assertEqual(result["jobs_created"], 1)
        self.assertEqual(len(self.decisions(mandate_id)), 2)

    def test_paused_mandate_ignores_new_events(self) -> None:
        mandate_id = self.create_mandate()
        self.pipeline.tick()
        self.service.pause(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.ingest("evt-paused")
        result = self.pipeline.tick()
        self.assertEqual(result["jobs_created"], 0)
        self.assertEqual(len(self.decisions(mandate_id)), 1)
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_resume_allows_new_events(self) -> None:
        mandate_id = self.create_mandate()
        self.pipeline.tick()
        self.service.pause(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.service.resume(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.ingest("evt-resume")
        self.pipeline.tick()
        self.assertEqual(len(self.decisions(mandate_id)), 2)

    def test_requirements_completion_triggers_baseline(self) -> None:
        response = self.service.create(
            self.ctx,
            MandateCreateRequest(
                goal="跟踪公告",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available"}],
                requirements=[{"code": "confirm", "detail": "确认口径"}],
                idempotency_key=key(),
            ),
        )
        mandate_id = response["mandate"]["mandate_id"]
        requirement_id = response["requirements"][0]["requirement_id"]
        first = self.pipeline.tick()
        self.assertEqual(first["jobs_created"], 0)

        self.service.resolve_requirement(
            self.ctx,
            mandate_id,
            requirement_id,
            RequirementResolutionRequest(resolution="resolved", idempotency_key=key()),
        )
        second = self.pipeline.tick()
        self.assertEqual(second["jobs_created"], 1)
        self.assertEqual(len(self.decisions(mandate_id)), 1)


class ContactSuppressionTests(PipelineTestCase):
    def test_late_result_archived_but_not_sent_after_pause(self) -> None:
        mandate_id = self.create_mandate()
        self.ingest("evt-late")
        self.pipeline.publisher.publish()
        self.pipeline.router.route()
        claimed = self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now)
        event_job = next(job for job in claimed if job.action == "event_review")

        self.service.pause(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        decision = self.pipeline.worker.submit_result(
            event_job.job_id,
            event_job.lease_token,
            run_id="run-late",
            outcome="completed",
            change_summary="迟到的变化",
            contact_suggestion={"should_contact": True},
        )
        self.assertIsNotNone(decision)
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "mandate_not_tracking")
        results = self.store.list_job_results(event_job.job_id)
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].stale)
        self.assertEqual(self.store.get_job(event_job.job_id).status, "cancelled")
        self.assertEqual(self.dispatcher.decisions, [])

    def test_stale_revision_suppressed(self) -> None:
        mandate_id = self.create_mandate()
        self.ingest("evt-stale")
        self.pipeline.publisher.publish()
        self.pipeline.router.route()
        claimed = self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now)
        event_job = next(job for job in claimed if job.action == "event_review")

        self.service.revise(
            self.ctx,
            mandate_id,
            MandateReviseRequest(
                expected_revision=1, goal="调整后的目标", idempotency_key=key()
            ),
        )
        decision = self.pipeline.worker.submit_result(
            event_job.job_id,
            event_job.lease_token,
            run_id="run-stale",
            outcome="completed",
            contact_suggestion={"should_contact": True},
        )
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "stale_revision")
        self.assertEqual(self.dispatcher.decisions, [])

    def test_no_material_change_suppressed(self) -> None:
        pipeline = PartnerPipeline(
            self.store,
            runner=StubResearchRunner(should_contact=False, now=lambda: self.now),
            dispatcher=self.dispatcher,
            now=lambda: self.now,
        )
        mandate_id = self.create_mandate()
        pipeline.tick()
        decisions = self.decisions(mandate_id)
        self.assertEqual(decisions[0].decision, "suppress")
        self.assertEqual(decisions[0].reason_code, "no_material_change")
        self.assertEqual(decisions[0].condition_result, "unmet")
        self.assertEqual(self.dispatcher.decisions, [])

    def test_failed_research_is_not_sent(self) -> None:
        mandate_id = self.create_mandate()
        self.ingest("evt-failed")
        self.pipeline.publisher.publish()
        self.pipeline.router.route()
        claimed = self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now)
        event_job = next(job for job in claimed if job.action == "event_review")
        decision = self.pipeline.worker.submit_result(
            event_job.job_id,
            event_job.lease_token,
            run_id="run-failed",
            outcome="failed",
            contact_suggestion={"should_contact": True},
        )
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "research_failed")
        self.assertEqual(decision.condition_result, "error")

    def test_dispatch_failure_does_not_flip_decision(self) -> None:
        pipeline = PartnerPipeline(
            self.store,
            runner=StubResearchRunner(now=lambda: self.now),
            dispatcher=FailingDispatcher(),
            now=lambda: self.now,
        )
        mandate_id = self.create_mandate()
        pipeline.tick()
        decision = self.decisions(mandate_id)[0]
        self.assertEqual(decision.decision, "send")
        rows = self.store._connect().execute(
            "SELECT status, detail FROM contact_records WHERE decision_id = ?",
            (decision.decision_id,),
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
