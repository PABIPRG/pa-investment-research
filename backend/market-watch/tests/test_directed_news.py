# -*- coding: utf-8 -*-
"""按标的定向拉取个股新闻（东财搜索 → 直接标注 code 的事件）回归测试。

运行（自 backend/market-watch）：
    ./env/Scripts/python.exe -m unittest tests.test_directed_news -v
依赖：market_watch.news.fetch_directed_news / events.directed_events（无真实网络，全 mock）。
"""

import os
import unittest
from unittest.mock import patch

os.environ["MW_SCHEDULE_ENABLED"] = "false"

from market_watch import events, news  # noqa: E402
from market_watch.events import (  # noqa: E402
    _classify_directed,
    _dedup,
    _directed_direction,
    _extract_rule,
    directed_events,
)
from market_watch.news import fetch_directed_news  # noqa: E402


class _Resp:
    def __init__(self, content: bytes, status: int = 200):
        self.content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code != 200:
            raise Exception(f"HTTP {self.status_code}")


class FetchDirectedNewsTests(unittest.TestCase):
    def test_parses_jsonp_and_strips_em(self):
        payload = (
            'x({"result":{"cmsArticleWebOld":[{"title":"<em>贵州</em>茅台<em>涨停</em>",'
            '"date":"2026-08-27 16:41:00","mediaName":"证券时报网",'
            '"url":"http://finance.eastmoney.com/a/1.html","content":"正文"}]}})'
        ).encode("utf-8")
        with patch("curl_cffi.requests.get", return_value=_Resp(payload)):
            items = fetch_directed_news("600519", 2)
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertTrue(it["id"].startswith("em-"))
        self.assertEqual(it["title"], "贵州茅台涨停")  # <em> 已剥
        self.assertEqual(it["time"], "2026-08-27 16:41:00")
        self.assertEqual(it["source"], "证券时报网")
        self.assertEqual(it["url"], "http://finance.eastmoney.com/a/1.html")

    def test_bad_jsonp_returns_empty(self):
        with patch("curl_cffi.requests.get", return_value=_Resp(b"not json at all")):
            self.assertEqual(fetch_directed_news("600519", 2), [])

    def test_http_error_returns_empty(self):
        with patch("curl_cffi.requests.get", side_effect=Exception("timeout")):
            self.assertEqual(fetch_directed_news("600519", 2), [])


class DirectedEventsTests(unittest.TestCase):
    def _patch_deps(self, holdings, watchlist, directed):
        p_hold = patch.object(events, "_holdings_codes", return_value=holdings)
        p_store = patch.object(events.JsonStore, "get", side_effect=lambda col, key: watchlist if col == "watchlist" else [])
        p_fetch = patch.object(events.news, "fetch_directed_news", side_effect=directed)
        return p_hold, p_store, p_fetch

    def test_builds_events_with_known_code(self):
        watch = [{"code": "600519", "name": "贵州茅台", "added_at": "x"}]
        item = {"id": "em-a1b2", "time": "2026-08-27 16:41:00", "title": "贵州茅台涨停",
                "content": "股价大涨", "source": "证券时报网", "url": "http://e/a1.html"}
        p_hold, p_store, p_fetch = self._patch_deps([], watch, lambda kw, top=3: [item] if kw == "600519" else [])
        with p_hold, p_store, p_fetch:
            evs = directed_events()
        self.assertEqual(len(evs), 1)
        ev = evs[0]
        self.assertTrue(ev["id"].startswith("ev-stock-600519-"))
        self.assertEqual(ev["tickers"], [{"name": "贵州茅台", "code": "600519"}])
        self.assertEqual(ev["direction"], "利好")  # "涨停" → _DIRECTED_UP
        self.assertEqual(ev["type"], "价格异动")

    def test_disabled_returns_empty(self):
        watch = [{"code": "600519", "name": "贵州茅台"}]
        p_hold, p_store, p_fetch = self._patch_deps([], watch, lambda kw, top=3: [])
        with p_hold, p_store, p_fetch:
            self.assertEqual(directed_events(), [])
        # enabled=false 时连标的读取都不触发
        with patch.object(events.settings, "directed_news_enabled", False):
            with patch.object(events, "_holdings_codes", side_effect=AssertionError("不该读持仓")):
                self.assertEqual(directed_events(), [])

    def test_name_fallback_when_code_empty(self):
        # _fetch_directed_for：code 无结果 → 用 name 再调一次（覆盖 ETF 等）
        calls = []

        def fake(kw, top=3):
            calls.append(kw)
            if kw == "513050":
                return []
            return [{"id": "em-x", "time": "t", "title": "ETF 新闻", "content": "c",
                     "source": "东财", "url": "http://e/x.html"}]  # 名称命中

        with patch.object(events.news, "fetch_directed_news", side_effect=fake):
            items = events._fetch_directed_for("513050", "中概互联", 3)
        self.assertEqual(calls, ["513050", "中概互联"])  # 先 code 后 name
        self.assertEqual(len(items), 1)


class RuleFunctionsTests(unittest.TestCase):
    def test_direction_keywords(self):
        self.assertEqual(_directed_direction("主力净流入超10亿"), "利好")
        self.assertEqual(_directed_direction("股东减持计划"), "利空")
        self.assertEqual(_directed_direction("平开震荡"), "中性")

    def test_classify_type(self):
        self.assertEqual(_classify_directed("公司发布业绩预告"), "业绩")
        self.assertEqual(_classify_directed("资金流出榜"), "相关")
        self.assertEqual(_classify_directed("无任何关键词"), "其他")

    def test_extract_rule_unchanged_semantics(self):
        # _extract_rule 仍只按核心价格词判方向，不被"减持"等语义词污染（零回归）
        names = {}
        it = {"id": "x", "title": "某股跌停，股东拟减持", "content": "", "time": "t",
              "source": "s", "url": "u"}
        ev = _extract_rule(it, names)
        self.assertEqual(ev["direction"], "利空")  # 跌停 → 利空
        self.assertEqual(ev["type"], "价格异动")


class DedupPrecedenceTests(unittest.TestCase):
    def test_directed_first_wins_on_same_item_id(self):
        directed = {"item_id": "em-abc", "id": "ev-stock-600519-x", "tickers": [{"name": "a", "code": "600519"}]}
        persisted = {"item_id": "em-abc", "id": "ev-other", "tickers": []}
        out = _dedup([directed, persisted], "item_id")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "ev-stock-600519-x")  # 保首次出现（定向版）


if __name__ == "__main__":
    unittest.main()
