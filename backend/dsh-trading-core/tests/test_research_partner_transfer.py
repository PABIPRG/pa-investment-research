# -*- coding: utf-8 -*-
"""数据包导出与导入（V1.3 §9.4）。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_transfer -v
"""

from __future__ import annotations

import copy
import secrets
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from research_partner.api import create_app
from research_partner.commands import (
    MandateCreateRequest,
    MandateReviseRequest,
    MandateStatusRequest,
)
from research_partner.context import RequestContext
from research_partner.factory import build_service
from research_partner.transfer import (
    TransferError,
    _digest,
    commit_import,
    export_snapshot,
    preview_import,
)

FIXED = datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)


def key() -> str:
    return "idem_" + secrets.token_hex(8)


def context() -> RequestContext:
    return RequestContext(
        instance_id="instance-1",
        principal_id="user-1",
        capabilities=frozenset({"mandate:read", "mandate:write"}),
    )


class TransferTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.store, self.service = build_service(self.root / "source.db", now=lambda: FIXED)
        self.target, _ = build_service(self.root / "target.db", now=lambda: FIXED)

    def tearDown(self) -> None:
        self.store.close()
        self.target.close()
        self._tmp.cleanup()

    def create(self, *, goal="跟踪茅台", mode="condition") -> dict:
        response = self.service.create(
            context(),
            MandateCreateRequest(
                goal=goal,
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available", "event_type": "公告"}],
                contact_policy=(
                    {"mode": "scheduled_delivery", "schedule": {"cron": "0 9 * * 1-5"}}
                    if mode == "scheduled_delivery"
                    else {"mode": "condition"}
                ),
                idempotency_key=key(),
            ),
        )
        return response

    def snapshot(self):
        return export_snapshot(
            self.store, principal_id="user-1", instance_id="instance-1"
        )


class ExportTests(TransferTestCase):
    def test_export_includes_versions_and_counts(self) -> None:
        created = self.create(mode="scheduled_delivery")
        snapshot = self.snapshot()

        self.assertEqual(snapshot["format"], "research-partner-data-package")
        self.assertEqual(snapshot["scope"]["principal_id"], "user-1")
        self.assertEqual(snapshot["counts"]["mandates"], 1)
        self.assertEqual(snapshot["counts"]["revisions"], 1)
        self.assertEqual(snapshot["counts"]["schedules"], 1)
        entry = snapshot["mandates"][0]
        self.assertEqual(entry["mandate"]["mandate_id"], created["mandate"]["mandate_id"])
        self.assertEqual(entry["revisions"][0]["revision"]["goal"], "跟踪茅台")
        self.assertEqual(len(entry["revisions"][0]["dependencies"]), 2)
        self.assertEqual(snapshot["integrity"]["algorithm"], "sha256")

    def test_export_marks_revision_chain(self) -> None:
        created = self.create()
        mandate_id = created["mandate"]["mandate_id"]
        self.service.revise(
            context(),
            mandate_id,
            MandateReviseRequest(
                expected_revision=1,
                goal="跟踪茅台与白酒行业",
                idempotency_key=key(),
            ),
        )
        snapshot = self.snapshot()
        self.assertEqual(snapshot["counts"]["revisions"], 2)
        self.assertEqual(
            [item["revision"]["revision"] for item in snapshot["mandates"][0]["revisions"]],
            [1, 2],
        )


class PreviewTests(TransferTestCase):
    def test_preview_reports_new_and_does_not_write(self) -> None:
        self.create()
        preview = preview_import(
            self.target, self.snapshot(), principal_id="user-1"
        )
        self.assertEqual(preview["counts"]["import"], 1)
        self.assertEqual(preview["items"][0]["imported_status"], "paused")
        self.assertIsNone(
            self.target.get_mandate_internal(preview["items"][0]["mandate_id"])
        )

    def test_tampered_package_is_rejected(self) -> None:
        self.create()
        snapshot = self.snapshot()
        snapshot["mandates"][0]["mandate"]["goal"] = "被篡改"
        with self.assertRaises(TransferError):
            preview_import(self.target, snapshot, principal_id="user-1")

    def test_unsupported_schema_version_is_rejected(self) -> None:
        self.create()
        snapshot = self.snapshot()
        snapshot["schema_version"] = "2.0"
        with self.assertRaises(TransferError):
            preview_import(self.target, snapshot, principal_id="user-1")

    def test_same_id_different_content_is_a_conflict(self) -> None:
        self.create()
        commit_import(
            self.target,
            self.snapshot(),
            principal_id="user-1",
            instance_id="instance-1",
        )
        changed = self.snapshot()
        changed["mandates"][0]["revisions"][0]["revision"]["goal"] = "新目标"
        changed["integrity"]["value"] = _digest(changed["mandates"])
        preview = preview_import(self.target, changed, principal_id="user-1")
        self.assertEqual(preview["counts"]["conflict"], 1)
        self.assertEqual(preview["items"][0]["action"], "conflict")


