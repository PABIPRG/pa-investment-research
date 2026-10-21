# -*- coding: utf-8 -*-
import unittest
from datetime import datetime, timezone

from research_entities.audit import make_event, redact


class AuditTest(unittest.TestCase):
    def test_sensitive_keys_are_redacted_recursively(self):
        payload = {
            "query": "分析贵州茅台",
            "context": {
                "password": "p",
                "nested": [{"api_key": "k"}, {"note": "ok"}],
            },
            "Authorization": "Bearer x",
            "cookie": "c",
        }
        cleaned = redact(payload)
        self.assertEqual(cleaned["query"], "分析贵州茅台")
        self.assertEqual(cleaned["context"]["password"], "[REDACTED]")
        self.assertEqual(cleaned["context"]["nested"][0]["api_key"], "[REDACTED]")
        self.assertEqual(cleaned["context"]["nested"][1]["note"], "ok")
        self.assertEqual(cleaned["Authorization"], "[REDACTED]")
        self.assertEqual(cleaned["cookie"], "[REDACTED]")

    def test_event_has_stable_fields(self):
        created = datetime(2026, 1, 1, tzinfo=timezone.utc)
        event = make_event(
            request_id="REQ_1",
            stage="resolve",
            payload={"token": "x", "n": 1},
            event_id="AUDIT_FIXED",
            created_at=created,
        )
        self.assertEqual(event.event_id, "AUDIT_FIXED")
        self.assertEqual(event.request_id, "REQ_1")
        self.assertEqual(event.created_at, created)
        self.assertEqual(event.payload, {"token": "[REDACTED]", "n": 1})

    def test_event_ids_are_unique_by_default(self):
        first = make_event(request_id="REQ_1", stage="a", payload={})
        second = make_event(request_id="REQ_1", stage="a", payload={})
        self.assertNotEqual(first.event_id, second.event_id)


if __name__ == "__main__":
    unittest.main()
