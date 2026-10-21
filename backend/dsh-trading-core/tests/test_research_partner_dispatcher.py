# -*- coding: utf-8 -*-
"""联系决定的真实投递适配器：通知事件映射与通知中心渲染。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_dispatcher -v
"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from research_partner.dispatcher import NotificationCenterDispatcher
from research_partner.models import ContactDecision
from adapter.notifications.models import NotificationEvent
from adapter.notifications.service import _render

NOW = datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)


def decision() -> ContactDecision:
    return ContactDecision(
        decision_id="DEC_" + "a" * 32,
        mandate_id="MND_" + "b" * 32,
        mandate_revision=2,
        job_id="JOB_1",
        decision="send",
        reason_code="condition_met",
        condition_result="met",
        detail="茅台发布回购公告，跌破你约定的估值区间。",
        dedupe_key="job:JOB_1:condition",
        condition_key="valuation",
        created_at=NOW,
    )


class EnvelopeTests(unittest.TestCase):
    def test_decision_maps_to_registered_notification_event(self) -> None:
        dispatcher = NotificationCenterDispatcher("http://127.0.0.1:8000", "secret")
        envelope = dispatcher.envelope(decision())
        self.assertEqual(envelope["type"], "research.contact.send.v1")
        self.assertEqual(envelope["eventId"], "research-contact:DEC_" + "a" * 32)
        self.assertEqual(envelope["subject"], {"kind": "mandate", "id": "MND_" + "b" * 32})
        self.assertEqual(envelope["payload"]["mandateRevision"], 2)
        self.assertEqual(envelope["payload"]["decisionId"], "DEC_" + "a" * 32)
        self.assertEqual(envelope["occurredAt"], "2026-10-21T07:00:00+00:00")

    def test_notification_center_renders_research_category(self) -> None:
        dispatcher = NotificationCenterDispatcher("http://127.0.0.1:8000", "secret")
        event = NotificationEvent.from_mapping(dispatcher.envelope(decision()))
        rendered = _render(event)
        self.assertEqual(rendered["category"], "research")
        self.assertEqual(rendered["title"], "研究委托有新进展")
        self.assertIn("回购", rendered["summary"])
        self.assertEqual(
            rendered["dedupeKey"],
            "research.contact.send.v1:DEC_" + "a" * 32,
        )
        self.assertEqual(rendered["action"]["kind"], "mandate")


class DispatchTests(unittest.TestCase):
    def test_dispatch_posts_with_internal_token(self) -> None:
        response = Mock(content=b"{}")
        response.json.return_value = {"id": "notification-1"}
        session = Mock()
        session.post.return_value = response
        dispatcher = NotificationCenterDispatcher(
            "http://127.0.0.1:8000/", "secret", session=session
        )
        record = dispatcher.dispatch(decision())
        self.assertEqual(record.channel, "browser")
        self.assertEqual(record.status, "queued")
        self.assertEqual(record.delivery_job_id, "notification-1")
        self.assertEqual(
            session.post.call_args.args[0],
            "http://127.0.0.1:8000/internal/notification-events",
        )
        self.assertEqual(
            session.post.call_args.kwargs["headers"]["X-Notification-Token"], "secret"
        )

    def test_duplicate_is_reported_as_duplicate(self) -> None:
        response = Mock(content=b"{}")
        response.json.return_value = {"id": "notification-1", "duplicate": True}
        session = Mock()
        session.post.return_value = response
        record = NotificationCenterDispatcher(
            "http://127.0.0.1:8000", "secret", session=session
        ).dispatch(decision())
        self.assertEqual(record.status, "duplicate")

    def test_http_error_raises_for_contact_service_to_record(self) -> None:
        session = Mock()
        session.post.return_value = Mock(raise_for_status=Mock(side_effect=OSError("down")))
        with self.assertRaises(OSError):
            NotificationCenterDispatcher(
                "http://127.0.0.1:8000", "secret", session=session
            ).dispatch(decision())

    def test_missing_endpoint_or_token_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            NotificationCenterDispatcher("", "secret")
        with self.assertRaises(ValueError):
            NotificationCenterDispatcher("http://127.0.0.1:8000", " ")


class WiringTests(unittest.TestCase):
    def test_default_dispatcher_requires_both_settings(self) -> None:
        from research_partner.api import _default_dispatcher

        with patch.dict(
            os.environ,
            {"RESEARCH_NOTIFICATION_URL": "", "NOTIFICATION_INTERNAL_TOKEN": "x"},
            clear=False,
        ):
            self.assertIsNone(_default_dispatcher())
        with patch.dict(
            os.environ,
            {
                "RESEARCH_NOTIFICATION_URL": "http://127.0.0.1:8000",
                "NOTIFICATION_INTERNAL_TOKEN": "x",
            },
            clear=False,
        ):
            dispatcher = _default_dispatcher()
        self.assertIsNotNone(dispatcher)
        self.assertEqual(dispatcher.endpoint, "http://127.0.0.1:8000")


if __name__ == "__main__":
    unittest.main()
