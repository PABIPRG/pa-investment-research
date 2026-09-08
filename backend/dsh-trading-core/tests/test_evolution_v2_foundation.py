# -*- coding: utf-8 -*-
"""自进化 v2 · P0 新模块单测：regime 检测器 / 基因组 / 事件账本池 / 基准板块映射 / 基因存档。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_v2_foundation -v
依赖：adapter.{regime,genome,ledger,benchmark,gene_archive,store,config}——无网络、无 LLM。
"""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")
os.environ.setdefault("REGIME_GATE_ENABLED", "false")

from adapter import gene_archive, genome, ledger, regime
from adapter.benchmark import benchmark_for_symbol, candidate_benchmarks
from adapter.config import settings
from adapter.store import JsonStore


def _store() -> JsonStore:
    return JsonStore(Path(tempfile.mkdtemp()))


def _steady(daily: float, n: int = 200, start: float = 100.0) -> list[float]:
    """单调日收益序列（daily 为乘子-1，如 0.002 → 日 +0.2%）。"""
    out, v = [], start
    for _ in range(n):
        out.append(v)
        v *= 1.0 + daily
    return out


def _sine(amplitude: float, n: int = 200, period: int = 20) -> list[float]:
    import math
    return [100.0 + amplitude * math.sin(2 * math.pi * i / period) for i in range(n)]


def _vol_spike() -> list[float]:
    """前段平缓、末 25 日剧烈摆动 → 已实现波动异常放大。"""
    closes = [100.0 * (1.0001 ** i) for i in range(175)]
    alt = [1.09, 0.92]
    for i in range(25):
        closes.append(closes[-1] * alt[i % 2])
    return closes


class RegimeClassifierTest(unittest.TestCase):
    def test_trend_up(self):
        r = regime.classify_regime(_steady(0.002))
        self.assertEqual(r["regime"], "trend_up")
        self.assertFalse(r["needs_more_data"])

    def test_trend_down(self):
        r = regime.classify_regime(_steady(-0.002))
        self.assertEqual(r["regime"], "trend_down")

    def test_oscillation(self):
        r = regime.classify_regime(_sine(0.8))
        self.assertEqual(r["regime"], "oscillation")

    def test_high_vol_spike(self):
        r = regime.classify_regime(_vol_spike())
        self.assertEqual(r["regime"], "high_vol")
        self.assertGreater(r["vol_annualized_pct"], 20.0)

    def test_too_short(self):
        r = regime.classify_regime(_steady(0.001, n=10))
        self.assertTrue(r["needs_more_data"])
        self.assertEqual(r["regime"], "unknown")

    def test_classify_and_store_then_latest(self):
        store = _store()
        closes = _steady(0.002)
        # 从日期升序写入 market_index
        from datetime import date, timedelta
        start = date(2026, 1, 1)
        for i, c in enumerate(closes):
            d = (start + timedelta(days=i)).isoformat()
            regime.record_index_close(store, "sh.000300", d, c)
        rec = regime.classify_and_store(store)
        self.assertEqual(rec["regime"], "trend_up")
        self.assertEqual(store.get("market_regime", "_latest"), rec["date"])
        latest = regime.latest_regime(store)
        self.assertEqual(latest["regime"], "trend_up")


class GenomeTest(unittest.TestCase):
    def test_legacy_backcompat_gate_open(self):
        legacy = {"kind": "rsi_reversal", "params": {"n": 10}, "symbols": ["688981"], "direction": "利空"}
        gene = genome.default_genome(legacy)
        self.assertEqual(gene["regime_gate"]["allow"], list(genome.REGIMES))
        self.assertEqual(genome.read_gene(legacy)["factor"]["family"], "rsi_reversal")
        # 门控未启用 → 任何 regime 都放行
        self.assertTrue(genome.regime_allowed(legacy, "trend_up"))

    def test_gate_allow_respected_when_enabled(self):
        legacy = {"kind": "bollinger", "symbols": ["688981"], "direction": "利空", "params": {}}
        legacy["gene"] = genome.gene_for("bollinger", {"n": 20}, ["688981"], "利空")
        legacy["gene"]["regime_gate"] = {"allow": ["oscillation"], "miss_mode": "on_default"}
        saved = settings.regime_gate_enabled
        try:
            settings.regime_gate_enabled = True
            self.assertFalse(genome.regime_allowed(legacy, "trend_up"))
            self.assertTrue(genome.regime_allowed(legacy, "oscillation"))
            self.assertTrue(genome.regime_allowed(legacy, "unknown"))  # miss → on_default
        finally:
            settings.regime_gate_enabled = saved


class LedgerTest(unittest.TestCase):
    def _rec(self, store, etype, direction, codes, date):
        return ledger.record_candidate(
            store, event={"type": etype, "time": date}, direction=direction, symbol_codes=codes
        )

    def test_pool_accumulates_and_excludes(self):
        store = _store()
        self._rec(store, "减持", "利空", ["688981", "603986"], "2026-08-01")
        self._rec(store, "减持", "利空", ["688981", "300839"], "2026-08-10")
        pool = ledger.symbol_pool(store, event_type="减持", direction="利空", max_symbols=10)
        self.assertEqual(set(pool), {"688981", "603986", "300839"})
        # 排除母体现有票 → 只给新增候选；按最近日期降序，300839 最新在前
        add = ledger.symbol_pool(store, event_type="减持", direction="利空", exclude=["688981"])
        self.assertNotIn("688981", add)
        self.assertEqual(add[0], "300839")

    def test_pool_id_normalization(self):
        self.assertEqual(ledger.pool_id("减持", "利空"), "减持|利空")
        self.assertEqual(ledger.pool_id("x", "weird"), "x|其他")

    def test_event_type_and_date_tolerant(self):
        ev = {"type": " 减持 ", "time": "2026-08-01T10:00:00+08:00"}
        self.assertEqual(ledger.event_type_of(ev), "减持")
        self.assertEqual(ledger.event_date_of(ev), "2026-08-01")


class BenchmarkMappingTest(unittest.TestCase):
    def test_board_mapping(self):
        self.assertEqual(benchmark_for_symbol("688981"), ("sh.000688", "科创50"))
        self.assertEqual(benchmark_for_symbol("689009"), ("sh.000688", "科创50"))
        self.assertEqual(benchmark_for_symbol("600519"), ("sh.000300", "沪深300"))
        self.assertEqual(benchmark_for_symbol("000858"), ("sh.000300", "沪深300"))

    def test_candidate_fallback_order(self):
        self.assertEqual(candidate_benchmarks("688981")[0][0], "sh.000688")
        self.assertEqual(candidate_benchmarks("600519"), [("sh.000300", "沪深300")])


class GeneArchiveTest(unittest.TestCase):
    def test_archive_and_revival_filter(self):
        store = _store()
        rec = {
            "id": "strat-x", "kind": "rsi_reversal",
            "gene": {"factor": {"family": "rsi_reversal"},
                     "regime_gate": {"allow": ["oscillation"], "miss_mode": "on_default"}},
            "symbols": ["688981"], "direction": "利空",
        }
        self.assertEqual(gene_archive.archive_record(store, rec, reason="retire:nav"), "strat-x")
        hit = gene_archive.revival_candidates(store, "oscillation")
        self.assertEqual(len(hit), 1)
        miss = gene_archive.revival_candidates(store, "trend_up")
        self.assertEqual(miss, [])
        self.assertEqual(len(gene_archive.all_archived(store)), 1)


if __name__ == "__main__":
    unittest.main()
