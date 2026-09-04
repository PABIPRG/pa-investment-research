# -*- coding: utf-8 -*-
"""全自动自进化闭环调度回归测试：shadow→自动进化→候选回测激活→推送。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_closed_loop -v
依赖：adapter.scheduler / adapter.store（无网络、无 LLM、不碰真实 store 目录）。
"""

import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")
os.environ.setdefault("SHADOW_SCHEDULE_ENABLED", "false")
os.environ.setdefault("CLOSED_LOOP_ENABLED", "false")

from adapter.scheduler import (
    _run_closed_loop_job,
    next_closed_loop_run_at,
    setup_scheduler,
    should_run_startup_backtest_catchup,
)
from adapter.store import JsonStore


def _temp_store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


class ClosedLoopSchedulerTests(unittest.TestCase):
    def test_next_closed_loop_run_is_timezone_aware_and_rolls_forward(self):
        now = datetime(2026, 9, 4, 15, 36, tzinfo=ZoneInfo("Asia/Shanghai"))
        with patch.object(__import__("adapter.scheduler", fromlist=["settings"]).settings, "closed_loop_enabled", True), \
                patch.object(__import__("adapter.scheduler", fromlist=["settings"]).settings, "closed_loop_time", "15:35"):
            result = next_closed_loop_run_at(now=now, timezone_name="Asia/Shanghai")
        self.assertEqual(result, "2026-09-05T15:35:00+08:00")

    def test_non_trading_day_skips_everything(self):
        store = _temp_store()
        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=False), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto") as evolve_auto, \
                patch("adapter.push.PusherManager") as pusher:
            _run_closed_loop_job()
        shadow.return_value.run.assert_not_called()
        evolve_auto.assert_not_called()
        pusher.return_value.push.assert_not_called()
        self.assertEqual(store.all("shadow_equity"), {})

    def test_sequencing_shadow_then_evolve_then_push(self):
        """空候选池时：shadow → evolve_auto → push，顺序不乱，候选步不跑。"""
        store = _temp_store()
        calls: list[str] = []

        def fake_shadow_run(params, cb):
            calls.append("shadow")
            return {"skipped": False, "overall_nav": 1.02, "strategies": {}}

        def fake_evolve_auto(s):
            calls.append("evolve")
            return {"status": "ready", "count": 0, "actions": [], "days_of_data": 5}

        def fake_push(title, content):
            calls.append("push")
            return []

        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation") as event_gen, \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", side_effect=fake_evolve_auto), \
                patch("adapter.push.PusherManager") as pusher:
            event_gen.side_effect = lambda s: calls.append("event") or {"n_events": 0, "candidates": []}
            shadow.return_value.run.side_effect = fake_shadow_run
            pusher.return_value.push.side_effect = fake_push
            _run_closed_loop_job()

        self.assertEqual(calls, ["event", "shadow", "evolve", "push"])
        runtime = store.get("evolution_previews", "_closed_loop_runtime")
        self.assertEqual(runtime["status"], "completed")
        self.assertRegex(runtime["recent_run_at"], r"T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")

    def test_candidate_auto_backtest_creates_durable_initial_tasks(self):
        store = _temp_store()
        for sid, vs in [
            ("s-new", "insufficient"),
            ("s-not-passed", "not_passed"),
            ("s-complete", "passed"),
        ]:
            store.set("strategies", sid, {
                "id": sid, "name": sid, "kind": "momentum", "direction": "利好",
                "symbols": ["600000"], "params": {"n": 10},
                "status": "candidate",
                "verification_status": vs,
                "backtest": {},
            })
        store.set("strategy_backtests", "done", {
            "task_id": "done", "strategy_id": "s-complete", "status": "completed",
            "completed_at": "2026-09-01 09:00:00",
        })
        queued: list[str] = []

        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation", return_value={"n_events": 0, "candidates": []}), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={"status": "ready", "count": 0, "actions": []}), \
                patch("adapter.backtest_tasks.trigger_first_backtests") as trigger, \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.0, "strategies": {}}
            trigger.side_effect = lambda ids: queued.extend(ids) or {"enqueued": len(ids)}
            pusher.return_value.push.return_value = []
            _run_closed_loop_job()

        self.assertEqual(queued, ["s-new"])
        self.assertEqual(store.get("strategies", "s-new")["status"], "candidate")

    def test_not_passed_candidate_is_intentionally_excluded(self):
        """验证未通过是产品定义的复测排除条件，不自动淘汰也不重跑。"""
        store = _temp_store()
        for sid, vs in [("s-not-passed", "not_passed"), ("s-new", "insufficient")]:
            store.set("strategies", sid, {
                "id": sid, "name": sid, "kind": "momentum", "direction": "利好",
                "symbols": ["600000"], "params": {"n": 10},
                "status": "candidate", "verification_status": vs, "backtest": {},
            })
        queued: list[str] = []
        pushed: list[tuple[str, str]] = []

        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation", return_value={"n_events": 0, "candidates": []}), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={"status": "ready", "count": 0, "actions": []}), \
                patch("adapter.backtest_tasks.trigger_first_backtests") as trigger, \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.0, "strategies": {}}
            trigger.side_effect = lambda ids: queued.extend(ids) or {"enqueued": len(ids)}
            pusher.return_value.push.side_effect = lambda title, content: pushed.append((title, content)) or []
            _run_closed_loop_job()

        self.assertEqual(queued, ["s-new"])
        self.assertEqual(store.get("strategies", "s-not-passed")["status"], "candidate")
        self.assertEqual(len(pushed), 1)
        self.assertIn("新建/恢复首测任务 1 条", pushed[0][1])

    def test_evolve_actions_appear_in_push_content(self):
        store = _temp_store()
        actions = [
            {"type": "promote", "sid": "s1", "reason": "nav 达标"},
            {"type": "mutate", "sid": "s2", "reason": "由 s1 变异"},
        ]
        pushed: list[tuple[str, str]] = []

        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation", return_value={"n_events": 0, "candidates": []}), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={
                    "status": "ready", "count": 2, "actions": actions,
                }), \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.03, "strategies": {}}
            pusher.return_value.push.side_effect = lambda title, content: pushed.append((title, content)) or []
            _run_closed_loop_job()

        self.assertEqual(len(pushed), 1)
        title, content = pushed[0]
        self.assertIn("自进化闭环日报", title)
        self.assertIn("升级 s1", content)
        self.assertIn("变异 s2", content)

    def test_event_generation_runs_and_counts_in_report(self):
        """闭环 Step 0：拉事件生成新候选，且计入推送日报。"""
        store = _temp_store()
        pushed: list[tuple[str, str]] = []
        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation",
                      return_value={"n_events": 3, "n_hypotheses": 2, "candidates": ["s-a", "s-b"]}), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={"status": "ready", "count": 0, "actions": []}), \
                patch("adapter.strategies.StrategyBacktestRunner") as btr, \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.0, "strategies": {}}
            btr.return_value.run.side_effect = lambda params, cb: {"verification_status": "pending"}
            pusher.return_value.push.side_effect = lambda title, content: pushed.append((title, content)) or []
            _run_closed_loop_job()

        self.assertEqual(len(pushed), 1)
        self.assertIn("事件生成：3 事件 → 新增 2 候选", pushed[0][1])

    def test_event_generation_disabled_skips_step(self):
        store = _temp_store()
        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler.settings.event_generation_enabled", False), \
                patch("adapter.scheduler._run_event_generation") as event_gen, \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={"status": "ready", "count": 0, "actions": []}), \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.0, "strategies": {}}
            pusher.return_value.push.return_value = []
            _run_closed_loop_job()

        event_gen.assert_not_called()


