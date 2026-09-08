# -*- coding: utf-8 -*-
"""自进化 v2 · P5 运行时自适应·冬眠 + 存档复活单测。

覆盖：
- shadow._regime_hibernation：门控关 → 原样返回；regime unknown → 全放行（conservative）；
  regime 在 gate.allow → 保留；不在 → 剔除为冬眠。
- evolution 冬眠分流：当日 regime 不在该策略适配区且冬眠开 → 记 冬眠、不判降级（环境不配合
  不计能力）；冬眠关 → 正常按 nav 判降。
- gene_archive.reactivate_archived：regime 切回擅长档 → 复活为 candidate（source=revival）；
  仍在跑/regime 不匹配/unknown → 不复活。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_hibernation -v
依赖 adapter.{shadow,evolution,genome,gene_archive,regime,config,store}——无网络、无 LLM。
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")

from adapter import evolution, gene_archive, genome, shadow  # noqa: E402
from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402

TRADE_DATE = "2026-09-08"


def _store():
    return JsonStore(Path(tempfile.mkdtemp()))


def _seed_regime(store, regime="trend_down"):
    store.set("market_regime", "2026-09-07", {
        "date": "2026-09-07", "regime": regime, "confidence_pct": 60.0,
    })
    store.set("market_regime", "_latest", "2026-09-07")


def _narrow_strategy(sid, *, allow=("trend_up",), nav=0.945, name="窄适配"):
    gene = genome.gene_for("momentum", {"n": 10}, ["600519"], "利好")
    gene["regime_gate"] = {"allow": list(allow), "miss_mode": "on_default"}
    return {
        "id": sid, "name": name, "kind": "momentum", "direction": "利好",
        "symbols": ["600519"], "params": {"n": 10}, "gene": gene,
        "status": "active",
        "backtest": {"out_of_sample": {"win_rate_pct": 60.0}},
        "evolve": {"state": "active", "tier": 1, "nav": nav},
    }


class ShadowHibernationTest(unittest.TestCase):
    def test_disabled_returns_all_unchanged(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = False
            store = _store()
            _seed_regime(store, "trend_down")
            s = _narrow_strategy("s1", allow=("trend_up",))
            kept, hib = shadow._regime_hibernation([s], store, TRADE_DATE)
            self.assertEqual(kept, [s])
            self.assertEqual(hib, set())
        finally:
            settings.evolve_hibernate_enabled = saved

    def test_unknown_regime_never_hibernates(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = True
            store = _store()
            s = _narrow_strategy("s1", allow=("trend_up",))
            # 无 regime 落库 → latest_regime 返回 None → 全放行
            kept, hib = shadow._regime_hibernation([s], store, TRADE_DATE)
            self.assertEqual(kept, [s])
            self.assertEqual(hib, set())
        finally:
            settings.evolve_hibernate_enabled = saved

    def test_out_of_band_strategy_hibernated(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = True
            store = _store()
            _seed_regime(store, "trend_down")  # 当前熊市
            s_in = _narrow_strategy("in", allow=("trend_down",))   # 适配当下 → 保留
            s_out = _narrow_strategy("out", allow=("trend_up",))   # 不适配 → 冬眠
            kept, hib = shadow._regime_hibernation([s_in, s_out], store, TRADE_DATE)
            self.assertEqual({x["id"] for x in kept}, {"in"})
            self.assertEqual(hib, {"out"})
        finally:
            settings.evolve_hibernate_enabled = saved

    def test_allowed_regime_keeps_strategy(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = True
            store = _store()
            _seed_regime(store, "trend_down")
            s = _narrow_strategy("s1", allow=("trend_down",))
            kept, hib = shadow._regime_hibernation([s], store, TRADE_DATE)
            self.assertEqual(kept, [s])
            self.assertEqual(hib, set())
        finally:
            settings.evolve_hibernate_enabled = saved


def _seed_decision(store, sid, *, allow=("trend_up",), regime="trend_down"):
    store.set("strategies", sid, _narrow_strategy(sid, allow=allow, nav=0.945))
    _seed_regime(store, regime)
    # 6 天 nav 压在观察线(0.95)下方 → 若不冬眠会判降
    for i in range(6):
        store.set("shadow_equity", (date(2026, 9, 1) + timedelta(days=i)).isoformat(), {
            "overall_nav": 0.945,
            "strategies": {sid: {"nav": 0.945}},
        })


class EvolutionHibernationDecisionTest(unittest.TestCase):
    def test_hibernate_on_holds_out_of_band_strategy(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = True
            store = _store()
            _seed_decision(store, "sSlow", allow=("trend_up",), regime="trend_down")
            plan = evolution.evolve(store, apply=False)
            demotes = [a for a in plan["actions"] if a["type"] == "demote"]
            retires = [a for a in plan["actions"] if a["type"] == "retire"]
            self.assertFalse(demotes)
            self.assertFalse(retires)
            rows = plan.get("per_strategy") or plan.get("strategies") or []
            self.assertTrue(any(
                (r or {}).get("behavior") == "冬眠" for r in rows
            ), [r.get("behavior") for r in rows])
        finally:
            settings.evolve_hibernate_enabled = saved

    def test_hibernate_off_still_demotes_out_of_band_strategy(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = False
            store = _store()
            _seed_decision(store, "sSlow", allow=("trend_up",), regime="trend_down")
            plan = evolution.evolve(store, apply=False)
            demotes = [a for a in plan["actions"] if a["type"] == "demote"]
            self.assertTrue(demotes)  # 默认关 → 仍按 nav 判降，与 v1 一致
        finally:
            settings.evolve_hibernate_enabled = saved

    def test_hibernate_allowed_strategy_not_held(self):
        saved = settings.evolve_hibernate_enabled
        try:
            settings.evolve_hibernate_enabled = True
            store = _store()
            # 该策略适配 trend_down（当下熊市），nav 也不低 → 不冬眠、不进冬眠 bucket
            _seed_decision(store, "sIn", allow=("trend_down",), regime="trend_down")
            plan = evolution.evolve(store, apply=False)
            rows = plan.get("per_strategy") or plan.get("strategies") or []
            self.assertFalse(any((r or {}).get("behavior") == "冬眠" for r in rows))
        finally:
            settings.evolve_hibernate_enabled = saved


class ArchiveRevivalTest(unittest.TestCase):
    def _archive_gene(self, sid, *, allow=("trend_up",)):
        gene = genome.gene_for("rsi_reversal", {"n": 14}, ["600519", "000858"], "利空")
        gene["regime_gate"] = {"allow": list(allow), "miss_mode": "on_default"}
        store = _store()
        rec = {"id": sid, "name": "老兵", "kind": "rsi_reversal", "direction": "利空",
               "symbols": ["600519", "000858"], "params": {"n": 14}, "gene": gene,
               "generation": 2}
        gene_archive.archive_record(store, rec, reason="retire:nav")
        return store

    def test_regime_switch_revives_archived_as_candidate(self):
        store = self._archive_gene("sOld", allow=("trend_up",))
        created = gene_archive.reactivate_archived(store, "trend_up")
        self.assertEqual(len(created), 1)
        rec = store.get("strategies", created[0])
        self.assertEqual(rec["source"], "revival")
        self.assertEqual(rec["status"], "candidate")
        self.assertEqual(rec["mutated_from"], "sOld")
        self.assertGreaterEqual(rec["generation"], 2)

    def test_no_revival_when_regime_does_not_match(self):
        store = self._archive_gene("sOld", allow=("trend_up",))
        self.assertEqual(gene_archive.reactivate_archived(store, "oscillation"), [])

    def test_no_revival_on_unknown_regime(self):
        store = self._archive_gene("sOld", allow=("trend_up",))
        self.assertEqual(gene_archive.reactivate_archived(store, None), [])

    def test_no_revival_when_sid_already_running(self):
        store = self._archive_gene("sOld", allow=("trend_up",))
        # sOld 已作为 active 在跑 → 不复活重复
        store.set("strategies", "sOld", {**_narrow_strategy("sOld"), "kind": "rsi_reversal",
                                          "direction": "利空"})
        created = gene_archive.reactivate_archived(store, "trend_up")
        # revival 语义是"新 candidate sid"，但 revive-* 以 archive key 去重不重复 →
        # 这里 sOld 在跑只挡 revival_candidates 的 exclude=running
        self.assertEqual(created, [])


if __name__ == "__main__":
    unittest.main()
