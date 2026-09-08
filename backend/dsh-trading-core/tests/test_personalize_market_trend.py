# -*- coding: utf-8 -*-
"""首页主列表补入大盘趋势事件：match 模式只豁免 政策/宏观 fresh，其余 fresh 仍丢弃。"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from adapter.personalize import build_cards
from adapter.store import JsonStore


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


def _ev(ev_id: str, ev_type: str, tickers=None, direction: str = "中性"):
    return {
        "id": ev_id, "item_id": f"item-{ev_id}", "type": ev_type,
        "tickers": tickers or [], "industries": [], "direction": direction,
        "summary": f"{ev_type} 示例事件", "title": f"{ev_type} 标题",
        "time": "", "source": "测试源", "url": "",
    }


class MarketTrendCardTests(unittest.TestCase):
    def setUp(self):
        self.store = _store()
        self.store.set("holdings", "default", [{"ticker": "600519"}])
        self.events = [
            _ev("hit-hold", "业绩", [{"code": "600519", "name": "贵州茅台"}]),   # 命中持仓
            _ev("trend-policy", "政策"),                                          # 大盘政策 fresh
            _ev("trend-macro", "宏观"),                                           # 大盘宏观 fresh
            _ev("noise-earn", "业绩"),                                            # 普通 fresh（应被丢弃）
        ]

    def test_match_only_keeps_policy_and_macro_fresh_but_drops_other_fresh(self):
        with patch("adapter.strategies.fetch_events", return_value=self.events):
            result = build_cards(self.store, limit=30, bucket="all", match_only=True)

        kept = result["cards"]
        buckets = {c["bucket"] for c in kept}
        # 命中卡保留（holdings 桶）
        self.assertIn("holdings", buckets)
        hit = next(c for c in kept if c["event_id"] == "hit-hold")
        self.assertEqual(hit["bucket"], "holdings")
        # 大盘趋势政策/宏观进入主列表（仍归 fresh 桶）
        kept_ids = {c["event_id"] for c in kept}
        self.assertIn("trend-policy", kept_ids)
        self.assertIn("trend-macro", kept_ids)
        # 普通 fresh（未命中、非政策/宏观）在 match 模式下仍丢弃
        self.assertNotIn("noise-earn", kept_ids)

    def test_without_match_all_fresh_are_kept(self):
        with patch("adapter.strategies.fetch_events", return_value=self.events):
            result = build_cards(self.store, limit=30, bucket="all", match_only=False)

        kept_ids = {c["event_id"] for c in result["cards"]}
        self.assertIn("noise-earn", kept_ids)  # 非 match 模式不受影响

    def test_business_views_combine_relationship_and_direction(self):
        self.store.set("watchlist", "default", ["000001"])
        events = [
            _ev("holding-risk", "公告", [{"code": "600519", "name": "贵州茅台"}], "利空"),
            _ev("holding-upside", "业绩", [{"code": "600519", "name": "贵州茅台"}], "利好"),
            _ev("watchlist-downside", "价格异动", [{"code": "000001", "name": "平安银行"}], "利空"),
            _ev("neutral", "宏观", direction="中性"),
        ]

        with patch("adapter.strategies.fetch_events", return_value=events):
            result = build_cards(self.store, limit=30, bucket="all", match_only=True)

        by_id = {item["event_id"]: item for item in result["cards"]}
        self.assertEqual(by_id["holding-risk"]["business_view"], "position_risk")
        self.assertEqual(by_id["holding-upside"]["business_view"], "radar_opportunity")
        self.assertEqual(by_id["watchlist-downside"]["business_view"], "radar_opportunity")
        self.assertEqual(by_id["neutral"]["business_view"], "neutral_event")

    def test_business_view_is_filtered_before_bounded_pagination(self):
        events = [
            _ev("risk", "公告", [{"code": "600519", "name": "贵州茅台"}], "利空"),
            _ev("radar-1", "政策", direction="利好"),
            _ev("radar-2", "宏观", direction="利空"),
            _ev("neutral", "宏观", direction="中性"),
        ]

        with patch("adapter.strategies.fetch_events", return_value=events):
            result = build_cards(
                self.store,
                limit=1,
                offset=1,
                bucket="all",
                business_view="radar_opportunity",
                match_only=True,
            )

        self.assertEqual(result["count"], 1)
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["cards"][0]["event_id"], "radar-2")
        self.assertEqual(result["business_view_counts"], {
            "position_risk": 1,
            "radar_opportunity": 2,
            "neutral_event": 1,
        })
        self.assertEqual(result["page_info"], {
            "offset": 1,
            "limit": 1,
            "total": 2,
            "has_more": False,
            "next_offset": None,
            "max_visible": 100,
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
