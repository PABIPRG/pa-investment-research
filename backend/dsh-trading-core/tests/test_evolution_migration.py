# -*- coding: utf-8 -*-
"""自进化 v2 · P2 基因座开放单测：生态位族内换 kind + 跨同类事件池换标的。

覆盖：
- genome 生态位族映射：rsi_reversal↔bollinger（利空反弹）、momentum↔breakout（利好动量）；
  ma_cross/volume_breakout 为单例 → family_alternatives 返回 ()。
- evolution._family_migrate：能换到同族备选 kind 并带该 kind 变异参数 + attribution_note；
  单例 kind 返回 (None,None,"") 退化为参数微扰。
- evolution._pool_migrated_symbols：母体无 pool_ref / 账本无同类历史 → None（v1 截短）；
  有池则从 events_ledger 同类池取票并排除母体已持。
- 裁决集成（EVOLVE_MIGRATION_ENABLED=true）：升级的母体会产出一条「kind 换成同族 bollinger」的
  变异子代；默认 false 时分支产物与 v1 一致（kind 不变）。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_migration -v
依赖：adapter.{evolution,genome,ledger,config,store}——无网络、无 LLM。
"""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("EVOLVE_MIGRATION_ENABLED", "false")

from adapter import evolution, genome, ledger  # noqa: E402
from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402


def _store():
    return JsonStore(Path(tempfile.mkdtemp()))


class NicheFamilyTest(unittest.TestCase):
    def test_rsi_bollinger_same_family(self):
        self.assertEqual(genome.family_of("rsi_reversal"), "利空反弹")
        self.assertEqual(set(genome.family_alternatives("rsi_reversal")), {"bollinger"})
        self.assertEqual(set(genome.family_alternatives("bollinger")), {"rsi_reversal"})

    def test_momentum_breakout_same_family(self):
        self.assertEqual(genome.family_of("momentum"), "利好动量")
        self.assertEqual(set(genome.family_alternatives("momentum")), {"breakout"})
        self.assertEqual(set(genome.family_alternatives("breakout")), {"momentum"})

    def test_singletons_have_no_alternative(self):
        self.assertEqual(genome.family_of("ma_cross"), None)
        self.assertEqual(genome.family_of("volume_breakout"), None)
        self.assertEqual(genome.family_alternatives("ma_cross"), ())
        self.assertEqual(genome.family_alternatives("volume_breakout"), ())


class FamilyMigrateTest(unittest.TestCase):
    def test_migrates_to_same_family_alt_with_params_and_note(self):
        kind, params, note = evolution._family_migrate("rsi_reversal", 1)
        self.assertEqual(kind, "bollinger")
        self.assertIsInstance(params, dict)
        self.assertIn("n", params)  # bollinger 用自身默认参数集
        self.assertIn("生态位内换打法 rsi_reversal→bollinger", note)

    def test_singleton_degrades_to_none(self):
        self.assertEqual(evolution._family_migrate("ma_cross", 1), (None, None, ""))


class PoolMigrateTest(unittest.TestCase):
    def test_no_pool_ref_returns_none(self):
        store = _store()
        rec = {"kind": "rsi_reversal", "symbols": ["688981"]}
        self.assertIsNone(evolution._pool_migrated_symbols(store, rec, ["688981"], 1))

    def test_empty_ledger_pool_returns_none(self):
        store = _store()
        rec = {"kind": "rsi_reversal", "symbols": ["688981"],
               "gene": genome.gene_for("rsi_reversal", {}, ["688981"], "利空",
                                       event_type="减持")}
        self.assertIsNone(evolution._pool_migrated_symbols(store, rec, ["688981"], 1))

    def test_pool_pulls_historical_candidates_excluding_held(self):
        store = _store()
        # 同类事件历史候选：先落池
        for ev, codes in [({"type": "减持", "time": "2026-08-01"}, ["688981", "603986"]),
                          ({"type": "减持", "time": "2026-08-10"}, ["688981", "300839"])]:
            ledger.record_candidate(store, event=ev, direction="利空", symbol_codes=codes)
        rec = {"kind": "rsi_reversal", "symbols": ["688981"],
               "gene": genome.gene_for("rsi_reversal", {}, ["688981"], "利空",
                                       event_type="减持")}
        syms = evolution._pool_migrated_symbols(store, rec, ["688981"], 1)
        self.assertIsNotNone(syms)
        # 泛化：母体保留锚点 688981，并引入同类事件历史候选 603986/300839（此前未交易过）
        self.assertIn("688981", syms)
        self.assertIn("603986", syms)
        self.assertIn("300839", syms)
        self.assertEqual(len(syms), 3)  # 无重复、无外来票


def _seed_promoting_strategy(store, sid="s-parent"):
    store.set("strategies", sid, {
        "id": sid, "name": "母体", "kind": "rsi_reversal",
        "direction": "利空", "symbols": ["688981", "603986"], "params": {"n": 14},
        "status": "active",
        "backtest": {"out_of_sample": {"win_rate_pct": 80.0}},
        "evolve": {"state": "active", "tier": 1},
    })
    for i, nav in enumerate([1.00, 1.01, 1.02, 1.03, 1.05]):
        store.set("shadow_equity", f"2026-08-{18 + i:02d}", {
            "overall_nav": nav,
            "strategies": {sid: {"nav": nav}},
        })


class DecisionMigrationWiringTest(unittest.TestCase):
    def test_migration_off_produces_same_kind_children(self):
        store = _store()
        _seed_promoting_strategy(store)
        plan = evolution.evolve(store, apply=False)
        kids = [a for a in plan["actions"] if a["type"] == "mutate"]
        self.assertTrue(kids)
        for k in kids:
            self.assertEqual(k["kind"], "rsi_reversal")  # 默认关 → 与 v1 同 kind
            self.assertIsNone(k.get("attribution_note"))

    def test_migration_on_swaps_kind_to_same_family(self):
        saved = settings.evolve_migration_enabled
        try:
            settings.evolve_migration_enabled = True
            store = _store()
            _seed_promoting_strategy(store)
            plan = evolution.evolve(store, apply=False)
            kids = [a for a in plan["actions"] if a["type"] == "mutate"]
            self.assertTrue(kids)
            # 存在把 rsi_reversal 换到同族 bollinger 的子代
            migrated = [k for k in kids if k["kind"] == "bollinger"]
            self.assertTrue(migrated, kids)
            for k in migrated:
                self.assertIn("生态位内换打法 rsi_reversal→bollinger", k.get("reason", ""))
        finally:
            settings.evolve_migration_enabled = saved

    def test_migration_provenance_persists_into_child_gene_meta(self):
        saved = settings.evolve_migration_enabled
        try:
            settings.evolve_migration_enabled = True
            store = _store()
            _seed_promoting_strategy(store)
            plan = evolution.evolve(store, apply=False)
            applied = evolution.evolve(store, apply=True, preview_token=plan["preview_token"])
            self.assertTrue(applied["applied"])
            kids = [v for k, v in store.all("strategies").items()
                    if isinstance(v, dict) and v.get("source") == "evolution"]
            migrated = [r for r in kids if r["kind"] == "bollinger"]
            self.assertTrue(migrated)
            self.assertEqual(migrated[0]["status"], "candidate")
            gene = migrated[0].get("gene") or {}
            self.assertIn("attribution_note", gene.get("meta") or {})
            self.assertIn("bollinger", (gene.get("meta") or {}).get("attribution_note", ""))
        finally:
            settings.evolve_migration_enabled = saved


if __name__ == "__main__":
    unittest.main()
