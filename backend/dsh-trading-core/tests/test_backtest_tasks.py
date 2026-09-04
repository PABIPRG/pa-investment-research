# -*- coding: utf-8 -*-
"""回测任务模型 + Runner 记账 + 自动回测巡检冒烟（temp store，无网络/无 LLM）。

覆盖产品语义：
1) 任务生命周期：run() begin → complete/fail，手动/自动统一进 strategy_backtests；
2) 显式时间窗口 vs 预设 lookback 年数的记账差异（lookback_years None vs 数值）；
3) 失败留痕：策略不存在 → run 抛错但任务行仍以 failed 落库；
4) 幂等/到期判定：has_inflight、latest_completed_at（无任务行回退 backtest.ran_at）；
5) is_auto_eligible 参与面：candidate/active 参与，retired/rejected/verification=failed 不参与；
6) 巡检 `_run_backtest_patrol`：首测/复测到期才触发、进行中跳过、候选失败自动 reject。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_backtest_tasks -v
"""

import datetime
import math
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")

from adapter import backtest_tasks as bt
from adapter import scheduler
from adapter.scheduler import _run_backtest_patrol
from adapter.store import JsonStore
from adapter.strategies import StrategyBacktestRunner


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


def _seed(store: JsonStore, sid: str, *, status: str = "candidate",
          verification_status: str | None = None, backtest: dict | None = None,
          kind: str = "rsi_reversal", symbols=("600519", "000001")) -> None:
    """往 temp store 种一个最小可回测策略（不含网络字段）。"""
    record = {
        "id": sid, "name": f"测试策略-{sid}", "status": status, "kind": kind,
        "direction": "利空", "symbols": list(symbols),
        "params": {"n": 14, "oversold": 30, "overbought": 70},
    }
    if verification_status is not None:
        record["verification_status"] = verification_status
    if backtest is not None:
        record["backtest"] = backtest
    store.mutate("strategies", sid, lambda _: record)


def _synth_ohlc(start: str, end: str) -> list[dict]:
    """确定性合成 OHLC（跳过周末），让信号/成交/汇总全链路在本地跑通。"""
    cur = datetime.date.fromisoformat(start)
    end_d = datetime.date.fromisoformat(end)
    price = 25.0
    i = 0
    rows: list[dict] = []
    while cur <= end_d:
        if cur.weekday() < 5:
            drift = math.sin(i / 9.0) * 0.012 + math.sin(i / 3.0) * 0.003
            price *= 1.0 + drift
            o, c = price * 0.999, price
            rows.append({
                "date": cur.isoformat(),
                "open": round(o, 3), "high": round(max(o, c) * 1.004, 3),
                "low": round(min(o, c) * 0.996, 3), "close": round(c, 3),
                "volume": 1_000_000 + (i % 5) * 100_000,
            })
            i += 1
        cur += datetime.timedelta(days=1)
    return rows


class _SynthRunner(StrategyBacktestRunner):
    """本地行情 Runner：无 baostock。"""

    def _fetch_hist(self, sym: str, start: str, end: str) -> list:
        return _synth_ohlc(start, end)


