# -*- coding: utf-8 -*-
"""自进化 v2 · P1 多维适应度单测：判「本事 vs 行情」。

覆盖：
- fitness 纯函数层：nav_verdict / percentile / overfit_of / effective_lines / compute_profile
  的 log(≡v1)/relative(挡beta+护alpha)/excess(超额)/overfit(样本内虚高不升) 四档判定矩阵。
- 进化裁决接线：EVOLVE_FITNESS_MODE=relative 时同批 3 策略里，绝对净值高但分位中游的
  「跟风 beta」不被 promote；overfit 只凭 IS 也不升；_apply_action 会把 fitness 落到 evolve.fitness。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_fitness -v
依赖：adapter.{fitness,evolution,config,store}——无网络、无 LLM。
"""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("EVOLVE_FITNESS_MODE", "log")

from adapter import fitness  # noqa: E402
from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402

P, D, R = 1.03, 0.95, 0.90          # promote/demote/retire 绝对线（v1 默认）
PP, RP = 80.0, 20.0                  # promote/retire 分位界
MIN_PEERS = 3
GAP, MIN_T = 25.0, 4


def profile(**kw):
    base = dict(
        nav=1.05, peer_navs=None, mode="log", min_peers=MIN_PEERS,
        promote_nav=P, demote_nav=D, retire_nav=R,
        promote_percentile=PP, retire_percentile=RP,
        extended=None, overfit_gap_pct=GAP, overfit_min_trades=MIN_T,
    )
    base.update(kw)
    return fitness.compute_profile(**base)


class NavVerdictTest(unittest.TestCase):
    def test_retire_priority(self):
        self.assertEqual(fitness.nav_verdict(0.88, promote_nav=P, demote_nav=D, retire_nav=R), "retire")
        self.assertEqual(fitness.nav_verdict(0.93, promote_nav=P, demote_nav=D, retire_nav=R), "demote")
        self.assertEqual(fitness.nav_verdict(1.05, promote_nav=P, demote_nav=D, retire_nav=R), "promote")
        self.assertEqual(fitness.nav_verdict(1.00, promote_nav=P, demote_nav=D, retire_nav=R), "hold")
        self.assertEqual(fitness.nav_verdict(None, promote_nav=P, demote_nav=D, retire_nav=R), "hold")


class PercentileTest(unittest.TestCase):
    def test_rank_and_tie(self):
        self.assertEqual(fitness.percentile(1.10, [1.10, 1.05, 1.02]), 83.3)
        self.assertEqual(fitness.percentile(1.05, [1.10, 1.05, 1.02]), 50.0)
        self.assertEqual(fitness.percentile(1.02, [1.10, 1.05, 1.02]), 16.7)
        self.assertIsNone(fitness.percentile(None, [1.0]))
        self.assertIsNone(fitness.percentile(1.0, []))


class OverfitTest(unittest.TestCase):
    def test_flag_when_is_oos_gap_large(self):
        ext = {"per_symbol": {"s1": {"in_winrate_pct": 90.0, "out_winrate_pct": 50.0, "out_trades": 6}}}
        ov = fitness.overfit_of(ext, gap_pct=GAP, min_trades=MIN_T)
        self.assertTrue(ov["flag"])
        self.assertEqual(ov["oos_trades"], 6)
        self.assertGreaterEqual(ov["gap_pct"], GAP)

    def test_no_flag_without_data(self):
        self.assertFalse(fitness.overfit_of(None, gap_pct=GAP, min_trades=MIN_T)["flag"])
        self.assertFalse(fitness.overfit_of({}, gap_pct=GAP, min_trades=MIN_T)["flag"])
        # 样本太少：虽 IS 高但 OOS 笔数不足 → 不下结论
        ext = {"per_symbol": {"s1": {"in_winrate_pct": 90.0, "out_winrate_pct": 40.0, "out_trades": 2}}}
        self.assertFalse(fitness.overfit_of(ext, gap_pct=GAP, min_trades=MIN_T)["flag"])
        self.assertEqual(fitness.overfit_of(ext, gap_pct=GAP, min_trades=MIN_T)["basis"], "insufficient")


