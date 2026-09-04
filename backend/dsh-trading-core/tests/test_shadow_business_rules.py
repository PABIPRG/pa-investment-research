# -*- coding: utf-8 -*-
"""影子验证只接收已生效策略的业务护栏。"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from adapter.shadow import ShadowRunner
from adapter.store import JsonStore


class ShadowBusinessRuleTests(unittest.TestCase):
    @staticmethod
    def _single_loss_history(extra_cycle: bool = False) -> list[dict]:
        closes = [10, 11, 10, 9, 9, 9, 9, 9, 9, 9]
        if extra_cycle:
            closes.extend([10, 9, 8])
        return [
            {
                "date": f"2026-08-{index + 1:02d}",
                "open": float(close),
                "high": float(close),
                "low": float(close),
                "close": float(close),
                "volume": 1000,
            }
            for index, close in enumerate(closes)
        ]

    def test_replaying_same_shadow_history_does_not_inflate_evolution_evidence(self):
        from adapter import evolution
        from adapter.config import settings

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            strategy = {
                "id": "stable-ledger",
                "name": "稳定台账",
                "status": "active",
                "kind": "momentum",
                "symbols": ["600000"],
                "params": {"n": 1},
                "evolve": {"state": "active", "tier": 1},
            }
            store.set("strategies", strategy["id"], strategy)
            runner = ShadowRunner(store)
            meta = {
                strategy["id"]: {
                    "track_from": "2026-08-01",
                    "initial_capital": 100000.0,
                    "activated_at": "2026-08-01 09:00:00",
                }
            }
            history = self._single_loss_history()

            with patch.object(runner, "_fetch_hist", return_value=history):
                for _ in range(3):
                    runner._run_strategy(
                        strategy, "2026-08-10", "2025-01-01", meta, lambda _m: None
                    )

            for day in range(1, 6):
                store.set("shadow_equity", f"2026-08-{day:02d}", {
                    "overall_nav": 1.0,
                    "strategies": {strategy["id"]: {"nav": 1.0}},
                })

            with patch.object(settings, "evolve_min_days", 5), \
                    patch.object(settings, "evolve_retire_nav", 0.5), \
                    patch.object(settings, "evolve_demote_nav", 0.5), \
                    patch.object(settings, "evolve_promote_nav", 2.0):
                attribution = evolution.attribution(store, strategy["id"])
                preview = evolution.evolve(store, strategy_id=strategy["id"])

            trades = store.get("shadows", f"trades:{strategy['id']}")
            metrics = attribution["strategies"][0]
            self.assertEqual(len(trades), 1)
            self.assertEqual(metrics["closed_trades"], 1)
            self.assertEqual(metrics["closed_cum_return_pct"], -10.0)
            self.assertFalse(any(action["type"] == "retire" for action in preview["actions"]))

    def test_replay_merge_keeps_a_genuinely_new_closed_trade(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            strategy = {
                "id": "growing-ledger",
                "name": "新增成交",
                "status": "active",
                "kind": "momentum",
                "symbols": ["600000"],
                "params": {"n": 1},
            }
            runner = ShadowRunner(store)
            meta = {
                strategy["id"]: {
                    "track_from": "2026-08-01",
                    "initial_capital": 100000.0,
                    "activated_at": "2026-08-01 09:00:00",
                }
            }

            with patch.object(
                runner, "_fetch_hist", return_value=self._single_loss_history()
            ):
                runner._run_strategy(
                    strategy, "2026-08-10", "2025-01-01", meta, lambda _m: None
                )
            with patch.object(
                runner, "_fetch_hist", return_value=self._single_loss_history(extra_cycle=True)
            ):
                runner._run_strategy(
                    strategy, "2026-08-13", "2025-01-01", meta, lambda _m: None
                )

            trades = store.get("shadows", f"trades:{strategy['id']}")
            self.assertEqual(len(trades), 2)
            self.assertEqual(
                {(trade["entry_date"], trade["exit_date"]) for trade in trades},
                {("2026-08-03", "2026-08-04"), ("2026-08-12", "2026-08-13")},
            )

    def test_failed_symbol_capital_refunded_as_idle_cash(self):
        """拉数失败的符号资本按闲置现金计入，不机械压低 NAV（3 符号中 1 失败仍 nav=1）。"""
        import pandas as pd

        from adapter.holdings_runner import HoldingDataError

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "s-acc", {
                "id": "s-acc", "name": "acc", "status": "active",
                "kind": "ma_cross", "symbols": ["A", "B", "C"], "params": {},
            })
            runner = ShadowRunner(store)
            hist = [
                {"date": f"2026-08-{d:02d}", "open": 10.0, "high": 10.5,
                 "low": 9.5, "close": 10.0, "volume": 1000}
                for d in range(3, 13)
            ]

            def fake_fetch(sym, start, end):
                if sym == "C":
                    raise HoldingDataError("baostock 登录失败: 瞬时")
                return hist

            def fake_signal(df, kind, params):
                return pd.Series(0, index=df.index)

            with patch("adapter.shadow._latest_trade_date", return_value="2026-09-01"), \
                    patch.object(runner, "_fetch_hist", side_effect=fake_fetch), \
                    patch("adapter.shadow.signal_series", side_effect=fake_signal):
                result = runner.run({"force": False}, lambda _m: None)

            self.assertFalse(result["skipped"])
            snap = result["strategies"]["s-acc"]
            # A/B 无当日 bar → 现金不动；C 失败 → 资本回补为闲置现金，NAV 不塌
            self.assertAlmostEqual(snap["equity"], 100000.0, places=2)
            self.assertEqual(snap["nav"], 1.0)
            self.assertIn("C", snap["symbol_errors"])

    def test_fetch_hist_retries_once_on_baostock_login_failure(self):
        """baostock 瞬时登录失败 → _fetch_hist 短暂退避后重试一次。"""
        from adapter.holdings_runner import HoldingDataError

        runner = ShadowRunner()
        hist = [{"date": "2026-09-01", "open": 1.0, "high": 1.0, "low": 1.0,
                 "close": 1.0, "volume": 1}]
        calls = {"n": 0}

        def fake_bs_hist(code, start, end, fields):
            calls["n"] += 1
            if calls["n"] == 1:
                raise HoldingDataError("baostock 登录失败: 瞬时")
            return hist

        with patch("adapter.holdings_runner._bs_hist", side_effect=fake_bs_hist), \
                patch("adapter.shadow.time.sleep"):
            out = runner._fetch_hist("600519", "2026-01-01", "2026-09-01")

        self.assertEqual(out, hist)
        self.assertEqual(calls["n"], 2)

    def test_explicit_candidate_is_skipped_instead_of_entering_paper_account(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set(
                "strategies",
                "candidate-1",
                {"id": "candidate-1", "status": "candidate", "symbols": ["600519"]},
            )
            runner = ShadowRunner(store)

            with patch("adapter.shadow._latest_trade_date", return_value="2026-08-26"):
                result = runner.run(
                    {"strategy_id": "candidate-1", "force": False}, lambda _message: None
                )

            self.assertTrue(result["skipped"])
            self.assertIn("无 active 策略", result["reason"])
            self.assertNotIn("reports", result)
            self.assertEqual(store.all("shadows"), {})
            self.assertEqual(store.all("shadow_equity"), {})


if __name__ == "__main__":
    unittest.main()
