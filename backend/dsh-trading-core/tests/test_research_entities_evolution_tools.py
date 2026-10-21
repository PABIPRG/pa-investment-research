# -*- coding: utf-8 -*-
"""研究能力服务的策略自进化工具：只读、如实降级。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_entities_evolution_tools -v
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from research_entities.toolbox.context import ToolContext
from research_entities.toolbox.executor import ToolExecutor

from tests.research_entities_fixtures import InMemoryEntityRepository

NOW = lambda: datetime(2026, 10, 21, 15, 30, tzinfo=timezone.utc)


class _Response:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeEvolutionSession:
    trust_env = True

    def __init__(self, responses, *, down=False):
        self.responses = responses
        self.down = down
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, params=None, timeout=None):
        if self.down:
            raise ConnectionError(f"服务不可达：{url}")
        self.calls.append((url, dict(params or {})))
        for suffix, payload in self.responses.items():
            if url.endswith(suffix):
                return _Response(payload)
        return _Response({"detail": "not found"}, status_code=404)


STATUS = {
    "as_of": "2026-10-21 15:30:00",
    "days_of_data": 8,
    "min_days": 5,
    "ready": True,
    "counts": {"promote": 1, "demote": 0, "retire": 0, "mutate": 0},
    "per_strategy": [
        {"strategy_id": "S001", "name": "均线跟随", "tier": 2, "decision": "promote"}
    ],
    "note": None,
    "recent_run_at": "2026-10-21 15:20:00",
}

ATTRIBUTION = {
    "as_of": "2026-10-21 15:30:00",
    "days_of_data": 8,
    "min_days": 5,
    "data_note": None,
    "overall": {"return_pct": 4.1, "max_drawdown_pct": -1.3},
    "strategies": [{"strategy_id": "S001", "return_pct": 3.2}],
}

PREVIEW = {
    "preview_status": "pending",
    "valid": True,
    "actions": [{"type": "promote", "sid": "S001", "reason": "胜率 62%"}],
}


class EvolutionToolTests(unittest.TestCase):
    def build(self, responses, *, down=False):
        session = FakeEvolutionSession(responses, down=down)
        context = ToolContext(
            InMemoryEntityRepository(),
            http_session=session,
            service_timeout=0.1,
            now=NOW,
        )
        return ToolExecutor(context, audit=False, use_cache=False), session

    def test_pool_lookup_reads_status_and_scopes_by_strategy(self) -> None:
        executor, session = self.build({"/evolution/status": STATUS})
        result = executor.execute_tool(
            "strategy_pool_lookup", params={"strategy_id": "S001"}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.source, "trading-core:/evolution")
        self.assertTrue(result.data["ready"])
        self.assertEqual(result.data["days_of_data"], 8)
        self.assertEqual(result.data["records"][0]["strategy_id"], "S001")
        url, params = session.calls[0]
        self.assertTrue(url.endswith("/evolution/status"))
        self.assertEqual(params["strategy_id"], "S001")
        self.assertEqual(params["include_history"], "false")

    def test_attribution_surfaces_data_gap_in_warnings(self) -> None:
        payload = {**ATTRIBUTION, "days_of_data": 2, "data_note": "影子净值仅 2 日"}
        executor, _ = self.build({"/evolution/attribution": payload})
        result = executor.execute_tool("strategy_attribution_lookup", params={})
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["overall"]["return_pct"], 4.1)
        self.assertIn("影子净值仅 2 日", result.warnings)
        self.assertIsNone(result.data["strategy_id"])

    def test_preview_is_read_only_and_empty_without_actions(self) -> None:
        executor, _ = self.build({"/evolution/preview": PREVIEW})
        result = executor.execute_tool(
            "strategy_evolution_preview", params={"strategy_id": "S001"}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["preview_status"], "pending")
        self.assertEqual(result.data["records"][0]["type"], "promote")

        none_executor, _ = self.build(
            {"/evolution/preview": {"preview_status": "none", "actions": []}}
        )
        empty = none_executor.execute_tool("strategy_evolution_preview", params={})
        self.assertEqual(empty.status, "empty")
        self.assertEqual(empty.data["reason"], "当前没有待确认的进化预案")

    def test_service_down_returns_unavailable_not_fabricated_data(self) -> None:
        executor, _ = self.build({}, down=True)
        for tool_id in (
            "strategy_pool_lookup",
            "strategy_attribution_lookup",
            "strategy_evolution_preview",
        ):
            result = executor.execute_tool(tool_id, params={})
            self.assertEqual(result.status, "unavailable", tool_id)
            self.assertIn("策略自进化服务不可用", result.error)


if __name__ == "__main__":
    unittest.main()
