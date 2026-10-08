"""使用真实 spawn 进程验证卡死、回收与会话复用，不访问外部行情。"""

import os
import sys
import time
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from adapter.isolated_price_worker import IsolatedPriceWorker, PriceWorkerError


def fake_source(action):
    if action == "spin":
        while True:
            pass
    if action == "exit":
        os._exit(1)
    if action == "slow":
        time.sleep(0.3)
    return {"pid": os.getpid(), "app_imported": "adapter.app" in sys.modules}


def slow_import():
    time.sleep(0.2)


class IsolatedPriceWorkerTests(unittest.TestCase):
    def worker(self, **options):
        worker = IsolatedPriceWorker(__name__, "fake_source", timeout=1.0, cooldown=0, **options)
        self.addCleanup(worker.close)
        return worker

    def test_reuses_process_without_importing_app(self):
        worker = self.worker()
        first = worker.call("ok")
        self.assertEqual(first, worker.call("ok"))
        self.assertFalse(first["app_imported"])

    def test_spin_is_killed_and_next_call_recovers(self):
        worker = self.worker()
        old_pid = worker.call("ok")["pid"]
        start = time.monotonic()
        with self.assertRaises(PriceWorkerError):
            worker.call("spin")
        self.assertLess(time.monotonic() - start, 1.6)
        with self.assertRaises(ProcessLookupError):
            os.kill(old_pid, 0)
        self.assertNotEqual(worker.call("ok")["pid"], old_pid)

    def test_crashed_child_does_not_poison_next_generation(self):
        worker = self.worker()
        with self.assertRaises(PriceWorkerError):
            worker.call("exit")
        self.assertTrue(worker.call("ok")["pid"])

    def test_capacity_rejects_excess_without_spawning(self):
        worker = self.worker(max_pending=1)
        pid = worker.call("ok")["pid"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(worker.call, "slow")
            deadline = time.monotonic() + 1
            while not worker._lock.locked() and time.monotonic() < deadline:
                time.sleep(0.001)
            start = time.monotonic()
            with self.assertRaises(PriceWorkerError):
                worker.call("ok")
            self.assertLess(time.monotonic() - start, 0.1)
            self.assertEqual(pending.result()["pid"], pid)

    def test_close_interrupts_hung_call_and_rejects_new_work(self):
        worker = self.worker()
        pid = worker.call("ok")["pid"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(worker.call, "spin")
            time.sleep(0.05)
            start = time.monotonic()
            worker.close()
            self.assertLess(time.monotonic() - start, 0.7)
            with self.assertRaises(PriceWorkerError):
                pending.result()
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        with self.assertRaises(PriceWorkerError):
            worker.call("ok")

    def test_cold_start_has_separate_finite_budget_and_can_reopen(self):
        worker = IsolatedPriceWorker(__name__, "fake_source", timeout=0.1,
                                     initializer="slow_import", startup_timeout=1)
        self.addCleanup(worker.close)
        pid = worker.call("ok")["pid"]
        worker.close()
        worker.open()
        self.assertNotEqual(worker.call("ok")["pid"], pid)

    def test_real_dependency_warmup_never_imports_app_or_creates_store(self):
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"DSH_INVESTMENT_STATE_DIR": str(Path(directory) / "state")}):
            for module, function, initializer in [
                ("adapter.holdings_runner", "_bs_hist_direct", "_prepare_bs"),
                ("adapter.portfolio_prices", "_load_http_prices", "_prepare_eastmoney"),
                ("adapter.portfolio_prices", "_load_sina_prices", "_prepare_sina"),
            ]:
                with self.subTest(module=module, initializer=initializer):
                    worker = IsolatedPriceWorker(module, function, initializer=initializer)
                    try:
                        worker.warm()  # 只导入真实依赖，不执行数据源函数。
                        self.assertFalse((Path(directory) / "state").exists())
                    finally:
                        worker.close()


if __name__ == "__main__":
    unittest.main()
