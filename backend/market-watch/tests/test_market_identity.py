"""证券代码到各行情供应商标识的统一事实。"""

import unittest
from unittest.mock import patch

from market_watch import quotes
from market_watch.market_identity import (
    UnsupportedProviderMarket,
    baostock_code,
    eastmoney_secid,
    resolve_market,
    sina_symbol,
)


class MarketIdentityTests(unittest.TestCase):
    def test_beijing_exchange_920223_uses_provider_specific_identifiers(self):
        """若北交所误归沪市，新浪与东财请求会使用错误代码。"""
        self.assertEqual(resolve_market("920223"), "bj")
        self.assertEqual(sina_symbol("920223"), "bj920223")
        self.assertEqual(eastmoney_secid("920223"), "0.920223")

    def test_baostock_explicitly_rejects_beijing_exchange(self):
        """若把北交所静默映射到沪市，K 线降级会查询错误市场。"""
        with self.assertRaises(UnsupportedProviderMarket):
            baostock_code("920223")

    def test_shenzhen_and_shanghai_keep_existing_provider_mappings(self):
        """若统一规则回归错误，沪深证券的既有行情请求会失效。"""
        self.assertEqual(resolve_market("600519"), "sh")
        self.assertEqual(sina_symbol("600519"), "sh600519")
        self.assertEqual(eastmoney_secid("600519"), "1.600519")
        self.assertEqual(baostock_code("600519"), "sh.600519")
        self.assertEqual(resolve_market("000001"), "sz")
        self.assertEqual(sina_symbol("000001"), "sz000001")
        self.assertEqual(eastmoney_secid("000001"), "0.000001")
        self.assertEqual(baostock_code("000001"), "sz.000001")

    @patch("market_watch.quotes._bs_hist_ohlcv_bounded", return_value=[])
    @patch("market_watch.quotes._http_get", side_effect=RuntimeError("eastmoney unavailable"))
    @patch("market_watch.quotes._sina_kline", return_value=None)
    def test_kline_skips_baostock_for_beijing_exchange(self, _sina, _eastmoney, baostock):
        """若降级链启动 baostock，北交所会被错误地交给不支持的供应商。"""
        self.assertIsNone(quotes._fetch_kline_uncached("920223", 5))
        baostock.assert_not_called()
