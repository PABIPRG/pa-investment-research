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
        self.assertEqual(row["source"], "auto")
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["window"], {"start": "2024-01-01", "end": "2025-12-31"})
        self.assertIsNone(row["lookback_years"])  # 显式区间 → 无预设年数
        self.assertIn(row["verification_status"], ("pending", "passed", "failed"))
        self.assertIsInstance(row["thresholds_pass"], bool)
        self.assertIn("summary", row)  # 列表行剔掉大块 result 曲线
        self.assertNotIn("result", row)
        self.assertIsNone(row["failure_reason"])
        # 最新证据仍写回策略记录（行为不变）
        self.assertIsNotNone((store.get("strategies", "strat-a") or {}).get("backtest"))

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
        self.assertFalse(bt.is_auto_eligible(rec(status="retired")))          # 归档不再复测
        self.assertFalse(bt.is_auto_eligible(rec(status="rejected")))         # 淘汰不再复测
        self.assertFalse(bt.is_auto_eligible(rec(verification_status="failed")))  # 验证失败不再复测
        self.assertFalse(bt.is_auto_eligible(rec(verification_status="archived")))
        self.assertFalse(bt.is_auto_eligible(None))


class _PatrolRunner:
    """巡检用录制 Runner：不真跑行情，记录被调的参数并按 sid 返回验证分类。"""

    results: dict[str, str] = {}
    calls: list[dict] = []

    def __init__(self, store):
        pass

    def run(self, params: dict, _cb) -> dict:
        _PatrolRunner.calls.append(params)
        return {"verification_status": _PatrolRunner.results.get(params["strategy_id"], "passed")}


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
        _seed(store, "s-failed", status="candidate", verification_status="failed")   # 验证失败排除
        _seed(store, "s-inflight", status="active")                                  # 进行中跳过
        store.mutate(bt.COLLECTION, "t-running", lambda _: {
            "task_id": "t-running", "strategy_id": "s-inflight",
            "source": "auto", "status": "running",
        })
        _seed(store, "s-reject", status="candidate")                                 # 首测失败 → reject
        _PatrolRunner.results = {"s-reject": "failed"}

        with patch("adapter.brief_engine._is_trading_day", return_value=True), \
             patch("adapter.scheduler.JsonStore", lambda: store), \
             patch("adapter.strategies.StrategyBacktestRunner", _PatrolRunner):
            _run_backtest_patrol()

        called = {params["strategy_id"] for params in _PatrolRunner.calls}
        self.assertEqual(called, {"s-first", "s-retest", "s-reject"})
        for params in _PatrolRunner.calls:
            self.assertEqual(params["source"], "auto")
            self.assertEqual(params["lookback_years"], scheduler.settings.auto_backtest_lookback_years)
            self.assertEqual(params["oos_frac"], 0.3)
            self.assertEqual(params["min_oos_trades"], 4)
        # 候选失败 + CANDIDATE_AUTO_REJECT → 自动淘汰
        self.assertEqual((store.get("strategies", "s-reject") or {}).get("status"), "rejected")
        # 通过的首测候选不激活（人工确认生效）
        self.assertEqual((store.get("strategies", "s-first") or {}).get("status"), "candidate")


class _FirstBacktestRunner:
    """生成即首测用 fake runner：录制参数并按 sid 返回验证分类（不真跑行情）。"""

    results: dict[str, str] = {}
    calls: list[dict] = []

    def __init__(self, store):
        pass

    def run(self, params: dict, _cb) -> dict:
        _FirstBacktestRunner.calls.append(params)
        return {"verification_status": _FirstBacktestRunner.results.get(params["strategy_id"], "passed")}


class FirstBacktestTests(unittest.TestCase):
    """候选落池即触发首测：run_first_backtests 的筛选 + 结果语义。"""

    def setUp(self):
        _FirstBacktestRunner.calls = []
        _FirstBacktestRunner.results = {}

    def test_passes_candidate_stays_candidate_not_activated(self):
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
        self.assertEqual(params["source"], "auto")
        self.assertEqual(params["lookback_years"], bt._default_auto_lookback())  # 默认 lookback 年
        # 通过只落 passed → 候选保持 candidate（人工确认生效，不自动激活）
        self.assertEqual((store.get("strategies", "s-pass") or {}).get("status"), "candidate")

    def test_failed_candidate_is_rejected(self):
        store = _store()
        _seed(store, "s-fail", status="candidate")
        _FirstBacktestRunner.results = {"s-fail": "failed"}

        with patch("adapter.strategies.StrategyBacktestRunner", _FirstBacktestRunner):
            stats = bt.run_first_backtests(store, ["s-fail"])

        self.assertEqual(stats["started"], 1)
        self.assertEqual(stats["rejected"], 1)
        self.assertEqual((store.get("strategies", "s-fail") or {}).get("status"), "rejected")

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
        with patch("adapter.backtest_tasks.threading.Thread") as mock_thread:
            result = bt.trigger_first_backtests(["s-a", "s-b", ""])
        self.assertEqual(result, {"enqueued": 2})  # 空串过滤
        mock_thread.assert_called_once()
        self.assertTrue(mock_thread.call_args.kwargs.get("daemon"))


if __name__ == "__main__":
    unittest.main()
