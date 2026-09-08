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


def _ev(ev_id: str, ev_type: str, tickers=None):
    return {
        "id": ev_id, "item_id": f"item-{ev_id}", "type": ev_type,
        "tickers": tickers or [], "industries": [], "direction": "中性",
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
