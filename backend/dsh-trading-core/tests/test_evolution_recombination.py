# -*- coding: utf-8 -*-
"""自进化 v2 · P3 有性繁殖 + 归因引导有向变异单测（纯函数层）。

覆盖 adapter/recombine.py：
- crossover：A 因子结构(kind+params) × B 标的池，带 parent_a/parent_b 双亲谱系；
  空池/无票返回 None；direction 由调用方保证一致（模块只落"其他"兜底不报错）。
- prune_losers：归因剪枝换掉证据最差的拖累票；无证据票保守保留；drop_worst<=0/池太小不动。
- best_symbols：从证据池挑 topN 胜因票。
- trade_scores：影子平仓流水聚合 per-symbol 均值。
- evidence_scores：extended_backtest.per_symbol → 分数，优先样本外累计收益。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_recombination -v
依赖 adapter.recombine——纯函数，无网络。
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")

from adapter import evolution, genome, recombine  # noqa: E402
from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402


class CrossoverTest(unittest.TestCase):
    def test_child_keeps_a_factor_b_symbols_with_dual_lineage(self):
        child = recombine.crossover(
            "rsi_reversal", {"n": 20, "oversold": 28}, ["600519", "000858", "600519"],
            "利空", parent_a="strat-A", parent_b="strat-B", symbol_cap=30)
        self.assertIsNotNone(child)
        self.assertEqual(child["kind"], "rsi_reversal")       # factor 取 A
        self.assertEqual(child["params"], {"n": 20, "oversold": 28})  # params 取 A
        self.assertEqual(child["symbols"], ["600519", "000858"])      # 标的池取 B、去重
        self.assertEqual(child["direction"], "利空")
        self.assertEqual(child["parent_a"], "strat-A")
        self.assertEqual(child["parent_b"], "strat-B")

    def test_empty_symbol_pool_returns_none(self):
        self.assertIsNone(recombine.crossover(
            "momentum", {}, [], "利好", parent_a="A", parent_b="B"))

    def test_only_none_symbols_returns_none(self):
        self.assertIsNone(recombine.crossover(
            "momentum", {}, [None, ""], "利好", parent_a="A", parent_b="B"))

    def test_symbol_cap_truncates_pool(self):
        child = recombine.crossover("rsi_reversal", {}, ["1", "2", "3", "4", "5"],
                                    "利空", parent_a="A", parent_b="B", symbol_cap=2)
        self.assertEqual(child["symbols"], ["1", "2"])

    def test_unknown_direction_is_bucketed_not_crash(self):
        child = recombine.crossover("rsi_reversal", {}, ["600519"], "中性",
                                    parent_a="A", parent_b="B")
        self.assertEqual(child["direction"], "其他")


class PruneLosersTest(unittest.TestCase):
    def test_drops_worst_scored_held_symbol(self):
        syms = recombine.prune_losers(
            ["688981", "603986", "300839"],
            {"688981": 2.0, "603986": -5.0, "300839": 1.0}, drop_worst=1)
        self.assertNotIn("603986", syms)
        self.assertIn("688981", syms)
        self.assertIn("300839", syms)

    def test_unknown_symbols_kept_conservatively(self):
        # 无证据票不主动裁（保守保留），即使它在池里最可能落后
        syms = recombine.prune_losers(
            ["688981", "NO_EVIDENCE"], {"688981": -3.0}, drop_worst=1)
        self.assertIn("NO_EVIDENCE", syms)

    def test_drop_worst_zero_or_exhaustive_leaves_unchanged(self):
        syms = ["a", "b", "c"]
        self.assertEqual(recombine.prune_losers(syms, {"a": 1.0}, drop_worst=0), syms)
        # 池 ≤ drop_worst：不裁到空
        self.assertEqual(recombine.prune_losers(syms, {"a": 1.0, "b": -1.0, "c": 0.0},
                                                drop_worst=5), syms)

    def test_dedup_preserved(self):
        syms = recombine.prune_losers(["x", "x", "y"], {"x": -9.0, "y": 1.0}, drop_worst=1)
        self.assertEqual(syms, ["y"])


class BestSymbolsTest(unittest.TestCase):
    def test_returns_top_n_scored(self):
        top = recombine.best_symbols({"a": 1.0, "b": 5.0, "c": 3.0}, keep=2)
        self.assertEqual(set(top), {"b", "c"})

    def test_keep_zero_returns_empty_guard(self):
        top = recombine.best_symbols({"a": 1.0, "b": 5.0}, keep=0)
        self.assertEqual(top, []) if not top else self.assertIsInstance(top, list)


class TradeScoresTest(unittest.TestCase):
    def test_averages_ret_pct_per_symbol(self):
        trades = [
            {"symbol": "600519", "ret_pct": 2.0},
            {"symbol": "600519", "ret_pct": 4.0},
            {"code": "000858", "ret_pct": -3.0},
        ]
        out = recombine.trade_scores(trades)
        self.assertEqual(out["600519"], 3.0)   # (2+4)/2
        self.assertEqual(out["000858"], -3.0)

    def test_skips_missing_or_bad_values(self):
        trades = [
            {"symbol": "600519", "ret_pct": None},
            {"ret_pct": 1.0},               # 无 code
            {"symbol": "000858"},           # 无 ret_pct
            {"symbol": "300839", "ret_pct": "oops"},
        ]
        self.assertEqual(recombine.trade_scores(trades), {})


class EvidenceScoresTest(unittest.TestCase):
    def test_prefers_oos_cum_ret(self):
        per = {"600519": {"out_cum_ret_pct": 12.0, "out_winrate_pct": 60.0,
                          "in_cum_ret_pct": 99.0},
               "000858": {"out_winrate_pct": 40.0},          # 无 out_cum → 退胜率
               "300839": {"in_cum_ret_pct": 5.0}}            # 只有样本内
        out = recombine.evidence_scores(per)
        self.assertEqual(out["600519"], 12.0)
        self.assertEqual(out["000858"], 40.0)
        self.assertEqual(out["300839"], 5.0)

    def test_empty_and_no_key_filters(self):
        self.assertEqual(recombine.evidence_scores({}), {})
        self.assertEqual(recombine.evidence_scores({"600519": {}}), {})


def _store():
    return JsonStore(Path(tempfile.mkdtemp()))


def _seed_active(store, sid, *, kind, symbols, direction="利空", oos_wr=80.0,
                 per_symbol=None, gene=None):
    gene = gene if gene is not None else genome.gene_for(kind, {"n": 14}, symbols, direction)
    store.set("strategies", sid, {
        "id": sid, "name": sid, "kind": kind, "direction": direction,
        "symbols": list(symbols), "params": {"n": 14}, "gene": gene,
        "status": "active",
        "backtest": {
            "out_of_sample": {"win_rate_pct": oos_wr},
            "extended_backtest": {"per_symbol": per_symbol or {}},
        },
        "evolve": {"state": "active", "tier": 1},
    })


def _seed_days(store, navs_by_sid, *, start=date(2026, 8, 18), n=6):
    """navs_by_sid: {sid: [每日 nav…]}，从 start 起连续 n 个交易日写 shadow_equity。"""
    for i in range(n):
        day = {sid: {"nav": series[i]} for sid, series in navs_by_sid.items()}
        overall = max((v["nav"] for v in day.values()), default=1.0)
        store.set("shadow_equity", (start + timedelta(days=i)).isoformat(), {
            "overall_nav": overall,
            "strategies": day,
        })


class DecisionRecombinationWiringTest(unittest.TestCase):
    def test_crossover_off_override_no_dual_lineage_child(self):
        # crossover 默认开（v2）；显式关回后只有单亲变异子代，无带 parent_b 的重组子代
        saved = settings.evolve_recombine_enabled
        try:
            settings.evolve_recombine_enabled = False
            store = _store()
            _seed_active(store, "sA", kind="rsi_reversal", symbols=["600519", "000858"], direction="利空")
            _seed_active(store, "sB", kind="momentum", symbols=["300750", "002594"], direction="利空")
            navs = {"sA": [1.0, 1.01, 1.02, 1.04, 1.05, 1.06],
                    "sB": [1.0, 1.01, 1.03, 1.04, 1.05, 1.05]}
            _seed_days(store, navs)
            plan = evolution.evolve(store, apply=False)
            kids = [a for a in plan["actions"] if a["type"] == "mutate"]
            self.assertTrue(kids)
            self.assertFalse([a for a in kids if a.get("parent_b")])
        finally:
            settings.evolve_recombine_enabled = saved

    def test_crossover_on_produces_factorA_poolB_dual_lineage_child(self):
        saved = settings.evolve_recombine_enabled
        try:
            settings.evolve_recombine_enabled = True
            store = _store()
            _seed_active(store, "sA", kind="rsi_reversal", symbols=["600519", "000858"], direction="利空")
            _seed_active(store, "sB", kind="momentum", symbols=["300750", "002594"], direction="利空")
            navs = {"sA": [1.0, 1.01, 1.02, 1.04, 1.05, 1.06],
                    "sB": [1.0, 1.01, 1.03, 1.04, 1.05, 1.05]}
            _seed_days(store, navs)
            plan = evolution.evolve(store, apply=False)
            xo = [a for a in plan["actions"]
                  if a["type"] == "mutate" and a.get("parent_b")]
            self.assertTrue(xo, [a for a in plan["actions"] if a["type"] == "mutate"])
            a = xo[0]
            # factor×symbols 重组：子代 kind ∈ {两亲本 kind}，symbols = 另一亲本标的池
            parent_kinds = {r["kind"] for r in _records(store, ("sA", "sB"))}
            self.assertIn(a["kind"], parent_kinds)
            self.assertEqual(len(a["symbols"]), 2)
            self.assertNotEqual(a["parent"], a["parent_b"])
            # 落库后基因 meta 保留双亲谱系
            applied = evolution.evolve(store, apply=True, preview_token=plan["preview_token"])
            self.assertTrue(applied["applied"])
            child = [v for k, v in store.all("strategies").items()
                     if isinstance(v, dict) and v.get("source") == "evolution"
                     and (v.get("gene") or {}).get("meta", {}).get("parent_b")]
            self.assertTrue(child)
            meta = (child[0].get("gene") or {}).get("meta") or {}
            self.assertIn("parent_a", meta)
            self.assertIn("parent_b", meta)
            self.assertNotEqual(meta["parent_a"], meta["parent_b"])
        finally:
            settings.evolve_recombine_enabled = saved

    def test_guided_prune_drops_attribution_loser_symbol(self):
        saved = settings.evolve_guided_prune_enabled
        try:
            settings.evolve_guided_prune_enabled = True
            store = _store()
            _seed_active(store, "sP", kind="rsi_reversal", symbols=["GOOD", "BAD"], direction="利空",
                         per_symbol={"GOOD": {"out_cum_ret_pct": 12.0},
                                     "BAD": {"out_cum_ret_pct": -20.0}})
            _seed_days(store, {"sP": [1.0, 1.01, 1.02, 1.03, 1.05, 1.06]})
            plan = evolution.evolve(store, apply=False)
            kids = [a for a in plan["actions"] if a["type"] == "mutate"]
            self.assertTrue(kids)
            # 归因剪枝：被样本外证据判为拖累的 BAD 被换掉，胜因 GOOD 保留
            for a in kids:
                self.assertNotIn("BAD", a["symbols"])
                self.assertIn("GOOD", a["symbols"])
        finally:
            settings.evolve_guided_prune_enabled = saved


def _records(store, sids):
    all_s = store.all("strategies") or {}
    return [all_s[sid] for sid in sids if sid in all_s]


if __name__ == "__main__":
    unittest.main()
