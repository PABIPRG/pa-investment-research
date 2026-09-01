# -*- coding: utf-8 -*-

import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from adapter.app import create_app
from adapter.report_store import ReportStore
from adapter.research_chat_context import (
    ResearchChatRevisionConflict,
    save_research_chat_context,
)
from adapter.schemas import ResearchChatContextSaveRequest
from adapter.store import JsonStore


SESSION_ID = "session-1"
STRATEGY_ID = "strategy-1"


def stock() -> dict:
    return {
        "code": "600519",
        "name": "贵州茅台",
        "market": "沪市",
        "type": "stock",
    }


def save_body(
    revision: int,
    strategy_id: str | None = STRATEGY_ID,
    instrument: dict | None = None,
) -> dict:
    return {
        "expected_revision": revision,
        "strategy_id": strategy_id,
        "instrument": stock() if instrument is None else instrument,
    }


class ResearchChatContextHttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))
        self.store.set("strategies", STRATEGY_ID, {
            "id": STRATEGY_ID,
            "name": "稳健趋势策略",
            "status": "active",
            "verification_status": "passed",
            "created_at": "2026-09-01T08:00:00Z",
        })
        self.store_patch = patch("adapter.app.JsonStore", return_value=self.store)
        self.store_patch.start()
        self.client = TestClient(create_app(report_store=ReportStore(self.store))).__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.store_patch.stop()
        self.temporary.cleanup()

    def test_unseen_session_returns_explicit_empty_context(self):
        response = self.client.get(f"/research-chat/contexts/{SESSION_ID}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"exists": False, "context": None})

    def test_save_and_read_round_trip_uses_server_revision(self):
        saved = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json=save_body(0),
        )

        self.assertEqual(saved.status_code, 200)
        context = saved.json()
        self.assertEqual(context["schema_version"], 1)
        self.assertEqual(context["session_id"], SESSION_ID)
        self.assertEqual(context["strategy_id"], STRATEGY_ID)
        self.assertEqual(context["instrument"], stock())
        self.assertEqual(context["revision"], 1)
        self.assertRegex(context["updated_at"], r"^\d{4}-\d{2}-\d{2}T")

        loaded = self.client.get(f"/research-chat/contexts/{SESSION_ID}")
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json(), {"exists": True, "context": context})

    def test_clear_keeps_revision_tombstone_and_rejects_stale_write(self):
        first = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json=save_body(0),
        )
        self.assertEqual(first.status_code, 200)

        cleared = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json={
                "expected_revision": 1,
                "strategy_id": None,
                "instrument": None,
            },
        )
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(cleared.json()["revision"], 2)
        self.assertIsNone(cleared.json()["strategy_id"])
        self.assertIsNone(cleared.json()["instrument"])

        stale = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json=save_body(0),
        )
        self.assertEqual(stale.status_code, 409)
        detail = stale.json()["detail"]
        self.assertEqual(detail["code"], "revision_conflict")
        self.assertEqual(detail["current_revision"], 2)

        loaded = self.client.get(f"/research-chat/contexts/{SESSION_ID}").json()
        self.assertEqual(loaded["context"]["revision"], 2)
        self.assertIsNone(loaded["context"]["strategy_id"])

    def test_concurrent_compare_and_swap_allows_exactly_one_writer(self):
        barrier = threading.Barrier(2)

        def save_once():
            barrier.wait()
            return save_research_chat_context(
                self.store,
                SESSION_ID,
                ResearchChatContextSaveRequest(**save_body(0)),
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(save_once) for _ in range(2)]

        successes = []
        conflicts = []
        for future in futures:
            try:
                successes.append(future.result())
            except ResearchChatRevisionConflict as exc:
                conflicts.append(exc)

        self.assertEqual(len(successes), 1)
        self.assertEqual(successes[0]["revision"], 1)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0].current_revision, 1)

    def test_missing_strategy_is_rejected_without_writing_context(self):
        response = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json=save_body(0, strategy_id="missing-strategy"),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "策略不存在")
        self.assertEqual(
            self.client.get(f"/research-chat/contexts/{SESSION_ID}").json(),
            {"exists": False, "context": None},
        )

    def test_request_rejects_unknown_fields_and_invalid_instrument(self):
        unknown = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json={**save_body(0), "arbitrary_url": "https://example.com"},
        )
        invalid_code = self.client.post(
            f"/research-chat/contexts/{SESSION_ID}",
            json=save_body(0, instrument={
                "code": "BTC",
                "name": "Bitcoin",
                "market": "crypto",
                "type": "crypto",
            }),
        )

        self.assertEqual(unknown.status_code, 422)
        self.assertEqual(invalid_code.status_code, 422)

    def test_session_id_is_restricted_to_safe_path_characters(self):
        response = self.client.get("/research-chat/contexts/session%20with%20spaces")

        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
