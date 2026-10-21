# -*- coding: utf-8 -*-
"""交易日历测试：日期对齐、最近交易日与数据源降级。"""

from __future__ import annotations

import unittest
from datetime import date, datetime, timezone

import pandas as pd

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.toolbox.context import ToolContext, ToolUnavailable
from research_entities.toolbox.executor import ToolExecutor
from research_entities.toolbox.trading_calendar import (
    TradingCalendar,
    calendar_for,
    latest_trading_day,
    recent_trading_days,
)

from tests.research_entities_fixtures import seed_stocks

STOCK_ID = "SEC:CN:A:600519"
SATURDAY = datetime(2026, 10, 24, 9, 0, tzinfo=timezone.utc)
FRIDAY = date(2026, 10, 23)

# 2026-10-19（周一）~ 10-23（周五）为交易日；10-24/25 周末。
TRADE_DATES = [date(2026, 10, 19 + offset) for offset in range(5)]


def calendar_frame():
    return pd.DataFrame({"trade_date": TRADE_DATES})


class FakeAkshare:
    def __init__(self, *, calendar_error: bool = False) -> None:
        self.calendar_error = calendar_error
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            if name == "tool_trade_date_hist_sina":
                if self.calendar_error:
                    raise RuntimeError("calendar down")
                return calendar_frame()
            return pd.DataFrame(
                [{"date": "2026-10-23", "close": 100.0, "volume": 10}]
            )

        return call


def build_context(fake, *, now=SATURDAY) -> ToolContext:
    repository = InMemoryEntityRepository()
    seed_stocks(repository)
    return ToolContext(repository, akshare_module=fake, timeout=5, now=lambda: now)


class TradingCalendarTest(unittest.TestCase):
    def test_weekend_and_holiday_alignment(self):
        calendar = TradingCalendar(TRADE_DATES)
        self.assertFalse(calendar.is_trading_day(date(2026, 10, 24)))
        self.assertTrue(calendar.is_trading_day(date(2026, 10, 23)))
        self.assertEqual(
            calendar.latest_on_or_before(date(2026, 10, 24)), date(2026, 10, 23)
        )
        self.assertEqual(
            calendar.latest_on_or_before(date(2026, 10, 19)), date(2026, 10, 19)
        )
        # 落在日历首日之前的日期按工作日近似。
        self.assertEqual(
            calendar.previous_trading_day(date(2026, 10, 19)), date(2026, 10, 16)
        )

    def test_recent_trading_days_newest_first(self):
        calendar = TradingCalendar(TRADE_DATES)
        days = calendar.recent_trading_days(3, end=date(2026, 10, 24))
        self.assertEqual(
            days,
            [date(2026, 10, 23), date(2026, 10, 22), date(2026, 10, 21)],
        )

    def test_weekday_fallback_when_calendar_missing(self):
        calendar = TradingCalendar()
        self.assertTrue(calendar.degraded)
        self.assertFalse(calendar.is_trading_day(date(2026, 10, 24)))
        self.assertEqual(
            calendar.latest_on_or_before(date(2026, 10, 24)), date(2026, 10, 23)
        )

    def test_dates_beyond_calendar_coverage_fall_back_to_weekdays(self):
        calendar = TradingCalendar(TRADE_DATES)
        self.assertEqual(
            calendar.latest_on_or_before(date(2027, 1, 4)), date(2027, 1, 4)
        )
        self.assertEqual(
            calendar.latest_on_or_before(date(2027, 1, 3)), date(2027, 1, 1)
        )


class CalendarIntegrationTest(unittest.TestCase):
    def test_calendar_loaded_once_and_cached(self):
        fake = FakeAkshare()
        context = build_context(fake)
        first = calendar_for(context)
        second = calendar_for(context)
        self.assertIs(first, second)
        self.assertEqual(first.source, "akshare")
        self.assertEqual(
            len([c for c in fake.calls if c[0] == "tool_trade_date_hist_sina"]), 1
        )

    def test_helpers_use_calendar(self):
        context = build_context(FakeAkshare())
        self.assertEqual(latest_trading_day(context, date(2026, 10, 24)), FRIDAY)
        self.assertEqual(
            recent_trading_days(context, 2, end=date(2026, 10, 24)),
            [FRIDAY, date(2026, 10, 22)],
        )

    def test_calendar_failure_degrades_to_weekdays(self):
        fake = FakeAkshare(calendar_error=True)
        context = build_context(fake)
        calendar = calendar_for(context)
        self.assertTrue(calendar.degraded)
        self.assertEqual(calendar.source, "weekday_fallback")

    def test_date_window_snaps_to_previous_trading_day(self):
        fake = FakeAkshare()
        context = build_context(fake)
        executor = ToolExecutor(context, audit=False, use_cache=False)
        result = executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], params={"days": 7}
        )
        self.assertEqual(result.status, "ok")
        quote_calls = [c for c in fake.calls if c[0] == "stock_zh_a_daily"]
        self.assertEqual(len(quote_calls), 1)
        self.assertEqual(quote_calls[0][1]["end_date"], "20261023")

    def test_quote_failure_does_not_break_calendar_fallback(self):
        fake = FakeAkshare(calendar_error=True)
        context = build_context(fake)
        executor = ToolExecutor(context, audit=False, use_cache=False)
        result = executor.execute_tool(
            "quote_history", entity_ids=[STOCK_ID], params={"days": 7}
        )
        self.assertEqual(result.status, "ok")
        quote_calls = [c for c in fake.calls if c[0] == "stock_zh_a_daily"]
        self.assertEqual(quote_calls[0][1]["end_date"], "20261023")


if __name__ == "__main__":
    unittest.main()
