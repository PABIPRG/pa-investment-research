# -*- coding: utf-8 -*-
"""0.1.0-rc.8 本地学习事实、治理、复盘与接口契约。"""

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")

from fastapi.testclient import TestClient
from pydantic import ValidationError

from adapter.app import create_app
from adapter.config import settings
from adapter.local_telemetry import (
    build_preference_review,
    clear_local_learning,
    local_learning_status,
    record_events,
    record_feedback,
    update_local_learning,
)
from adapter.schemas import (
    LocalLearningEvent,
    LocalLearningSettingsRequest,
    PersonalizedFeedbackRequest,
    PersonalizedInteractionRequest,
)
from adapter.store import JsonStore


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


def _at(value: str):
    instant = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    return lambda: instant


def _event(event_id: str, *, action: str = "open", context: dict | None = None) -> dict:
    return {
        "event_id": event_id,
        "schema_version": 1,
        "action": action,
        "surface": "dashboard",
        "target_type": "event",
        "target_id": "event-1",
        "session_id": "session-1",
        "context": context or {"ticker": "600519.SH", "industries": ["白酒"]},
    }


class EventGovernanceTests(unittest.TestCase):
    def test_server_time_and_event_id_make_retries_idempotent(self):
        store = _store()
        result = record_events(store, [_event("event-1")], now=_at("2026-08-27T01:02:03"))
        duplicate = record_events(store, [_event("event-1")], now=_at("2026-08-27T02:00:00"))

        self.assertEqual(result["stored"], 1)
        self.assertEqual(duplicate["stored"], 0)
        self.assertEqual(duplicate["duplicates"], 1)
        rows = store.get("behavior", "events")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["occurred_at"], "2026-08-27T01:02:03Z")
        self.assertNotIn("client_ts", rows[0])

    def test_schema_rejects_unknown_and_sensitive_metadata(self):
        for key in ("query", "title", "prompt", "holdings", "cost", "url", "path", "api_key"):
            with self.subTest(key=key), self.assertRaises(ValidationError):
                LocalLearningEvent(**_event("event-1", context={key: "secret"}))
        with self.assertRaises(ValidationError):
            LocalLearningEvent(**{**_event("event-2"), "occurred_at": "2026-08-27"})
        with self.assertRaises(ValidationError):
            LocalLearningEvent(**{**_event("event-3"), "target_id": "用户搜索 贵州茅台"})
        with self.assertRaises(ValidationError):
            PersonalizedFeedbackRequest(card_id="一段卡片标题", sentiment="useful")
        with self.assertRaises(ValidationError):
            PersonalizedFeedbackRequest(
                card_id="card-1", sentiment="useful", prompt="不应被静默忽略",
            )
        with self.assertRaises(ValidationError):
            PersonalizedInteractionRequest(
                card_id="card-1", action="click", query="不应被静默忽略",
            )
        with self.assertRaises(ValidationError):
            LocalLearningEvent(**_event("event-4", context={"direction": "很看好"}))
        with self.assertRaises(ValidationError):
            LocalLearningSettingsRequest(enabled="false")
        with self.assertRaises(ValidationError):
            LocalLearningEvent(**{**_event("event-5"), "schema_version": "1"})

    def test_batch_is_atomic_when_one_event_is_invalid(self):
        store = _store()
        invalid = {**_event("event-2"), "context": {"query": "不应保存"}}
        with self.assertRaisesRegex(ValueError, "未允许字段"):
            record_events(store, [_event("event-1"), invalid])
        self.assertEqual(store.get("behavior", "events"), None)
        with self.assertRaisesRegex(ValueError, "event_id 必须是字符串"):
            record_events(store, [{**_event("event-3"), "event_id": 3}])

    def test_time_and_count_retention_are_both_enforced(self):
        store = _store()
        store.set("behavior", "events", [
            {**_event("expired"), "occurred_at": "2026-01-01T00:00:00Z"},
        ])
        with patch.object(settings, "local_learning_event_cap", 2):
            record_events(store, [_event("fresh-1"), _event("fresh-2")], now=_at("2026-08-27T00:00:00"))
            record_events(store, [_event("fresh-3")], now=_at("2026-08-27T00:01:00"))
        rows = store.get("behavior", "events")
        self.assertEqual([row["event_id"] for row in rows], ["fresh-3", "fresh-1"])
        self.assertNotIn("expired", {row["event_id"] for row in rows})

    def test_count_limit_is_shared_by_events_interactions_and_feedback(self):
        store = _store()
        with patch.object(settings, "local_learning_event_cap", 2):
            record_events(store, [_event("event-1")], now=_at("2026-08-25T00:00:00"))
            record_feedback(store, "card-1", "useful", now=_at("2026-08-26T00:00:00"))
            record_events(store, [_event("event-2")], now=_at("2026-08-27T00:00:00"))
            status = local_learning_status(store, now=_at("2026-08-27T01:00:00"))

        self.assertEqual(status["record_count"], 2)
        self.assertEqual(status["event_count"], 1)
        self.assertEqual(status["feedback_count"], 1)
        self.assertEqual(store.get("behavior", "events")[0]["event_id"], "event-2")

    def test_status_prunes_expired_records_without_waiting_for_another_write(self):
        store = _store()
        store.set("behavior", "events", [
            {**_event("expired"), "occurred_at": "2026-01-01T00:00:00Z"},
        ])

        status = local_learning_status(store, now=_at("2026-08-27T00:00:00"))

        self.assertEqual(status["record_count"], 0)
        self.assertEqual(store.get("behavior", "events"), [])

    def test_pause_stops_new_facts_without_breaking_calls(self):
        store = _store()
        status = update_local_learning(store, False, now=_at("2026-08-27T00:00:00"))
        result = record_events(store, [_event("paused")])
        feedback = record_feedback(store, "card-1", "useful")

        self.assertFalse(status["enabled"])
        self.assertEqual(result["reason"], "paused")
        self.assertFalse(feedback["stored"])
        self.assertEqual(local_learning_status(store)["event_count"], 0)

    def test_feedback_correction_keeps_only_the_last_value(self):
        store = _store()
        first = record_feedback(
            store, "risk-1", "useful", {"risk_source": "event", "ticker": "600519.SH"},
            now=_at("2026-08-26T00:00:00"),
        )
        second = record_feedback(
            store, "risk-1", "useless", {"risk_source": "event", "ticker": "600519.SH"},
            now=_at("2026-08-27T00:00:00"),
        )

        self.assertFalse(first["replaced"])
        self.assertTrue(second["replaced"])
        rows = store.get("behavior", "default")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sentiment"], "useless")

    def test_clear_is_scoped_to_learning_data(self):
        store = _store()
        store.set("holdings", "default", [{"ticker": "600519", "quantity": 10}])
        store.set("preferences", "risk_profile", "conservative")
        record_events(store, [_event("event-1")])
        record_feedback(store, "card-1", "useful", {"ticker": "600519.SH"})

        result = clear_local_learning(store)

        self.assertEqual(result["deleted_total"], 2)
        self.assertEqual(store.get("behavior", "events"), [])
        self.assertEqual(store.get("behavior", "default"), [])
        self.assertEqual(store.get("preferences", "risk_profile"), "conservative")
        self.assertEqual(store.get("holdings", "default")[0]["quantity"], 10)


