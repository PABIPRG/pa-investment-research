# -*- coding: utf-8 -*-
"""全自动自进化闭环调度回归测试：shadow→自动进化→候选回测激活→推送。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_closed_loop -v
依赖：adapter.scheduler / adapter.store（无网络、无 LLM、不碰真实 store 目录）。
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")
os.environ.setdefault("SHADOW_SCHEDULE_ENABLED", "false")
os.environ.setdefault("CLOSED_LOOP_ENABLED", "false")

from adapter.scheduler import _run_closed_loop_job, setup_scheduler
from adapter.store import JsonStore


def _temp_store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


class ClosedLoopSchedulerTests(unittest.TestCase):
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

    def test_candidate_auto_backtest_routes_passed_failed_pending(self):
        store = _temp_store()
        # s-pass 将"通过回测"→自动激活；s-fail→淘汰；s-pend→样本外不足保持；
        # s-skip 已 passed 不再重复回测。
        for sid, vs in [("s-pass", "passed"), ("s-fail", "failed"), ("s-pend", "pending"), ("s-skip", "passed")]:
            store.set("strategies", sid, {
                "id": sid, "name": sid, "kind": "momentum", "direction": "利好",
                "symbols": ["600000"], "params": {"n": 10},
                "status": "candidate",
                "verification_status": "pending" if sid != "s-skip" else "passed",
                "backtest": {},
            })

        outcome = {"s-pass": "passed", "s-fail": "failed", "s-pend": "pending"}
        backtested: list[str] = []

        def fake_backtest(params, cb):
            sid = params["strategy_id"]
            backtested.append(sid)
            return {"verification_status": outcome[sid]}

        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation", return_value={"n_events": 0, "candidates": []}), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={"status": "ready", "count": 0, "actions": []}), \
                patch("adapter.strategies.StrategyBacktestRunner") as btr, \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.0, "strategies": {}}
            btr.return_value.run.side_effect = fake_backtest
            pusher.return_value.push.return_value = []
            _run_closed_loop_job()

        self.assertEqual(backtested, ["s-pass", "s-fail", "s-pend"])
        self.assertEqual(store.get("strategies", "s-pass")["status"], "active")
        self.assertEqual(store.get("strategies", "s-fail")["status"], "rejected")
        self.assertEqual(store.get("strategies", "s-pend")["status"], "candidate")
        self.assertEqual(store.get("strategies", "s-skip")["status"], "candidate")

    def test_stale_failed_candidates_cleaned_up(self):
        """已回测失败但仍留 candidate 池的候选 → 闭环自动淘汰（不重跑回测）。"""
        store = _temp_store()
        for sid, vs in [("s-old-fail", "failed"), ("s-pend", "pending"), ("s-passed", "passed")]:
            store.set("strategies", sid, {
                "id": sid, "name": sid, "kind": "momentum", "direction": "利好",
                "symbols": ["600000"], "params": {"n": 10},
                "status": "candidate", "verification_status": vs, "backtest": {},
            })
        backtested: list[str] = []
        pushed: list[tuple[str, str]] = []

        with patch("adapter.scheduler.JsonStore", return_value=store), \
                patch("adapter.brief_engine._is_trading_day", return_value=True), \
                patch("adapter.scheduler._run_event_generation", return_value={"n_events": 0, "candidates": []}), \
                patch("adapter.shadow.ShadowRunner") as shadow, \
                patch("adapter.evolution.evolve_auto", return_value={"status": "ready", "count": 0, "actions": []}), \
                patch("adapter.strategies.StrategyBacktestRunner") as btr, \
                patch("adapter.push.PusherManager") as pusher:
            shadow.return_value.run.return_value = {"skipped": False, "overall_nav": 1.0, "strategies": {}}
            btr.return_value.run.side_effect = lambda params, cb: backtested.append(params["strategy_id"]) or {"verification_status": "pending"}
            pusher.return_value.push.side_effect = lambda title, content: pushed.append((title, content)) or []
            _run_closed_loop_job()

        # 只有 pending 的 s-pend 走回测；passed 的 s-passed 天然跳过；failed 的 s-old-fail 直接清理不重跑
        self.assertEqual(backtested, ["s-pend"])
        self.assertEqual(store.get("strategies", "s-old-fail")["status"], "rejected")
        self.assertEqual(store.get("strategies", "s-pend")["status"], "candidate")
        self.assertEqual(store.get("strategies", "s-passed")["status"], "candidate")
        # 日报记录清理数
        self.assertEqual(len(pushed), 1)
        self.assertIn("清理 1 条失败遗留", pushed[0][1])

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
                patch("adapter.scheduler.settings.shadow_schedule_enabled", False):
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
