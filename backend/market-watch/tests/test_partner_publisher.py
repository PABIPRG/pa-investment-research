# -*- coding: utf-8 -*-
"""委托核心事件产生方：新闻、行情异动、持仓风险的统一信封与接管行为。"""

from __future__ import annotations

import os
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault("MW_SCHEDULE_ENABLED", "false")

from market_watch import partner_publisher
from market_watch.notification_publisher import center_enabled
from market_watch.partner_publisher import (
    news_envelope,
    news_hook_type,
    price_alert_envelope,
    publish_event,
    publish_news_events,
    risk_envelope,
)


class NewsEnvelopeTests(unittest.TestCase):
    def event(self, **overrides):
        base = {
            "id": "ev-abc123",
            "item_id": "flash-1",
            "type": "公告",
            "tickers": [{"name": "贵州茅台", "code": "600519"}],
            "industries": ["白酒"],
            "direction": "利好",
            "summary": "公司发布回购公告",
            "title": "贵州茅台回购",
            "time": "2026-10-21 09:30:00",
            "source": "财联社",
            "url": "https://example.com/1",
        }
        base.update(overrides)
        return base

    def test_company_type_uses_company_hook_and_entities(self):
        envelope = news_envelope(self.event())
        self.assertEqual(envelope["hook_type"], "company.event_available")
        self.assertEqual(envelope["event_id"], "news:ev-abc123")
        self.assertIn("company:600519", envelope["subject_ids"])
        self.assertIn("security:600519", envelope["subject_ids"])
        self.assertIn("industry:白酒", envelope["subject_ids"])
        self.assertEqual(envelope["payload"]["event_type"], "公告")
        self.assertEqual(envelope["producer"], "market-watch")
        self.assertEqual(envelope["occurred_at"], "2026-10-21T09:30:00+08:00")

    def test_industry_and_market_types_use_their_hooks(self):
        self.assertEqual(news_hook_type("政策"), "industry.event_available")
        self.assertEqual(news_hook_type("产业"), "industry.event_available")
        self.assertEqual(news_hook_type("价格异动"), "market.condition_changed")
        self.assertEqual(news_hook_type("其他"), "news.item_available")

    def test_unlisted_company_uses_name_as_stable_subject(self):
        envelope = news_envelope(
            self.event(tickers=[{"name": "某未上市公司", "code": ""}])
        )
        self.assertIn("company:某未上市公司", envelope["subject_ids"])
        self.assertEqual(envelope["hook_type"], "company.event_available")

    def test_event_identity_and_hash_are_deterministic(self):
        first = news_envelope(self.event())
        second = news_envelope(self.event())
        self.assertEqual(first["event_id"], second["event_id"])
        self.assertEqual(first["content_hash"], second["content_hash"])

        changed = news_envelope(self.event(summary="完全不同的内容"))
        self.assertEqual(changed["event_id"], first["event_id"])  # 来源事实标识稳定
        self.assertNotEqual(changed["content_hash"], first["content_hash"])

    def test_unparseable_time_falls_back_to_now_with_timezone(self):
        envelope = news_envelope(self.event(time="09:30"))
        self.assertRegex(envelope["occurred_at"], r"\+08:00$")