class PreferenceReviewTests(unittest.TestCase):
    def test_review_prunes_to_retention_before_reading_a_longer_window(self):
        store = _store()
        record_events(store, [_event("old-event")], now=_at("2026-06-01T00:00:00"))

        with patch.object(settings, "local_learning_retention_days", 30):
            review = build_preference_review(store, 90, now=_at("2026-08-27T00:00:00"))

        self.assertEqual(review["overview"]["signal_count"], 0)
        self.assertEqual(review["status"]["record_count"], 0)
        self.assertEqual(store.get("behavior", "events"), [])

    def test_review_uses_latest_feedback_even_when_legacy_rows_are_unsorted(self):
        store = _store()
        store.set("behavior", "default", [
            {
                "card_id": "card-1", "action": "feedback", "sentiment": "useful",
                "server_ts": "2026-08-25T00:00:00Z", "meta": {"ticker": "600519"},
            },
            {
                "card_id": "card-1", "action": "feedback", "sentiment": "useless",
                "server_ts": "2026-08-26T00:00:00Z", "meta": {"ticker": "600519"},
            },
        ])

        review = build_preference_review(store, 7, now=_at("2026-08-27T00:00:00"))

        self.assertEqual(review["overview"]["feedback"], 1)
        self.assertIn("减少此类", review["recent_activity"][0]["label"])

    def test_small_sample_reports_insufficient_data(self):
        store = _store()
        record_events(store, [_event("event-1")], now=_at("2026-08-27T00:00:00"))
        review = build_preference_review(store, 7, now=_at("2026-08-27T01:00:00"))

        self.assertFalse(review["enough_data"])
        self.assertEqual(review["insights"], [])
        self.assertIn("数据不足", review["data_note"])
        self.assertIsNone(review["funnel"]["open_rate"])

    def test_review_is_deterministic_and_explains_interest_only(self):
        store = _store()
        store.set("preferences", "risk_profile", "conservative")
        record_events(store, [_event("event-1")], now=_at("2026-08-25T08:00:00"))
        record_events(store, [_event("event-2", action="analyze")], now=_at("2026-08-26T08:00:00"))
        record_events(store, [_event("event-3")], now=_at("2026-08-27T08:00:00"))

        first = build_preference_review(store, 7, now=_at("2026-08-27T09:00:00"))
        second = build_preference_review(store, 7, now=_at("2026-08-27T09:00:00"))

        self.assertTrue(first["enough_data"])
        self.assertEqual(first["snapshot_id"], second["snapshot_id"])
        self.assertEqual(first["insights"], second["insights"])
        self.assertEqual(first["top_tickers"][0]["ticker"], "600519.SH")
        self.assertIn("不改变风险承受能力", first["insights"][0]["safety_note"])
        self.assertEqual(first["explicit_risk_profile"]["key"], "conservative")
        self.assertEqual(first["explicit_risk_profile"]["behavior_adjustment"], 0)


class LocalLearningRouteTests(unittest.TestCase):
    def test_routes_validate_and_use_the_local_store(self):
        store = _store()
        app = create_app()
        with patch("adapter.app.JsonStore", return_value=store), TestClient(app) as client:
            posted = client.post("/personalized/local-learning/events", json={
                "events": [_event("route-event")],
            })
            review = client.get("/personalized/review", params={"days": 7})
            invalid = client.get("/personalized/review", params={"days": 8})
            clear_without_confirmation = client.post(
                "/personalized/local-learning/clear", json={"confirm": False},
            )

        self.assertEqual(posted.status_code, 200)
        self.assertEqual(posted.json()["stored"], 1)
        self.assertEqual(review.status_code, 200)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(clear_without_confirmation.status_code, 422)


if __name__ == "__main__":
    unittest.main(verbosity=2)
