import time
import unittest
from unittest.mock import patch

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