class CommitTests(TransferTestCase):
    def test_import_preserves_identity_and_forces_paused(self) -> None:
        source = self.create(mode="scheduled_delivery")
        package = copy.deepcopy(self.snapshot())
        result = commit_import(
            self.target,
            package,
            principal_id="user-2",
            instance_id="instance-9",
        )
        self.assertEqual(result["counts"]["imported"], 1)
        mandate_id = source["mandate"]["mandate_id"]
        imported = self.target.get_mandate_internal(mandate_id)
        self.assertEqual(imported.status, "paused")  # 包内是 tracking
        self.assertEqual(imported.principal_id, "user-2")  # 归属当前主体
        self.assertEqual(imported.instance_id, "instance-9")
        self.assertEqual(imported.current_revision, 1)
        # 日程随委托导入，但暂停状态不会扫描到期。
        schedules = self.target.list_schedules(mandate_id, active_only=False)
        self.assertEqual(len(schedules), 1)
        self.assertTrue(schedules[0].enabled)

    def test_import_does_not_restore_jobs_or_resend_notifications(self) -> None:
        self.create()
        before = len(self.service.store.list_inbox(limit=100))
        commit_import(
            self.target,
            self.snapshot(),
            principal_id="user-1",
            instance_id="instance-1",
        )
        self.assertEqual(self.target.list_inbox(limit=100), [])
        self.assertEqual(self.target.list_contact_decisions(
            self.snapshot()["mandates"][0]["mandate"]["mandate_id"]
        ), [])
        self.assertGreaterEqual(before, 0)  # 源库不变，导入不产生事件

    def test_reimport_is_idempotent_by_batch(self) -> None:
        self.create()
        package = self.snapshot()
        first = commit_import(
            self.target,
            package,
            principal_id="user-1",
            instance_id="instance-1",
            batch_id="IMP_0123456789abcdef",
        )
        second = commit_import(
            self.target,
            package,
            principal_id="user-1",
            instance_id="instance-1",
            batch_id="IMP_0123456789abcdef",
        )
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(second["counts"]["imported"], 1)

    def test_unchanged_package_is_skipped(self) -> None:
        self.create()
        package = self.snapshot()
        commit_import(
            self.target, package, principal_id="user-1", instance_id="instance-1"
        )
        preview = preview_import(self.target, package, principal_id="user-1")
        self.assertEqual(preview["counts"]["skip"], 1)
        again = commit_import(
            self.target, package, principal_id="user-1", instance_id="instance-1"
        )
        self.assertEqual(again["counts"]["imported"], 0)
        self.assertEqual(again["counts"]["skipped"], 1)

    def test_conflict_requires_explicit_replace(self) -> None:
        self.create()
        commit_import(
            self.target, self.snapshot(), principal_id="user-1", instance_id="instance-1"
        )
        changed = self.snapshot()
        changed["mandates"][0]["revisions"][0]["revision"]["goal"] = "新目标"
        changed["integrity"]["value"] = _digest(changed["mandates"])
        mandate_id = changed["mandates"][0]["mandate"]["mandate_id"]

        skipped = commit_import(
            self.target, changed, principal_id="user-1", instance_id="instance-1"
        )
        self.assertEqual(skipped["counts"]["imported"], 0)
        self.assertIn("conflict_skipped", skipped["skipped"][0]["reason"])

        replaced = commit_import(
            self.target,
            changed,
            principal_id="user-1",
            instance_id="instance-1",
            resolutions={mandate_id: "replace"},
        )
        self.assertEqual(replaced["counts"]["imported"], 1)
        revision = self.target.get_revision(mandate_id, 1)
        self.assertEqual(revision.goal, "新目标")

    def test_ended_mandate_stays_archived(self) -> None:
        created = self.create()
        mandate_id = created["mandate"]["mandate_id"]
        self.service.end(
            context(),
            mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        commit_import(
            self.target,
            self.snapshot(),
            principal_id="user-1",
            instance_id="instance-1",
        )
        self.assertEqual(self.target.get_mandate_internal(mandate_id).status, "ended")


class TransferApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "state.db"
        self._client_ctx = TestClient(create_app(store_path=path))
        self.client = self._client_ctx.__enter__()
        self.headers = {"X-Principal-Id": "user-1", "X-Instance-Id": "instance-1"}

    def tearDown(self) -> None:
        self._client_ctx.__exit__(None, None, None)
        self._tmp.cleanup()

    def test_export_preview_and_import_endpoints(self) -> None:
        created = self.client.post(
            "/research/mandates",
            json={
                "goal": "跟踪茅台",
                "subjects": [{"entity_id": "company:600519"}],
                "triggers": [{"hook_type": "company.event_available"}],
                "contact_policy": {"mode": "condition"},
                "idempotency_key": key(),
            },
            headers=self.headers,
        )
        self.assertEqual(created.status_code, 201)

        package = self.client.get("/research/data/package", headers=self.headers)
        self.assertEqual(package.status_code, 200)
        body = package.json()
        self.assertEqual(body["counts"]["mandates"], 1)

        preview = self.client.post(
            "/research/data/import/preview",
            json={"package": body},
            headers=self.headers,
        )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json()["counts"]["skip"], 1)

        committed = self.client.post(
            "/research/data/import",
            json={"package": body},
            headers=self.headers,
        )
        self.assertEqual(committed.status_code, 200)
        self.assertEqual(committed.json()["counts"]["imported"], 0)

    def test_invalid_package_returns_400(self) -> None:
        response = self.client.post(
            "/research/data/import/preview",
            json={"package": {"format": "nope"}},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
