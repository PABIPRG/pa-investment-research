# -*- coding: utf-8 -*-
"""批量工具并发执行测试：顺序稳定、有界并发。"""

from __future__ import annotations

import time
import unittest
from datetime import datetime, timezone

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.normalizer import entity_id_for_security
from research_entities.toolbox.cache import TTLCache
from research_entities.toolbox.context import ToolContext
from research_entities.toolbox.contracts import ToolRequest
from research_entities.toolbox.executor import ToolExecutor

from tests.research_entities_fixtures import seed_stocks

NOW = lambda: datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
CODES = ["600519", "000858", "300750", "601318"]


class SlowSession:
    """模拟兄弟服务：每次 HTTP 调用耗时 0.25s。"""

    trust_env = False

    def __init__(self, delay: float = 0.25) -> None:
        self.delay = delay

    def get(self, url, params=None, timeout=None):
        time.sleep(self.delay)
        return _SlowResponse({})

    def post(self, url, json=None, timeout=None):
        time.sleep(self.delay)
        return _SlowResponse({})


class _SlowResponse:
    status_code = 200

    def __init__(self, payload) -> None:
        self.payload = payload

    def json(self):
        return self.payload


class OfflineAkshare:
    def __getattr__(self, name):
        def call(**kwargs):
            from research_entities.toolbox.context import ToolUnavailable

            raise ToolUnavailable("离线测试")

        return call


def build_executor(*, max_workers: int) -> ToolExecutor:
    repository = InMemoryEntityRepository()
    seed_stocks(repository)
    context = ToolContext(
        repository,
        akshare_module=OfflineAkshare(),
        http_session=SlowSession(),
        timeout=5,
        service_timeout=5,
        now=NOW,
    )
    return ToolExecutor(
        context,
        audit=False,
        cache=TTLCache(),
        max_workers=max_workers,
    )


def requests() -> list[ToolRequest]:
    return [
        ToolRequest(
            tool_id="industry_chain_lookup",
            entity_ids=[entity_id_for_security("ENTITY_02_01", code)],
        )
        for code in CODES
    ]


class ExecuteManyTest(unittest.TestCase):
    def test_parallel_is_faster_than_serial_and_preserves_order(self):
        parallel = build_executor(max_workers=4)
        started = time.monotonic()
        results = parallel.execute_many(requests())
        parallel_elapsed = time.monotonic() - started

        self.assertEqual([item.status for item in results], ["ok"] * 4)
        self.assertEqual(
            [item.entity_ids[0] for item in results],
            [request.entity_ids[0] for request in requests()],
        )
        # 四个 0.25s 的调用串行约 1s；并发应显著更短。
        self.assertLess(parallel_elapsed, 0.75)

    def test_max_workers_one_stays_serial(self):
        executor = build_executor(max_workers=1)
        started = time.monotonic()
        results = executor.execute_many(requests())
        elapsed = time.monotonic() - started

        self.assertEqual(len(results), 4)
        self.assertGreaterEqual(elapsed, 0.9)

    def test_per_call_override(self):
        executor = build_executor(max_workers=4)
        started = time.monotonic()
        results = executor.execute_many(requests(), max_workers=1)
        elapsed = time.monotonic() - started

        self.assertEqual(len(results), 4)
        self.assertGreaterEqual(elapsed, 0.9)

    def test_empty_batch(self):
        executor = build_executor(max_workers=4)
        self.assertEqual(executor.execute_many([]), [])


if __name__ == "__main__":
    unittest.main()
