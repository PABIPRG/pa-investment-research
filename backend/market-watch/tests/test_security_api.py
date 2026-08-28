import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException


os.environ["MW_SCHEDULE_ENABLED"] = "false"

from market_watch import quotes
from market_watch.app import _technical_snapshot, indices, securities_search, security_detail, tech_signal
from market_watch.quotes import search_securities
from market_watch.schemas import SecurityDetailRequest, TechSignalRequest


class SecurityApiTests(unittest.TestCase):
    @patch(
        "market_watch.app.quotes.get_kline",
        side_effect=quotes.KlineDeadlineExceeded("K 线冷请求超时"),
    )
    def test_shared_technical_snapshot_maps_cold_deadline_to_retryable_http_error(self, _get_kline):
        with self.assertRaises(HTTPException) as raised:
            _technical_snapshot("600519", 120)

        self.assertEqual(raised.exception.status_code, 504)
        self.assertIn("后台刷新仍在继续", str(raised.exception.detail))

    @patch("market_watch.app.quotes.get_quote_bounded")
    @patch("market_watch.app._technical_snapshot")
    def test_tech_signal_reuses_shared_snapshot_and_bounded_name_lookup(
        self, technical_snapshot, get_quote_bounded,
    ):
        technical_snapshot.return_value = {"bars": 120, "signals": ["价格位于均线上方"]}
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

    @patch("market_watch.app.briefs.indices_spot")
    def test_indices_returns_a_compact_market_overview(self, indices_spot):
        indices_spot.return_value = [
            {"code": "000001", "name": "上证指数", "price": 3210.5, "pct_change": 0.8},
        ]

        payload = indices()

        self.assertEqual(payload["items"][0]["name"], "上证指数")
        self.assertIn("as_of", payload)

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

    @patch("market_watch.app.news.fetch_stock_news")
    @patch("market_watch.app.quotes.get_fund_flow")
    @patch("market_watch.app._technical_snapshot")
    @patch("market_watch.app.quotes.cache")
    def test_detail_aggregates_quote_technical_fund_flow_and_news(
        self, cache, technical_snapshot, get_fund_flow, fetch_stock_news,
    ):
        cache.return_value.get_quote.return_value = {
            "code": "600519", "name": "贵州茅台", "price": 1450.0, "pct_change": 1.2,
        }
        technical_snapshot.return_value = {"bars": 120, "signals": ["价格位于均线上方"]}
        get_fund_flow.return_value = 1.25
        fetch_stock_news.return_value = [{"title": "公司发布经营数据", "source": "东财", "time": "10:00"}]

        payload = security_detail(SecurityDetailRequest(code="600519", lookback=120))

        self.assertEqual(payload["name"], "贵州茅台")
        self.assertEqual(payload["quote"]["price"], 1450.0)
        self.assertEqual(payload["technical"]["bars"], 120)
        self.assertEqual(payload["fund_flow_yi"], 1.25)
        self.assertEqual(payload["news"][0]["source"], "东财")

    @patch("market_watch.app.news.fetch_stock_news", return_value=[])
    @patch("market_watch.app.quotes.get_fund_flow", return_value=None)
    @patch("market_watch.app._technical_snapshot", side_effect=HTTPException(404, "600519 无 K 线数据"))
    @patch("market_watch.app.quotes.cache")
    def test_detail_keeps_a_valid_quote_when_technical_data_is_temporarily_missing(
        self, cache, _technical_snapshot, _get_fund_flow, _fetch_stock_news,
    ):
        cache.return_value.get_quote.return_value = {
            "code": "600519", "name": "贵州茅台", "price": 1450.0,
        }

        payload = security_detail(SecurityDetailRequest(code="600519"))

        self.assertEqual(payload["quote"]["price"], 1450.0)
        self.assertEqual(payload["technical"], {})
        self.assertEqual(payload["warnings"], ["600519 无 K 线数据"])


if __name__ == "__main__":
    unittest.main()
