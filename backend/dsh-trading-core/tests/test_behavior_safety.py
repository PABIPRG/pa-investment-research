# -*- coding: utf-8 -*-
"""行为兴趣与显式风险、预警严重度的安全隔离。"""

import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from adapter.behavior_profile import compute_behavior_profile, effective_aggression
from adapter.personalize import _recent_clicks
from adapter.risk_engine import _md5, _reset_risk_cache_for_tests, risk_alerts
from adapter.store import JsonStore
from adapter.strategies import _str2md5


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


class ExplicitRiskIsolationTests(unittest.TestCase):
    def test_negative_news_clicks_and_positive_outcomes_never_change_risk(self):
        store = _store()
        store.set("behavior", "default", [
            {
                "card_id": f"card-{index}",
                "action": "click",
                "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                "meta": {"ticker": "600519", "direction": "利空"},
            }
            for index in range(20)
        ])

        behavior = compute_behavior_profile(store)

        self.assertEqual(behavior["direction_skew"]["bad_pct"], 1.0)
        self.assertEqual(behavior["aggression_delta"], 0.0)
        self.assertEqual(behavior["feedback_delta"], 0.0)
        self.assertEqual(behavior["outcome_delta"], 0.0)
        self.assertEqual(effective_aggression(store, "conservative"), 0.0)
        self.assertEqual(effective_aggression(store, "balanced"), 0.5)

    def test_legacy_feedback_uses_latest_value_and_unfollow_is_not_positive_interest(self):
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
        store.set("behavior", "events", [{
            "action": "unfollow", "occurred_at": "2026-08-27T00:00:00Z",
            "context": {"ticker": "000001", "industries": ["银行"], "strategy_id": "strategy-1"},
        }])

        with patch("adapter.behavior_profile.time.time", return_value=datetime(
            2026, 8, 27, 1, tzinfo=timezone.utc,
        ).timestamp()):
            behavior = compute_behavior_profile(store)

        self.assertEqual(behavior["feedback"]["useful"], 0)
        self.assertEqual(behavior["feedback"]["useless"], 1)
        self.assertEqual(behavior["focus_tickers"], [])
        self.assertEqual(behavior["industry_affinity"], [])
        self.assertEqual(behavior["strategy_affinity"], [])

    def test_recent_interest_parses_iso_offsets_as_absolute_time(self):
        store = _store()
        store.set("behavior", "events", [{
            "action": "open", "occurred_at": "2026-08-27T08:00:00+08:00",
            "context": {"ticker": "600519"},
        }])

        with patch("adapter.personalize.time.time", return_value=datetime(
            2026, 8, 27, 1, tzinfo=timezone.utc,
        ).timestamp()):
            self.assertEqual(_recent_clicks(store, hours=2), {"600519"})


class AlertSeverityIsolationTests(unittest.TestCase):
    def tearDown(self):
        _reset_risk_cache_for_tests()

    def test_repeated_useless_feedback_never_downgrades_event_alert(self):
        store = _store()
        store.set("holdings", "default", [{"ticker": "600519"}])
        event = {
            "id": "bad-news",
            "direction": "利空",
            "summary": "测试利空事件",
            "time": "2026-08-27 09:00:00",
            "tickers": [{"code": "600519"}],
            "industries": ["白酒"],
        }
        risk_id = "risk-" + _str2md5("event:bad-news")
        upstream = {
            "degraded": False,
            "source": "fresh",
            "error": None,
        }
        _reset_risk_cache_for_tests()

        with patch(
            "adapter.strategies.fetch_events_with_status",
            return_value=([event], upstream),
        ), patch(
            "adapter.risk_engine._feedback_counts",
            return_value={risk_id: {"useful": 0, "useless": 99}},
        ):
            result = risk_alerts(store)

        item = next(row for row in result["items"] if row["id"] == risk_id)
        self.assertEqual(item["source"], "event")
        self.assertEqual(item["severity"], "高")
        self.assertEqual(item["feedback"]["useless"], 99)
        self.assertNotIn("灵敏度已下调", item["detail"])

    def test_shadow_closed_trades_ledger_is_list_of_dicts(self):
        """回归：shadows/trades:{sid} 存的是 list[dict]，必须按 list 读（不能当单个 dict 炸 500）。"""
        store = _store()
        sid = "strat-shadow-a"
        store.set("shadow_equity", "2026-09-02", {
            "strategies": {
                sid: {"name": "影子策略A", "symbols": ["600519"], "nav": 1.02,
                      "closed_count": 2},
            },
            "strategy_errors": {},
        })
        # 与 shadow.py 写入一致：一条 key，值是多笔已平仓 dict 的 list
        store.set("shadows", f"trades:{sid}", [
            {"symbol": "600519", "ret_pct": -3.2},
            {"symbol": "000001", "ret_pct": -1.8},
        ])
        # 影子分支用 risk_engine._md5（12 位），与 event 分支的 strategies._str2md5（10 位）不同
        risk_id = "risk-" + _md5("shadow:closed:" + sid)

        with patch("adapter.strategies.fetch_events_with_status",
                   return_value=([], {"degraded": True, "source": "stale",
                                      "error": None})), patch(
            "adapter.risk_engine._feedback_counts", return_value={}):
            result = risk_alerts(store)

        item = next(row for row in result["items"] if row["id"] == risk_id)
        self.assertEqual(item["source"], "shadow")
        self.assertEqual(item["severity"], "中")
        self.assertEqual(item["strategy_id"], sid)
        # 两笔都计入，net=-5.0 → 明细含累计 -5.0% 与已平仓 2 笔
        self.assertIn("已平仓 2 笔，累计收益 -5.0%", item["detail"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