class LogModeV1Test(unittest.TestCase):
    def test_log_ignores_relative_and_overfit_absent(self):
        # 2 peers < min_peers，且无 extended → log 档 = 纯 v1 绝对线
        p = profile(nav=1.05, peer_navs=[1.06, 1.04], mode="log")
        self.assertEqual(p["decision"], "promote")
        self.assertEqual(p["percentile"], None)
        self.assertEqual(p["blocked_by"], "none")
        p2 = profile(nav=0.88, peer_navs=[1.06, 1.04], mode="log")
        self.assertEqual(p2["decision"], "retire")


class RelativeModeTest(unittest.TestCase):
    COHORT = [1.10, 1.05, 1.02]  # 3 只同批

    def test_block_beta_rider_mid_pack(self):
        # 绝对净值过 1.03 但分位 50%（中游）→ 挡：跟风不升
        p = profile(nav=1.05, peer_navs=self.COHORT, mode="relative")
        self.assertEqual(p["decision"], "hold")
        self.assertEqual(p["blocked_by"], "rank")
        self.assertEqual(p["rank"], "mid")

    def test_top_pack_still_promotes(self):
        p = profile(nav=1.10, peer_navs=self.COHORT, mode="relative")
        self.assertEqual(p["decision"], "promote")
        self.assertEqual(p["rank"], "top")

    def test_rescue_top_alpha_in_crash(self):
        crash = [0.88, 0.75, 0.60]  # 全池大跌，但 nav 0.88 已破淘汰线 0.90
        p = profile(nav=0.88, peer_navs=crash, mode="relative")
        self.assertEqual(p["decision"], "hold")   # 抗跌最高，不被误杀
        self.assertEqual(p["absolute"]["verdict"], "retire")
        self.assertEqual(p["gated"], "rescue_top")

    def test_bottom_still_retires(self):
        crash = [0.88, 0.75, 0.60]
        p = profile(nav=0.60, peer_navs=crash, mode="relative")
        self.assertEqual(p["decision"], "retire")
        self.assertEqual(p["rank"], "bottom")

    def test_relative_inert_when_peers_short(self):
        p = profile(nav=1.05, peer_navs=[1.06], mode="relative")
        self.assertEqual(p["percentile"], None)
        self.assertEqual(p["decision"], "promote")  # 退化 v1


class OverfitBlocksPromoteTest(unittest.TestCase):
    EXT = {"per_symbol": {"s1": {"in_winrate_pct": 90.0, "out_winrate_pct": 50.0, "out_trades": 6}}}

    def test_overfit_holds_even_in_log_mode(self):
        # 任一 mode，样本内虚高都不许升（铁则）
        p = profile(nav=1.10, peer_navs=[1.12, 1.11, 1.10], mode="log", extended=self.EXT)
        self.assertEqual(p["decision"], "hold")
        self.assertEqual(p["blocked_by"], "overfit")


class ExcessModeTest(unittest.TestCase):
    def test_promote_requires_positive_excess(self):
        # 绝对 +10%，基准 +15% → 超额为负，不升
        p = profile(nav=1.10, mode="excess", bench_return_pct=15.0)
        self.assertEqual(p["decision"], "hold")
        self.assertEqual(p["blocked_by"], "excess")
        self.assertEqual(p["excess"]["excess_pct"], -5.0)
        # 基准 +2% → 超额 +8% > 0，升
        p2 = profile(nav=1.10, mode="excess", bench_return_pct=2.0)
        self.assertEqual(p2["decision"], "promote")

    def test_excess_requires_bench(self):
        # 无基准：excess 档退化为 relative 规则（peers 不足 → v1）
        p = profile(nav=1.10, mode="excess", bench_return_pct=None)
        self.assertEqual(p["decision"], "promote")


