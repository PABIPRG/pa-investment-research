# -*- coding: utf-8 -*-
"""策略自进化事件出口：信封、幂等登记与投递重试。

运行：
    env/Scripts/python.exe -m unittest tests.test_evolution_events -v
"""

from __future__ import annotations

import gc
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from adapter import evolution_events
from adapter.store import JsonStore


class RecordingSink:
    def __init__(self, *, fail: bool = False) -> None:
        self.events = []
        self.fail = fail

    def record_event(self, envelope) -> None:
        if self.fail:
            raise RuntimeError("委托核心存储不可用")
        self.events.append(envelope)


class EvolutionEventsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self._tmp.name))
        self.occurred_at = datetime(2026, 10, 21, 7, 20, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        gc.collect()
        self._tmp.cleanup()

    def stage(self, *, actions, status_value="completed"):
        return evolution_events.stage_closed_loop(
            self.store,
            run_id="2026-10-21",
            occurred_at=self.occurred_at,
            actions=actions,
            status_value=status_value,
        )

    def test_events_describe_each_action_and_the_run(self) -> None:
        staged = self.stage(
            actions=[
                {"type": "promote", "sid": "S001", "reason": "胜率 62%"},
                {"type": "retire", "sid": "S002", "reason": "连续回撤"},
            ]
        )
        self.assertEqual(len(staged), 3)
        by_id = {event["event_id"]: event for event in staged}

        promote = by_id["strategy-change:2026-10-21:S001:promote"]
        self.assertEqual(promote["hook_type"], "strategy.condition_changed")
        self.assertEqual(promote["producer"], "trading-core-evolution")
        self.assertEqual(promote["subject_ids"], ["strategy:S001", "strategy_pool:default"])
        self.assertEqual(promote["payload"]["from_stage"], "watch")
        self.assertEqual(promote["payload"]["to_stage"], "active")
        self.assertEqual(promote["payload"]["event_type"], "promote")

        completed = by_id["strategy-evolution:2026-10-21"]
        self.assertEqual(completed["hook_type"], "strategy.evolution_completed")
        self.assertEqual(completed["payload"]["action_count"], 2)
        self.assertIn("strategy:S001", completed["subject_ids"])

    def test_staging_is_idempotent_per_run(self) -> None:
        actions = [{"type": "promote", "sid": "S001", "reason": "胜率 62%"}]
        first = self.stage(actions=actions)
        second = self.stage(actions=actions)
        self.assertEqual(len(first), 2)
        self.assertEqual(second, [])
        self.assertEqual(len(evolution_events.pending_events(self.store)), 2)

    def test_publish_marks_success_and_keeps_failures_for_retry(self) -> None:
        self.stage(actions=[{"type": "promote", "sid": "S001", "reason": "x"}])

        failing = RecordingSink(fail=True)
        result = evolution_events.publish_pending(self.store, failing)
        self.assertEqual(result["published"], 0)
        self.assertEqual(len(result["failed"]), 2)
        self.assertEqual(result["pending"], 2)

        sink = RecordingSink()
        result = evolution_events.publish_pending(self.store, sink)
        self.assertEqual(result["published"], 2)
        self.assertEqual(result["pending"], 0)
        hook_types = sorted(event.hook_type for event in sink.events)
        self.assertEqual(
            hook_types,
            ["strategy.condition_changed", "strategy.evolution_completed"],
        )

        # 已投递的事件不会再次进入待发队列。
        again = evolution_events.publish_pending(self.store, sink)
        self.assertEqual(again["published"], 0)
        self.assertEqual(len(sink.events), 2)

    def test_run_without_actions_still_reports_completion(self) -> None:
        staged = self.stage(actions=[], status_value="partial")
        self.assertEqual(len(staged), 1)
        self.assertEqual(staged[0]["hook_type"], "strategy.evolution_completed")
        self.assertEqual(staged[0]["payload"]["status"], "partial")
        self.assertEqual(staged[0]["subject_ids"], ["strategy_pool:default"])


if __name__ == "__main__":
    unittest.main()