class LedgerTests(unittest.TestCase):
    def test_restart_keeps_terminal_backtests_queryable_through_unified_routes(self):
        from fastapi.testclient import TestClient

        from adapter.app import create_app
        from adapter.report_store import ReportStore

        store = _store()
        completed_result = {"verification_status": "passed", "summary": {"trades": 4}}
        store.set("strategies", "strategy-completed", {
            "id": "strategy-completed",
            "status": "active",
            "verification_status": "passed",
            "backtest": completed_result,
        })
        store.set(bt.COLLECTION, "task-completed", {
            "task_id": "task-completed",
            "strategy_id": "strategy-completed",
            "source": "manual",
            "status": "completed",
            "verification_status": "passed",
            "result": completed_result,
            "report_id": "task-completed",
        })
        store.set(bt.COLLECTION, "task-running", {
            "task_id": "task-running",
            "strategy_id": "strategy-running",
            "source": "periodic_retest",
            "status": "running",
            "verification_status": None,
        })

        with patch("adapter.app.JsonStore", return_value=store):
            with TestClient(create_app(report_store=ReportStore(store))) as client:
                completed_status = client.get("/analyze/task-completed")
                completed_payload = client.get("/analyze/task-completed/result")
                failed_status = client.get("/analyze/task-running")
                failed_payload = client.get("/analyze/task-running/result")

        self.assertEqual(completed_status.status_code, 200)
        self.assertEqual(completed_status.json(), {
            "task_id": "task-completed",
            "task_type": "strategy",
            "status": "done",
            "error": None,
        })
        self.assertEqual(completed_payload.status_code, 200)
        self.assertEqual(completed_payload.json(), completed_result)
        self.assertEqual(failed_status.status_code, 200)
        self.assertEqual(failed_status.json(), {
            "task_id": "task-running",
            "task_type": "strategy",
            "status": "failed",
            "error": "服务重启导致任务中断，可重新运行",
        })
        self.assertEqual(failed_payload.status_code, 409)
        self.assertEqual(failed_payload.json(), {"detail": "任务尚未完成"})

    def test_create_pending_task_persists_before_claim_and_deduplicates(self):
        store = _store()
        _seed(store, "strat-pending")

        first = bt.create_pending_task(
            store,
            task_id="task-pending-1",
            strategy_id="strat-pending",
            source="initial_auto",
            window_start="2024-01-01",
            window_end="2025-12-31",
            lookback_years=2.0,
            initial_capital=100_000.0,
            request_params={"strategy_id": "strat-pending", "lookback_years": 2.0},
            dedupe_key="initial:strat-pending",
        )
        duplicate = bt.create_pending_task(
            store,
            task_id="task-pending-2",
            strategy_id="strat-pending",
            source="initial_auto",
            window_start="2024-01-01",
            window_end="2025-12-31",
            lookback_years=2.0,
            initial_capital=100_000.0,
            request_params={"strategy_id": "strat-pending", "lookback_years": 2.0},
            dedupe_key="initial:strat-pending",
        )

        self.assertEqual(first["task_id"], "task-pending-1")
        self.assertEqual(first["status"], "pending")
        self.assertIsNone(first["verification_status"])
        self.assertEqual(duplicate["task_id"], first["task_id"])
        self.assertEqual(len(bt.list_tasks(store, strategy_id="strat-pending")), 1)

    def test_concurrent_create_with_same_dedupe_key_persists_one_task(self):
        store = _store()
        barrier = threading.Barrier(3)
        results: list[dict] = []

        def create(task_id: str) -> None:
            barrier.wait()
            results.append(bt.create_pending_task(
                store,
                task_id=task_id,
                strategy_id="strat-concurrent",
                source="periodic_retest",
                window_start="2024-01-01",
                window_end="2025-12-31",
                request_params={"strategy_id": "strat-concurrent"},
                dedupe_key="periodic_retest:strat-concurrent:2026-09-04",
            ))

        threads = [threading.Thread(target=create, args=(f"task-{index}",)) for index in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()

        self.assertEqual(len(store.all(bt.COLLECTION)), 1)
        self.assertEqual(len({row["task_id"] for row in results}), 1)

    def test_cancelled_task_cannot_be_completed_by_a_late_worker(self):
        store = _store()
        _seed(store, "strat-cancel")
        bt.create_pending_task(
            store,
            task_id="task-cancel",
            strategy_id="strat-cancel",
            source="manual",
            window_start="2024-01-01",
            window_end="2025-12-31",
        )

        self.assertTrue(bt.claim_task(store, "task-cancel"))
        self.assertTrue(bt.cancel_task(store, "task-cancel"))
        self.assertFalse(bt.complete_task(
            store,
            "task-cancel",
            verification_status="passed",
            thresholds_pass=True,
            result={"out_of_sample": {}},
        ))

        row = store.get(bt.COLLECTION, "task-cancel")
        self.assertEqual(row["status"], "cancelled")
        self.assertIsNone(row["verification_status"])

    def test_pending_task_can_only_be_reserved_for_one_background_dispatch(self):
        store = _store()
        bt.create_pending_task(
            store,
            task_id="task-reserve",
            strategy_id="strat-reserve",
            source="initial_auto",
            window_start="2024-01-01",
            window_end="2025-12-31",
        )

        self.assertTrue(bt.reserve_task(store, "task-reserve"))
        self.assertFalse(bt.reserve_task(store, "task-reserve"))
        self.assertEqual(store.get(bt.COLLECTION, "task-reserve")["status"], "pending")

    def test_recovery_fails_interrupted_running_and_migrates_queued(self):
        store = _store()
        store.mutate(bt.COLLECTION, "task-running", lambda _: {
            "task_id": "task-running", "strategy_id": "s1", "status": "running",
            "verification_status": "pending",
        })
        store.mutate(bt.COLLECTION, "task-queued", lambda _: {
            "task_id": "task-queued", "strategy_id": "s2", "status": "queued",
            "verification_status": "pending",
        })

        recovered = bt.recover_tasks(store)

        self.assertEqual(recovered, {"interrupted": 1, "pending": 1})
        interrupted = store.get(bt.COLLECTION, "task-running")
        self.assertEqual(interrupted["status"], "failed")
        self.assertIn("服务重启", interrupted["failure_reason"])
        self.assertIsNone(interrupted["verification_status"])
        queued = store.get(bt.COLLECTION, "task-queued")
        self.assertEqual(queued["status"], "pending")
        self.assertNotIn("dispatch_reserved_at", queued)
        self.assertIsNone(queued["verification_status"])

    def test_recovery_projects_legacy_completed_source_and_verdict(self):
        store = _store()
        store.set(bt.COLLECTION, "task-legacy", {
            "task_id": "task-legacy", "strategy_id": "s1", "status": "completed",
            "source": "auto", "verification_status": "failed",
            "result": {"verification_status": "failed", "reason": "旧结论"},
        })

        bt.recover_tasks(store)

        detail = bt.get_task(store, "task-legacy")
        summary = bt.list_tasks(store)[0]
        self.assertEqual(detail["source"], "auto_legacy")
        self.assertEqual(detail["verification_status"], "not_passed")
        self.assertEqual(detail["result"]["verification_status"], "not_passed")
        self.assertEqual(summary["source"], "auto_legacy")
        self.assertEqual(summary["verification_status"], "not_passed")

    def test_manual_run_records_completed_task_and_persists_backtest(self):
        store = _store()
        _seed(store, "strat-a")
        runner = _SynthRunner(store)
        runner.run(
            {"strategy_id": "strat-a", "source": "auto",
             "start_date": "2024-01-01", "end_date": "2025-12-31"},
            lambda _m: None,
        )
        tasks = bt.list_tasks(store, strategy_id="strat-a")
        self.assertEqual(len(tasks), 1)
        row = tasks[0]
        self.assertEqual(row["source"], "auto_legacy")
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["window"], {"start": "2024-01-01", "end": "2025-12-31"})
        self.assertIsNone(row["lookback_years"])  # 显式区间 → 无预设年数
        self.assertIn(row["verification_status"], ("insufficient", "passed", "not_passed"))
        self.assertIsInstance(row["thresholds_pass"], bool)
        self.assertIn("summary", row)  # 列表行剔掉大块 result 曲线
        self.assertNotIn("result", row)
        self.assertIsNone(row["failure_reason"])
        self.assertEqual(row["report_id"], row["task_id"])
        self.assertIsNotNone(store.get("reports", row["report_id"]))

    def test_runner_claims_the_existing_task_returned_by_deduplication(self):
        store = _store()
        _seed(store, "strat-dedupe", symbols=("600519",))
        bt.create_pending_task(
            store,
            task_id="d" * 32,
            strategy_id="strat-dedupe",
            source="initial_auto",
            window_start="2024-01-01",
            window_end="2025-12-31",
            request_params={"strategy_id": "strat-dedupe"},
            dedupe_key="initial_auto:strat-dedupe",
        )

        _SynthRunner(store).run({
            "task_id": "e" * 32,
            "strategy_id": "strat-dedupe",
            "source": "initial_auto",
            "dedupe_key": "initial_auto:strat-dedupe",
            "start_date": "2024-01-01",
            "end_date": "2025-12-31",
        }, lambda _message: None)

        self.assertEqual(store.get(bt.COLLECTION, "d" * 32)["status"], "completed")
        self.assertIsNone(store.get(bt.COLLECTION, "e" * 32))
        # 最新证据仍写回策略记录（行为不变）
        self.assertIsNotNone((store.get("strategies", "strat-dedupe") or {}).get("backtest"))

    def test_lookback_run_records_preset_years_window(self):
        store = _store()
        _seed(store, "strat-b")
        runner = _SynthRunner(store)
        runner.run(
            {"strategy_id": "strat-b", "source": "manual", "lookback_years": 1.5},
            lambda _m: None,
        )
        row = bt.list_tasks(store, strategy_id="strat-b")[0]
        self.assertEqual(row["source"], "manual")
        self.assertEqual(row["lookback_years"], 1.5)
        expected_start = (datetime.date.today() - datetime.timedelta(days=int(1.5 * 366))).isoformat()
        self.assertEqual(row["window"]["start"], expected_start)
        self.assertEqual(row["window"]["end"], datetime.date.today().isoformat())

    def test_missing_strategy_raises_but_records_failed_task(self):
        store = _store()
        runner = _SynthRunner(store)
        with self.assertRaises(ValueError):
            runner.run({"strategy_id": "no-such"}, lambda _m: None)
        rows = bt.list_tasks(store, strategy_id="no-such")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertIsNotNone(rows[0]["failure_reason"])
        self.assertIn("策略不存在", rows[0]["failure_reason"])

    def test_inflight_and_latest_completed_with_backtest_ran_at_fallback(self):
        store = _store()
        _seed(store, "strat-c")
        bt.begin_task(store, task_id="t1", strategy_id="strat-c", source="manual",
                      window_start="2024-01-01", window_end="2024-12-31")
        self.assertTrue(bt.has_inflight(store, "strat-c"))
        self.assertIsNone(bt.latest_completed_at(store, "strat-c"))
        bt.complete_task(store, "t1", verification_status="passed",
                         thresholds_pass=True, result={"out_of_sample": {}})
        self.assertFalse(bt.has_inflight(store, "strat-c"))
        self.assertEqual(bt.latest_completed_at(store, "strat-c"),
                         (store.get(bt.COLLECTION, "t1") or {}).get("completed_at"))
        # 无任务行 → 回退策略 backtest.ran_at（兼容改造前老数据）
        _seed(store, "strat-old", status="active", verification_status="passed",
              backtest={"ran_at": "2026-08-01 12:00:00"})
        self.assertEqual(bt.latest_completed_at(store, "strat-old"),
                         "2026-08-01 12:00:00")

    def test_is_auto_eligible_gates(self):
        def rec(**kw):
            base = {"status": "candidate", "verification_status": None}
            base.update(kw)
            return base
        self.assertTrue(bt.is_auto_eligible(rec(status="candidate")))
        self.assertTrue(bt.is_auto_eligible(rec(status="active", verification_status="passed")))
        self.assertTrue(bt.is_auto_eligible(rec(status="active", verification_status="insufficient")))
        self.assertFalse(bt.is_auto_eligible(rec(status="retired")))          # 归档不再复测
        self.assertFalse(bt.is_auto_eligible(rec(status="rejected")))         # 淘汰不再复测
        self.assertFalse(bt.is_auto_eligible(rec(verification_status="not_passed")))
        self.assertFalse(bt.is_auto_eligible(rec(verification_status="failed")))  # 历史兼容
        self.assertFalse(bt.is_auto_eligible(rec(verification_status="archived")))
        self.assertFalse(bt.is_auto_eligible(None))