class DecisionWiringTest(unittest.TestCase):
    def _store(self):
        return JsonStore(Path(tempfile.mkdtemp()))

    def _seed(self, store, navs: dict, days: int = 5):
        from datetime import date, timedelta

        d0 = date(2026, 8, 17)
        dates = [(d0 + timedelta(days=i)).isoformat() for i in range(days)]
        # 各策略线性爬到终值 nav
        for sid, nav in navs.items():
            store.set("strategies", sid, {
                "id": sid, "name": sid, "kind": "rsi_reversal",
                "direction": "利空", "symbols": [f"6000{sid[-1]}"], "params": {"n": 14},
                "status": "active",
                "backtest": {"out_of_sample": {"win_rate_pct": 80.0}},
                "evolve": {"state": "active", "tier": 1},
            })
        for i, d in enumerate(dates):
            frac = (i + 1) / days
            overall = 1.0 + (sum(navs.values()) / len(navs) - 1.0) * frac
            store.set("shadow_equity", d, {
                "overall_nav": round(overall, 4),
                "strategies": {
                    sid: {"nav": round(1.0 + (nav - 1.0) * frac, 4)}
                    for sid, nav in navs.items()
                },
            })

    def _decide(self, store):
        from adapter import evolution
        return evolution._per_strategy_decisions(store, evolution.attribution(store))

    def test_relative_blocks_mid_pack_beta_from_promote(self):
        saved = settings.evolve_fitness_mode
        try:
            settings.evolve_fitness_mode = "relative"
            store = self._store()
            # 三只同批爬到不同终值：strategies[0] 顶、[1] 中游、[2] 低
            self._seed(store, {"s-top": 1.10, "s-mid": 1.05, "s-low": 1.02})
            per, _ = self._decide(store)
            dec = {e["strategy_id"]: e for e in per}
            self.assertEqual(dec["s-top"]["decision"], "promote")   # 顶位真本事 → 升
            self.assertEqual(dec["s-mid"]["decision"], "none")       # 过线但中游 → 跟风不升
            self.assertEqual(dec["s-mid"]["fitness"]["decision"], "hold")
            self.assertEqual(dec["s-mid"]["fitness"]["blocked_by"], "rank")
            self.assertIn("跟风不升", dec["s-mid"]["behavior"])
        finally:
            settings.evolve_fitness_mode = saved

    def test_overfit_flag_blocks_promote_through_decision(self):
        saved = settings.evolve_fitness_mode
        try:
            settings.evolve_fitness_mode = "log"
            store = self._store()
            store.set("strategies", "s-over", {
                "id": "s-over", "name": "过拟合", "kind": "rsi_reversal",
                "direction": "利空", "symbols": ["600001"], "params": {"n": 14},
                "status": "active",
                "backtest": {"out_of_sample": {"win_rate_pct": 80.0},
                             "extended_backtest": {"per_symbol": {
                                 "600001": {"in_winrate_pct": 92.0, "out_winrate_pct": 45.0,
                                            "out_trades": 6}}}},
                "evolve": {"state": "active", "tier": 1},
            })
            store.set("strategies", "s-norm", {
                "id": "s-norm", "name": "正常", "kind": "rsi_reversal",
                "direction": "利空", "symbols": ["600002"], "params": {"n": 14},
                "status": "active", "backtest": {"out_of_sample": {"win_rate_pct": 80.0}},
                "evolve": {"state": "active", "tier": 1},
            })
            self._seed(store, {"s-over": 1.10, "s-norm": 1.08})
            # 复写 s-over 终值足够高、且带 extended → 过拟合不升
            rec = store.get("strategies", "s-over")
            store.set("strategies", "s-over", {**rec, "backtest": {
                "out_of_sample": {"win_rate_pct": 80.0},
                "extended_backtest": {"per_symbol": {
                    "600001": {"in_winrate_pct": 92.0, "out_winrate_pct": 45.0, "out_trades": 6}}}}})
            per, _ = self._decide(store)
            dec = {e["strategy_id"]: e for e in per}
            self.assertEqual(dec["s-over"]["fitness"]["overfit"]["flag"], True)
            self.assertIn("过拟合不升", dec["s-over"]["behavior"])
            self.assertEqual(dec["s-over"]["decision"], "none")
        finally:
            settings.evolve_fitness_mode = saved

    def test_apply_action_persists_fitness_to_evolve(self):
        from adapter import evolution
        store = self._store()
        store.set("strategies", "x", {"id": "x", "name": "x", "status": "active",
                                      "evolve": {"state": "active", "tier": 1}})
        action = {"type": "promote", "sid": "x", "from": "tier1", "to": "tier2",
                  "reason": "升", "fitness": {"decision": "promote", "mode": "log",
                                              "percentile": None, "overfit": {"flag": False}}}
        evolution._apply_action(store, action)
        self.assertEqual(store.get("strategies", "x")["evolve"]["tier"], 2)
        self.assertEqual(store.get("strategies", "x")["evolve"]["fitness"]["decision"], "promote")


if __name__ == "__main__":
    unittest.main()
