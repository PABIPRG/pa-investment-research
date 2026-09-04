# -*- coding: utf-8 -*-
"""策略验证分类与生命周期解耦的业务契约。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from fastapi.testclient import TestClient

from adapter.app import create_app
from adapter import backtest_tasks as bt
from adapter import strategies as strategies_module
from adapter.report_store import ReportStore
from adapter.store import JsonStore
from adapter.strategies import (
    _persist_strategy_backtest,
    _verification_outcome,
    create_candidates,
    finalize_completed_backtest_resilient,
    project_strategy_verification,
    reconcile_completed_backtests,
    StrategyBacktestRunner,
    strategy_verification_status,
    transition_strategy,
)
from adapter.task_report_render import render_strategy_report


class StrategyVerificationTests(unittest.TestCase):
    def test_strategy_projection_keeps_five_semantics_independent(self):
        projected = project_strategy_verification({
            "id": "variant-1",
            "status": "candidate",
            "verification_status": "not_passed",
            "source": "evolution",
            "evolve": {"tier": 2},
        }, task_status="running")

        self.assertEqual(projected["participation_status"], "candidate")
        self.assertEqual(projected["verification_status"], "not_passed")
        self.assertEqual(projected["confidence_tier"], 2)
        self.assertEqual(projected["source"], "evolution")
        self.assertEqual(projected["task_status"], "running")
        self.assertEqual(projected["semantic_labels"], {
            "participation": "候选",
            "verification": "验证未通过",
            "confidence": "已升级",
            "source": "变异来源",
            "task": "运行中",
        })
    def test_completed_finalization_immediately_compensates_transient_report_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-finalize", {
                "id": "strategy-finalize", "name": "补偿策略", "kind": "momentum",
                "symbols": ["600519"], "status": "candidate",
                "verification_status": "insufficient",
            })
            bt.create_pending_task(
                store, task_id="9" * 32, strategy_id="strategy-finalize",
                source="manual", window_start="2024-01-01", window_end="2025-12-31",
                request_params={"strategy_id": "strategy-finalize"},
            )
            bt.claim_task(store, "9" * 32)
            result = {"verification_status": "not_passed", "reason": "未达标"}
            bt.complete_task(
                store, "9" * 32, verification_status="not_passed",
                thresholds_pass=False, result=result,
            )

            real_ensure = strategies_module._ensure_completed_report
            calls = 0

            def flaky_ensure(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError("瞬时写入失败")
                return real_ensure(*args, **kwargs)

            with patch("adapter.strategies._ensure_completed_report", side_effect=flaky_ensure):
                output = finalize_completed_backtest_resilient(store, "9" * 32)

            self.assertEqual(output["status"], "active")
            self.assertEqual(store.get(bt.COLLECTION, "9" * 32)["report_id"], "9" * 32)
            self.assertEqual(calls, 2)

    def test_restart_reconciles_completed_task_with_strategy_and_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-recover", {
                "id": "strategy-recover",
                "name": "恢复策略",
                "kind": "momentum",
                "symbols": ["600519"],
                "status": "candidate",
                "verification_status": "insufficient",
            })
            bt.create_pending_task(
                store,
                task_id="a" * 32,
                strategy_id="strategy-recover",
                source="manual",
                window_start="2024-01-01",
                window_end="2025-12-31",
                request_params={"strategy_id": "strategy-recover"},
            )
            bt.claim_task(store, "a" * 32)
            result = {
                "verification_status": "not_passed",
                "thresholds_pass": False,
                "reason": "样本外未达标",
                "in_sample": {},
                "out_of_sample": {},
                "symbol_errors": {},
            }
            bt.complete_task(
                store,
                "a" * 32,
                verification_status="not_passed",
                thresholds_pass=False,
                result=result,
            )

            repaired = reconcile_completed_backtests(store)

            self.assertEqual(repaired, {"repaired": 1, "failed": 0})
            self.assertEqual(store.get("strategies", "strategy-recover")["status"], "active")
            self.assertEqual(store.get(bt.COLLECTION, "a" * 32)["report_id"], "a" * 32)

    def test_reconciliation_uses_latest_completion_for_strategy_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-history", {
                "id": "strategy-history", "name": "历史策略", "kind": "momentum",
                "symbols": ["600519"], "status": "candidate",
                "verification_status": "insufficient",
            })
            for task_id, completed_at, verdict in (
                ("b" * 32, "2026-09-01 10:00:00", "passed"),
                ("c" * 32, "2026-09-02 10:00:00", "not_passed"),
            ):
                result = {
                    "verification_status": verdict,
                    "thresholds_pass": verdict == "passed",
                    "reason": verdict,
                }
                store.set(bt.COLLECTION, task_id, {
                    "task_id": task_id, "strategy_id": "strategy-history",
                    "status": "completed", "completed_at": completed_at,
                    "verification_status": verdict,
                    "thresholds_pass": verdict == "passed", "result": result,
                })

            reconcile_completed_backtests(store)

            strategy = store.get("strategies", "strategy-history")
            self.assertEqual(strategy["verification_status"], "not_passed")
            self.assertEqual(strategy["backtest"]["reason"], "not_passed")
            self.assertEqual(reconcile_completed_backtests(store), {"repaired": 0, "failed": 0})

    def test_reconciliation_uses_completion_sequence_when_timestamps_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-sequence", {
                "id": "strategy-sequence", "name": "顺序策略", "kind": "momentum",
                "symbols": ["600519"], "status": "candidate",
                "verification_status": "insufficient",
            })
            with patch("adapter.backtest_tasks._iso_now", return_value="2026-09-03 10:00:00"):
                for task_id, verdict in (("f" * 32, "passed"), ("0" * 32, "not_passed")):
                    bt.create_pending_task(
                        store, task_id=task_id, strategy_id="strategy-sequence",
                        source="manual", window_start="2024-01-01", window_end="2025-12-31",
                    )
                    bt.claim_task(store, task_id)
                    bt.complete_task(
                        store, task_id, verification_status=verdict,
                        thresholds_pass=verdict == "passed",
                        result={"verification_status": verdict, "reason": verdict},
                    )

            reconcile_completed_backtests(store)

            strategy = store.get("strategies", "strategy-sequence")
            self.assertEqual(strategy["verification_status"], "not_passed")
            self.assertEqual(strategy["backtest"]["reason"], "not_passed")
            self.assertEqual(
                [row["task_id"] for row in bt.list_tasks(store, strategy_id="strategy-sequence")],
                ["0" * 32, "f" * 32],
            )

    def test_late_finalize_cannot_overwrite_newer_completed_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-race", {
                "id": "strategy-race", "name": "并发策略", "kind": "momentum",
                "symbols": ["600519"], "status": "candidate",
                "verification_status": "insufficient",
            })
            task_ids = ("1" * 32, "2" * 32)
            for task_id, verdict in zip(task_ids, ("passed", "not_passed")):
                bt.create_pending_task(
                    store, task_id=task_id, strategy_id="strategy-race",
                    source="manual", window_start="2024-01-01", window_end="2025-12-31",
                    request_params={"strategy_id": "strategy-race"},
                )
                bt.claim_task(store, task_id)
                bt.complete_task(
                    store, task_id, verification_status=verdict,
                    thresholds_pass=verdict == "passed",
                    result={"verification_status": verdict, "reason": verdict},
                )

            strategies_module.finalize_completed_backtest(store, task_ids[1])
            strategies_module.finalize_completed_backtest(store, task_ids[0])

            strategy = store.get("strategies", "strategy-race")
            self.assertEqual(strategy["backtest"]["reason"], "not_passed")
            self.assertEqual(strategy["latest_backtest_sequence"], 2)
            self.assertEqual(strategy["latest_backtest_task_id"], task_ids[1])
            self.assertEqual(store.get(bt.COLLECTION, task_ids[0])["report_id"], task_ids[0])

    def test_new_candidate_starts_insufficient_without_changing_lifecycle(self):
        event = {
            "id": "event-1", "summary": "产业订单改善",
            "tickers": [{"code": "600519", "name": "贵州茅台"}],
        }
        hypothesis = {
            "event_idx": 0,
            "kind": "momentum",
            "params": {"n": 12},
            "symbols": ["600519"],
            "direction": "利好",
            "rationale": "订单改善可能形成趋势",
        }
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            with patch("adapter.strategies.JsonStore", return_value=store):
                strategy_ids = create_candidates([event], [hypothesis])

            self.assertEqual(len(strategy_ids), 1)
            strategy = store.get("strategies", strategy_ids[0])
            self.assertEqual(strategy["status"], "candidate")
            self.assertEqual(strategy["verification_status"], "insufficient")
            self.assertEqual(strategy["name"], "贵州茅台")
            self.assertEqual(strategy["tickers"], [{"code": "600519", "name": "贵州茅台"}])

    def test_latest_evidence_projects_verification_without_lifecycle_guessing(self):
        self.assertEqual(
            strategy_verification_status({"status": "active", "backtest": None}),
            "insufficient",
        )
        self.assertEqual(
            strategy_verification_status({
                "status": "rejected",
                "backtest": {"thresholds_pass": True, "reason": "样本外达标"},
            }),
            "passed",
        )
        self.assertEqual(
            strategy_verification_status({
                "status": "active",
                "backtest": {"thresholds_pass": False, "reason": "样本外成交不足"},
            }),
            "insufficient",
        )
        self.assertEqual(
            strategy_verification_status({
                "status": "candidate",
                "backtest": {"thresholds_pass": False, "reason": "样本外未达标"},
            }),
            "not_passed",
        )
        self.assertEqual(
            project_strategy_verification({
                "status": "retired",
                "backtest": {"thresholds_pass": True},
            })["verification_status"],
            "passed",
        )

    def test_threshold_outcome_has_three_independent_verification_results(self):
        self.assertEqual(
            _verification_outcome({"n_evaluated": 2}, 4),
            ("insufficient", False, "样本外成交不足(2<4)"),
        )
        self.assertEqual(
            _verification_outcome({
                "n_evaluated": 8,
                "win_rate_pct": 62.5,
                "avg_simulated_return_pct": 1.2,
            }, 4),
            ("passed", True, "样本外胜率/均收益达标"),
        )
        status, passed, reason = _verification_outcome({
            "n_evaluated": 8,
            "win_rate_pct": 40.0,
            "avg_simulated_return_pct": -0.5,
        }, 4)
        self.assertEqual((status, passed), ("not_passed", False))
        self.assertIn("样本外未达标", reason)

    def test_backtest_persistence_activates_candidate_and_preserves_terminal_lifecycle(self):
        backtest = {
            "thresholds_pass": True,
            "verification_status": "passed",
            "reason": "样本外胜率/均收益达标",
        }
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            for lifecycle in ("candidate", "active", "rejected", "retired"):
                strategy_id = f"strategy-{lifecycle}"
                store.set("strategies", strategy_id, {
                    "id": strategy_id,
                    "status": lifecycle,
                    "verification_status": "insufficient",
                })
                saved = _persist_strategy_backtest(
                    store, strategy_id, {}, backtest, "passed"
                )
                self.assertEqual(
                    saved["status"], "active" if lifecycle == "candidate" else lifecycle
                )
                self.assertEqual(saved["verification_status"], "passed")

    def test_strategy_runner_activates_candidate_when_first_task_completes(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-1", {
                "id": "strategy-1",
                "name": "事件趋势策略",
                "kind": "momentum",
                "params": {"n": 10},
                "symbols": ["600519"],
                "direction": "利好",
                "status": "candidate",
                "verification_status": "insufficient",
            })
            runner = StrategyBacktestRunner(store)
            progress = []
            in_summary = {
                "n_evaluated": 10,
                "win_rate_pct": 60.0,
                "avg_simulated_return_pct": 1.0,
            }
            out_summary = {
                "n_evaluated": 8,
                "win_rate_pct": 62.5,
                "avg_simulated_return_pct": 1.2,
            }
            with (
                patch.object(runner, "_fetch_hist", return_value=[{}] * 50),
                patch("adapter.strategies._make_df", return_value=[{}] * 50),
                patch("adapter.strategies.signal_series", return_value=object()),
                patch(
                    "adapter.strategies.split_in_out",
                    return_value=(object(), object(), object(), object()),
                ),
                patch(
                    "adapter.strategies.simulate_trades",
                    side_effect=[[{"ret_pct": 1.0}], [{"ret_pct": 1.2}]],
                ),
                patch(
                    "adapter.strategies.trades_to_decision_rows",
                    side_effect=[[{"sample": "in"}], [{"sample": "out"}]],
                ),
                patch(
                    "adapter.backtest_engine.compute_summary",
                    side_effect=[in_summary, out_summary],
                ),
                patch("adapter.strategies.portfolio_equity_curve", return_value={}),
                patch("adapter.strategies.curve_stats", return_value={}),
            ):
                result = runner.run(
                    {"strategy_id": "strategy-1", "min_oos_trades": 4},
                    progress.append,
                )

            saved = store.get("strategies", "strategy-1")
            self.assertEqual(result["status"], "active")
            self.assertEqual(result["verification_status"], "passed")
            self.assertEqual(saved["status"], "active")
            self.assertEqual(saved["verification_status"], "passed")
            self.assertEqual(result["signal"]["verification_status"], "passed")
            self.assertIn("生命周期进入 active", progress[-1])

    def test_runner_does_not_activate_when_every_symbol_fetch_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-no-data", {
                "id": "strategy-no-data",
                "name": "无行情策略",
                "kind": "momentum",
                "params": {"n": 10},
                "symbols": ["600519", "000001"],
                "status": "candidate",
                "verification_status": "insufficient",
            })
            runner = StrategyBacktestRunner(store)
            with patch.object(runner, "_fetch_hist", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "没有可用的标的行情"):
                    runner.run({"strategy_id": "strategy-no-data"}, lambda _m: None)

            saved = store.get("strategies", "strategy-no-data")
            task = next(iter(store.all("strategy_backtests").values()))
            self.assertEqual(saved["status"], "candidate")
            self.assertEqual(task["status"], "failed")

    def test_lifecycle_transition_preserves_verification_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-1", {
                "id": "strategy-1",
                "status": "candidate",
                "verification_status": "passed",
                "backtest": {"thresholds_pass": True},
            })

            activated = transition_strategy(store, "strategy-1", "activate")
            self.assertEqual(activated["status"], "active")
            self.assertEqual(activated["verification_status"], "passed")

            rejected = transition_strategy(store, "strategy-1", "reject")
            self.assertEqual(rejected["status"], "rejected")
            self.assertEqual(rejected["verification_status"], "passed")

            retired = transition_strategy(store, "strategy-1", "retire")
            self.assertEqual(retired["status"], "retired")
            self.assertEqual(retired["verification_status"], "passed")

            reactivated = transition_strategy(store, "strategy-1", "activate")
            self.assertEqual(reactivated["status"], "active")
            self.assertEqual(reactivated["verification_status"], "passed")

    def test_strategy_report_names_verification_separately_from_lifecycle(self):
        report = render_strategy_report(
            {"id": "strategy-1", "name": "事件策略", "symbols": ["600519"]},
            "candidate",
            {
                "verification_status": "passed",
                "thresholds_pass": True,
                "reason": "样本外胜率/均收益达标",
            },
        )

        self.assertIn("生命周期状态：candidate", report)
        self.assertIn("验证分类：已验证通过", report)
        self.assertIn("## 验证结论", report)


class StrategyVerificationHttpTests(unittest.TestCase):
    def test_impact_route_declares_bounded_50_without_fake_pagination(self):
        events = [
            {"id": f"event-{index}", "summary": f"事件 {index}"}
            for index in range(55)
        ] + [{"id": "event-1", "summary": "重复事件"}]
        healthy = {"degraded": False}
        with patch(
            "adapter.strategies.fetch_events_with_status",
            return_value=(events, healthy),
        ) as fetch:
            with TestClient(create_app()) as client:
                response = client.get("/personalized/impact?limit=999")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(fetch.call_args.kwargs["limit"], 50)
        self.assertEqual(payload["count"], 50)
        self.assertEqual(payload["page_info"], {
            "mode": "bounded",
            "pagination_supported": False,
            "max_visible": 50,
        })
        self.assertNotIn("total", payload)
        self.assertEqual(len({event["id"] for event in payload["events"]}), 50)

    def test_impact_route_surfaces_upstream_failure_for_recoverable_refresh(self):
        degraded = {
            "degraded": True,
            "source": "fail-open",
            "reason": "market-watch unavailable",
        }
        with patch(
            "adapter.strategies.fetch_events_with_status",
            return_value=([], degraded),
        ):
            with TestClient(create_app()) as client:
                response = client.get("/personalized/impact?limit=50")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {
            "detail": "事件传导数据源暂时不可用，请稍后重试",
        })

    def test_backtest_detail_cancel_and_retry_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-1", {
                "id": "strategy-1", "status": "candidate",
                "verification_status": "insufficient",
            })
            store.set("strategy_backtests", "task-1", {
                "task_id": "task-1",
                "strategy_id": "strategy-1",
                "source": "manual",
                "status": "pending",
                "request_params": {"strategy_id": "strategy-1", "lookback_years": 2.0},
                "created_at": "2026-09-03 09:00:00",
            })
            with patch("adapter.app.JsonStore", return_value=store):
                app = create_app(report_store=ReportStore(store))
                with patch.object(app.state.manager, "cancel", return_value=True), \
                     patch.object(app.state.manager, "start", return_value="task-2") as start:
                    with TestClient(app) as client:
                        detail = client.get("/strategies/strategy-1/backtests/task-1")
                        cancelled = client.post(
                            "/strategies/strategy-1/backtests/task-1/cancel"
                        )
                        retried = client.post(
                            "/strategies/strategy-1/backtests/task-1/retry"
                        )

            self.assertEqual(detail.status_code, 200)
            self.assertEqual(detail.json()["task_id"], "task-1")
            self.assertEqual(cancelled.json()["status"], "cancelled")
            self.assertEqual(retried.json(), {
                "task_id": "task-2", "retry_of_task_id": "task-1"
            })
            retry_params = start.call_args.args[0]
            self.assertEqual(retry_params["retry_of_task_id"], "task-1")
            self.assertEqual(retry_params["source"], "manual")

    def test_list_detail_and_transition_return_stable_verification_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "legacy-1", {
                "id": "legacy-1",
                "name": "历史策略",
                "status": "active",
                "source": "evolution",
                "evolve": {"tier": 2},
                "backtest": {
                    "thresholds_pass": False,
                    "reason": "样本外成交不足(2<4)",
                },
                "created_at": "2026-08-26 09:00:00",
            })
            with patch("adapter.app.JsonStore", return_value=store):
                with TestClient(create_app(report_store=ReportStore(store))) as client:
                    bt.create_pending_task(
                        store,
                        task_id="8" * 32,
                        strategy_id="legacy-1",
                        source="periodic_retest",
                        window_start="2024-01-01",
                        window_end="2025-12-31",
                    )
                    bt.claim_task(store, "8" * 32)
                    listed = client.get("/strategies")
                    detail = client.get("/strategies/legacy-1")
                    retired = client.post("/strategies/legacy-1/retire")

            self.assertEqual(listed.status_code, 200)
            self.assertEqual(
                listed.json()["items"][0]["verification_status"], "insufficient"
            )
            self.assertEqual(detail.status_code, 200)
            self.assertEqual(detail.json()["verification_status"], "insufficient")
            self.assertEqual(listed.json()["items"][0]["semantic_labels"], {
                "participation": "正常运行",
                "verification": "样本不足",
                "confidence": "已升级",
                "source": "变异来源",
                "task": "运行中",
            })
            self.assertEqual(
                detail.json()["semantic_labels"],
                listed.json()["items"][0]["semantic_labels"],
            )
            self.assertEqual(retired.status_code, 200)
            self.assertEqual(retired.json(), {
                "id": "legacy-1",
                "status": "retired",
                "verification_status": "insufficient",
            })
            persisted = store.get("strategies", "legacy-1")
            self.assertEqual(persisted["status"], "retired")
            self.assertEqual(persisted["verification_status"], "insufficient")


if __name__ == "__main__":
    unittest.main()