class _PatrolRunner:
    """巡检用录制 Runner：不真跑行情，记录被调的参数并按 sid 返回验证分类。"""

    results: dict[str, str] = {}
    calls: list[dict] = []

    def __init__(self, store):
        self.store = store

    def run(self, params: dict, _cb) -> dict:
        _PatrolRunner.calls.append(params)
        sid = params["strategy_id"]
        self.store.update("strategies", sid, status="active")
        return {"verification_status": _PatrolRunner.results.get(sid, "passed")}


class PatrolTests(unittest.TestCase):
    def setUp(self):
        _PatrolRunner.calls = []
        _PatrolRunner.results = {}

    def test_patrol_selects_due_eligible_and_skips_inflight_ineligible(self):
        store = _store()
        now = datetime.datetime.now()
        past = (now - datetime.timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
        recent = now.strftime("%Y-%m-%d %H:%M:%S")
        _seed(store, "s-first", status="candidate")                                  # 首测 due
        _seed(store, "s-retest", status="active", verification_status="passed",
              backtest={"ran_at": past})                                            # 满间隔复测 due
        _seed(store, "s-recent", status="active", verification_status="passed",
              backtest={"ran_at": recent})                                          # 未到期
        _seed(store, "s-retired", status="retired", verification_status="archived")  # 归档排除
        _seed(store, "s-rejected", status="rejected")                                # 淘汰排除
        _seed(store, "s-failed", status="active", verification_status="not_passed")  # 验证未通过排除
        _seed(store, "s-inflight", status="active")                                  # 进行中跳过
        store.mutate(bt.COLLECTION, "t-running", lambda _: {
            "task_id": "t-running", "strategy_id": "s-inflight",
            "source": "auto", "status": "running",
        })
        _seed(store, "s-reject", status="candidate")                                 # 未通过也完成 → active
        _PatrolRunner.results = {"s-reject": "not_passed"}

        with patch("adapter.brief_engine._is_trading_day", return_value=True), \
             patch("adapter.scheduler.JsonStore", lambda: store), \
             patch("adapter.strategies.StrategyBacktestRunner", _PatrolRunner):
            _run_backtest_patrol()

        called = {params["strategy_id"] for params in _PatrolRunner.calls}
        self.assertEqual(called, {"s-first", "s-retest", "s-reject"})
        by_id = {params["strategy_id"]: params for params in _PatrolRunner.calls}
        self.assertEqual(by_id["s-retest"]["source"], "periodic_retest")
        self.assertEqual(by_id["s-first"]["source"], "initial_auto")
        self.assertEqual(by_id["s-reject"]["source"], "initial_auto")
        for params in _PatrolRunner.calls:
            self.assertEqual(params["lookback_years"], scheduler.settings.auto_backtest_lookback_years)
            self.assertEqual(params["oos_frac"], 0.3)
            self.assertEqual(params["min_oos_trades"], 4)
        self.assertEqual((store.get("strategies", "s-reject") or {}).get("status"), "active")
        self.assertEqual((store.get("strategies", "s-first") or {}).get("status"), "active")

    def test_retest_uses_15_day_boundary_and_intentionally_excludes_not_passed(self):
        store = _store()
        now = datetime.datetime.now()
        for days in (14, 15, 16):
            ran_at = (now - datetime.timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
            _seed(
                store,
                f"s-{days}",
                status="active",
                verification_status="passed",
                backtest={"ran_at": ran_at},
            )
        _seed(
            store,
            "s-not-passed",
            status="active",
            verification_status="not_passed",
            backtest={"ran_at": (now - datetime.timedelta(days=30)).strftime(
                "%Y-%m-%d %H:%M:%S"
            )},
        )

        with patch("adapter.brief_engine._is_trading_day", return_value=True), \
             patch("adapter.scheduler.JsonStore", lambda: store), \
             patch("adapter.strategies.StrategyBacktestRunner", _PatrolRunner):
            _run_backtest_patrol()

        called = {params["strategy_id"] for params in _PatrolRunner.calls}
        self.assertEqual(called, {"s-15", "s-16"})


class _FirstBacktestRunner:
    """生成即首测用 fake runner：录制参数并按 sid 返回验证分类（不真跑行情）。"""

    results: dict[str, str] = {}
    calls: list[dict] = []

    def __init__(self, store):
        self.store = store

    def run(self, params: dict, _cb) -> dict:
        _FirstBacktestRunner.calls.append(params)
        sid = params["strategy_id"]
        self.store.update("strategies", sid, status="active")
        return {"verification_status": _FirstBacktestRunner.results.get(sid, "passed")}


class FirstBacktestTests(unittest.TestCase):
    """候选落池即触发首测：run_first_backtests 的筛选 + 结果语义。"""

    def setUp(self):
        _FirstBacktestRunner.calls = []
        _FirstBacktestRunner.results = {}

    def test_completed_candidate_becomes_active(self):
        store = _store()
        _seed(store, "s-pass", status="candidate", verification_status="pending")
        _FirstBacktestRunner.results = {"s-pass": "passed"}

        with patch("adapter.strategies.StrategyBacktestRunner", _FirstBacktestRunner):
            stats = bt.run_first_backtests(store, ["s-pass"])

        self.assertEqual(stats["started"], 1)
        self.assertEqual(stats["completed"], 1)
        self.assertEqual(stats["rejected"], 0)
        self.assertEqual(len(_FirstBacktestRunner.calls), 1)
        params = _FirstBacktestRunner.calls[0]
        self.assertEqual(params["strategy_id"], "s-pass")
        self.assertEqual(params["source"], "initial_auto")
        self.assertEqual(params["lookback_years"], bt._default_auto_lookback())  # 默认 lookback 年
        self.assertEqual((store.get("strategies", "s-pass") or {}).get("status"), "active")

    def test_not_passed_candidate_is_still_activated(self):
        store = _store()
        _seed(store, "s-fail", status="candidate")
        _FirstBacktestRunner.results = {"s-fail": "not_passed"}

        with patch("adapter.strategies.StrategyBacktestRunner", _FirstBacktestRunner):
            stats = bt.run_first_backtests(store, ["s-fail"])

        self.assertEqual(stats["started"], 1)
        self.assertEqual(stats["rejected"], 0)
        self.assertEqual((store.get("strategies", "s-fail") or {}).get("status"), "active")

    def test_skips_inflight_existing_evidence_and_ineligible(self):
        store = _store()
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _seed(store, "s-inflight", status="candidate")          # 有进行中任务 → 跳过
        store.mutate(bt.COLLECTION, "t-running", lambda _: {
            "task_id": "t-running", "strategy_id": "s-inflight",
            "source": "auto", "status": "running",
        })
        _seed(store, "s-done", status="candidate",
              backtest={"ran_at": now})                         # 已有首测证据 → 跳过
        _seed(store, "s-retired", status="retired")             # 归档 → 不参与
        _seed(store, "s-ok", status="candidate")                # 应跑
        _FirstBacktestRunner.results = {"s-ok": "passed"}

        with patch("adapter.strategies.StrategyBacktestRunner", _FirstBacktestRunner):
            stats = bt.run_first_backtests(store, ["s-inflight", "s-done", "s-retired", "s-ok"])

        self.assertEqual(stats["started"], 1)
        self.assertEqual(stats["skipped"], 3)
        self.assertEqual([c["strategy_id"] for c in _FirstBacktestRunner.calls], ["s-ok"])

    def test_trigger_enqueues_all_ids_via_background_thread(self):
        store = _store()
        _seed(store, "s-a")
        _seed(store, "s-b")
        with patch("adapter.backtest_tasks.JsonStore", return_value=store), \
             patch("adapter.backtest_tasks.threading.Thread") as mock_thread:
            result = bt.trigger_first_backtests(["s-a", "s-b", ""])
        self.assertEqual(result, {"enqueued": 2})  # 空串过滤
        rows = store.all(bt.COLLECTION)
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["status"] for row in rows.values()}, {"pending"})
        self.assertEqual({row["source"] for row in rows.values()}, {"initial_auto"})
        mock_thread.assert_called_once()
        self.assertTrue(mock_thread.call_args.kwargs.get("daemon"))


if __name__ == "__main__":
    unittest.main()
