import time
import unittest
from unittest.mock import Mock, patch

from market_watch import quotes


class QuoteResolutionTests(unittest.TestCase):
    """get_quotes 逐码合并（ulist 漏码用新浪补位）+ 双源均缺时最近成功价兜底。"""

    def tearDown(self):
        quotes._last_good.clear()

    @patch("market_watch.quotes._sina_hq", return_value={})
    @patch("market_watch.quotes._ulist")
    def test_ulist_missing_codes_filled_from_sina(self, ulist, sina):
        ulist.return_value = {"600519": {"code": "600519", "price": 1450.0}}
        sina.return_value = {"000858": {"code": "000858", "price": 160.0}}

        rows = quotes.cache().get_quotes(["600519", "000858"])

        self.assertEqual([r["code"] for r in rows], ["600519", "000858"])
        # 逐码合并：ulist 成功但缺个别码时，新浪只补缺失码，不做全量 or 降级
        ulist.assert_called_once_with(["600519", "000858"])
        sina.assert_called_once_with(["000858"])

    @patch("market_watch.quotes._sina_hq")
    @patch("market_watch.quotes._ulist")
    def test_zero_primary_price_is_filled_from_sina(self, ulist, sina):
        """开盘前东财的零价不是有效现价，不能阻止备用源补位。"""
        ulist.return_value = {
            "600519": {"code": "600519", "name": "贵州茅台", "price": 0.0}
        }
        sina.return_value = {
            "600519": {"code": "600519", "name": "贵州茅台", "price": 1450.0}
        }

        rows = quotes.cache().get_quotes(["600519"])

        self.assertEqual(rows[0]["price"], 1450.0)
        sina.assert_called_once_with(["600519"])

    @patch("market_watch.quotes._sina_hq")
    @patch("market_watch.quotes._ulist")
    def test_zero_prices_do_not_overwrite_a_recent_good_quote(self, ulist, sina):
        """两个即时源都返回零价时，应保留最近一次有效现价。"""
        zero = {"600519": {"code": "600519", "name": "贵州茅台", "price": 0.0}}
        ulist.return_value = zero
        sina.return_value = zero
        quotes._last_good["600519"] = (
            time.time() - 60,
            {"code": "600519", "name": "贵州茅台", "price": 1450.0},
        )

        rows = quotes.cache().get_quotes(["600519"])

        self.assertEqual(rows[0]["price"], 1450.0)

    @patch("market_watch.quotes.requests.get")
    def test_sina_preopen_zero_uses_previous_close_as_latest_available_price(self, get):
        """新浪开盘前当前价为零时，昨收是可展示的最新有效价格。"""
        response = Mock()
        response.content = (
            'var hq_str_sh600519="贵州茅台,0.00,1450.00,0.00,0.00,0.00,0.00,0.00,0,0.00";'
        ).encode("gbk")
        get.return_value = response

        rows = quotes._sina_hq(["600519"])

        self.assertEqual(rows["600519"]["price"], 1450.0)
        self.assertEqual(rows["600519"]["pct_change"], 0.0)

    @patch("market_watch.quotes._sina_hq", return_value={})
    @patch("market_watch.quotes._ulist", return_value={})
    def test_both_sources_down_serves_last_good_within_window(self, ulist, sina):
        quotes._last_good["600519"] = (
            time.time() - 60,
            {"code": "600519", "name": "贵州茅台", "price": 1450.0},
        )

        rows = quotes.cache().get_quotes(["600519"])

        self.assertEqual(rows, [{"code": "600519", "name": "贵州茅台", "price": 1450.0}])

    @patch("market_watch.quotes._sina_hq", return_value={})
    @patch("market_watch.quotes._ulist", return_value={})
    def test_stale_past_window_not_served(self, ulist, sina):
        quotes._last_good["600519"] = (
            time.time() - 99_999,
            {"code": "600519", "name": "贵州茅台", "price": 1450.0},
        )

        rows = quotes.cache().get_quotes(["600519"])

        self.assertEqual(rows, [])

    @patch("market_watch.quotes._sina_hq", return_value={})
    @patch("market_watch.quotes._ulist")
    def test_success_refreshes_last_good(self, ulist, sina):
        ulist.return_value = {"600519": {"code": "600519", "name": "贵州茅台", "price": 1450.0}}

        quotes.cache().get_quotes(["600519"])

        self.assertIn("600519", quotes._last_good)


if __name__ == "__main__":
    unittest.main()
