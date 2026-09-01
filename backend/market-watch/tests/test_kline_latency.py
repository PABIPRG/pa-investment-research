# -*- coding: utf-8 -*-
"""技术信号 K 线可轮询生命周期、缓存与 single-flight 契约。"""

import threading
import time
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace
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
    def __init__(self, gate: threading.Event, result):
        self.gate = gate
        self.result = result
        self.calls = 0

    def __call__(self, _code: str, _lookback: int):
        self.calls += 1
        self.gate.wait(timeout=1)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class SequenceKlineSource:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = 0

    def __call__(self, _code: str, _lookback: int):
        result = self.results[min(self.calls, len(self.results) - 1)]
        self.calls += 1
        if isinstance(result, BaseException):
            raise result
        return result


class RecordingFuture:
    def __init__(self, result):
        self.value = result
        self.timeouts = []

    def result(self, timeout=None):
        self.timeouts.append(timeout)
        return self.value


class RecordingEvent:
    def __init__(self):
        self.timeouts = []

    def wait(self, timeout=None):
        self.timeouts.append(timeout)
        return False


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
            failure_cache = getattr(quotes, "_KLINE_FAILURE_CACHE", None)
            if failure_cache is not None:
                failure_cache.clear()
            self.assertFalse(quotes._KLINE_FLIGHTS)

    def tearDown(self):
        deadline = time.monotonic() + 1
        while quotes._KLINE_FLIGHTS and time.monotonic() < deadline:
            time.sleep(0.01)
        with quotes._KLINE_LOCK:
            quotes._KLINE_CACHE.clear()
            failure_cache = getattr(quotes, "_KLINE_FAILURE_CACHE", None)
            if failure_cache is not None:
                failure_cache.clear()

    def _read_kline(self, code: str, lookback: int = 120):
        reader = getattr(quotes, "read_kline", None)
        if reader is not None:
            return reader(code, lookback)
        try:
            frame = quotes.get_kline(code, lookback)
        except quotes.KlineDeadlineExceeded:
            return SimpleNamespace(status="legacy_deadline", retry_after_ms=None)
        except quotes.KlineRefreshBusy:
            return SimpleNamespace(status="legacy_busy", retry_after_ms=None)
        if frame is None:
            return SimpleNamespace(status="legacy_none", reason_code=None)
        return SimpleNamespace(
            status="legacy_frame", frame=frame, stale=None, as_of=None,
        )

    def _wait_for_flights(self):
        deadline = time.monotonic() + 1
        while quotes._KLINE_FLIGHTS and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertFalse(quotes._KLINE_FLIGHTS)

    def _invoke_callback_with_drained_admission(self, future, *, replacement=None):
        key = ("600519", 120)
        callback_done = threading.Event()
        for _ in range(quotes._KLINE_WORKERS):
            self.assertTrue(quotes._KLINE_ADMISSION.acquire(blocking=False))
        with quotes._KLINE_LOCK:
            quotes._KLINE_FLIGHTS[key] = replacement or future
        callback_error = None
        try:
            try:
                quotes._finish_kline_refresh(key, future, callback_done)
            except BaseException as exc:
                callback_error = exc
            with quotes._KLINE_LOCK:
                remaining_flight = quotes._KLINE_FLIGHTS.get(key)
            first_release = quotes._KLINE_ADMISSION.acquire(blocking=False)
            second_release = quotes._KLINE_ADMISSION.acquire(blocking=False)
        finally:
            with quotes._KLINE_LOCK:
                quotes._KLINE_FLIGHTS.pop(key, None)
            for _ in range(quotes._KLINE_WORKERS):
                quotes._KLINE_ADMISSION.release()
        return (
            callback_error, callback_done.is_set(), remaining_flight,
            first_release, second_release,
        )

    def test_callback_completion_wait_uses_only_remaining_cold_deadline(self):
        future = RecordingFuture(_frame(12))
        callback_done = RecordingEvent()
        setattr(future, "_kline_callback_done", callback_done)
        with (
            patch.object(quotes, "_start_kline_refresh", return_value=future),
            patch.object(quotes.settings, "kline_cold_deadline", 0.05),
            patch.object(quotes.time, "monotonic", side_effect=[100.0, 100.01, 100.04]),
        ):
            result = quotes.read_kline("600519", 120)

        self.assertEqual(result.status, "preparing")
        self.assertAlmostEqual(future.timeouts[0], 0.04, places=6)
        self.assertAlmostEqual(callback_done.timeouts[0], 0.01, places=6)

    def test_callback_base_exception_still_cleans_up_and_notifies_waiters(self):
        future = Future()
        future.set_exception(KeyboardInterrupt("provider aborted"))

        with patch.object(quotes.logger, "warning"):
            outcome = self._invoke_callback_with_drained_admission(future)

        error, notified, remaining_flight, first_release, second_release = outcome
        self.assertIsNone(error)
        self.assertTrue(notified)
        self.assertIsNone(remaining_flight)
        self.assertTrue(first_release)
        self.assertFalse(second_release)

    def test_callback_logging_failure_still_cleans_up_and_notifies_waiters(self):
        future = Future()
        future.set_exception(RuntimeError("provider failed"))
        with patch.object(
            quotes.logger, "warning", side_effect=KeyboardInterrupt("logger failed"),
        ):
            outcome = self._invoke_callback_with_drained_admission(future)

        error, notified, remaining_flight, first_release, second_release = outcome
        self.assertIsNone(error)
        self.assertTrue(notified)
        self.assertIsNone(remaining_flight)
        self.assertTrue(first_release)
        self.assertFalse(second_release)

    def test_old_callback_does_not_remove_a_replacement_flight(self):
        future = Future()
        future.set_result(None)
        replacement = Future()

        outcome = self._invoke_callback_with_drained_admission(
            future, replacement=replacement,
        )

        error, notified, remaining_flight, first_release, second_release = outcome
        self.assertIsNone(error)
        self.assertTrue(notified)
        self.assertIs(remaining_flight, replacement)
        self.assertTrue(first_release)
        self.assertFalse(second_release)

    def test_concurrent_cold_requests_return_preparing_from_one_source_call(self):
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(12))
        started = time.monotonic()
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes.settings, "kline_cold_deadline", 0.03),
            ):
                with ThreadPoolExecutor(max_workers=6) as executor:
                    futures = [executor.submit(self._read_kline, "600519", 120) for _ in range(6)]
                    results = [future.result() for future in futures]
                elapsed = time.monotonic() - started
                self.assertEqual([result.status for result in results], ["preparing"] * 6)
                self.assertTrue(all(result.retry_after_ms == 1500 for result in results))
                self.assertEqual(source.calls, 1)
                self.assertLess(elapsed, 0.3)
        finally:
            gate.set()

    def test_background_success_becomes_ready_on_next_read(self):
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(12))
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes.settings, "kline_cold_deadline", 0.01),
            ):
                preparing = self._read_kline("600519")
                self.assertEqual(preparing.status, "preparing")
                gate.set()
                self._wait_for_flights()
                ready = self._read_kline("600519")
        finally:
            gate.set()

        self.assertEqual(ready.status, "ready")
        self.assertFalse(ready.stale)
        self.assertEqual(float(ready.frame.iloc[-1]["close"]), 12)
        self.assertIsNotNone(ready.as_of)
        self.assertEqual(source.calls, 1)

    def test_stale_kline_returns_ready_immediately_while_one_refresh_runs(self):
        clock = FakeClock(61)
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(15))
        with quotes._KLINE_LOCK:
            quotes._KLINE_CACHE[("000001", 120)] = (0, _frame(10), "2026-08-24 15:00:00")
        started = time.monotonic()
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes, "_KLINE_CLOCK", clock),
                patch.object(quotes.settings, "kline_cache_ttl", 60),
                patch.object(quotes.settings, "kline_stale_ttl", 300),
            ):
                first = self._read_kline("000001", 120)
                deadline = time.monotonic() + 0.2
                while source.calls == 0 and time.monotonic() < deadline:
                    time.sleep(0.005)
                second = self._read_kline("000001", 120)
                elapsed = time.monotonic() - started
        finally:
            gate.set()

        self.assertLess(elapsed, 0.1)
        self.assertEqual(first.status, "ready")
        self.assertTrue(first.stale)
        self.assertEqual(float(first.frame.iloc[-1]["close"]), 10)
        self.assertEqual(second.status, "ready")
        self.assertTrue(second.stale)
        self.assertEqual(float(second.frame.iloc[-1]["close"]), 10)
        self.assertEqual(source.calls, 1)

    def test_empty_background_result_is_negatively_cached_until_ttl_expires(self):
        clock = FakeClock(0)
        source = SequenceKlineSource(None)
        with (
            patch.object(quotes, "_fetch_kline_uncached", source),
            patch.object(quotes, "_KLINE_CLOCK", clock),
            patch.object(quotes.settings, "kline_failure_ttl", 30),
        ):
            first = self._read_kline("600519")
            second = self._read_kline("600519")
            self.assertEqual(first.status, "unavailable")
            self.assertEqual(second.status, "unavailable")
            self.assertEqual(first.reason_code, "no_data")
            self.assertEqual(source.calls, 1)

            clock.now = 31
            third = self._read_kline("600519")

        self.assertEqual(third.status, "unavailable")
        self.assertEqual(source.calls, 2)

    def test_background_exception_is_negatively_cached_and_releases_flight(self):
        source = SequenceKlineSource(RuntimeError("provider failed"))
        with (
            patch.object(quotes, "_fetch_kline_uncached", source),
            patch.object(quotes.settings, "kline_failure_ttl", 30),
            patch.object(quotes.logger, "warning"),
        ):
            codes = tuple(f"{index:06d}" for index in range(quotes._KLINE_WORKERS + 1))
            results = [self._read_kline(code) for code in codes]
            second = self._read_kline("000001")

        self.assertTrue(all(result.status == "unavailable" for result in results))
        self.assertEqual(second.status, "unavailable")
        self.assertTrue(all(result.reason_code == "provider_error" for result in results))
        self.assertEqual(source.calls, quotes._KLINE_WORKERS + 1)

    def test_success_callback_releases_admission_for_each_completed_key(self):
        source = SequenceKlineSource(_frame(12))
        codes = tuple(f"{index:06d}" for index in range(quotes._KLINE_WORKERS + 1))
        with patch.object(quotes, "_fetch_kline_uncached", source):
            results = [self._read_kline(code) for code in codes]

        self.assertTrue(all(result.status == "ready" for result in results))
        self.assertEqual(source.calls, quotes._KLINE_WORKERS + 1)
        self.assertFalse(quotes._KLINE_FLIGHTS)

    def test_empty_callback_releases_admission_for_each_completed_key(self):
        source = SequenceKlineSource(None)
        codes = tuple(f"{index:06d}" for index in range(quotes._KLINE_WORKERS + 1))
        with patch.object(quotes, "_fetch_kline_uncached", source):
            results = [self._read_kline(code) for code in codes]

        self.assertTrue(all(result.status == "unavailable" for result in results))
        self.assertEqual(source.calls, quotes._KLINE_WORKERS + 1)
        self.assertFalse(quotes._KLINE_FLIGHTS)

    def test_refresh_failure_keeps_stale_data_and_original_as_of(self):
        clock = FakeClock(61)
        source = SequenceKlineSource(RuntimeError("provider failed"))
        with quotes._KLINE_LOCK:
            quotes._KLINE_CACHE[("000001", 120)] = (0, _frame(10), "2026-08-24 15:00:00")
        with (
            patch.object(quotes, "_fetch_kline_uncached", source),
            patch.object(quotes, "_KLINE_CLOCK", clock),
            patch.object(quotes.settings, "kline_cache_ttl", 60),
            patch.object(quotes.settings, "kline_stale_ttl", 300),
            patch.object(quotes.settings, "kline_failure_ttl", 30),
            patch.object(quotes.logger, "warning"),
        ):
            first = self._read_kline("000001")
            self._wait_for_flights()
            second = self._read_kline("000001")

        self.assertEqual(first.status, "ready")
        self.assertTrue(first.stale)
        self.assertEqual(first.as_of, "2026-08-24 15:00:00")
        self.assertEqual(second.status, "ready")
        self.assertTrue(second.stale)
        self.assertEqual(second.as_of, first.as_of)
        self.assertEqual(float(second.frame.iloc[-1]["close"]), 10)
        self.assertEqual(source.calls, 1)

    def test_failure_cache_evicts_least_recently_used_key_at_capacity(self):
        source = SequenceKlineSource(None)
        with (
            patch.object(quotes, "_fetch_kline_uncached", source),
            patch.object(quotes.settings, "kline_failure_cache_size", 2),
        ):
            self.assertEqual(self._read_kline("000001").status, "unavailable")
            self.assertEqual(self._read_kline("000002").status, "unavailable")
            self.assertEqual(self._read_kline("000001").status, "unavailable")
            self.assertEqual(self._read_kline("000003").status, "unavailable")

        failure_cache = getattr(quotes, "_KLINE_FAILURE_CACHE", {})
        self.assertEqual(len(failure_cache), 2)
        self.assertIn(("000001", 120), failure_cache)
        self.assertNotIn(("000002", 120), failure_cache)
        self.assertEqual(source.calls, 3)

    def test_get_kline_keeps_preparing_exception_compatibility(self):
        gate = threading.Event()
        source = BlockingKlineSource(gate, _frame(12))
        try:
            with (
                patch.object(quotes, "_fetch_kline_uncached", source),
                patch.object(quotes.settings, "kline_cold_deadline", 0.01),
            ):
                with self.assertRaises(quotes.KlineDeadlineExceeded):
                    quotes.get_kline("600519", 120)
        finally:
            gate.set()

    def test_get_kline_returns_none_for_unavailable_compatibility(self):
        source = SequenceKlineSource(None)
        with patch.object(quotes, "_fetch_kline_uncached", source):
            self.assertIsNone(quotes.get_kline("600519", 120))

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
                result = quotes.read_kline(codes[quotes._KLINE_WORKERS], 120)
                self.assertEqual(result.status, "preparing")
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