class PriceAndRiskEnvelopeTests(unittest.TestCase):
    def test_price_alert_uses_market_condition_hook(self):
        trigger = {
            "rule_id": "rule-1",
            "code": "600519",
            "ts": "2026-10-21T10:00:00+08:00",
            "name": "贵州茅台",
            "rule_name": "跌幅预警",
            "condition_text": "日内跌幅达到 3%",
            "price": 1400.0,
            "value": -3.1,
        }
        envelope = price_alert_envelope(trigger)
        self.assertEqual(envelope["hook_type"], "market.condition_changed")
        self.assertEqual(
            envelope["event_id"], "price-alert:rule-1:600519:2026-10-21T10:00:00+08:00"
        )
        self.assertEqual(envelope["subject_ids"], ["company:600519", "security:600519"])
        self.assertEqual(envelope["payload"]["event_type"], "price_alert")
        self.assertEqual(envelope["payload"]["rule_id"], "rule-1")

    def test_risk_hit_uses_risk_condition_hook(self):
        event = {
            "event_id": "position-risk-hit:abc",
            "ticker": "002518",
            "kind": "stop_loss",
            "rule_id": "rule-2",
            "price": 18.2,
            "observed_at": "2026-10-21T14:30:00+08:00",
            "quote_source": "eastmoney",
            "freshness": "fresh",
            "config_version": 3,
            "generation": 2,
        }
        envelope = risk_envelope(event)
        self.assertEqual(envelope["hook_type"], "risk.condition_changed")
        self.assertEqual(envelope["event_id"], "risk:position-risk-hit:abc")
        self.assertEqual(envelope["payload"]["kind"], "stop_loss")
        self.assertEqual(envelope["payload"]["freshness"], "fresh")


class PublishTests(unittest.TestCase):
    def test_publish_posts_unified_envelope(self):
        response = Mock()
        response.content = b"{}"
        response.json.return_value = {"accepted": True, "duplicate": False}
        envelope = news_envelope({"id": "ev-1", "type": "其他", "time": "2026-10-21"})
        with patch.object(partner_publisher.settings, "research_partner_url", "http://127.0.0.1:8301"), \
             patch.object(partner_publisher.requests, "post", return_value=response) as post:
            result = publish_event(envelope)
        self.assertTrue(result["ok"])
        self.assertEqual(post.call_args.args[0], "http://127.0.0.1:8301/research/events")
        self.assertEqual(post.call_args.kwargs["json"]["event_id"], envelope["event_id"])

    def test_publish_failure_never_raises(self):
        envelope = news_envelope({"id": "ev-2", "type": "其他", "time": "2026-10-21"})
        with patch.object(partner_publisher.settings, "research_partner_url", "http://127.0.0.1:8301"), \
             patch.object(partner_publisher.requests, "post", side_effect=OSError("offline")):
            result = publish_event(envelope)
        self.assertFalse(result["ok"])
        self.assertIn("offline", result["error"])

    def test_disabled_partner_skips_instead_of_failing(self):
        with patch.object(partner_publisher.settings, "research_partner_url", ""):
            self.assertTrue(publish_event({"event_id": "x"})["skipped"])

    def test_news_events_are_deduplicated_by_local_cursor(self):
        events = [{"id": "ev-a", "type": "公告", "time": "2026-10-21"}]
        with patch.object(partner_publisher.settings, "research_partner_url", "http://127.0.0.1:8301"), \
             patch.object(partner_publisher.requests, "post", return_value=Mock(content=b"{}", **{"json.return_value": {}})) as post, \
             patch.object(partner_publisher, "_delivered", side_effect=[set(), {"news:ev-a"}]), \
             patch.object(partner_publisher, "_mark_delivered"):
            first = publish_news_events(events)
            second = publish_news_events(events)
        self.assertEqual(first["published"], 1)
        self.assertEqual(second["published"], 0)
        self.assertEqual(post.call_count, 1)


class TakeoverTests(unittest.TestCase):
    def test_configured_partner_disables_center_outlet(self):
        with patch.object(partner_publisher.settings, "research_partner_url", "http://127.0.0.1:8301"), \
             patch.object(partner_publisher.settings, "notification_mode", "auto"), \
             patch.object(partner_publisher.settings, "notification_internal_token", "secret"):
            self.assertFalse(center_enabled())

    def test_explicit_partner_mode_disables_center_outlet(self):
        with patch.object(partner_publisher.settings, "research_partner_url", ""), \
             patch.object(partner_publisher.settings, "notification_mode", "partner"):
            self.assertFalse(center_enabled())

    def test_legacy_center_still_works_without_partner(self):
        with patch.object(partner_publisher.settings, "research_partner_url", ""), \
             patch.object(partner_publisher.settings, "notification_mode", "center"):
            self.assertTrue(center_enabled())


if __name__ == "__main__":
    unittest.main()
