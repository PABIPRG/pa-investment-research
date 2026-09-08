# -*- coding: utf-8 -*-
"""自进化 v2 · 最小市场 regime 检测器（P0.5）。

目标：给进化/影子一个"当前市场处于什么状态"的开关基因输入，把"环境不配合"与
"能力不行"分开。本期只做**分类器 + 按日落库**；regime_gate 门控默认不生效
（REGIME_GATE_ENABLED=false），真正的启用留到 P5。

设计（§5）：不引重型库，规则 + 阈值，纯函数便于单测。输入是主基准（默认沪深300）
的日 close 序列，输出每交易日一个 regime 标签：
  - high_vol     已实现波动(20d 年化) 相对自身近期分布异常放大（priority 最高）
  - trend_up     |价/MA_slow-1|≥阈值 且 快均线向上（指数站上慢线且抬升）
  - trend_down   同上但向下
  - oscillation  其余（价在慢线附近缠绕）
  - unknown      历史不足，无法判定

持久化（JsonStore，collection 名 alnum+下划线）：
  - `market_index`  key=基准代码 → {code,name,dates:{date:close}}    （append 每日）
  - `market_regime` key=日期       → {date,index_code,regime,underlying,confidence_pct,
                                     vol_annualized_pct,dist_slow_pct,samples,as_of}
  - `market_regime` 另维护指针 key `_latest` = 最近一个已判定日期。
"""
# 注意：store.py 集合名只允许 [A-Za-z0-9_]，"market/regime" 写作 `market_regime`。

from __future__ import annotations

import time
from collections import deque
from typing import Iterable, Optional, Sequence

from .store import JsonStore

