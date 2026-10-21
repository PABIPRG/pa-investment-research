# -*- coding: utf-8 -*-
"""A 股交易日历：用于日期窗口对齐与逐日抓取，避免周末/节假日空请求。

日历来自新浪 ``tool_trade_date_hist_sina``，按进程缓存；数据源不可用或
超出日历覆盖范围时退回「周一至周五」工作日近似，并在结果里标记来源。
"""

from __future__ import annotations

import threading
import time
from datetime import date, timedelta
from typing import Iterable

from .context import ToolContext, ToolUnavailable

CALENDAR_TTL_SECONDS = 86400
FALLBACK_TTL_SECONDS = 600


class TradingCalendar:
    def __init__(self, dates: Iterable[date] = (), *, source: str = "akshare") -> None:
        self.dates = set(dates)
        # 没有日期集合等价于日历不可用，必须显式暴露降级状态。
        self.source = source if self.dates else "weekday_fallback"
        self.min_date = min(self.dates) if self.dates else None
        self.max_date = max(self.dates) if self.dates else None

    @property
    def degraded(self) -> bool:
        return self.source != "akshare"

    def is_trading_day(self, day: date) -> bool:
        if self.dates and (self.min_date is None or self.min_date <= day <= self.max_date):
            return day in self.dates
        # 日历未覆盖（数据源失败或未来年份）时按工作日近似。
        return day.weekday() < 5

    def latest_on_or_before(self, day: date) -> date:
        """返回 ``day`` 当天或之前最近的交易日。"""
        if self.dates and self.min_date is not None and day >= self.min_date:
            if day <= self.max_date:
                if day in self.dates:
                    return day
                candidate = day - timedelta(days=1)
                while candidate >= self.min_date:
                    if candidate in self.dates:
                        return candidate
                    candidate -= timedelta(days=1)
            # 超出日历覆盖范围，按工作日回溯，最多 10 天。
            candidate = day if day.weekday() < 5 else day - timedelta(days=day.weekday() - 4)
            return candidate
        candidate = day
        for _ in range(10):
            if candidate.weekday() < 5:
                return candidate
            candidate -= timedelta(days=1)
        return candidate

    def previous_trading_day(self, day: date) -> date:
        return self.latest_on_or_before(day - timedelta(days=1))

    def recent_trading_days(self, count: int, *, end: date | None = None) -> list[date]:
        """返回最近 ``count`` 个交易日，最新在前。"""
        if count <= 0:
            return []
        cursor = self.latest_on_or_before(end or date.today())
        result: list[date] = []
        guard = 0
        while len(result) < count and guard < count * 3 + 10:
            result.append(cursor)
            cursor = self.previous_trading_day(cursor)
            guard += 1
        return result


def _build_calendar(ctx: ToolContext) -> TradingCalendar:
    try:
        frame = ctx.call_akshare("tool_trade_date_hist_sina")
    except ToolUnavailable:
        return TradingCalendar(source="weekday_fallback")
    dates: list[date] = []
    try:
        column = frame["trade_date"]
    except (KeyError, TypeError, IndexError):
        column = []
    for value in column:
        if isinstance(value, date):
            dates.append(value)
            continue
        text = str(value)[:10]
        try:
            dates.append(date.fromisoformat(text))
        except ValueError:
            continue
    if not dates:
        return TradingCalendar(source="weekday_fallback")
    return TradingCalendar(dates, source="akshare")


class _CalendarHolder:
    def __init__(self) -> None:
        self.calendar: TradingCalendar | None = None
        self.expires_at = 0.0
        self.lock = threading.Lock()


def calendar_for(ctx: ToolContext) -> TradingCalendar:
    """取当前工具上下文的交易日历；同一进程内缓存一天，失败时短缓存。"""

    holder = getattr(ctx, "_trading_calendar_holder", None)
    if holder is None:
        holder = _CalendarHolder()
        setattr(ctx, "_trading_calendar_holder", holder)

    now = time.monotonic()
    with holder.lock:
        if holder.calendar is not None and now < holder.expires_at:
            return holder.calendar
        calendar = _build_calendar(ctx)
        holder.calendar = calendar
        holder.expires_at = now + (
            FALLBACK_TTL_SECONDS if calendar.degraded else CALENDAR_TTL_SECONDS
        )
        return calendar


def latest_trading_day(ctx: ToolContext, day: date) -> date:
    return calendar_for(ctx).latest_on_or_before(day)


def recent_trading_days(
    ctx: ToolContext, count: int, *, end: date | None = None
) -> list[date]:
    # 用上下文时钟而不是系统时钟，保证回放/测试可复现。
    return calendar_for(ctx).recent_trading_days(count, end=end or ctx.today())
