import logging
import os
import unittest
import warnings
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException


os.environ["MW_SCHEDULE_ENABLED"] = "false"

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient
    from market_watch import quotes
    from market_watch.app import (
        _technical_snapshot, app, indices, securities_search, security_detail,
        tech_signal,
    )
from market_watch.quotes import search_securities
from market_watch.schemas import SecurityDetailRequest, TechSignalRequest

client = TestClient(app)
logging.getLogger("httpx").setLevel(logging.WARNING)


class SecurityApiTests(unittest.TestCase):
    @patch("market_watch.app.quotes.get_quote_bounded")
    @patch("market_watch.app.quotes.read_kline")
    def test_tech_signal_returns_202_while_kline_is_preparing(
        self, read_kline, get_quote_bounded,
    ):
        read_kline.return_value = quotes.KlineRead(
            status="preparing",
            retry_after_ms=1500,
            message="600519 K 线正在后台准备，请稍后重试",
        )

        response = client.post("/tech-signal", json={"code": "600519", "lookback": 120})

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "preparing")
        self.assertEqual(response.json()["code"], "600519")
        self.assertIn("as_of", response.json())
        self.assertEqual(response.json()["retry_after_ms"], 1500)
        get_quote_bounded.assert_not_called()

    @patch("market_watch.app.summarize", return_value=["价格位于均线上方"])
    @patch("market_watch.app.compute_indicators", return_value={"ma5": 10.5})
    @patch("market_watch.app.quotes.get_quote_bounded", return_value={"name": "贵州茅台"})
    @patch("market_watch.app.quotes.read_kline")
    def test_tech_signal_ready_keeps_compatible_fields_and_returns_200(
        self, read_kline, _get_quote_bounded, _compute_indicators, _summarize,
    ):
        frame = pd.DataFrame([{
            "date": "2026-08-24", "open": 10.0, "close": 11.0,
            "high": 12.0, "low": 9.0, "volume": 1000, "amount": 100000,
        }])
        read_kline.return_value = quotes.KlineRead(
            status="ready", frame=frame, stale=True, as_of="2026-08-24 15:00:00",
        )

        response = client.post("/tech-signal", json={"code": "600519", "lookback": 120})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ready")
        self.assertTrue(payload["stale"])
        self.assertEqual(payload["code"], "600519")
        self.assertEqual(payload["name"], "贵州茅台")
        self.assertEqual(payload["as_of"], "2026-08-24 15:00:00")
        for field in ("bars", "last", "indicators", "signals"):
            self.assertIn(field, payload)

    @patch("market_watch.app.quotes.get_quote_bounded")
    @patch("market_watch.app.quotes.read_kline")
    def test_tech_signal_unavailable_is_a_retryable_200_domain_terminal(
        self, read_kline, get_quote_bounded,
    ):
        read_kline.return_value = quotes.KlineRead(
            status="unavailable",
            reason_code="provider_error",
            message="600519 K 线暂不可用，请稍后重试",
        )

        response = client.post("/tech-signal", json={"code": "600519", "lookback": 120})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "status": "unavailable",
            "code": "600519",
            "as_of": None,
            "reason_code": "provider_error",
            "message": "600519 K 线暂不可用，请稍后重试",
            "retryable": True,
        })
        get_quote_bounded.assert_not_called()

    def test_tech_signal_invalid_input_returns_422(self):
        response = client.post("/tech-signal", json={"code": "abcdef", "lookback": 120})

        self.assertEqual(response.status_code, 422)

    @patch("market_watch.app.quotes.get_quote_bounded")
    @patch("market_watch.app._technical_snapshot")
    def test_tech_signal_reuses_shared_snapshot_and_bounded_name_lookup(
        self, technical_snapshot, get_quote_bounded,
    ):
        technical_snapshot.return_value = {
            "status": "ready", "stale": False, "as_of": "2026-08-24 15:00:00",
            "bars": 120, "signals": ["价格位于均线上方"],
        }
        get_quote_bounded.return_value = {"name": "贵州茅台"}

        payload = tech_signal(TechSignalRequest(code="600519", lookback=120))

        self.assertEqual(payload["name"], "贵州茅台")
        technical_snapshot.assert_called_once_with("600519", 120)
        get_quote_bounded.assert_called_once_with("600519")

    @patch("market_watch.quotes._security_catalog")
    def test_search_ranks_exact_name_before_code_and_contains_matches(self, catalog):
        catalog.return_value = [
            {"code": "600519", "name": "贵州茅台", "market": "沪市"},
            {"code": "600059", "name": "古越龙山", "market": "沪市"},
            {"code": "000568", "name": "泸州老窖", "market": "深市"},
        ]

        self.assertEqual(search_securities("600", 8)[0]["code"], "600059")
        self.assertEqual(search_securities("贵州茅台", 8)[0]["code"], "600519")
        self.assertEqual(search_securities("茅台", 8)[0]["code"], "600519")

    @patch("market_watch.quotes.cache")
    @patch("market_watch.quotes._security_catalog")
    def test_search_falls_back_to_quote_cache_for_codes_outside_ashare_catalog(self, catalog, cache):
        catalog.return_value = [{"code": "600519", "name": "贵州茅台", "market": "沪市"}]
        cache.return_value.get_quote.return_value = {"code": "513050", "name": "中概互联网ETF易方达"}

        result = search_securities("513050", 5)

        self.assertEqual(result, [{"code": "513050", "name": "中概互联网ETF易方达", "market": "沪市"}])
        cache.return_value.get_quote.assert_called_once_with("513050")

    @patch("market_watch.quotes.cache")
    @patch("market_watch.quotes._security_catalog")
    def test_search_quote_fallback_skipped_when_catalog_already_matches(self, catalog, cache):
        catalog.return_value = [{"code": "600519", "name": "贵州茅台", "market": "沪市"}]

        result = search_securities("600519", 8)

        self.assertEqual(result[0]["code"], "600519")
        cache.return_value.get_quote.assert_not_called()

    @patch("market_watch.quotes.cache")
    @patch("market_watch.quotes._security_catalog")
    def test_search_quote_fallback_returns_empty_when_quote_has_no_name(self, catalog, cache):
        catalog.return_value = [{"code": "600519", "name": "贵州茅台", "market": "沪市"}]
        cache.return_value.get_quote.return_value = {}

        self.assertEqual(search_securities("513050", 5), [])

    @patch("market_watch.app.quotes.search_securities")
    def test_search_returns_ranked_security_candidates(self, search):
        search.return_value = [{"code": "600519", "name": "贵州茅台", "market": "沪市"}]

        payload = securities_search("茅台", 8)

        self.assertEqual(payload["items"][0]["code"], "600519")
        search.assert_called_once_with("茅台", 8)

    def test_search_rejects_an_empty_keyword(self):
        with self.assertRaises(HTTPException) as raised:
            securities_search("   ", 8)
        self.assertEqual(raised.exception.status_code, 422)

    @patch("market_watch.app.briefs.indices_snapshot")
    def test_indices_returns_a_compact_market_overview(self, indices_snapshot):
        indices_snapshot.return_value = {
            "as_of": "2026-08-31 10:00:00",
            "items": [{
                "code": "sh000001", "name": "上证指数", "price": 3210.5,
                "pct_change": 0.8, "as_of": "2026-08-31 10:00:00", "stale": False,
            }],
            "stale": False,
            "warnings": [],
        }

        payload = indices()

        self.assertEqual(payload["items"][0]["name"], "上证指数")
        self.assertEqual(payload["as_of"], "2026-08-31 10:00:00")
        self.assertFalse(payload["stale"])
        self.assertEqual(payload["warnings"], [])

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.quotes._clist_top", return_value=[])
    def test_scan_empty_result_is_a_successful_source_aware_response(
        self, _scan_rows, _trade_date,
    ):
        response = client.post("/scan", json={"kind": "gainers", "top_n": 10})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["items"], [])
        self.assertEqual(response.json()["source"], "eastmoney")
        self.assertFalse(response.json()["stale"])
        self.assertTrue(response.json()["complete"])

    @patch("akshare.fund_etf_spot_em")
    @patch("akshare.stock_info_a_code_name")
    def test_security_catalog_includes_exchange_traded_etfs(self, stock_catalog, etf_catalog):
        stock_catalog.return_value.to_dict.return_value = [
            {"code": "600519", "name": "贵州茅台"},
        ]
        etf_catalog.return_value.to_dict.return_value = [
            {"代码": "510300", "名称": "沪深300ETF"},
        ]

        items, index = quotes._load_security_catalog()

        self.assertIn(
            {"code": "510300", "name": "沪深300ETF", "market": "沪市 ETF", "type": "ETF"},
            items,
        )
        self.assertEqual(index["沪深300ETF"], ["510300"])

    @patch("market_watch.app.news.fetch_stock_news", side_effect=AssertionError("详情不得走旧列表包装"))
    @patch("market_watch.app.news.stock_news_snapshot")
    @patch("market_watch.app.quotes.get_fund_flow")
    @patch("market_watch.app._technical_snapshot")
    @patch("market_watch.app.quotes.cache")
    def test_detail_aggregates_quote_technical_fund_flow_and_news(
        self, cache, technical_snapshot, get_fund_flow, stock_news_snapshot, _fetch_stock_news,
    ):
        cache.return_value.get_quote.return_value = {
            "code": "600519", "name": "贵州茅台", "price": 1450.0, "pct_change": 1.2,
        }
        technical_snapshot.return_value = {"bars": 120, "signals": ["价格位于均线上方"]}
        get_fund_flow.return_value = 1.25
        stock_news_snapshot.return_value = SimpleNamespace(
            status="ready",
            items=({"title": "公司发布经营数据", "source": "东财", "time": "10:00"},),
            message=None,
        )

        payload = security_detail(SecurityDetailRequest(code="600519", lookback=120))

        self.assertEqual(payload["name"], "贵州茅台")
        self.assertEqual(payload["quote"]["price"], 1450.0)
        self.assertEqual(payload["technical"]["bars"], 120)
        self.assertEqual(payload["fund_flow_yi"], 1.25)
        self.assertEqual(payload["news"][0]["source"], "东财")
        stock_news_snapshot.assert_called_once_with("600519", limit=8)

    @patch("market_watch.app.news.stock_news_snapshot")
    @patch("market_watch.app.quotes.get_fund_flow", return_value=1.25)
    @patch("market_watch.app._technical_snapshot", return_value={"status": "ready"})
    @patch("market_watch.app.quotes.cache")
    def test_detail_keeps_stale_news_items_and_adds_the_snapshot_warning(
        self, cache, _technical_snapshot, _get_fund_flow, stock_news_snapshot,
    ):
        cache.return_value.get_quote.return_value = {
            "code": "600519", "name": "贵州茅台", "price": 1450.0,
        }
        stock_news_snapshot.return_value = SimpleNamespace(
            status="stale",
            items=({"title": "缓存资讯", "source": "东财", "time": "09:00"},),
            message="个股资讯源暂不可用，已返回最近成功缓存",
        )

        payload = security_detail(SecurityDetailRequest(code="600519"))

        self.assertEqual(payload["news"][0]["title"], "缓存资讯")
        self.assertEqual(payload["warnings"], ["个股资讯源暂不可用，已返回最近成功缓存"])

    @patch("market_watch.app.news.stock_news_snapshot")
    @patch("market_watch.app.quotes.get_fund_flow", return_value=2.5)
    @patch("market_watch.app._technical_snapshot")
    @patch("market_watch.app.quotes.cache")
    def test_detail_keeps_other_sections_when_technical_is_unavailable(
        self, cache, technical_snapshot, _get_fund_flow, stock_news_snapshot,
    ):
        cache.return_value.get_quote.return_value = {
            "code": "600519", "name": "贵州茅台", "price": 1450.0,
        }
        technical_snapshot.return_value = {
            "status": "unavailable", "code": "600519", "as_of": None,
            "reason_code": "no_data", "message": "600519 暂无 K 线数据，请稍后重试",
            "retryable": True,
        }
        stock_news_snapshot.return_value = SimpleNamespace(
            status="ready",
            items=({"title": "仍可读取的资讯", "source": "东财", "time": "10:00"},),
            message=None,
        )

        payload = security_detail(SecurityDetailRequest(code="600519"))

        self.assertEqual(payload["quote"]["price"], 1450.0)
        self.assertEqual(payload["fund_flow_yi"], 2.5)
        self.assertEqual(payload["technical"]["status"], "unavailable")
        self.assertEqual(payload["news"][0]["title"], "仍可读取的资讯")
        self.assertEqual(payload["warnings"], ["600519 暂无 K 线数据，请稍后重试"])

    @patch("market_watch.app.news.stock_news_snapshot")
    @patch("market_watch.app.quotes.get_fund_flow", return_value=2.5)
    @patch("market_watch.app._technical_snapshot")
    @patch("market_watch.app.quotes.cache")
    def test_detail_keeps_other_sections_when_technical_is_preparing(
        self, cache, technical_snapshot, _get_fund_flow, stock_news_snapshot,
    ):
        cache.return_value.get_quote.return_value = {
            "code": "600519", "name": "贵州茅台", "price": 1450.0,
        }
        technical_snapshot.return_value = {
            "status": "preparing", "code": "600519", "as_of": None,
            "retry_after_ms": 1500, "message": "600519 K 线正在后台准备，请稍后重试",
        }
        stock_news_snapshot.return_value = SimpleNamespace(
            status="ready",
            items=({"title": "仍可读取的资讯", "source": "东财", "time": "10:00"},),
            message=None,
        )

        payload = security_detail(SecurityDetailRequest(code="600519"))

        self.assertEqual(payload["quote"]["price"], 1450.0)
        self.assertEqual(payload["fund_flow_yi"], 2.5)
        self.assertEqual(payload["technical"]["status"], "preparing")
        self.assertEqual(payload["news"][0]["title"], "仍可读取的资讯")
        self.assertEqual(payload["warnings"], ["600519 K 线正在后台准备，请稍后重试"])


if __name__ == "__main__":
    unittest.main()
