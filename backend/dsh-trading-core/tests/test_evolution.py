# -*- coding: utf-8 -*-
"""自进化闭环回归测试：S_shadow→T→W→H + R→S→U→K outcome + 数据不足护栏。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution -v
依赖：adapter.evolution / adapter.store / adapter.strategies（无网络、无 LLM）。
"""

import copy
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("BRIEF_SCHEDULE_ENABLED", "false")

from fastapi.testclient import TestClient
from pydantic import ValidationError

from adapter.behavior_profile import compute_behavior_profile
from adapter import evolution as evolution_module
from adapter.app import create_app
from adapter.config import settings
from adapter.evolution import (
    EvolutionPreviewConflict,
    attribution,
    current_preview,
    decision_outcome,
    evolve,
    evolve_auto,
    record_closed_loop_run,
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

    def test_scoped_compatibility_routes_validate_and_forward_strategy_id(self):
        app = create_app()
        with TestClient(app) as client:
            with patch("adapter.evolution.current_preview") as scoped_preview:
                scoped_preview.return_value = {"preview_status": "none", "actions": []}
                response = client.get("/evolution/preview?strategy_id=strategy:alpha@v2")
                self.assertEqual(response.status_code, 200)
                scoped_preview.assert_called_once_with(strategy_id="strategy:alpha@v2")

            with patch("adapter.evolution.evolve") as scoped_evolve:
                scoped_evolve.return_value = {"preview_status": "empty", "actions": []}
                response = client.post("/evolution/run", json={
                    "apply": False,
                    "strategy_id": "strategy:alpha@v2",
                })
                self.assertEqual(response.status_code, 200)
                scoped_evolve.assert_called_once_with(
                    apply=False,
                    preview_token=None,
                    strategy_id="strategy:alpha@v2",
                )

            with patch("adapter.evolution.current_preview") as invalid_preview:
                response = client.get("/evolution/preview?strategy_id=../unsafe")
                self.assertEqual(response.status_code, 422)
                invalid_preview.assert_not_called()

    def test_waiting_data_guardrail_never_writes(self):
        store = _store()
        _plant(store, days=1)
        preview = evolve(store, apply=False)
        self.assertEqual(preview["status"], "waiting_data")
        self.assertEqual(preview["preview_status"], "blocked")
        self.assertNotIn("preview_token", preview)
        self.assertEqual(current_preview(store)["preview_status"], "none")
        self.assertEqual(store.all("evolution_previews"), {})
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
        self.assertEqual(bad.get("verification_status"), None)
        kids = [k for k, v in store.all("strategies").items()
                if isinstance(v, dict) and v.get("source") == "evolution"]
        self.assertEqual(len(kids), 2)
        for kid in kids:
            rec = store.get("strategies", kid)
            self.assertEqual(rec["status"], "candidate")
            self.assertEqual(rec["verification_status"], "insufficient")
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
        self.assertEqual(preview["preview_status"], "empty")
        self.assertNotIn("preview_token", preview)
        self.assertEqual(current_preview(store)["preview_status"], "none")
        per = {p["strategy_id"]: p for p in preview["per_strategy"]}
        self.assertEqual(per["strat-t2"]["decision"], "none")
        self.assertIn("不重复升级", per["strat-t2"]["reason"])
        self.assertEqual(per["strat-t2"]["behavior"], "已升级")
        self.assertEqual(per["strat-band"]["decision"], "none")
        self.assertIn("带内", per["strat-band"]["reason"])
        self.assertEqual(per["strat-band"]["behavior"], "正常运行")

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
    def test_invalid_scoped_identifier_is_rejected_before_storage_io(self):
        store = Mock(spec=JsonStore)

        for operation in (status, attribution, current_preview, evolve):
            with self.subTest(operation=operation.__name__):
                with self.assertRaisesRegex(ValueError, "strategy_id"):
                    operation(store, strategy_id="../unsafe")
                self.assertEqual(store.method_calls, [])

    def test_scoped_status_exposes_only_target_strategy_without_writes(self):
        store = _store()
        _plant(store)
        store.set("strategies", "strat-child", {
            "id": "strat-child",
            "name": "子策略",
            "kind": "rsi_reversal",
            "status": "candidate",
            "source": "evolution",
            "mutated_from": "strat-good",
            "evolve": {"state": "candidate", "tier": 1},
        })
        before = copy.deepcopy(store.all("strategies"))

        result = status(store, strategy_id="strat-good")

        self.assertEqual(
            [row["strategy_id"] for row in result["per_strategy"]],
            ["strat-good"],
        )
        self.assertEqual(result["counts"], {
            "active": 1,
            "candidate": 0,
            "retired": 0,
            "watch": 0,
            "rejected": 0,
        })
        self.assertTrue(all(
            action.get("sid") == "strat-good" or action.get("parent") == "strat-good"
            for run in result["recent_applied"]
            for action in run["actions"]
        ))
        self.assertEqual(store.all("strategies"), before)

    def test_global_status_exposes_closed_loop_dashboard_contract(self):
        result = status(_store())
        for key in (
            "closed_loop_enabled", "closed_loop_time", "lifecycle",
            "per_strategy", "recent_applied", "last_applied_at",
        ):
            self.assertIn(key, result)

    def test_scoped_read_routes_forward_strategy_id_and_map_missing_to_404(self):
        app = create_app()
        with TestClient(app) as client:
            with patch("adapter.evolution.status") as scoped_status:
                scoped_status.return_value = {"ready": True}
                response = client.get("/evolution/status?strategy_id=strat-good")
                self.assertEqual(response.status_code, 200)
                scoped_status.assert_called_once_with(strategy_id="strat-good")

            with patch(
                "adapter.evolution.attribution",
                side_effect=evolution_module.EvolutionStrategyNotFound("策略不存在"),
            ):
                response = client.get("/evolution/attribution?strategy_id=strat-missing")
                self.assertEqual(response.status_code, 404)

    def test_status_counts_lifecycle(self):
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        st = status(store)
        self.assertTrue(st["ready"])
        # 变异候选按真实状态（candidate）计，不再有独立 mutated 计数
        self.assertNotIn("mutated", st["counts"])
        self.assertGreaterEqual(st["counts"]["candidate"], 2)
        self.assertGreaterEqual(st["counts"]["retired"], 1)

    def test_status_exposes_closed_loop_and_last_applied(self):
        """闭环看板字段：上次应用时间、下次运行时刻、各策略判定、最近自动进化记录。"""
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        st = status(store)
        self.assertIsNotNone(st["last_applied_at"])
        self.assertEqual(st["closed_loop_time"], "15:35")
        self.assertEqual(st["closed_loop_enabled"], settings.closed_loop_enabled)
        # per_strategy 覆盖每个 active 策略且含判定字段
        actives = [s.get("id") for s in (store.all("strategies") or {}).values()
                   if isinstance(s, dict) and s.get("status") == "active"]
        per = {p["strategy_id"]: p for p in st["per_strategy"]}
        for sid in actives:
            self.assertIn(sid, per)
            self.assertIn("behavior", per[sid])
            self.assertIn("reason", per[sid])
        # 最近自动进化记录
        self.assertGreaterEqual(len(st["recent_applied"]), 1)
        self.assertGreater(st["recent_applied"][0]["count"], 0)

    def test_status_exposes_persisted_run_next_schedule_and_four_way_summary(self):
        store = _store()
        _plant(store)
        _preview_and_apply(store)
        record_closed_loop_run(
            store,
            run_at="2026-09-04T15:35:00+08:00",
            status_value="completed",
            action_count=3,
        )
        with patch(
            "adapter.scheduler.next_closed_loop_run_at",
            return_value="2026-09-05T15:35:00+08:00",
        ):
            st = status(store)

        self.assertEqual(st["recent_run_at"], "2026-09-04T15:35:00+08:00")
        self.assertEqual(st["next_scheduled_run_at"], "2026-09-05T15:35:00+08:00")
        self.assertEqual(set(st["evolution_counts"]), {"normal", "watch", "promote", "retire"})
        self.assertEqual(st["evolution_counts"]["promote"], 1)
        self.assertEqual(st["evolution_counts"]["retire"], 1)
        self.assertNotIn("mutated", st["evolution_counts"])

    def test_status_per_strategy_waiting_when_data_insufficient(self):
        """数据不足时各策略判定为「待判定」，不进归因计算。"""
        store = _store()
        store.set("strategies", "strat-only", {
            "id": "strat-only", "name": "仅此一个", "kind": "momentum",
            "direction": "利好", "symbols": ["600000"], "params": {"n": 10},
            "status": "active",
        })
        st = status(store)
        self.assertFalse(st["ready"])
        per = {p["strategy_id"]: p for p in st["per_strategy"]}
        self.assertEqual(per["strat-only"]["behavior"], "待判定")
        self.assertIn("影子数据不足", per["strat-only"]["reason"])
        self.assertEqual(st["recent_applied"], [])

    def test_status_recent_applied_capped_and_desc(self):
        """最近自动进化记录按 applied_at 降序且最多 5 条。"""
        store = _store()
        _plant(store)
        import adapter.evolution as ev
        for i in range(6):
            store.set("evolution_previews", f"tok{i}", {
                "preview_status": "applied",
                "applied_at": f"2026-08-{20 + i:02d} 15:35:00",
                "actions": [{"type": "promote", "sid": "strat-good", "reason": f"第{i}轮"}],
            })
        recs = ev._recent_applied(store, limit=5)
        self.assertEqual(len(recs), 5)
        ats = [r["applied_at"] for r in recs]
        self.assertEqual(ats, sorted(ats, reverse=True))
        self.assertEqual(recs[0]["count"], 1)

    def test_status_lifecycle_groups_strategies_by_state(self):
        """闭环运行状态分组：变异策略按真实状态（candidate）落桶并带来源标记。"""
        store = _store()
        _plant(store)
        _preview_and_apply(store)  # strat-good 升级、strat-bad 退役、2 个变异候选（status=candidate）
        st = status(store)
        lc = st["lifecycle"]
        active_ids = {e["strategy_id"] for e in lc["active"]}
        candidate_ids = {e["strategy_id"] for e in lc["candidate"]}
        retired_ids = {e["strategy_id"] for e in lc["retired"]}
        self.assertIn("strat-good", active_ids)
        self.assertNotIn("strat-bad", active_ids)
        self.assertIn("strat-bad", retired_ids)
        self.assertEqual(len(candidate_ids), 2)
        self.assertNotIn("mutated", lc)  # 不再有独立「变异」桶
        for entry in lc["candidate"]:
            self.assertEqual(entry["mutated_from"], "strat-good")
            self.assertEqual(entry["source"], "evolution")
        # 计数与列表一致；counts 无 mutated 键
        self.assertEqual(st["counts"]["active"], len(active_ids))
        self.assertEqual(st["counts"]["candidate"], len(candidate_ids))
        self.assertEqual(st["counts"]["retired"], len(retired_ids))
        self.assertNotIn("mutated", st["counts"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