class SetupSchedulerGatingTests(unittest.TestCase):
    def test_all_disabled_returns_none(self):
        with patch("adapter.scheduler.settings.closed_loop_enabled", False), \
                patch("adapter.scheduler.settings.schedule_enabled", False), \
                patch("adapter.scheduler.settings.shadow_schedule_enabled", False), \
                patch("adapter.scheduler.settings.auto_retest_enabled", False):
            self.assertIsNone(setup_scheduler())

    def test_closed_loop_enabled_registers_daily_job(self):
        with patch("adapter.scheduler.settings.closed_loop_enabled", True), \
                patch("adapter.scheduler.settings.schedule_enabled", False), \
                patch("adapter.scheduler.settings.shadow_schedule_enabled", False), \
                patch("adapter.scheduler.settings.closed_loop_time", "15:35"):
            sched = setup_scheduler()
            self.addCleanup(sched.shutdown if sched else lambda: None)
            self.assertIsNotNone(sched)
            job = sched.get_job("closed_loop_daily")
            self.assertIsNotNone(job)
            # apscheduler CronTrigger 的 hour/minute 由表达式承载（repr 可读）
            self.assertIn("hour='15'", repr(job.trigger))
            self.assertIn("minute='35'", repr(job.trigger))

    def test_auto_retest_registers_daily_job_without_early_catchup(self):
        now = datetime(2026, 9, 4, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        with patch("adapter.scheduler.settings.closed_loop_enabled", False), \
                patch("adapter.scheduler.settings.schedule_enabled", False), \
                patch("adapter.scheduler.settings.shadow_schedule_enabled", False), \
                patch("adapter.scheduler.settings.auto_retest_enabled", True), \
                patch("adapter.scheduler.settings.auto_retest_time", "15:40"):
            sched = setup_scheduler(now=now)
            self.addCleanup(sched.shutdown if sched else lambda: None)
            self.assertIsNotNone(sched)
            self.assertIsNotNone(sched.get_job("backtest_patrol_daily"))
            self.assertIsNone(sched.get_job("backtest_patrol_startup_catchup"))

    def test_startup_catchup_is_registered_once_after_missed_time(self):
        now = datetime(2026, 9, 4, 16, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        with patch("adapter.scheduler.settings.closed_loop_enabled", False), \
                patch("adapter.scheduler.settings.schedule_enabled", False), \
                patch("adapter.scheduler.settings.shadow_schedule_enabled", False), \
                patch("adapter.scheduler.settings.auto_retest_enabled", True), \
                patch("adapter.scheduler.settings.auto_retest_time", "15:40"):
            sched = setup_scheduler(now=now)
            self.addCleanup(sched.shutdown if sched else lambda: None)
            self.assertIsNotNone(sched)
            jobs = [job for job in sched.get_jobs() if job.id == "backtest_patrol_startup_catchup"]
            self.assertEqual(len(jobs), 1)

    def test_startup_catchup_boundary_uses_service_timezone(self):
        before = datetime(2026, 9, 4, 15, 39, tzinfo=ZoneInfo("Asia/Shanghai"))
        at_time = datetime(2026, 9, 4, 15, 40, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertFalse(should_run_startup_backtest_catchup(before, "15:40"))
        self.assertTrue(should_run_startup_backtest_catchup(at_time, "15:40"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
