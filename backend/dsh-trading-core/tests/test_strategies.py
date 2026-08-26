# -*- coding: utf-8 -*-
"""策略 DSL 新增 kind 回归测试：breakout / bollinger / volume_breakout。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_strategies -v
依赖：adapter.strategies（无网络、无 LLM）。合成 OHLC+volume 数据，贴近 _make_df 输出。
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

from adapter import strategies as S
from adapter.store import JsonStore


def make_df(close, high=None, low=None, volume=None):
    n = len(close)
    high = high if high is not None else list(close)
    low = low if low is not None else list(close)
    volume = volume if volume is not None else [1000.0] * n
    return pd.DataFrame({
        "date": [f"2026-01-{i + 1:02d}" for i in range(n)],
        "open": list(close), "high": high, "low": low,
        "close": list(close), "volume": volume,
    })


class KindsRegistered(unittest.TestCase):
    def test_kinds_registered(self):
        for kind in ("breakout", "bollinger", "volume_breakout"):
            self.assertIn(kind, S.KINDS)
            self.assertIn(kind, S._DEFAULT_PARAMS)
        self.assertEqual(S.KINDS, ("ma_cross", "rsi_reversal", "momentum",
                                   "breakout", "bollinger", "volume_breakout"))


class ClampParams(unittest.TestCase):
    def test_clamp_breakout_bounds(self):
        self.assertEqual(S._clamp_params("breakout", {}), {"n": 20})
        self.assertEqual(S._clamp_params("breakout", {"n": 3}), {"n": 5})
        self.assertEqual(S._clamp_params("breakout", {"n": 200}), {"n": 60})
        self.assertEqual(S._clamp_params("breakout", {"n": 30}), {"n": 30})

    def test_clamp_bollinger_bounds(self):
        self.assertEqual(S._clamp_params("bollinger", {}), {"n": 20, "k": 2.0})
        self.assertEqual(S._clamp_params("bollinger", {"n": 2, "k": 0.5}), {"n": 5, "k": 1.0})
        self.assertEqual(S._clamp_params("bollinger", {"n": 100, "k": 9}), {"n": 60, "k": 3.5})

    def test_clamp_volume_breakout_bounds(self):
        self.assertEqual(S._clamp_params("volume_breakout", {}), {"n": 20, "vol_mult": 1.5})
        self.assertEqual(S._clamp_params("volume_breakout", {"vol_mult": 0.1}), {"n": 20, "vol_mult": 1.0})
        self.assertEqual(S._clamp_params("volume_breakout", {"n": 4, "vol_mult": 9}), {"n": 5, "vol_mult": 4.0})

    def test_clamp_momentum_regression(self):
        self.assertEqual(S._clamp_params("momentum", {"n": 100}), {"n": 60})


class BreakoutSignal(unittest.TestCase):
    # 20 根 flat 100 → bar20 突破 110 → bar21..24 通道内 105 → bar25 跌破 95
    def _df(self):
        close = [100] * 20 + [110] + [105] * 4 + [95] + [100] * 5
        return make_df(close)

    def test_warmup_and_flat_are_zero(self):
        sig = S.signal_series(self._df(), "breakout", {"n": 5})
        self.assertEqual(sig.iloc[:20].tolist(), [0] * 20)

    def test_entry_latch_exit(self):
        sig = S.signal_series(self._df(), "breakout", {"n": 5})
        self.assertEqual(sig.iloc[20:25].tolist(), [1, 1, 1, 1, 1])
        self.assertEqual(sig.iloc[25:].tolist(), [0, 0, 0, 0, 0, 0])

    def test_no_lookahead_high_excluded(self):
        # bar20 high=500 但 close 未突破 → 不进场（shift(1) 排除当日 high）
        close = [100] * 21
        high = [100] * 20 + [500]
        df = make_df(close, high=high)
        sig = S.signal_series(df, "breakout", {"n": 5})
        self.assertEqual(sig.iloc[20], 0)

    def test_simulate_trades_enters_next_bar(self):
        sig = S.signal_series(self._df(), "breakout", {"n": 5})
        trades = S.simulate_trades(self._df(), sig)
        self.assertTrue(trades)
        # bar20 信号 → bar21 开盘成交
        self.assertEqual(trades[0]["entry_date"], "2026-01-22")


class BollingerSignal(unittest.TestCase):
    def _df(self):
        # 30 根恒定 100 → 10 根跌到 80 → 10 根回到 100
        close = [100] * 30 + [80] * 10 + [100] * 10
        return make_df(close)

    def test_warmup_entry_latch_exit(self):
        df = self._df()
        sig = S.signal_series(df, "bollinger", {"n": 20, "k": 2.0})
        # warmup（前 19 根 rolling 无效）+ 恒定期 close=100 不低于下轨(100) → 全 0
        self.assertEqual(sig.iloc[:30].tolist(), [0] * 30)
        # 下跌段触及下轨进场并闩锁
        self.assertEqual(sig.iloc[30:40].tolist(), [1] * 10)
        # 回到中轨平仓
        self.assertEqual(sig.iloc[40:].tolist(), [0] * 10)

    def test_entry_uses_lower_band_and_exit_uses_mid(self):
        df = self._df()
        n, k = 20, 2.0
        ma = df["close"].rolling(n, min_periods=n).mean()
        sd = df["close"].rolling(n, min_periods=n).std()
        lower = ma - k * sd
        # bar30 收盘 80 低于下轨（真正超跌）→ 触发
        self.assertLess(df["close"].iloc[30], lower.iloc[30])
        # bar40 收盘回到中轨之上 → 平仓
        self.assertGreater(df["close"].iloc[40], ma.iloc[40])


class VolumeBreakoutSignal(unittest.TestCase):
    def _df(self, close=None, volume=None, high=None, low=None):
        if close is None:
            # bar20 价突破 110（量不足）→ bar21 价 111 + 量 5000 放量确认 → 通道内 → 跌破 95
            close = [100] * 20 + [110, 111] + [105] * 4 + [95]
        if volume is None:
            volume = [1000.0] * len(close)
            if len(close) > 21:
                volume[21] = 5000.0  # 放量确认日
        return make_df(close, high=high, low=low, volume=volume)

    def test_price_alone_no_entry(self):
        # 价突破 110 但量不足（1000 < 1.5×1000）→ 不进
        close = [100] * 20 + [110]
        df = self._df(close, volume=[1000.0] * 21)
        sig = S.signal_series(df, "volume_breakout", {"n": 5, "vol_mult": 1.5})
        self.assertEqual(sig.iloc[20], 0)

    def test_volume_confirms_entry_and_latch(self):
        df = self._df()
        sig = S.signal_series(df, "volume_breakout", {"n": 5, "vol_mult": 1.5})
        self.assertEqual(sig.iloc[20], 0)          # 价突破但量不足
        self.assertEqual(sig.iloc[21], 1)          # 放量确认进场
        self.assertEqual(sig.iloc[22:26].tolist(), [1, 1, 1, 1])  # 通道内闩锁
        self.assertEqual(sig.iloc[26], 0)          # 跌破前 N 低平仓

    def test_vol_ma_excludes_today(self):
        df = self._df()
        vol = pd.to_numeric(df["volume"]).astype(float)
        vol_ma = vol.rolling(5, min_periods=5).mean().shift(1)
        # vol_ma[21] 用 vol[16..20]（均 1000），不含 bar21 自身 5000
        self.assertAlmostEqual(vol_ma.iloc[21], 1000.0)

    def test_missing_volume_col_degrades_to_zero(self):
        df = self._df()
        df = df.drop(columns=["volume"])
        sig = S.signal_series(df, "volume_breakout", {"n": 5})
        self.assertEqual(sig.tolist(), [0] * len(df))  # 无 volume → 永不进场，不抛错

    def test_nan_volume_does_not_crash(self):
        df = self._df()
        vol = list(df["volume"])
        vol[10] = None  # 停牌日无成交量
        df["volume"] = vol
        sig = S.signal_series(df, "volume_breakout", {"n": 5})
        self.assertEqual(len(sig), len(df))


class SignalShape(unittest.TestCase):
    def test_length_dtype_values(self):
        df = make_df([100] * 40, volume=[1000.0] * 40)
        for kind, params in (("breakout", {"n": 5}),
                             ("bollinger", {"n": 5, "k": 2.0}),
                             ("volume_breakout", {"n": 5})):
            sig = S.signal_series(df, kind, params)
            self.assertEqual(len(sig), len(df), kind)
            self.assertTrue(pd.api.types.is_integer_dtype(sig), kind)
            self.assertLessEqual(set(sig.unique()), {0, 1}, kind)


class LikongSemantics(unittest.TestCase):
    def _patched(self):
        store = JsonStore(Path(tempfile.mkdtemp()))
        p = mock.patch.object(S, "JsonStore", lambda: store)
        return store, p

    def test_likong_bollinger_allowed(self):
        store, p = self._patched()
        events = [{"id": "ev-1", "summary": "白酒渠道利空", "direction": "利空"}]
        hypos = [{"event_idx": 0, "symbols": ["600519"], "direction": "利空",
                  "kind": "bollinger", "params": {}, "rationale": "超跌反弹"}]
        with p:
            ids = S.create_candidates(events, hypos)
        self.assertEqual(len(ids), 1)
        strat = store.get("strategies", ids[0])
        self.assertEqual(strat["kind"], "bollinger")
        self.assertEqual(strat["direction"], "利空")

    def test_likong_breakout_forced_to_rsi_reversal(self):
        store, p = self._patched()
        events = [{"id": "ev-2", "summary": "行业利空", "direction": "利空"}]
        hypos = [{"event_idx": 0, "symbols": ["000858"], "direction": "利空",
                  "kind": "breakout", "params": {}, "rationale": "x"}]
        with p:
            ids = S.create_candidates(events, hypos)
        self.assertEqual(len(ids), 1)
        strat = store.get("strategies", ids[0])
        self.assertEqual(strat["kind"], "rsi_reversal")  # 系统只做多，强转超跌反弹


class PromptListsNewKinds(unittest.TestCase):
    def test_prompt_mentions_new_kinds(self):
        for kind in ("breakout", "bollinger", "volume_breakout"):
            self.assertIn(kind, S._HYPOTHESIS_SYSTEM)


if __name__ == "__main__":
    unittest.main()
