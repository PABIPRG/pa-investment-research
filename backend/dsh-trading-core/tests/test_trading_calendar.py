# -*- coding: utf-8 -*-
"""交易日历判定回归测试：缓存 + 失败重试 + 完全不可用时的工作日启发式降级。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_trading_calendar -v
无网络：patch akshare.tool_trade_date_hist_sina；setUp 清空 _TRADE_CAL_CACHE。
"""

import os
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")

import adapter.brief_engine as be


class _FakeSeries:
    def __init__(self, values):
        self._values = values

    def astype(self, _dtype):
        return self

    def tolist(self):
        return list(self._values)


class _FakeCal:
    def __init__(self, dates):
        self._dates = dates

    def __getitem__(self, _key):
        return _FakeSeries(self._dates)


class TradingCalendarTests(unittest.TestCase):
    def setUp(self):
        be._TRADE_CAL_CACHE.clear()

    def test_membership_exact_when_calendar_available(self):
        with patch("akshare.tool_trade_date_hist_sina",
                   return_value=_FakeCal(["2026-09-04", "2026-09-07"])):
            self.assertTrue(be._is_trading_day("2026-09-07"))
            self.assertFalse(be._is_trading_day("2026-09-05"))  # 周六
            self.assertFalse(be._is_trading_day("2026-09-06"))  # 周日
        self.assertEqual(be._TRADE_CAL_CACHE, ["2026-09-04", "2026-09-07"])

    def test_weekday_fallback_when_calendar_empty(self):
        with patch("akshare.tool_trade_date_hist_sina", return_value=_FakeCal([])):
            self.assertTrue(be._is_trading_day("2026-09-07"))   # 周一
            self.assertFalse(be._is_trading_day("2026-09-05"))  # 周六
        self.assertEqual(be._TRADE_CAL_CACHE, [])  # 全失败不缓存

    def test_retry_then_success_caches(self):
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("sina 超时")
            return _FakeCal(["2026-09-07"])

        with patch("akshare.tool_trade_date_hist_sina", side_effect=flaky), \
                patch("adapter.brief_engine.time.sleep", return_value=None):
            self.assertTrue(be._is_trading_day("2026-09-07"))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(be._TRADE_CAL_CACHE, ["2026-09-07"])

    def test_latest_trade_date_falls_back_to_today(self):
        today = datetime.now().strftime("%Y-%m-%d")
        with patch("akshare.tool_trade_date_hist_sina", return_value=_FakeCal([])):
            self.assertEqual(be._latest_trade_date(), today)

    def test_latest_trade_date_picks_most_recent_past_date(self):
        today = datetime.now()
        dates = [
            (today - timedelta(days=3)).strftime("%Y-%m-%d"),
            (today - timedelta(days=1)).strftime("%Y-%m-%d"),
            (today + timedelta(days=1)).strftime("%Y-%m-%d"),
        ]
        with patch("akshare.tool_trade_date_hist_sina", return_value=_FakeCal(dates)):
            self.assertEqual(be._latest_trade_date(), dates[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