_INDEX_COLLECTION = "market_index"
_REGIME_COLLECTION = "market_regime"
_LATEST_KEY = "_latest"


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _std(xs: Sequence[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    var = sum((x - m) ** 2 for x in xs) / len(xs)
    return var ** 0.5


def _rolling_std(xs: Sequence[float], window: int) -> list[float]:
    out: list[float] = []
    dq: deque = deque()
    s = 0.0
    s2 = 0.0
    for v in xs:
        dq.append(v)
        s += v
        s2 += v * v
        if len(dq) > window:
            old = dq.popleft()
            s -= old
            s2 -= old * old
        if len(dq) == window:
            m = s / window
            var = s2 / window - m * m
            out.append((var if var > 0 else 0.0) ** 0.5)
    return out


def _daily_returns(closes: Sequence[float]) -> list[float]:
    return [closes[i] / closes[i - 1] - 1.0 for i in range(1, len(closes))]


def classify_regime(
    closes: Sequence[float],
    *,
    ma_fast: int = 20,
    ma_slow: int = 60,
    vol_window: int = 20,
    high_vol_ratio: float = 1.5,
    trend_dist_pct: float = 0.02,
    slope_ref_days: int = 5,
) -> dict:
    """从升序日 close 序列判 regime。纯函数。

    需足够历史（≥ max(ma_slow, 2*ma_fast) + slope_ref_days + 1），否则返回 unknown。
    返回字典字段见函数内注释，供落库与单测断言。
    """
    closes = [float(x) for x in closes]
    n = len(closes)
    base = {
        "regime": "unknown",
        "underlying": None,
        "confidence_pct": None,
        "vol_annualized_pct": None,
        "dist_slow_pct": None,
        "ma_fast_slope_pct": None,
        "needs_more_data": True,
        "samples": n,
    }
    need = max(ma_slow, ma_fast * 2) + slope_ref_days + 1
    if n < need:
        return base

    # 慢/快均线（最近 + 5 交易日前，做斜率参考）
    ma_slow_now = sum(closes[-ma_slow:]) / ma_slow
    ma_slow_prev = sum(closes[-ma_slow - slope_ref_days: -slope_ref_days]) / ma_slow
    ma_fast_now = sum(closes[-ma_fast:]) / ma_fast
    ma_fast_prev = sum(closes[-ma_fast - slope_ref_days: -slope_ref_days]) / ma_fast
    close_now = closes[-1]
    dist_slow = (close_now / ma_slow_now - 1.0) if ma_slow_now else 0.0
    slope_fast = (ma_fast_now / ma_fast_prev - 1.0) if ma_fast_prev else 0.0

    # 已实现波动（20d 年化）与其近期分布
    rets = _daily_returns(closes)
    vol_now = _std(rets[-vol_window:]) * (252 ** 0.5) if len(rets) >= vol_window else None
    vol_base = None
    if len(rets) >= vol_window:
        # 滚动 vol_window 波动率（最多取近 200 个交易日）取中位数作基线
        hist = rets[-200:]
        vol_series = [
            _std(hist[i:i + vol_window]) * (252 ** 0.5)
            for i in range(0, len(hist) - vol_window + 1)
        ]
        if vol_series:
            vol_series.sort()
            vol_base = vol_series[len(vol_series) // 2]
    high_vol = (
        vol_now is not None
        and vol_base is not None
        and vol_base > 0
        and vol_now > vol_base * high_vol_ratio
    )

    trend_up = (not high_vol) and dist_slow >= trend_dist_pct and slope_fast > 0
    trend_down = (not high_vol) and dist_slow <= -trend_dist_pct and slope_fast < 0
    underlying = None
    if high_vol:
        regime = "high_vol"
        underlying = "trend_up" if dist_slow >= trend_dist_pct and slope_fast > 0 else (
            "trend_down" if dist_slow <= -trend_dist_pct and slope_fast < 0 else "oscillation"
        )
    elif trend_up:
        regime = "trend_up"
        underlying = None
    elif trend_down:
        regime = "trend_down"
        underlying = None
    else:
        regime = "oscillation"
        underlying = None
    # 置信度启发式：波动异常 & 偏离慢线越远 & 斜率越陡 → 越确定
    confidence = 0.0
    if not high_vol:
        magnitude = min(1.0, abs(dist_slow) / (trend_dist_pct * 3 or 1e-9))
        confidence = max(0.0, min(1.0, magnitude))
    else:
        excess = (vol_now / vol_base - 1.0) if vol_now and vol_base else 0.0
        confidence = max(0.0, min(1.0, excess / (high_vol_ratio - 1.0 or 1e-9)))

    return {
        "regime": regime,
        "underlying": underlying,
        "confidence_pct": round(confidence * 100, 1),
        "vol_annualized_pct": round(vol_now * 100, 2) if vol_now is not None else None,
        "dist_slow_pct": round(dist_slow * 100, 3),
        "ma_fast_slope_pct": round(slope_fast * 100, 3),
        "needs_more_data": False,
        "samples": n,
    }


# ---- 持久化 hooks ---------------------------------------------------------


def record_index_close(
    store: JsonStore,
    code: str,
    trade_date: str,
    close: float,
    name: str | None = None,
) -> None:
    """把某基准某日收盘 append 进 market_index（幂等覆盖同日）。"""
    if not code or not trade_date:
        return
    close = float(close)
    if close <= 0:
        return

    def transform(current):
        doc = dict(current or {})
        dates = dict((doc.get("dates") or {}))
        dates[trade_date] = close
        doc["code"] = code
        doc["name"] = name or doc.get("name") or code
        doc["updated_at"] = _now()
        doc["dates"] = dates
        return doc

    store.mutate(_INDEX_COLLECTION, code, transform)


def _sorted_dates(dates: dict) -> list[str]:
    return sorted(d for d in dates if isinstance(d, str))


def classify_and_store(
    store: JsonStore,
    as_of: str | None = None,
    *,
    code: str | None = None,
    ma_fast: int | None = None,
    ma_slow: int | None = None,
    vol_window: int | None = None,
    high_vol_ratio: float | None = None,
    trend_dist_pct: float | None = None,
) -> dict:
    """读 market_index 某基准最近 close 序列，判 regime 并落 market_regime（按日 + _latest 指针）。

    返回落库的判定 dict（无法判定则返回 unknown dict 且不写日记录，仅刷新 _latest 若旧指针为空）。
    """
    from .config import settings

    code = code or settings.regime_index
    doc = store.get(_INDEX_COLLECTION, code) or {}
    dates = dict((doc.get("dates") or {}))
    if not dates:
        return {
            "date": None, "index_code": code, "regime": "unknown",
            "confidence_pct": None, "samples": 0, "needs_more_data": True,
        }
    ordered = _sorted_dates(dates)
    closes = [float(dates[d]) for d in ordered if float(dates[d]) > 0]
    result = classify_regime(
        closes,
        ma_fast=ma_fast if ma_fast is not None else settings.regime_ma_fast,
        ma_slow=ma_slow if ma_slow is not None else settings.regime_ma_slow,
        vol_window=vol_window if vol_window is not None else settings.regime_vol_window,
        high_vol_ratio=high_vol_ratio if high_vol_ratio is not None else settings.regime_high_vol_ratio,
        trend_dist_pct=trend_dist_pct if trend_dist_pct is not None else settings.regime_trend_dist_pct,
    )
    if result.get("needs_more_data"):
        # 历史不足：不写该日判定，避免把 unknown 当有效门控输入
        if store.get(_REGIME_COLLECTION, _LATEST_KEY) is None:
            store.set(_REGIME_COLLECTION, _LATEST_KEY, None)
        return {
            "date": None, "index_code": code, "regime": "unknown",
            "confidence_pct": None, "samples": result.get("samples"),
            "needs_more_data": True,
        }
    as_of = as_of or _now()
    trade_date = ordered[-1]
    record = {
        "date": trade_date,
        "index_code": code,
        "regime": result["regime"],
        "underlying": result.get("underlying"),
        "confidence_pct": result.get("confidence_pct"),
        "vol_annualized_pct": result.get("vol_annualized_pct"),
        "dist_slow_pct": result.get("dist_slow_pct"),
        "ma_fast_slope_pct": result.get("ma_fast_slope_pct"),
        "samples": result.get("samples"),
        "as_of": as_of,
    }
    store.set(_REGIME_COLLECTION, trade_date, record)
    store.set(_REGIME_COLLECTION, _LATEST_KEY, trade_date)
    return record


def latest_regime(
    store: JsonStore,
    as_of_date: str | None = None,
    *,
    code: str | None = None,
) -> dict | None:
    """取最近一个已判定 regime（<= as_of_date 时给当日之前最近档，用于门控）。

    as_of_date 缺省返回全局 _latest；给定时退到 <= 该日的最接近档，避免用未来状态。
    """
    if code is not None:
        # 目前单基准主档即可满足门控；多基准细分留给 P5 需要时扩展
        pass
    if as_of_date is None:
        latest = store.get(_REGIME_COLLECTION, _LATEST_KEY)
        record = store.get(_REGIME_COLLECTION, latest) if isinstance(latest, str) else None
        return record if isinstance(record, dict) else None
    best = None
    for key, rec in (store.all(_REGIME_COLLECTION) or {}).items():
        if not isinstance(rec, dict) or not isinstance(key, str) or key == _LATEST_KEY:
            continue
        if str(key) <= as_of_date and (best is None or str(key) > best[0]):
            best = (str(key), rec)
    return best[1] if best else None


def refresh_and_classify(store: JsonStore, lookback_days: int = 400) -> dict:
    """每日刷新主基准收盘 + 判定 regime 并落库（P0.3/P0.5 接线）。

    拉主基准（settings.regime_index，默认沪深300）近 lookback_days 日收盘 → market_index，
    再 classify_and_store。网络失败抛异常，由调度方按非致命处理。
    """
    from datetime import date, timedelta

    from . import benchmark
    from .config import settings

    code = settings.regime_index
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=lookback_days)).isoformat()
    rows = benchmark.fetch_index_rows(code, start, end)
    benchmark.record_index_rows(store, code, None, rows)
    return classify_and_store(store, code=code)


__all__ = [
    "classify_regime",
    "record_index_close",
    "classify_and_store",
    "latest_regime",
    "refresh_and_classify",
    "_INDEX_COLLECTION",
    "_REGIME_COLLECTION",
]
