# -*- coding: utf-8 -*-
"""技术指标计算：MA / MACD / RSI / KDJ / BOLL / 支撑压力 / 量价形态。

纯 pandas 计算（不引 stockstats），兼容 pandas 3.0。
输入统一列名 date/open/close/high/low/volume/amount（升序）。
所有输出显式 float() 防 numpy 标量泄漏进 JSON。
"""

import math

import pandas as pd

_DEFAULTS = {
    "ma": {"ma5": None, "ma10": None, "ma20": None, "ma60": None, "trend": "数据不足"},
    "macd": {"dif": None, "dea": None, "hist": None, "cross": None},
    "rsi": {"rsi14": None, "state": None},
    "kdj": {"k": None, "d": None, "j": None, "cross": None},
    "boll": {"upper": None, "mid": None, "lower": None, "band_pos": None, "state": None},
    "support_resistance": {"support": None, "resistance": None, "pos": None},
    "pattern": {"pattern": None, "vol_ratio": None},
}


def _f(v) -> float | None:
    """转 float，NaN/None/inf → None。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, 3)


def _need(series: pd.Series, n: int) -> bool:
    return len(series) >= n and series.iloc[-1] is not None and not pd.isna(series.iloc[-1])


def ma_signals(close: pd.Series) -> dict:
    out = dict(_DEFAULTS["ma"])
    cur = {n: None for n in (5, 10, 20, 60)}
    for n in (5, 10, 20, 60):
        if len(close) >= n:
            cur[n] = _f(close.rolling(n).mean().iloc[-1])
    out.update({f"ma{n}": v for n, v in cur.items()})
    vals = [cur[5], cur[10], cur[20], cur[60]]
    if all(v is not None for v in vals):
        if vals[0] > vals[1] > vals[2] > vals[3]:
            out["trend"] = "多头排列"
        elif vals[0] < vals[1] < vals[2] < vals[3]:
            out["trend"] = "空头排列"
        else:
            out["trend"] = "均线缠绕"
    return out


def macd_signals(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    out = dict(_DEFAULTS["macd"])
    if len(close) < slow + signal + 1:
        return out
    ema_f = close.ewm(span=fast, adjust=False).mean()
    ema_s = close.ewm(span=slow, adjust=False).mean()
    dif = ema_f - ema_s
    dea = dif.ewm(span=signal, adjust=False).mean()
    bar = (dif - dea) * 2
    cross = None
    if dif.iloc[-2] <= dea.iloc[-2] and dif.iloc[-1] > dea.iloc[-1]:
        cross = "金叉"
    elif dif.iloc[-2] >= dea.iloc[-2] and dif.iloc[-1] < dea.iloc[-1]:
        cross = "死叉"
    out.update({"dif": _f(dif.iloc[-1]), "dea": _f(dea.iloc[-1]),
                "hist": _f(bar.iloc[-1]), "cross": cross})
    return out


def rsi_signals(close: pd.Series, period: int = 14) -> dict:
    out = dict(_DEFAULTS["rsi"])
    if len(close) < period + 1:
        return out
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, 1e-12)
    rsi = 100 - 100 / (1 + rs)
    v = _f(rsi.iloc[-1])
    state = None
    if v is not None:
        state = "超买" if v > 70 else ("超卖" if v < 30 else "正常")
    out.update({"rsi14": v, "state": state})
    return out


def kdj_signals(high: pd.Series, low: pd.Series, close: pd.Series,
                n: int = 9, m1: int = 3, m2: int = 3) -> dict:
    out = dict(_DEFAULTS["kdj"])
    if len(close) < n:
        return out
    low_n = low.rolling(n).min()
    high_n = high.rolling(n).max()
    rng = (high_n - low_n).replace(0, 1e-12)
    rsv = (close - low_n) / rng * 100
    k = rsv.ewm(alpha=1 / m1, adjust=False).mean()
    d = k.ewm(alpha=1 / m2, adjust=False).mean()
    j = 3 * k - 2 * d
    cross = None
    if k.iloc[-2] <= d.iloc[-2] and k.iloc[-1] > d.iloc[-1]:
        cross = "金叉"
    elif k.iloc[-2] >= d.iloc[-2] and k.iloc[-1] < d.iloc[-1]:
        cross = "死叉"
    out.update({"k": _f(k.iloc[-1]), "d": _f(d.iloc[-1]), "j": _f(j.iloc[-1]), "cross": cross})
    return out


def boll_signals(close: pd.Series, n: int = 20, k: float = 2.0) -> dict:
    out = dict(_DEFAULTS["boll"])
    if len(close) < n:
        return out
    mid = close.rolling(n).mean()
    std = close.rolling(n).std()
    up = mid + k * std
    low = mid - k * std
    price = close.iloc[-1]
    band_pos = None
    if _f(up.iloc[-1]) is not None and _f(low.iloc[-1]) is not None:
        rng = up.iloc[-1] - low.iloc[-1]
        band_pos = (price - low.iloc[-1]) / rng if rng > 1e-12 else 0.5
    state = None
    if _f(up.iloc[-1]) is not None and _f(low.iloc[-1]) is not None:
        if price > up.iloc[-1]:
            state = "突破上轨"
        elif price < low.iloc[-1]:
            state = "跌破下轨"
        else:
            state = "轨道内"
    out.update({"upper": _f(up.iloc[-1]), "mid": _f(mid.iloc[-1]),
                "lower": _f(low.iloc[-1]), "band_pos": _f(band_pos), "state": state})
    return out


def support_resistance(high: pd.Series, low: pd.Series, n: int = 60) -> dict:
    out = dict(_DEFAULTS["support_resistance"])
    if len(high) < 2:
        return out
    h_win = high.iloc[-n:]
    l_win = low.iloc[-n:]
    support = _f(l_win.min())
    resistance = _f(h_win.max())
    price = high.iloc[-1]
    pos = None
    if support is not None and resistance is not None and (resistance - support) > 1e-12:
        pos = _f((price - support) / (resistance - support))
    out.update({"support": support, "resistance": resistance, "pos": pos})
    return out


def volume_price_pattern(close: pd.Series, volume: pd.Series, high: pd.Series) -> dict:
    out = dict(_DEFAULTS["pattern"])
    if len(close) < 25 or len(volume) < 25:
        return out
    v5 = volume.rolling(5).mean().iloc[-1]
    last_v = volume.iloc[-1]
    prev20_high = high.iloc[-21:-1].max()  # 前 20 根（不含今日）最高
    if _f(v5) is None or v5 <= 0:
        return out
    last_c = close.iloc[-1]
    pattern = None
    if last_v > v5 * 1.5 and last_c > prev20_high:
        pattern = "放量突破"
    elif last_v < v5 * 0.7 and last_c < close.iloc[-2]:
        pattern = "缩量回调"
    out.update({"pattern": pattern, "vol_ratio": _f(last_v / v5)})
    return out


def compute_indicators(df: pd.DataFrame) -> dict:
    """df 列 date/open/close/high/low/volume/amount（升序）→ 各指标 dict。"""
    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    volume = df["volume"].astype(float)
    ind = {
        "ma": ma_signals(close),
        "macd": macd_signals(close),
        "rsi": rsi_signals(close),
        "kdj": kdj_signals(high, low, close),
        "boll": boll_signals(close),
        "support_resistance": support_resistance(high, low),
        "pattern": volume_price_pattern(close, volume, high),
    }
    return ind


def summarize(ind: dict) -> list[str]:
    """把指标 dict 压成人类可读的信号行（供 tech_signal 渲染/LLM 上下文）。"""
    lines = []
    ma = ind.get("ma") or {}
    if ma.get("trend"):
        lines.append(f"MA {ma['trend']}（5/10/20/60: {ma.get('ma5')}/{ma.get('ma10')}/{ma.get('ma20')}/{ma.get('ma60')}）")
    macd = ind.get("macd") or {}
    if macd.get("cross"):
        lines.append(f"MACD {macd['cross']}（DIF {macd.get('dif')} / DEA {macd.get('dea')}）")
    rsi = ind.get("rsi") or {}
    if rsi.get("state") and rsi.get("state") != "正常":
        lines.append(f"RSI {rsi['state']}（{rsi.get('rsi14')}）")
    kdj = ind.get("kdj") or {}
    if kdj.get("cross"):
        lines.append(f"KDJ {kdj['cross']}（K {kdj.get('k')} / D {kdj.get('d')} / J {kdj.get('j')}）")
    boll = ind.get("boll") or {}
    if boll.get("state") and boll.get("state") != "轨道内":
        lines.append(f"布林 {boll['state']}（上轨 {boll.get('upper')} / 下轨 {boll.get('lower')}）")
    sr = ind.get("support_resistance") or {}
    if sr.get("support") is not None:
        lines.append(f"支撑 {sr.get('support')} / 压力 {sr.get('resistance')}（区间位置 {sr.get('pos')}）")
    pat = ind.get("pattern") or {}
    if pat.get("pattern"):
        lines.append(f"量价 {pat['pattern']}（量比 {pat.get('vol_ratio')}）")
    return lines
