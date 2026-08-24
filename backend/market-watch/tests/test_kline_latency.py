# -*- coding: utf-8 -*-
"""技术信号 K 线冷请求的 deadline、stale cache 与 single-flight 契约。"""

import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pandas as pd

from market_watch import quotes


def _frame(close: float) -> pd.DataFrame:
    return pd.DataFrame([{
        "date": "2026-08-24", "open": close - 1, "close": close,
        "high": close + 1, "low": close - 2, "volume": 1000, "amount": 100000,
    }])


class FakeClock:
    def __init__(self, now: float = 0.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class BlockingKlineSource:
    def __init__(self, gate: threading.Event, result: pd.DataFrame):
        self.gate = gate
        self.result = result
        self.calls = 0

    def __call__(self, _code: str, _lookback: int) -> pd.DataFrame:
        self.calls += 1
        self.gate.wait(timeout=1)
        return self.result


class _FakePipeEnd:
    def close(self):
        return None


class _NeverReadyReceive(_FakePipeEnd):
    def poll(self, _timeout):
        return False


class _FakeProcess:
    def __init__(self):
        self.started = False
        self.terminated = False
        self.killed = False

    def start(self):
        self.started = True

    def join(self, timeout=None):
        return None

    def is_alive(self):
        return not self.terminated and not self.killed

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


class _FakeProcessContext:
    def __init__(self):
        self.process = _FakeProcess()

    def Pipe(self, duplex=False):
        return _NeverReadyReceive(), _FakePipeEnd()

    def Process(self, **_kwargs):
        return self.process


class KlineLatencyTests(unittest.TestCase):
    def setUp(self):
        with quotes._KLINE_LOCK:
            quotes._KLINE_CACHE.clear()
            self.assertFalse(quotes._KLINE_FLIGHTS)

    def tearDown(self):
        deadline = time.monotonic() + 1
        while quotes._KLINE_FLIGHTS and time.monotonic() < deadline:
            time.sleep(0.01)
        with quotes._KLINE_LOCK:
            quotes._KLINE_CACHE.clear()

    def test_concurrent_cold_requests_share_one_source_and_obey_deadline(self):
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(12))
        started = time.monotonic()
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes.settings, "kline_cold_deadline", 0.03),
            ):
                with ThreadPoolExecutor(max_workers=6) as executor:
                    futures = [executor.submit(quotes.get_kline, "600519", 120) for _ in range(6)]
                    errors = []
                    for future in futures:
                        with self.assertRaises(quotes.KlineDeadlineExceeded) as raised:
                            future.result()
                        errors.append(raised.exception)
                elapsed = time.monotonic() - started
                self.assertEqual(len(errors), 6)
                self.assertEqual(source.calls, 1)
                self.assertLess(elapsed, 0.3)
                gate.set()
                deadline = time.monotonic() + 1
                while quotes._KLINE_FLIGHTS and time.monotonic() < deadline:
                    time.sleep(0.01)
                cached = quotes.get_kline("600519", 120)
        finally:
            gate.set()

        self.assertIsNotNone(cached)
        self.assertEqual(float(cached.iloc[-1]["close"]), 12)
        self.assertEqual(source.calls, 1)

    def test_stale_kline_returns_immediately_while_one_refresh_runs(self):
        clock = FakeClock(61)
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(15))
        with quotes._KLINE_LOCK:
            quotes._KLINE_CACHE[("000001", 120)] = (0, _frame(10))
        started = time.monotonic()
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes, "_KLINE_CLOCK", clock),
                patch.object(quotes.settings, "kline_cache_ttl", 60),
                patch.object(quotes.settings, "kline_stale_ttl", 300),
            ):
                first = quotes.get_kline("000001", 120)
                deadline = time.monotonic() + 0.2
                while source.calls == 0 and time.monotonic() < deadline:
                    time.sleep(0.005)
                second = quotes.get_kline("000001", 120)
                elapsed = time.monotonic() - started
        finally:
            gate.set()

        self.assertLess(elapsed, 0.1)
        self.assertEqual(float(first.iloc[-1]["close"]), 10)
        self.assertEqual(float(second.iloc[-1]["close"]), 10)
        self.assertEqual(source.calls, 1)

    def test_unique_stalled_keys_are_rejected_at_bounded_admission(self):
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(12))
        codes = tuple(f"{index:06d}" for index in range(quotes._KLINE_WORKERS + 1))
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes.settings, "kline_cold_deadline", 0.01),
            ):
                for code in codes[:quotes._KLINE_WORKERS]:
                    with self.assertRaises(quotes.KlineDeadlineExceeded):
                        quotes.get_kline(code, 120)
                started = time.monotonic()
                with self.assertRaises(quotes.KlineRefreshBusy):
                    quotes.get_kline(codes[quotes._KLINE_WORKERS], 120)
                self.assertLess(time.monotonic() - started, 0.05)
                self.assertEqual(len(quotes._KLINE_FLIGHTS), quotes._KLINE_WORKERS)
        finally:
            gate.set()

    def test_baostock_timeout_terminates_its_isolated_process(self):
        context = _FakeProcessContext()
        with (
            patch.object(quotes.multiprocessing, "get_context", return_value=context),
            patch.object(quotes.settings, "kline_baostock_timeout", 0.01),
        ):
            with self.assertRaisesRegex(TimeoutError, "baostock K线 600519 超时"):
                quotes._bs_hist_ohlcv_bounded("600519", "2026-01-01", "2026-08-24")

        self.assertTrue(context.process.started)
        self.assertTrue(context.process.terminated)
        self.assertFalse(context.process.killed)


if __name__ == "__main__":
    unittest.main()
