# -*- coding: utf-8 -*-
"""自进化闭环回归测试：S_shadow→T→W→H + R→S→U→K outcome + 数据不足护栏。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution -v
依赖：adapter.evolution / adapter.store / adapter.strategies（无网络、无 LLM）。
"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")

from fastapi.testclient import TestClient
from pydantic import ValidationError

from adapter.behavior_profile import compute_behavior_profile
from adapter.app import create_app
from adapter.evolution import (
    EvolutionPreviewConflict,
    attribution,
    current_preview,
    decision_outcome,
    evolve,
    evolve_auto,
    status,
)
from adapter.personalize import _active_strategies
from adapter.schemas import EvolutionRunRequest
from adapter.store import JsonStore


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


def _preview_and_apply(store: JsonStore) -> tuple[dict, dict]:
    preview = evolve(store, apply=False)
    applied = evolve(store, apply=True, preview_token=preview["preview_token"])
    return preview, applied


def _plant(store: JsonStore, days: int = 5) -> None:
    """构造 2 个 active 策略 + days 日影子净值 + 平仓记录 + 行为埋点。"""
    store.set("strategies", "strat-good", {
        "id": "strat-good", "name": "好策略", "kind": "rsi_reversal",
        "direction": "利空", "symbols": ["688981", "603986", "688347"],
        "params": {"n": 14, "oversold": 30, "overbought": 70},
        "status": "active",
        "backtest": {"out_of_sample": {"win_rate_pct": 80.0}},
        "evolve": {"state": "active", "tier": 1},
    })
    store.set("strategies", "strat-bad", {
        "id": "strat-bad", "name": "坏策略", "kind": "momentum",
        "direction": "利好", "symbols": ["301446"], "params": {"n": 10},
        "status": "active",
        "backtest": {"out_of_sample": {"win_rate_pct": 60.0}},
        "evolve": {"state": "active", "tier": 1},
    })
    dates = ["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24"]
    ov = [1.000, 1.008, 1.012, 1.020, 1.035]
    g = [1.000, 1.010, 1.015, 1.022, 1.040]   # 盈利 → 升级
    b = [1.000, 0.992, 0.985, 0.978, 0.960]   # 亏损 + 低胜率 → 淘汰
    for i, d in enumerate(dates[:days]):
        store.set("shadow_equity", d, {
            "overall_nav": ov[i],
            "strategies": {"strat-good": {"nav": g[i]}, "strat-bad": {"nav": b[i]}},
        })
    store.set("shadows", "trades:strat-bad", [
        {"sid": "strat-bad", "code": "301446", "ret_pct": -3.0},
        {"sid": "strat-bad", "code": "301446", "ret_pct": -5.0},
        {"sid": "strat-bad", "code": "301446", "ret_pct": 1.0},
    ])
    store.set("shadows", "trades:strat-good", [
        {"sid": "strat-good", "code": "688981", "ret_pct": 2.0},
        {"sid": "strat-good", "code": "688981", "ret_pct": 3.0},
    ])
    store.set("behavior", "default", [
        {"card_id": "c1", "action": "click",
         "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
         "meta": {"strategy_id": "strat-good", "ticker": "688981", "direction": "利空"}},
    ])


class AttributionTests(unittest.TestCase):
    def test_attribution_reports_overall_and_per_strategy(self):
        store = _store()
        _plant(store)
        a = attribution(store)
        self.assertEqual(a["days_of_data"], 5)
        self.assertEqual(a["overall"]["strategy_count"], 2)
        rows = {s["strategy_id"]: s for s in a["strategies"]}
        self.assertEqual(rows["strat-good"]["return_pct"], 4.0)
        self.assertEqual(rows["strat-bad"]["return_pct"], -4.0)
        self.assertEqual(rows["strat-bad"]["closed_win_rate_pct"], 33.3)

    def test_attribution_notes_insufficient_data(self):
        store = _store()
        _plant(store, days=1)
        a = attribution(store)
        self.assertIsNotNone(a["data_note"])
        self.assertEqual(a["overall"]["max_drawdown_pct"], None)


class EvolveTests(unittest.TestCase):
    def test_apply_request_requires_well_formed_preview_token(self):
        with self.assertRaises(ValidationError):
            EvolutionRunRequest(apply=True)
        with self.assertRaises(ValidationError):
            EvolutionRunRequest(apply=True, preview_token="not-a-token")
        with self.assertRaises(ValidationError):
            EvolutionRunRequest(apply=False, preview_token="1" * 32)
        request = EvolutionRunRequest(apply=True, preview_token="1" * 32)
        self.assertEqual(request.preview_token, "1" * 32)

    def test_http_contract_exposes_preview_and_maps_drift_to_conflict(self):
        app = create_app()
        with TestClient(app) as client:
            with patch("adapter.evolution.current_preview", return_value={
                "preview_status": "pending", "preview_token": "1" * 32, "actions": [],
            }):
                response = client.get("/evolution/preview")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["preview_token"], "1" * 32)
            with patch(
                "adapter.evolution.evolve",
                side_effect=EvolutionPreviewConflict("策略或影子证据已变化"),
            ):
                response = client.post("/evolution/run", json={
                    "apply": True, "preview_token": "1" * 32,
                })
                self.assertEqual(response.status_code, 409)
                self.assertIn("证据已变化", response.json()["detail"])

    def test_waiting_data_guardrail_never_writes(self):
        store = _store()
        _plant(store, days=1)
        preview, plan = _preview_and_apply(store)
        self.assertRegex(preview["preview_token"], r"^[0-9a-f]{32}$")
        self.assertEqual(preview["state_version"], plan["state_version"])
        self.assertEqual(plan["status"], "waiting_data")
        self.assertEqual(plan["count"], 0)
        # 未写任何动作（好策略未被升级、坏策略未被淘汰）
        self.assertEqual(store.get("strategies", "strat-bad").get("status"), "active")

    def test_evolve_promotes_mutates_and_retires(self):
        store = _store()
        _plant(store)
        plan = evolve(store, apply=False)
        types = {a["type"] for a in plan["actions"]}
        self.assertIn("promote", types)
        self.assertIn("retire", types)
        self.assertIn("mutate", types)

        applied = evolve(store, apply=True, preview_token=plan["preview_token"])
        self.assertTrue(applied["applied"])
        self.assertEqual(applied["preview_status"], "applied")
        good = store.get("strategies", "strat-good")
        bad = store.get("strategies", "strat-bad")
        self.assertEqual(good["evolve"]["tier"], 2)
        self.assertEqual(bad["status"], "retired")
        self.assertEqual(bad["verification_status"], "archived")
        kids = [k for k, v in store.all("strategies").items()
                if isinstance(v, dict) and v.get("source") == "evolution"]
        self.assertEqual(len(kids), 2)
        for kid in kids:
            rec = store.get("strategies", kid)
            self.assertEqual(rec["status"], "candidate")
            self.assertEqual(rec["verification_status"], "pending")
            self.assertEqual(rec["mutated_from"], "strat-good")

    def test_preview_includes_per_strategy_decision_reasons(self):
        store = _store()
        _plant(store)
        preview = evolve(store, apply=False)
        per = {p["strategy_id"]: p for p in preview["per_strategy"]}
        self.assertEqual(per["strat-good"]["decision"], "promote")
        self.assertEqual(per["strat-bad"]["decision"], "retire")
        self.assertIn("升级线", per["strat-good"]["reason"])
        self.assertIn("平仓胜率", per["strat-bad"]["reason"])
        self.assertEqual(per["strat-good"]["behavior"], "升级+变异")
        self.assertEqual(per["strat-bad"]["behavior"], "淘汰")

    def test_preview_per_strategy_none_when_upgraded_or_in_band(self):
        """无动作时 per_strategy 给出可读原因：已升级不重复 / 带内无动作。"""
        store = _store()
        store.set("strategies", "strat-t2", {
            "id": "strat-t2", "name": "已升级", "kind": "momentum",
            "direction": "利好", "symbols": ["600000"], "params": {"n": 10},
            "status": "active",
            "evolve": {"state": "active", "tier": 2},
        })
        store.set("strategies", "strat-band", {
            "id": "strat-band", "name": "带内", "kind": "momentum",
            "direction": "利好", "symbols": ["600001"], "params": {"n": 10},
            "status": "active",
            "evolve": {"state": "active", "tier": 1},
        })
        for d, ov in [("2026-08-24", 1.0), ("2026-08-25", 1.005), ("2026-08-26", 1.01),
                      ("2026-08-27", 1.015), ("2026-08-28", 1.02)]:
            store.set("shadow_equity", d, {
                "overall_nav": ov,
                "strategies": {"strat-t2": {"nav": ov}, "strat-band": {"nav": ov}},
            })
        preview = evolve(store, apply=False)
        self.assertEqual(preview["actions"], [])
        per = {p["strategy_id"]: p for p in preview["per_strategy"]}
        self.assertEqual(per["strat-t2"]["decision"], "none")
        self.assertIn("不重复升级", per["strat-t2"]["reason"])
        self.assertEqual(per["strat-t2"]["behavior"], "已升级")
        self.assertEqual(per["strat-band"]["decision"], "none")
        self.assertIn("带内", per["strat-band"]["reason"])
        self.assertEqual(per["strat-band"]["behavior"], "带内运行")

    def test_preview_exposes_last_applied_at_after_auto_apply(self):
        """闭环自动应用过进化后，再生成空预案也能带上轮应用时间供前端展示。"""
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        preview = evolve(store, apply=False)
        self.assertEqual(preview["actions"], [])  # 已升级/已淘汰后无新动作
        self.assertIsNotNone(preview["last_applied_at"])
        self.assertRegex(str(preview["last_applied_at"]), r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

    def test_preview_token_rejects_duplicate_apply(self):
        store = _store()
        _plant(store)
        preview, _ = _preview_and_apply(store)
        with self.assertRaisesRegex(EvolutionPreviewConflict, "不能重复提交"):
            evolve(store, apply=True, preview_token=preview["preview_token"])

    def test_state_drift_rejects_old_preview_without_writing_actions(self):
        store = _store()
        _plant(store)
        preview = evolve(store, apply=False)
        store.update("strategies", "strat-good", name="人工更新后的策略")

        with self.assertRaisesRegex(EvolutionPreviewConflict, "证据已变化"):
            evolve(store, apply=True, preview_token=preview["preview_token"])

        self.assertEqual(store.get("strategies", "strat-good")["evolve"]["tier"], 1)
        self.assertEqual(store.get("strategies", "strat-bad")["status"], "active")

    def test_new_preview_supersedes_previous_token(self):
        store = _store()
        _plant(store)
        first = evolve(store, apply=False)
        second = evolve(store, apply=False)
        with self.assertRaisesRegex(EvolutionPreviewConflict, "不能重复提交"):
            evolve(store, apply=True, preview_token=first["preview_token"])
        applied = evolve(store, apply=True, preview_token=second["preview_token"])
        self.assertTrue(applied["applied"])

    def test_current_preview_exposes_exact_pending_actions_only(self):
        store = _store()
        _plant(store)
        preview = evolve(store, apply=False)
        context = current_preview(store)
        self.assertTrue(context["valid"])
        self.assertEqual(context["preview_token"], preview["preview_token"])
        self.assertEqual(context["actions"], preview["actions"])
        evolve(store, apply=True, preview_token=preview["preview_token"])
        self.assertEqual(current_preview(store)["preview_status"], "none")

    def test_recommendation_side_excludes_watch_and_retired(self):
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        actives = [s.get("id") for s in _active_strategies(store)]
        self.assertIn("strat-good", actives)
        self.assertNotIn("strat-bad", actives)


class EvolveAutoTests(unittest.TestCase):
    """全自动闭环用 evolve_auto()：数据不足不写库；就绪自动 preview→apply。"""

    def test_waiting_data_returns_note_and_writes_nothing(self):
        store = _store()
        _plant(store, days=1)
        result = evolve_auto(store)
        self.assertEqual(result["status"], "waiting_data")
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["actions"], [])
        # 未写 evolution_previews 集合
        self.assertEqual(store.all("evolution_previews"), {})
        # 生命周期未变
        self.assertEqual(store.get("strategies", "strat-good")["evolve"]["tier"], 1)
        self.assertEqual(store.get("strategies", "strat-bad")["status"], "active")

    def test_ready_auto_applies_promote_retire_mutate(self):
        store = _store()
        _plant(store)  # 5 日影子数据 → 就绪
        result = evolve_auto(store)
        self.assertTrue(result["applied"])
        self.assertEqual(result["preview_status"], "applied")
        types = {a["type"] for a in result["actions"]}
        self.assertIn("promote", types)
        self.assertIn("retire", types)
        self.assertIn("mutate", types)
        good = store.get("strategies", "strat-good")
        bad = store.get("strategies", "strat-bad")
        self.assertEqual(good["evolve"]["tier"], 2)
        self.assertEqual(bad["status"], "retired")
        kids = [k for k, v in store.all("strategies").items()
                if isinstance(v, dict) and v.get("source") == "evolution"]
        self.assertEqual(len(kids), 2)
        # 预案已消费，无残留待确认预案
        self.assertEqual(current_preview(store)["preview_status"], "none")


class OutcomeTests(unittest.TestCase):
    def test_decision_outcome_remains_strategy_evidence(self):
        # 淘汰 strat-bad 后，结果仍可用于策略归因，但不能修改用户风险画像。
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        od = decision_outcome(store)
        self.assertGreater(od["samples"], 0)
        self.assertGreater(od["delta"], 0.0)

    def test_outcome_does_not_flow_into_explicit_risk_profile(self):
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        beh = compute_behavior_profile(store)
        self.assertEqual(beh["outcome"]["delta"], 0.003)
        self.assertEqual(beh["outcome_delta"], 0.0)
        self.assertEqual(beh["aggression_delta"], 0.0)

    def test_decision_outcome_zero_when_insufficient(self):
        store = _store()
        _plant(store, days=1)
        od = decision_outcome(store)
        self.assertEqual(od["delta"], 0.0)
        self.assertEqual(od["samples"], 0)


class StatusTests(unittest.TestCase):
    def test_status_counts_lifecycle(self):
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        st = status(store)
        self.assertTrue(st["ready"])
        self.assertGreaterEqual(st["counts"]["mutated"], 2)
        self.assertGreaterEqual(st["counts"]["retired"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
