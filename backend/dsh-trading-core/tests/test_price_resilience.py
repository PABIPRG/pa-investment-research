"""故障中的缓存、准入和真实 HTTP 处理链，不使用外部行情。"""

import asyncio
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI

from adapter.isolated_price_worker import IsolatedPriceWorker
from adapter.portfolio_performance import PortfolioPriceError, record_holdings_snapshot
from adapter.portfolio_price_cache import PortfolioPriceHistoryCache, run_price_read
from adapter.public_observatory import register_public_observatory_routes
from adapter.store import JsonStore


def hung_price_source(*_):
    while True:
        pass


def healthy_price_source(*_):
    return [{"date": "2026-01-01", "close": 12}]


class PriceResilienceTests(unittest.TestCase):
    def test_scheduler_shutdown_error_does_not_skip_price_worker_cleanup(self):
        from fastapi.testclient import TestClient
        from unittest.mock import Mock
        from adapter import app as adapter_app
        scheduler = Mock()
        scheduler.shutdown.side_effect = RuntimeError("调度器退出失败")
        with patch.object(adapter_app, "setup_scheduler", return_value=scheduler), \
                patch.object(adapter_app, "open_price_workers"), \
                patch.object(adapter_app, "close_price_workers") as close:
            with self.assertRaisesRegex(RuntimeError, "调度器退出失败"):
                with TestClient(adapter_app.create_app()):
                    pass
            close.assert_called_once()

    def test_hung_eastmoney_still_reaches_sina_in_parent(self):
        from adapter import portfolio_prices
        eastmoney = IsolatedPriceWorker(__name__, "hung_price_source", timeout=0.1, cooldown=0)
        sina = IsolatedPriceWorker(__name__, "healthy_price_source", timeout=0.1, cooldown=0)
        self.addCleanup(eastmoney.close)
        self.addCleanup(sina.close)
        with patch("adapter.holdings_runner._bs_hist", return_value=[]), \
                patch.object(portfolio_prices, "_http_worker", eastmoney), \
                patch.object(portfolio_prices, "_sina_worker", sina):
            rows = portfolio_prices.load_portfolio_prices("000001", "2026-01-01", "2026-01-02")
        self.assertEqual(rows, [{"date": "2026-01-01", "close": 12}])

    def test_lifespan_reopens_and_closes_workers_on_each_run(self):
        from fastapi.testclient import TestClient
        from adapter import app as adapter_app
        from adapter import portfolio_prices, holdings_runner
        workers = [IsolatedPriceWorker("tests.test_isolated_price_worker", "fake_source") for _ in range(3)]
        for worker in workers:
            self.addCleanup(worker.close)
        with patch.object(holdings_runner, "_bs_worker", workers[0]), \
                patch.object(portfolio_prices, "_http_worker", workers[1]), \
                patch.object(portfolio_prices, "_sina_worker", workers[2]):
            for _ in range(2):
                with TestClient(adapter_app.create_app()) as client:
                    self.assertEqual(client.get("/health").status_code, 200)
                    for worker in workers:
                        self.assertTrue(worker.call("ok")["pid"])
                for worker in workers:
                    self.assertIsNone(worker._process)

    def test_same_ticker_does_not_wait_indefinitely_or_repeat_failed_load(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def loader(*_):
            calls.append(1)
            entered.set()
            release.wait(1)
            raise RuntimeError("行情断线")

        cache = PortfolioPriceHistoryCache(loader, wait_seconds=0.01)
        args = ("000001", "2026-01-01", "2026-01-02")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(cache.load, *args)
            self.assertTrue(entered.wait(1))
            try:
                with self.assertRaises(PortfolioPriceError):
                    cache.load(*args)
            finally:
                release.set()
            with self.assertRaises(RuntimeError):
                pending.result()
        with self.assertRaises(PortfolioPriceError):
            cache.load(*args)
        self.assertEqual(len(calls), 1)

    def test_failed_refresh_does_not_replace_cache_or_treat_stale_as_fresh(self):
        now = [0.0]
        rows = [{"date": "2026-01-01", "close": 12}]
        from unittest.mock import Mock
        loader = Mock(side_effect=[rows, RuntimeError("断线"), rows])
        cache = PortfolioPriceHistoryCache(loader, ttl_seconds=1, clock=lambda: now[0])
        args = ("000001", "2026-01-01", "2026-01-02")
        self.assertEqual(cache.load(*args), rows)
        now[0] = 2
        with self.assertRaises(RuntimeError):
            cache.load(*args)
        with self.assertRaises(PortfolioPriceError):
            cache.load(*args)
        now[0] = 8
        self.assertEqual(cache.load(*args), rows)

    def test_cancelled_request_keeps_slot_until_sync_work_really_finishes(self):
        entered, release = threading.Event(), threading.Event()
        slots = threading.BoundedSemaphore(1)

        def load():
            entered.set()
            release.wait(2)

        async def exercise():
            task = asyncio.create_task(run_price_read(load))
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(entered.is_set())
            task.cancel()
            try:
                with self.assertRaises(asyncio.CancelledError):
                    await task
                with self.assertRaises(PortfolioPriceError):
                    await run_price_read(lambda: [])
            finally:
                release.set()
            for _ in range(100):
                if slots.acquire(blocking=False):
                    slots.release()
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(await run_price_read(lambda: "恢复"), "恢复")

        with patch("adapter.portfolio_price_cache._PRICE_READ_SLOTS", slots):
            asyncio.run(exercise())

    def test_hung_history_does_not_starve_activities_and_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            store = JsonStore(Path(directory))
            record_holdings_snapshot(store, [{"ticker": "000001", "quantity": 1, "cost_price": 10}],
                                     "manual", datetime(2026, 1, 1, tzinfo=ZoneInfo("Asia/Shanghai")))
            worker = IsolatedPriceWorker("tests.test_isolated_price_worker", "fake_source", timeout=0.6, cooldown=0)
            self.addCleanup(worker.close)
            worker.call("ok")
            spin = [True]
            entered = threading.Event()

            def loader(*_):
                entered.set()
                worker.call("spin" if spin[0] else "ok")
                return [{"date": "2026-01-01", "close": 12}, {"date": "2026-01-02", "close": 13}]

            app = FastAPI()
            register_public_observatory_routes(app, store_factory=lambda: store, price_loader=loader,
                                              quote_loader=lambda _: {})

            async def exercise():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    pending = [asyncio.create_task(client.get("/public/performance/v1/history?from=2026-01-01&to=2026-01-02")) for _ in range(4)]
                    for _ in range(100):
                        if entered.is_set():
                            break
                        await asyncio.sleep(0.005)
                    start = time.monotonic()
                    excess = await client.get("/public/performance/v1/history?from=2026-01-01&to=2026-01-02")
                    activities = await client.get("/public/performance/v1/activities?as_of=2026-01-02")
                    self.assertEqual(excess.status_code, 503)
                    self.assertEqual(activities.status_code, 200)
                    self.assertLess(time.monotonic() - start, 0.3)
                    results = await asyncio.gather(*pending)
                    self.assertTrue(all(result.status_code == 503 for result in results))
                    spin[0] = False
                    recovered = await client.get("/public/performance/v1/history?from=2026-01-01&to=2026-01-02")
                    self.assertEqual(recovered.status_code, 200)
                    self.assertEqual(recovered.json()["points"][-1]["value"], "13.00")

            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
