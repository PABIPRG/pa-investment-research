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
from adapter.report_store import ReportStore
from adapter.store import JsonStore
from adapter.strategies import (
    _persist_strategy_backtest,
    _verification_outcome,
    create_candidates,
    project_strategy_verification,
    StrategyBacktestRunner,
    strategy_verification_status,
    transition_strategy,
)
from adapter.task_report_render import render_strategy_report


class StrategyVerificationTests(unittest.TestCase):
    def test_new_candidate_starts_pending_without_changing_lifecycle(self):
        event = {"id": "event-1", "summary": "产业订单改善"}
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
            self.assertEqual(strategy["verification_status"], "pending")

    def test_latest_evidence_projects_verification_without_lifecycle_guessing(self):
        self.assertEqual(
            strategy_verification_status({"status": "active", "backtest": None}),
            "pending",
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
            "pending",
        )
        self.assertEqual(
            strategy_verification_status({
                "status": "candidate",
                "backtest": {"thresholds_pass": False, "reason": "样本外未达标"},
            }),
            "failed",
        )
        self.assertEqual(
            project_strategy_verification({
                "status": "retired",
                "backtest": {"thresholds_pass": True},
            })["verification_status"],
            "archived",
        )

    def test_threshold_outcome_has_three_independent_verification_results(self):
        self.assertEqual(
            _verification_outcome({"n_evaluated": 2}, 4),
            ("pending", False, "样本外成交不足(2<4)"),
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
        self.assertEqual((status, passed), ("failed", False))
        self.assertIn("样本外未达标", reason)

    def test_backtest_persistence_never_changes_lifecycle(self):
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
                    "verification_status": "pending",
                })
                saved = _persist_strategy_backtest(
                    store, strategy_id, {}, backtest, "passed"
                )
                self.assertEqual(saved["status"], lifecycle)
                self.assertEqual(
                    saved["verification_status"],
                    "archived" if lifecycle == "retired" else "passed",
                )

    def test_strategy_runner_passes_candidate_without_activating_it(self):
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
                "verification_status": "pending",
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
            self.assertEqual(result["status"], "candidate")
            self.assertEqual(result["verification_status"], "passed")
            self.assertEqual(saved["status"], "candidate")
            self.assertEqual(saved["verification_status"], "passed")
            self.assertEqual(result["signal"]["verification_status"], "passed")
            self.assertIn("生命周期保持 candidate", progress[-1])

    def test_lifecycle_transition_preserves_evidence_and_retirement_archives(self):
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
            self.assertEqual(retired["verification_status"], "archived")

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
    def test_list_detail_and_transition_return_stable_verification_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "legacy-1", {
                "id": "legacy-1",
                "name": "历史策略",
                "status": "active",
                "backtest": {
                    "thresholds_pass": False,
                    "reason": "样本外成交不足(2<4)",
                },
                "created_at": "2026-08-26 09:00:00",
            })
            with patch("adapter.app.JsonStore", return_value=store):
                with TestClient(create_app(report_store=ReportStore(store))) as client:
                    listed = client.get("/strategies")
                    detail = client.get("/strategies/legacy-1")
                    retired = client.post("/strategies/legacy-1/retire")

            self.assertEqual(listed.status_code, 200)
            self.assertEqual(
                listed.json()["items"][0]["verification_status"], "pending"
            )
            self.assertEqual(detail.status_code, 200)
            self.assertEqual(detail.json()["verification_status"], "pending")
            self.assertEqual(retired.status_code, 200)
            self.assertEqual(retired.json(), {
                "id": "legacy-1",
                "status": "retired",
                "verification_status": "archived",
            })
            persisted = store.get("strategies", "legacy-1")
            self.assertEqual(persisted["status"], "retired")
            self.assertEqual(persisted["verification_status"], "archived")


if __name__ == "__main__":
    unittest.main()
