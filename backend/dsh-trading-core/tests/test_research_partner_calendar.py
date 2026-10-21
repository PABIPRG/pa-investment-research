# -*- coding: utf-8 -*-
"""交易日历适配器：真实交易日、覆盖范围外降级与缓存。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_calendar -v
"""

from __future__ import annotations

import os
import unittest
from datetime import date
from unittest.mock import patch

from research_partner.calendar import AkshareTradingCalendar


def dates() -> list[date]:
    return [
        date(2026, 9, 30),
        date(2026, 10, 9),
        date(2026, 10, 20),
        date(2026, 10, 21),
        date(2026, 10, 22),
    ]


class TradingDayTests(unittest.TestCase):
    def test_holiday_within_coverage_is_not_a_trading_day(self) -> None:
        calendar = AkshareTradingCalendar(lambda: dates())
        self.assertTrue(calendar.is_trading_day(date(2026, 10, 21)))
        self.assertFalse(calendar.is_trading_day(date(2026, 10, 1)))  # 国庆休市

    def test_outside_coverage_falls_back_to_weekday(self) -> None:
        calendar = AkshareTradingCalendar(lambda: dates())
        self.assertFalse(calendar.is_trading_day(date(2027, 1, 2)))  # 周六
        self.assertTrue(calendar.is_trading_day(date(2027, 1, 4)))  # 周一

    def test_loader_failure_degrades_to_weekday(self) -> None:
        def broken() -> list[date]:
            raise OSError("offline")

        calendar = AkshareTradingCalendar(broken)
        self.assertTrue(calendar.is_trading_day(date(2026, 10, 21)))
        self.assertFalse(calendar.is_trading_day(date(2026, 10, 24)))
        self.assertTrue(calendar.degraded)
        self.assertEqual(calendar.source, "weekday_fallback")

    def test_empty_result_degrades(self) -> None:
        calendar = AkshareTradingCalendar(lambda: [])
        self.assertTrue(calendar.degraded)
        self.assertTrue(calendar.is_trading_day(date(2026, 10, 21)))

    def test_loaded_calendar_is_cached_for_a_day(self) -> None:
        calls = {"n": 0}
        clock = {"now": 0.0}

        def loader() -> list[date]:
            calls["n"] += 1
            return dates()

        calendar = AkshareTradingCalendar(loader, clock=lambda: clock["now"])
        calendar.is_trading_day(date(2026, 10, 21))
        calendar.is_trading_day(date(2026, 10, 22))
        self.assertEqual(calls["n"], 1)

        clock["now"] = 86401
        calendar.is_trading_day(date(2026, 10, 22))
        self.assertEqual(calls["n"], 2)

    def test_fallback_is_cached_shorter(self) -> None:
        calls = {"n": 0}
        clock = {"now": 0.0}

        def loader() -> list[date]:
            calls["n"] += 1
            return []

        calendar = AkshareTradingCalendar(loader, clock=lambda: clock["now"])
        calendar.is_trading_day(date(2026, 10, 21))
        clock["now"] = 601
        calendar.is_trading_day(date(2026, 10, 21))
        self.assertEqual(calls["n"], 2)


class WiringTests(unittest.TestCase):
    def test_default_calendar_requires_explicit_opt_in(self) -> None:
        from research_partner.api import _default_calendar

        with patch.dict(os.environ, {"RESEARCH_TRADING_CALENDAR": ""}, clear=False):
            self.assertIsNone(_default_calendar())
        with patch.dict(os.environ, {"RESEARCH_TRADING_CALENDAR": "akshare"}, clear=False):
            self.assertIsInstance(_default_calendar(), AkshareTradingCalendar)


if __name__ == "__main__":
    unittest.main()
