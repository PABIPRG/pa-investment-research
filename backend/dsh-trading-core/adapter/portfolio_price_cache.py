# -*- coding: utf-8 -*-
"""组合收益历史行情的进程内覆盖范围缓存。"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable

from starlette.concurrency import run_in_threadpool
from .portfolio_performance import PortfolioPriceError


_PRICE_READ_SLOTS = threading.BoundedSemaphore(4)


async def run_price_read(load):
    """行情准入必须发生在公共同步线程池之前，满载不排队。"""
    if not _PRICE_READ_SLOTS.acquire(blocking=False):
        raise PortfolioPriceError("行情查询繁忙，请稍后重试")
    guard = threading.Lock()
    started = cancelled = False

    def execute():
        nonlocal started
        with guard:
            if cancelled:
                return None
            started = True
        try:
            return load()
        finally:
            _PRICE_READ_SLOTS.release()

    try:
        return await run_in_threadpool(execute)
    finally:
        # 浏览器断开或协程取消并不终止同步线程，名额必须随实际工作释放。
        with guard:
            if not started:
                cancelled = True
                _PRICE_READ_SLOTS.release()


@dataclass(frozen=True)
class _PriceHistoryEntry:
    start_date: date
    end_date: date
    rows: tuple[dict[str, Any], ...]
    expires_at: float


class PortfolioPriceHistoryCache:
    """复用同一标的已覆盖的历史行情，避免切换区间重复访问外部源。"""

    def __init__(
        self,
        loader: Callable[[str, str, str], list[dict[str, Any]]],
        *,
        ttl_seconds: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
        wait_seconds: float = 0.1,
        failure_backoff: float = 5.0,
    ) -> None:
        self._loader = loader
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._wait_seconds = wait_seconds
        self._failure_backoff = failure_backoff
        self._guard = threading.Lock()
        self._entries: dict[str, _PriceHistoryEntry] = {}
        self._ticker_locks: dict[str, threading.Lock] = {}
        self._retry_at: dict[str, float] = {}

    def _ticker_lock(self, ticker: str) -> threading.Lock:
        with self._guard:
            return self._ticker_locks.setdefault(ticker, threading.Lock())

    @staticmethod
    def _slice(
        rows: tuple[dict[str, Any], ...], start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        start = start_date.isoformat()
        end = end_date.isoformat()
        return [
            dict(row)
            for row in rows
            if start <= str(row.get("date", ""))[:10] <= end
        ]

    def load(self, ticker: str, start_date: str, end_date: str) -> list[dict[str, Any]]:
        """返回请求区间；新鲜缓存覆盖该区间时不访问外部行情源。"""
        requested_start = date.fromisoformat(start_date)
        requested_end = date.fromisoformat(end_date)
        ticker_lock = self._ticker_lock(ticker)
        if not ticker_lock.acquire(timeout=self._wait_seconds):
            raise PortfolioPriceError(f"{ticker} 历史行情正在读取，请稍后重试")
        try:
            now = self._clock()
            with self._guard:
                cached = self._entries.get(ticker)
            fresh = cached is not None and cached.expires_at > now
            if (
                fresh
                and cached is not None
                and cached.start_date <= requested_start
                and cached.end_date >= requested_end
            ):
                return self._slice(cached.rows, requested_start, requested_end)

            if now < self._retry_at.get(ticker, 0):
                raise PortfolioPriceError(f"{ticker} 历史行情正在恢复")

            load_start = (
                min(requested_start, cached.start_date)
                if fresh and cached is not None
                else requested_start
            )
            load_end = (
                max(requested_end, cached.end_date)
                if fresh and cached is not None
                else requested_end
            )
            try:
                loaded = tuple(
                    dict(row)
                    for row in self._loader(
                        ticker, load_start.isoformat(), load_end.isoformat()
                    ) or []
                    if isinstance(row, dict)
                )
            except Exception:
                self._retry_at[ticker] = self._clock() + self._failure_backoff
                raise
            self._retry_at.pop(ticker, None)
            entry = _PriceHistoryEntry(
                start_date=load_start,
                end_date=load_end,
                rows=loaded,
                expires_at=self._clock() + self._ttl_seconds,
            )
            with self._guard:
                self._entries[ticker] = entry
            return self._slice(entry.rows, requested_start, requested_end)
        finally:
            ticker_lock.release()
