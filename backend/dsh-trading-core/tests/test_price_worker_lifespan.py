"""真实 lifespan 就绪与预热退出回归；不访问行情网络。"""

import asyncio
import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from adapter.isolated_price_worker import IsolatedPriceWorker


def source(*_):
    return os.getpid()


def stalled_import():
    while True:
        time.sleep(0.05)


class PriceWorkerLifespanTests(unittest.TestCase):
    def test_blocked_warmup_does_not_delay_health_and_shutdown_waits_for_it(self):
        from adapter import app as adapter_app, holdings_runner, portfolio_prices
        ready, exit_client, release = threading.Event(), threading.Event(), threading.Event()
        entered = [threading.Event() for _ in range(3)]
        finished = [threading.Event() for _ in range(3)]
        workers = [Mock() for _ in range(3)]
        for index, worker in enumerate(workers):
            def warm(index=index):
                entered[index].set()
                release.wait(5)
                finished[index].set()
            worker.warm.side_effect = warm
            worker.close.side_effect = release.set

        def serve():
            with TestClient(adapter_app.create_app()) as client:
                self.assertEqual(client.get("/health").json()["service"], "trading-core")
                ready.set()
                exit_client.wait(5)

        with patch.object(holdings_runner, "_bs_worker", workers[0]), \
                patch.object(portfolio_prices, "_http_worker", workers[1]), \
                patch.object(portfolio_prices, "_sina_worker", workers[2]), \
                ThreadPoolExecutor(max_workers=1) as executor:
            task = executor.submit(serve)
            try:
                self.assertTrue(ready.wait(1), "行情预热不能阻塞服务就绪")
                for event in entered:
                    self.assertTrue(event.wait(1), "三个源应并行预热")
            finally:
                exit_client.set()
                if not ready.is_set():
                    release.set()
                try:
                    task.result(timeout=6)
                finally:
                    release.set()
        for worker in workers:
            worker.open.assert_called_once()
            worker.close.assert_called_once()
        self.assertTrue(all(event.is_set() for event in finished))

    def test_shutdown_interrupts_real_cold_import_and_next_lifespan_reopens(self):
        from adapter import app as adapter_app, holdings_runner, portfolio_prices
        workers = [IsolatedPriceWorker(__name__, "source", initializer="stalled_import",
                                       startup_timeout=30, timeout=0.2) for _ in range(3)]
        for worker in workers:
            self.addCleanup(worker.close)
        with patch.object(holdings_runner, "_bs_worker", workers[0]), \
                patch.object(portfolio_prices, "_http_worker", workers[1]), \
                patch.object(portfolio_prices, "_sina_worker", workers[2]):
            for _ in range(2):
                started = time.monotonic()
                with TestClient(adapter_app.create_app()) as client:
                    self.assertEqual(client.get("/health").status_code, 200)
                    self.assertLess(time.monotonic() - started, 2)
                    deadline = time.monotonic() + 3
                    while any(worker._process is None for worker in workers) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(all(worker._process is not None for worker in workers))
                    pids = [worker._process.pid for worker in workers]
                    shutdown_started = time.monotonic()
                self.assertLess(time.monotonic() - shutdown_started, 2)
                for pid, worker in zip(pids, workers):
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                    self.assertIsNone(worker._process)
                    self.assertIsNone(worker._exchange_thread)
                self.assertFalse(any(thread.name.startswith("price-warmup") for thread in threading.enumerate()))

    def test_cancelled_shutdown_still_waits_for_warmup_threads(self):
        from adapter import app as adapter_app
        entered, closed, release, finished = [threading.Event() for _ in range(4)]

        def warm():
            entered.set()
            release.wait(5)
            finished.set()

        async def exercise():
            ready, shutdown = asyncio.Event(), asyncio.Event()

            async def serve():
                async with adapter_app.lifespan(adapter_app.create_app()):
                    ready.set()
                    await shutdown.wait()

            task = asyncio.create_task(serve())
            try:
                await asyncio.wait_for(ready.wait(), 1)
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set())
                shutdown.set()
                for _ in range(100):
                    if closed.is_set():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(closed.is_set())
                for _ in range(2):
                    task.cancel()
                    await asyncio.sleep(0.05)
                    self.assertFalse(task.done(), "取消不能让正在运行的预热线程脱离生命周期")
            finally:
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertTrue(finished.is_set())

        with patch.object(adapter_app, "open_price_workers"), \
                patch.object(adapter_app, "warm_price_workers", side_effect=warm), \
                patch.object(adapter_app, "close_price_workers", side_effect=closed.set):
            asyncio.run(exercise())

    def test_recovery_failure_closes_workers_without_starting_warmup(self):
        from adapter import app as adapter_app
        with patch.object(adapter_app, "open_price_workers") as reopen, \
                patch("adapter.holdings_operation_index.ensure", side_effect=RuntimeError("索引恢复失败")), \
                patch.object(adapter_app, "close_price_workers") as close:
            with self.assertRaisesRegex(RuntimeError, "索引恢复失败"):
                with TestClient(adapter_app.create_app()):
                    pass
            reopen.assert_called_once()
            close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
