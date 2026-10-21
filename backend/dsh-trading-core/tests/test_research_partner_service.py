# -*- coding: utf-8 -*-
"""研究委托命令服务与 HTTP 契约测试（Slice 2）。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_service -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from research_partner.api import create_app
from research_partner.commands import (
    MandateCreateRequest,
    MandateReviseRequest,
    MandateStatusRequest,
    RequirementResolutionRequest,
)
from research_partner.context import RequestContext
from research_partner.errors import Conflict, NotFound
from research_partner.factory import build_service
from research_partner.service import MandateService


def key() -> str:
    return "idem_" + secrets.token_hex(8)


def utc() -> datetime:
    return datetime.now(timezone.utc)


WRITE = frozenset({"mandate:read", "mandate:write"})


class ServiceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "partner.db"
        self.now = utc()
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1", principal_id="user-1", capabilities=WRITE
        )
        self.other = RequestContext(
            instance_id="instance-1", principal_id="user-2", capabilities=WRITE
        )

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def create_request(self, **overrides) -> MandateCreateRequest:
        data = {
            "goal": "跟踪订单与产能变化",
            "subjects": [{"entity_id": "company:600519"}],
            "triggers": [{"hook_type": "company.event_available"}],
            "contact_policy": {"channels": ["app"]},
            "idempotency_key": key(),
        }
        data.update(overrides)
        return MandateCreateRequest(**data)

    def drain_events(self) -> list[str]:
        claimed = self.store.claim_outbox(
            limit=50, now=self.now + timedelta(seconds=1)
        )
        return [item.event_type for item in claimed]


class CreateTests(ServiceTestCase):
    def test_create_without_requirements_is_tracking(self) -> None:
        response = self.service.create(self.ctx, self.create_request())
        self.assertEqual(response["mandate"]["status"], "tracking")
        self.assertEqual(response["mandate"]["current_revision"], 1)
        self.assertEqual(response["revision"]["goal"], "跟踪订单与产能变化")
        self.assertEqual(len(response["subjects"]), 1)
        self.assertEqual(len(response["dependencies"]), 1)
        dependency = response["dependencies"][0]
        self.assertEqual(dependency["hook_type"], "company.event_available")
        self.assertEqual(dependency["subject_id"], "company:600519")
        self.assertCountEqual(self.drain_events(), ["mandate.created"])

    def test_create_with_requirements_blocks_tracking(self) -> None:
        response = self.service.create(
            self.ctx,
            self.create_request(
                requirements=[
                    {"code": "confirm_subject", "detail": "确认跟踪主体"},
                    {"code": "confirm_horizon", "detail": "确认跟踪期限"},
                ]
            ),
        )
        self.assertEqual(response["mandate"]["status"], "pending_requirements")
        self.assertEqual(len(response["requirements"]), 2)
        self.assertTrue(all(item["status"] == "open" for item in response["requirements"]))
        self.assertCountEqual(
            self.drain_events(), ["mandate.created", "mandate.review_requested"]
        )

    def test_global_dependency_when_no_subject(self) -> None:
        response = self.service.create(
            self.ctx,
            self.create_request(subjects=[], triggers=[{"hook_type": "schedule.due"}]),
        )
        self.assertEqual(len(response["dependencies"]), 1)
        self.assertIsNone(response["dependencies"][0]["subject_id"])

    def test_duplicate_triggers_compile_to_one_dependency(self) -> None:
        response = self.service.create(
            self.ctx,
            self.create_request(
                triggers=[
                    {"hook_type": "company.event_available"},
                    {"hook_type": "company.event_available"},
                ]
            ),
        )
        self.assertEqual(len(response["dependencies"]), 1)

    def test_idempotent_retry_returns_same_mandate(self) -> None:
        request = self.create_request()
        first = self.service.create(self.ctx, request)
        second = self.service.create(self.ctx, request)
        self.assertEqual(first["mandate"]["mandate_id"], second["mandate"]["mandate_id"])
        items = self.store.list_mandates("user-1")[0]
        self.assertEqual(len(items), 1)
        self.assertCountEqual(self.drain_events(), ["mandate.created"])

    def test_same_key_different_content_conflicts(self) -> None:
        request = self.create_request()
        self.service.create(self.ctx, request)
        with self.assertRaises(Conflict):
            self.service.create(
                self.ctx,
                request.model_copy(update={"goal": "另一个目标"}),
            )

    def test_principal_isolation(self) -> None:
        response = self.service.create(self.ctx, self.create_request())
        mandate_id = response["mandate"]["mandate_id"]
        with self.assertRaises(NotFound):
            self.service.get(self.other, mandate_id)
        self.assertEqual(self.service.list(self.other)["items"], [])


class RevisionTests(ServiceTestCase):
    def test_revise_replaces_dependencies(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        mandate_id = created["mandate"]["mandate_id"]
        revised = self.service.revise(
            self.ctx,
            mandate_id,
            MandateReviseRequest(
                expected_revision=1,
                goal="改为跟踪毛利",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "schedule.due"}],
                change_summary="目标调整",
                idempotency_key=key(),
            ),
        )
        self.assertEqual(revised["mandate"]["current_revision"], 2)
        self.assertEqual(revised["revision"]["goal"], "改为跟踪毛利")
        self.assertEqual(revised["mandate"]["status"], "tracking")
        self.assertEqual(
            [item["hook_type"] for item in revised["dependencies"]], ["schedule.due"]
        )
        history = self.store.list_dependencies(mandate_id, active_only=False)
        self.assertEqual(len(history), 2)
        self.assertEqual(sum(1 for item in history if item.active), 1)
        self.assertCountEqual(self.drain_events(), ["mandate.created", "mandate.revised"])

    def test_stale_expected_revision_conflicts(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        mandate_id = created["mandate"]["mandate_id"]
        revision = MandateReviseRequest(
            expected_revision=1, goal="第一次调整", idempotency_key=key()
        )
        self.service.revise(self.ctx, mandate_id, revision)
        with self.assertRaises(Conflict):
            self.service.revise(
                self.ctx,
                mandate_id,
                MandateReviseRequest(
                    expected_revision=1, goal="并发调整", idempotency_key=key()
                ),
            )

    def test_revise_adding_requirements_blocks_tracking(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        mandate_id = created["mandate"]["mandate_id"]
        revised = self.service.revise(
            self.ctx,
            mandate_id,
            MandateReviseRequest(
                expected_revision=1,
                goal="补充跟踪口径",
                requirements=[{"code": "confirm_metric", "detail": "确认毛利口径"}],
                idempotency_key=key(),
            ),
        )
        self.assertEqual(revised["mandate"]["status"], "pending_requirements")
        self.assertCountEqual(
            self.drain_events(),
            ["mandate.created", "mandate.revised", "mandate.review_requested"],
        )

    def test_revise_paused_keeps_paused(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        mandate_id = created["mandate"]["mandate_id"]
        self.service.pause(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        revised = self.service.revise(
            self.ctx,
            mandate_id,
            MandateReviseRequest(
                expected_revision=1, goal="暂停期间调整", idempotency_key=key()
            ),
        )
        self.assertEqual(revised["mandate"]["status"], "paused")


class RequirementTests(ServiceTestCase):
    def test_resolving_all_requirements_resumes_tracking(self) -> None:
        created = self.service.create(
            self.ctx,
            self.create_request(
                requirements=[{"code": "confirm_subject", "detail": "确认主体"}]
            ),
        )
        mandate_id = created["mandate"]["mandate_id"]
        requirement_id = created["requirements"][0]["requirement_id"]
        resolved = self.service.resolve_requirement(
            self.ctx,
            mandate_id,
            requirement_id,
            RequirementResolutionRequest(resolution="resolved", idempotency_key=key()),
        )
        self.assertEqual(resolved["requirement"]["status"], "resolved")
        self.assertEqual(resolved["open_requirements"], 0)
        self.assertEqual(resolved["mandate"]["status"], "tracking")
        events = self.drain_events()
        self.assertIn("mandate.requirements_completed", events)

    def test_waiver_also_resolves(self) -> None:
        created = self.service.create(
            self.ctx,
            self.create_request(
                requirements=[{"code": "confirm_subject", "detail": "确认主体"}]
            ),
        )
        mandate_id = created["mandate"]["mandate_id"]
        requirement_id = created["requirements"][0]["requirement_id"]
        resolved = self.service.resolve_requirement(
            self.ctx,
            mandate_id,
            requirement_id,
            RequirementResolutionRequest(resolution="waived", idempotency_key=key()),
        )
        self.assertEqual(resolved["requirement"]["status"], "waived")
        self.assertEqual(resolved["mandate"]["status"], "tracking")

    def test_idempotent_resolution(self) -> None:
        created = self.service.create(
            self.ctx,
            self.create_request(
                requirements=[{"code": "confirm_subject", "detail": "确认主体"}]
            ),
        )
        mandate_id = created["mandate"]["mandate_id"]
        requirement_id = created["requirements"][0]["requirement_id"]
        request = RequirementResolutionRequest(
            resolution="resolved", idempotency_key=key()
        )
        first = self.service.resolve_requirement(
            self.ctx, mandate_id, requirement_id, request
        )
        second = self.service.resolve_requirement(
            self.ctx, mandate_id, requirement_id, request
        )
        self.assertEqual(first["requirement"]["status"], second["requirement"]["status"])
        # 幂等重放不重复发 requirements_completed。
        events = self.drain_events()
        self.assertEqual(events.count("mandate.requirements_completed"), 1)

    def test_unknown_requirement_not_found(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        with self.assertRaises(NotFound):
            self.service.resolve_requirement(
                self.ctx,
                created["mandate"]["mandate_id"],
                "REQ_" + "0" * 32,
                RequirementResolutionRequest(resolution="resolved", idempotency_key=key()),
            )


class StatusTests(ServiceTestCase):
    def test_pause_resume_end(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        mandate_id = created["mandate"]["mandate_id"]
        paused = self.service.pause(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.assertEqual(paused["mandate"]["status"], "paused")
        resumed = self.service.resume(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.assertEqual(resumed["mandate"]["status"], "tracking")
        ended = self.service.end(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.assertEqual(ended["mandate"]["status"], "ended")
        self.assertIsNotNone(ended["mandate"]["ended_at"])
        with self.assertRaises(Conflict):
            self.service.resume(
                self.ctx,
                mandate_id,
                MandateStatusRequest(expected_revision=1, idempotency_key=key()),
            )

    def test_stale_expected_revision_conflicts(self) -> None:
        created = self.service.create(self.ctx, self.create_request())
        mandate_id = created["mandate"]["mandate_id"]
        with self.assertRaises(Conflict):
            self.service.pause(
                self.ctx,
                mandate_id,
                MandateStatusRequest(expected_revision=2, idempotency_key=key()),
            )

    def test_resume_with_open_requirements_stays_pending(self) -> None:
        created = self.service.create(
            self.ctx,
            self.create_request(
                requirements=[{"code": "confirm_subject", "detail": "确认主体"}]
            ),
        )
        mandate_id = created["mandate"]["mandate_id"]
        self.service.pause(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        resumed = self.service.resume(
            self.ctx,
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.assertEqual(resumed["mandate"]["status"], "pending_requirements")


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "api.db"
        self._client_ctx = TestClient(create_app(store_path=path))
        self.client = self._client_ctx.__enter__()
        self.headers = {"X-Principal-Id": "user-1", "X-Instance-Id": "instance-1"}

    def tearDown(self) -> None:
        self._client_ctx.__exit__(None, None, None)
        self._tmp.cleanup()

    def payload(self, **overrides) -> dict:
        data = {
            "goal": "跟踪公告",
            "subjects": [{"entity_id": "company:600519"}],
            "triggers": [{"hook_type": "company.event_available"}],
            "idempotency_key": key(),
        }
        data.update(overrides)
        return data

    def test_health_and_create(self) -> None:
        health = self.client.get("/research/partners/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["service"], "research-partner")

        created = self.client.post(
            "/research/mandates", json=self.payload(), headers=self.headers
        )
        self.assertEqual(created.status_code, 201)
        body = created.json()
        mandate_id = body["mandate"]["mandate_id"]

        fetched = self.client.get(
            f"/research/mandates/{mandate_id}", headers=self.headers
        )
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json()["mandate"]["mandate_id"], mandate_id)

        listed = self.client.get("/research/mandates", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()["items"]), 1)

    def test_conflict_and_not_found(self) -> None:
        payload = self.payload()
        self.client.post("/research/mandates", json=payload, headers=self.headers)
        conflict = self.client.post(
            "/research/mandates",
            json={**payload, "goal": "不同内容"},
            headers=self.headers,
        )
        self.assertEqual(conflict.status_code, 409)

        missing = self.client.get(
            "/research/mandates/MND_" + "0" * 32, headers=self.headers
        )
        self.assertEqual(missing.status_code, 404)

    def test_other_principal_cannot_read(self) -> None:
        created = self.client.post(
            "/research/mandates", json=self.payload(), headers=self.headers
        ).json()
        mandate_id = created["mandate"]["mandate_id"]
        response = self.client.get(
            f"/research/mandates/{mandate_id}",
            headers={"X-Principal-Id": "user-2", "X-Instance-Id": "instance-1"},
        )
        self.assertEqual(response.status_code, 404)

    def test_event_ingest_and_tick_closed_loop(self) -> None:
        created = self.client.post(
            "/research/mandates", json=self.payload(), headers=self.headers
        ).json()
        mandate_id = created["mandate"]["mandate_id"]

        tick = self.client.post("/research/partners/tick", headers=self.headers)
        self.assertEqual(tick.status_code, 200)
        self.assertEqual(tick.json()["jobs_completed"], 1)

        event = {
            "event_id": "evt-api-001",
            "hook_type": "company.event_available",
            "producer": "market-watch",
            "occurred_at": self.now_iso(),
            "observed_at": self.now_iso(),
            "subject_ids": ["company:600519"],
            "payload": {"title": "公告", "event_type": "announcement"},
        }
        accepted = self.client.post("/research/events", json=event)
        self.assertEqual(accepted.status_code, 202)
        self.assertFalse(accepted.json()["duplicate"])
        duplicate = self.client.post("/research/events", json=event)
        self.assertTrue(duplicate.json()["duplicate"])

        tick = self.client.post("/research/partners/tick", headers=self.headers)
        self.assertEqual(tick.json()["jobs_created"], 1)

        decisions = self.client.get(
            f"/research/mandates/{mandate_id}/decisions", headers=self.headers
        )
        self.assertEqual(decisions.status_code, 200)
        self.assertEqual(len(decisions.json()["items"]), 2)

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def test_validation_errors_are_422(self) -> None:
        response = self.client.post(
            "/research/mandates",
            json={"goal": "", "idempotency_key": "short"},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
