# -*- coding: utf-8 -*-
"""自进化 v2 · P4 种群治理单测（纯函数层）。

覆盖 adapter/governance.py：
- niche_key：因子族生态位指纹（rsi_reversal/bollinger 同指纹→利空反弹族；momentum/breakout→
  利好动量族；跨事件池/方向不同 → 不同指纹）。
- shadow_correlation / pearson：相关序列≈1、反向≈-1、无交集/样本不足 → None。
- clone_blocked：高相关且更差 → 拦；高相关但更优 → 放行；低相关/样本不足 → 放行。
- stagnant：连续 N 天不创新高 → True；刚创新高/样本不足/仍在上攻 → False。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_governance -v
依赖 adapter.{governance,genome}——纯函数，无网络。
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")

from adapter import evolution, genome, governance  # noqa: E402
from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402


class NicheKeyTest(unittest.TestCase):
    def test_same_family_same_pool_same_direction_is_same_niche(self):
        # P2 同族换 kind（rsi_reversal↔bollinger）仍视为同一生态位候选，防绕过去重
        self.assertEqual(
            governance.niche_key("rsi_reversal", event_type="减持", direction="利空"),
            governance.niche_key("bollinger", event_type="减持", direction="利空"))

    def test_momentum_family_distinct_from_rsi(self):
        self.assertNotEqual(
            governance.niche_key("rsi_reversal", event_type="减持", direction="利空"),
            governance.niche_key("momentum", event_type="减持", direction="利空"))

    def test_pool_or_direction_differ_means_distinct_niche(self):
        base = governance.niche_key("rsi_reversal", event_type="减持", direction="利空")
        self.assertNotEqual(base, governance.niche_key("rsi_reversal", event_type="回购", direction="利空"))
        self.assertNotEqual(base, governance.niche_key("rsi_reversal", event_type="减持", direction="利好"))

    def test_singleton_kind_falls_back_to_kind(self):
        self.assertEqual(governance.niche_key("ma_cross"), "ma_cross||")


class PearsonCorrelationTest(unittest.TestCase):
    def test_perfect_positive_is_one(self):
        self.assertAlmostEqual(governance.pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1.0)

    def test_perfect_negative_is_minus_one(self):
        self.assertAlmostEqual(governance.pearson([1, 2, 3], [3, 2, 1]), -1.0)

    def test_too_few_points_or_zero_variance_none(self):
        self.assertIsNone(governance.pearson([1], [2]))           # 1 点
        self.assertIsNone(governance.pearson([1, 1, 1], [2, 2, 2]))  # 零方差
        self.assertIsNone(governance.pearson(None, [1, 2]))


class ShadowCorrelationTest(unittest.TestCase):
    def test_aligned_by_common_dates(self):
        a = {"2026-08-01": 1.0, "2026-08-02": 1.05, "2026-08-03": 1.10}
        b = {"2026-08-01": 2.0, "2026-08-02": 2.05, "2026-08-03": 2.10}
        self.assertAlmostEqual(governance.shadow_correlation(a, b), 1.0)

    def test_disjoint_dates_none(self):
        self.assertIsNone(governance.shadow_correlation(
            {"2026-08-01": 1.0}, {"2026-08-02": 1.0}))


class CloneBlockedTest(unittest.TestCase):
    def test_high_corr_and_worse_is_blocked(self):
        self.assertTrue(governance.clone_blocked(0.95, 0.80, candidate_better=False))

    def test_high_corr_but_better_is_allowed(self):
        self.assertFalse(governance.clone_blocked(0.95, 0.80, candidate_better=True))

    def test_low_corr_allowed_regardless(self):
        self.assertFalse(governance.clone_blocked(0.5, 0.80, candidate_better=False))

    def test_no_corr_allowed(self):
        self.assertFalse(governance.clone_blocked(None, 0.80, candidate_better=False))


class StagnantTest(unittest.TestCase):
    def test_flat_then_dip_not_new_high_is_stagnant(self):
        # 曾到 1.10 后连续 stale_days 天徘徊在 1.05，追不上旧高 → 停滞
        days = {"2026-08-01": 1.00, "2026-08-02": 1.10, "2026-08-03": 1.09,
                "2026-08-04": 1.08, "2026-08-05": 1.05, "2026-08-06": 1.06,
                "2026-08-07": 1.05, "2026-08-08": 1.06, "2026-08-09": 1.04,
                "2026-08-10": 1.05}
        self.assertTrue(governance.stagnant(days, stale_days=5))

    def test_still_making_new_high_is_not_stagnant(self):
        days = {"2026-08-01": 1.00, "2026-08-02": 1.02, "2026-08-03": 1.04,
                "2026-08-04": 1.06, "2026-08-05": 1.05, "2026-08-06": 1.07,
                "2026-08-07": 1.08}
        self.assertFalse(governance.stagnant(days, stale_days=5))

    def test_not_enough_history_is_not_stagnant(self):
        days = {"2026-08-01": 1.00, "2026-08-02": 1.01, "2026-08-03": 1.00}
        self.assertFalse(governance.stagnant(days, stale_days=5))

    def test_just_now_dips_but_flat_top_is_stagnant_when_stale_long(self):
        # 长时间横盘（top 停在窗口外）即使没大跌也算平庸
        days = {f"2026-07-{i:02d}": 1.20 for i in range(1, 16)}
        days.update({f"2026-08-{i:02d}": 1.19 for i in range(1, 16)})
        self.assertTrue(governance.stagnant(days, stale_days=10))


def _store():
    return JsonStore(Path(tempfile.mkdtemp()))


def _seed_active(store, sid, *, kind="rsi_reversal", symbols, direction="利空",
                 status="active", evolve_state="active", nav=None, oos_wr=80.0):
    gene = genome.gene_for(kind, {"n": 14}, symbols, direction)
    rec = {
        "id": sid, "name": sid, "kind": kind, "direction": direction,
        "symbols": list(symbols), "params": {"n": 14}, "gene": gene,
        "status": status,
        "backtest": {"out_of_sample": {"win_rate_pct": oos_wr}},
        "evolve": {"state": evolve_state, "tier": 1},
    }
    store.set("strategies", sid, rec)
    return rec


def _seed_days(store, navs_by_sid, *, start=date(2026, 8, 1), n=None):
    lengths = [len(s) for s in navs_by_sid.values()]
    n = n or (lengths[0] if lengths else 0)
    for i in range(n):
        day = {sid: {"nav": s[i]} for sid, s in navs_by_sid.items() if i < len(s)}
        overall = max((v["nav"] for v in day.values()), default=1.0)
        store.set("shadow_equity", (start + timedelta(days=i)).isoformat(), {
            "overall_nav": overall, "strategies": day,
        })


class DecisionGovernanceWiringTest(unittest.TestCase):
    def test_stagnant_enabled_retires_flat_active(self):
        saved = settings.evolve_stagnant_enabled
        saved_days = settings.evolve_stagnant_days
        try:
            settings.evolve_stagnant_enabled = True
            settings.evolve_stagnant_days = 5
            store = _store()
            _seed_active(store, "sFlat", symbols=["600519"], direction="利空")
            # 爬到 1.06 后长期横在 1.02（既不破淘汰线也不够升级），N 天不创新高 → 停滞让位
            series = [1.00, 1.01, 1.03, 1.05, 1.06] + [1.02] * 8
            _seed_days(store, {"sFlat": series})
            plan = evolution.evolve(store, apply=False)
            ret = [a for a in plan["actions"] if a["type"] == "retire"]
            self.assertEqual(len(ret), 1, [a for a in plan["actions"]])
            self.assertTrue(ret[0].get("stagnant"))
            self.assertIn("未刷新影子净值新高", ret[0]["reason"])
        finally:
            settings.evolve_stagnant_enabled = saved
            settings.evolve_stagnant_days = saved_days

    def test_stagnant_off_by_default_no_retire(self):
        store = _store()
        _seed_active(store, "sFlat", symbols=["600519"], direction="利空")
        series = [1.00, 1.01, 1.03, 1.05, 1.06] + [1.02] * 8
        _seed_days(store, {"sFlat": series})
        plan = evolution.evolve(store, apply=False)
        ret = [a for a in plan["actions"] if a["type"] == "retire"]
        self.assertFalse(ret)  # 默认关 → 平庸让位不生效，与 v1 一致

    def test_archive_on_retire_writes_gene_archive(self):
        saved = settings.evolve_archive_enabled
        try:
            settings.evolve_archive_enabled = True
            store = _store()
            _seed_active(store, "sBad", symbols=["600519"], direction="利空")
            _seed_days(store, {"sBad": [0.80] * 6})  # 持续跌破淘汰线 0.90
            plan = evolution.evolve(store, apply=False)
            applied = evolution.evolve(store, apply=True, preview_token=plan["preview_token"])
            self.assertTrue(applied["applied"])
            arch = store.all("gene_archive") or {}
            self.assertIn("sBad", arch)
            self.assertIn("淘汰", (arch["sBad"] or {}).get("archive_reason", ""))
        finally:
            settings.evolve_archive_enabled = saved

    def test_clone_dedup_blocks_worse_clone_from_spawning(self):
        saved = settings.evolve_correlation_enabled
        try:
            settings.evolve_correlation_enabled = True
            store = _store()
            # 两条同生态位（同 kind+方向+无事件池）高相关 active，S1 恒优于 S2
            _seed_active(store, "S1", symbols=["600519"], direction="利空")
            _seed_active(store, "S2", symbols=["600519"], direction="利空")
            s1 = [1.00, 1.01, 1.02, 1.04, 1.05, 1.06]
            s2 = [0.5 + 0.5 * v for v in s1]  # 与 S1 完全同涨跌(corr=1)，但恒低
            _seed_days(store, {"S1": s1, "S2": s2})
            plan = evolution.evolve(store, apply=False)
            mut_parents = {a["parent"] for a in plan["actions"] if a["type"] == "mutate"}
            # 更优的 S1 正常产变异；被去重的更差克隆 S2 不产新变异（堵克隆膨胀）
            self.assertIn("S1", mut_parents)
            self.assertNotIn("S2", mut_parents)
        finally:
            settings.evolve_correlation_enabled = saved


if __name__ == "__main__":
    unittest.main()
