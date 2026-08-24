# -*- coding: utf-8 -*-
"""事件→投资假设→回测验证→策略候选池（架构图 E→G→H 的落点）。

- 事件源：market-watch `GET /news/events`（HTTP，TTL 缓存）。
- 假设生成：LLM（chat_json）把事件转成可回测的技术规则策略；失败规则降级。
- 策略 DSL：`{kind: ma_cross|rsi_reversal|momentum, params, symbols, direction, ...}`，
  kind 都是只做多的规则信号（利空事件强制 rsi_reversal 超跌反弹，系统无做空）。
- 回测：baostock 前复权日线 → 内联轻量指标（ma/rsi，纯 pandas，不 import tradingagents）
  → 全序列先算信号（因果、无 look-ahead）→ 按行数切样本内(70%)/样本外(30%) →
  统一「bar t 信号 → bar t+1 开盘价成交」状态机逐笔成交 → compute_summary 聚合副口径
  + 合成组合净值曲线自算日频回撤/Sharpe 主口径 → 过阈值进 active，否则 rejected。
"""

import hashlib
import logging
import math
import re
import threading
import time
from datetime import date, timedelta
from typing import Callable

import requests

from .config import settings
from .store import JsonStore

logger = logging.getLogger("adapter.strategies")

# 支持的策略 kind
KINDS = ("ma_cross", "rsi_reversal", "momentum")
# A 股可交易前缀：0=深主板/中小、3=创业板、6=沪主板/科创板；4/8=北交所排除，2/9=B 股排除
_ALLOWED_PREFIXES = ("0", "3", "6")
# 利空只允许超跌反弹（系统做多）
_LONLY = {"rsi_reversal": "超跌反弹"}

_DEFAULT_PARAMS = {
    "ma_cross": {"fast": 5, "slow": 20},
    "rsi_reversal": {"n": 14, "oversold": 30, "overbought": 70},
    "momentum": {"n": 10},
}

_EVENTS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_EVENTS_CACHE_LOCK = threading.Lock()
_EVENTS_REFRESH_LOCK = threading.Lock()


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _str2md5(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()[:10]


# ---- 事件源 -------------------------------------------------------------


def _expand_events(events: list[dict], cached_impact: bool) -> list[dict]:
    """风险读取只复用影响图谱缓存，其他调用保持完整扩展语义。"""
    try:
        from . import impact

        if cached_impact:
            return impact.expand_events_cached(events)
        return impact.expand_events(events)
    except Exception:  # noqa: BLE001 — 扩展失败保持原样
        return events


def _event_status(**fields) -> dict:
    return {
        "degraded": False,
        "stale": False,
        "source": "upstream",
        "reason": None,
        **fields,
    }


def fetch_events_with_status(
    limit: int = 20,
    timeout: float | None = None,
    *,
    cached_impact: bool = False,
) -> tuple[list[dict], dict]:
    """按 deadline 拉 market-watch；超时使用 stale，且并发刷新 single-flight。"""
    deadline = max(0.05, float(timeout if timeout is not None else 4.0))
    now = time.time()
    with _EVENTS_CACHE_LOCK:
        hit = _EVENTS_CACHE.get("events")
    age = (now - hit[0]) if hit else None
    if hit and age is not None and age < max(0.0, settings.event_cache_ttl):
        return _expand_events(hit[1], cached_impact), _event_status(
            source="fresh-cache",
            age_seconds=round(age, 3),
            deadline_seconds=deadline,
        )

    stale = None
    if hit and age is not None and age < max(0.0, settings.event_stale_ttl):
        stale = hit[1]
    if not _EVENTS_REFRESH_LOCK.acquire(blocking=False):
        events = stale or []
        return _expand_events(events, cached_impact), _event_status(
            degraded=True,
            stale=stale is not None,
            source="stale-cache" if stale is not None else "fail-open",
            reason="market-watch refresh already in flight",
            age_seconds=round(age, 3) if age is not None else None,
            deadline_seconds=deadline,
        )

    try:
        try:
            response = requests.get(
                settings.mw_url.rstrip("/") + f"/news/events?limit={limit}",
                timeout=deadline,
                proxies={},
            )
            response.raise_for_status()
            payload = response.json() or {}
            events = payload.get("items") or []
            if not isinstance(events, list):
                raise ValueError("market-watch items 必须是列表")
        except Exception as exc:  # noqa: BLE001 — stale/fail-open 保住读取路径
            logger.warning("拉取 market-watch 事件失败（使用 stale/fail-open）: %s", exc)
            events = stale or []
            reason = f"{type(exc).__name__}: {str(exc)[:160]}"
            return _expand_events(events, cached_impact), _event_status(
                degraded=True,
                stale=stale is not None,
                source="stale-cache" if stale is not None else "fail-open",
                reason=reason,
                age_seconds=round(age, 3) if age is not None else None,
                deadline_seconds=deadline,
            )
        refreshed_at = time.time()
        with _EVENTS_CACHE_LOCK:
            _EVENTS_CACHE["events"] = (refreshed_at, events)
        return _expand_events(events, cached_impact), _event_status(
            source="upstream",
            age_seconds=0.0,
            deadline_seconds=deadline,
        )
    finally:
        _EVENTS_REFRESH_LOCK.release()


def fetch_events(limit: int = 20, timeout: float = 4.0) -> list[dict]:
    """兼容调用：返回事件列表；失败时优先返回 stale，再 fail-open 为空列表。"""
    events, _status = fetch_events_with_status(limit=limit, timeout=timeout)
    return events


def _reset_event_cache_for_tests() -> None:
    """测试隔离：生产调用不使用。"""
    with _EVENTS_CACHE_LOCK:
        _EVENTS_CACHE.clear()


# ---- 轻量指标（纯 pandas，不 import tradingagents）----


def _ma(close, n: int):
    """n 日均线；min_periods=n 保证前 n 根为 NaN（warmup 期不误触发）。"""
    return close.rolling(n, min_periods=n).mean()


def _rsi(close, n: int = 14):
    """Wilder RSI。avg_loss==0（一路涨）填 100，避免除零产生 NaN 误触发买入。"""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, float("nan"))
    rsi = 100.0 - 100.0 / (1.0 + rs)
    return rsi.where(avg_loss.notna() & avg_loss.ne(0), 100.0)


def _make_df(hist: list[dict]):
    """[{"date","open","high","low","close"}] → 按 date 升序 DataFrame，剔除 close NaN 行。"""
    import pandas as pd

    df = pd.DataFrame(hist)
    df = df.dropna(subset=["close"])
    df = df.sort_values("date").reset_index(drop=True)
    return df


# ---- 信号生成 -----------------------------------------------------------


def signal_series(df, kind: str, params: dict):
    """返回与 df 等长的 0/1 序列（1=持多）。只用 ≤t 数据（因果）。
    warmup 期（指标 NaN）一律 0，不产生伪穿越。"""
    import pandas as pd

    if kind == "ma_cross":
        fast, slow = int(params.get("fast", 5)), int(params.get("slow", 20))
        if fast >= slow:
            raise ValueError(f"ma_cross fast({fast}) 必须小于 slow({slow})")
        ma_f = _ma(df["close"], fast)
        ma_s = _ma(df["close"], slow)
        sig = (ma_f > ma_s).astype(int).where(ma_f.notna() & ma_s.notna(), 0)
        return sig.fillna(0).astype(int)

    if kind == "rsi_reversal":
        n = int(params.get("n", 14))
        lo, hi = float(params.get("oversold", 30)), float(params.get("overbought", 70))
        rsi = _rsi(df["close"], n)
        raw = pd.Series(0, index=df.index, dtype=float)
        raw[rsi < lo] = 1.0
        raw[rsi > hi] = 0.0
        # 区间内保持前值；首段（指标 warmup）为 0
        sig = raw.where(rsi.notna(), 0.0).ffill().fillna(0.0)
        return sig.astype(int)

    # momentum
    n = int(params.get("n", 10))
    return (df["close"] > df["close"].shift(n)).fillna(0).astype(int)


# ---- 成交模拟（统一「t 信号 → t+1 开盘成交」，回测/影子同约定）----


def _px(df, i: int) -> float:
    """第 i 根 bar 成交价：开盘优先，开盘 NaN（停牌）用收盘兜底。"""
    op = df["open"].iloc[i]
    if pd_notna(op):
        return float(op)
    return float(df["close"].iloc[i])


def pd_notna(v) -> bool:
    import math

    if v is None:
        return False
    try:
        return not math.isnan(float(v))
    except (TypeError, ValueError):
        return True


def simulate_trades(df, sig, lot_size: int = 100) -> list[dict]:
    """单标的逐 bar 状态机 → 已平仓成交列表。序列末尾仍持仓→最后收盘强平。
    返回每条 {ticker, entry_date, entry_price, exit_date, exit_price, bars_held,
    direction, ret_pct, exit_reason}。"""
    n = len(df)
    trades: list[dict] = []
    open_trade: dict | None = None
    prev = 0  # 起始视为空仓（无历史信号）
    for t in range(n):
        cur = int(sig.iloc[t]) if pd_notna(sig.iloc[t]) else 0
        if open_trade is None and prev == 0 and cur == 1:
            # 意图转多 → 下一 bar 开盘买入
            if t + 1 < n:
                open_trade = {
                    "ticker": "", "entry_date": df["date"].iloc[t + 1],
                    "entry_price": _px(df, t + 1),
                }
        elif open_trade is not None and prev == 1 and cur == 0:
            # 意图转空 → 下一 bar 开盘卖出
            if t + 1 < n:
                trades.append(_close_trade(open_trade, df, t + 1, "signal"))
                open_trade = None
        prev = cur
    # 尾仓：最后收盘价强平（计划约定；无 t+1 可用，退化为收盘兑现）
    if open_trade is not None:
        trades.append(_close_trade(open_trade, df, n - 1, "series_end", use_close=True))
    return trades


def _close_trade(open_trade: dict, df, i: int, reason: str, use_close: bool = False) -> dict:
    entry = float(open_trade["entry_price"])
    exit_px = float(df["close"].iloc[i]) if use_close else _px(df, i)
    ret = (exit_px - entry) / entry * 100.0 if entry else 0.0
    return {
        "ticker": open_trade.get("ticker", ""),
        "entry_date": open_trade["entry_date"],
        "entry_price": entry,
        "exit_date": df["date"].iloc[i],
        "exit_price": exit_px,
        "bars_held": max(i - _date_index_open(df, open_trade["entry_date"]), 1),
        "direction": "long",
        "ret_pct": round(ret, 4),
        "exit_reason": reason,
    }


def _date_index_open(df, entry_date: str) -> int:
    """open_trade 记录的是 t+1 的成交行；回退到开仓意图所在行以算持仓天数。"""
    idx = df.index[df["date"] == entry_date]
    if len(idx):
        return int(idx[0]) - 1
    return 0


# ---- compute_summary 复用包装 ----


def trades_to_decision_rows(
    trades: list[dict], ticker: str, direction: str, neutral_band_pct: float = 2.0
) -> list[dict]:
    """把 simulate_trades 输出包装成 backtest_engine.compute_summary 认识的条目。
    字段语义：eval_status="evaluated"（否则算 insufficient）；hit_sl/hit_tp=None
    （规则回测不设止损止盈，正确排除触发率）；direction 只做方向映射，系统 long-only。"""
    from .backtest_engine import classify_outcome

    rows = []
    for tr in trades:
        ret = float(tr["ret_pct"])
        outcome, dir_correct = classify_outcome(ret, "up", neutral_band_pct)
        rows.append({
            "eval_status": "evaluated",
            "key": f"{ticker}_{tr['entry_date']}",
            "ticker": ticker,
            "trade_date": tr["entry_date"],
            "action": "买入",
            "direction_expected": "up",
            "position_recommendation": "long",
            "outcome": outcome,
            "direction_correct": dir_correct,
            "simulated_return_pct": ret,
            "stock_return_pct": ret,
            "hit_sl": None, "hit_tp": None,
            "first_hit": "not_applicable", "first_hit_days": None,
            "exit_reason": tr["exit_reason"],
            "exit_price": tr["exit_price"],
            "end_bar_date": tr["exit_date"],
            "n_forward_bars": tr["bars_held"],
        })
    return rows


# ---- 合成组合净值曲线（主口径：回撤/Sharpe 用日频净值自算）----


def _symbol_equity(df, sig, capital: float) -> list[float]:
    """单标的独立子账户：意图转多→t+1 开盘全仓买入，转空→t+1 开盘清仓。
    返回逐 bar 权益（现金+市值）。"""
    n = len(df)
    cash = float(capital)
    qty = 0.0
    equity = []
    for t in range(n):
        if t > 0:
            prev_intent = int(sig.iloc[t - 1]) if pd_notna(sig.iloc[t - 1]) else 0
            if prev_intent == 1 and qty == 0:
                px = _px(df, t)
                if px > 0:
                    qty = cash / px
                    cash = 0.0
            elif prev_intent == 0 and qty > 0:
                px = _px(df, t)
                cash = qty * px
                qty = 0.0
        close = float(df["close"].iloc[t])
        equity.append(cash + qty * close)
    return equity


def portfolio_equity_curve(per_symbol: dict, capital_per_symbol: float) -> dict:
    """per_symbol: {ticker: (df, sig)}。各标的子账户等权，按公共日期合成组合净值。"""
    import pandas as pd

    if not per_symbol:
        return {"date": [], "nav": [], "daily_return": []}
    eq_map: dict[str, list[float]] = {}
    dates: list[str] | None = None
    for sym, (df, sig) in per_symbol.items():
        eq_map[sym] = _symbol_equity(df, sig, capital_per_symbol)
        if dates is None:
            dates = list(df["date"])
    n = len(dates or [])
    if not n:
        return {"date": [], "nav": [], "daily_return": []}
    nav = []
    for i in range(n):
        total = sum(
            eq[i] if i < len(eq) else eq[-1]
            for eq in eq_map.values()
        )
        nav.append(total / (len(eq_map) * capital_per_symbol))
    rets = [0.0]
    for i in range(1, n):
        prev = nav[i - 1]
        rets.append((nav[i] - prev) / prev * 100.0 if prev else 0.0)
    return {"date": list(dates), "nav": [round(v, 6) for v in nav],
            "daily_return": [round(v, 4) for v in rets]}


def curve_stats(curve: dict) -> dict:
    """组合净值 → 累计收益 / 日频最大回撤 / 年化 Sharpe。"""
    nav = curve.get("nav") or []
    if len(nav) < 2:
        return {"portfolio_return_pct": None, "portfolio_max_drawdown_pct": None,
                "portfolio_sharpe": None}
    ret_pct = (nav[-1] / nav[0] - 1) * 100.0 if nav[0] else None
    peak, max_dd = nav[0], 0.0
    for v in nav:
        if v > peak:
            peak = v
        dd = (v - peak) / peak if peak else 0.0
        max_dd = min(max_dd, dd)
    daily = curve.get("daily_return") or []
    mean = sum(daily) / len(daily) if daily else 0.0
    var = sum((d - mean) ** 2 for d in daily) / len(daily) if daily else 0.0
    std = math.sqrt(var)
    sharpe = (mean / std * math.sqrt(252)) if std > 0 else None
    return {
        "portfolio_return_pct": round(ret_pct, 4) if ret_pct is not None else None,
        "portfolio_max_drawdown_pct": round(max_dd * 100, 4),
        "portfolio_sharpe": round(sharpe, 4) if sharpe is not None else None,
    }


# ---- 样本内/外切分 ----


def split_in_out(df, sig, oos_frac: float = 0.3):
    """先在全序列算 signal（保证 OOS 起点有指标 warmup、不偷看未来），再按行数 70/30 切。
    OOS 独立跑状态机，不继承样本内持仓。"""
    n = len(df)
    split = int(n * (1 - oos_frac))
    split = max(1, min(n - 1, split))
    return (
        df.iloc[:split].reset_index(drop=True), sig.iloc[:split].reset_index(drop=True),
        df.iloc[split:].reset_index(drop=True), sig.iloc[split:].reset_index(drop=True),
    )


# ---- 假设生成（LLM + 规则降级）----


_HYPOTHESIS_SYSTEM = (
    "你是A股事件→投资假设助手。把给定每条结构化事件转成一个可回测的技术策略假设。规则：\n"
    "1) 只有 direction∈{利好,利空} 且至少一个可交易 A 股 6 位代码（排除北交所 4/8 开头）的事件才生成；\n"
    "2) kind 只能取 ma_cross/rsi_reversal/momentum：利好→ma_cross（趋势跟随）或 momentum（动量），"
    "二选一给最贴合事件语义的；利空→只能 rsi_reversal（超跌反弹，因为系统只做多）；\n"
    "3) params 按 kind 给合理默认（ma_cross:{fast:5,slow:20}，rsi_reversal:{n:14,oversold:30,"
    "overbought:70}，momentum:{n:10}），只可微调，不得越界；\n"
    "4) symbols 只填事件明确涉及、有 6 位代码的 A 股；\n"
    "5) rationale 一句话解释假设与事件的因果。\n"
    '只输出 JSON（不要其它文字）：{"hypotheses":[{"event_idx":整数,"symbols":["600519"],'
    '"direction":"利好|利空","kind":"ma_cross","params":{"fast":5,"slow":20},'
    '"rationale":"...","holding_window_days":20}]}'
)


def generate_hypotheses(events: list[dict]) -> list[dict]:
    """事件 → 假设列表。每条 {event_idx, symbols, direction, kind, params, rationale, holding_window_days}。
    LLM 失败/不可用 → 规则降级（利好 momentum / 利空 rsi_reversal）。"""
    usable = [
        e for e in events
        if e.get("direction") in ("利好", "利空")
        and (any(t.get("code") for t in (e.get("tickers") or []))
             or (e.get("impact_codes") or []))
    ]
    if not usable:
        return []

    if settings.llm_available():
        try:
            block = "\n".join(
                f"[{i}] direction={e.get('direction')} type={e.get('type')} "
                f"tickers={[t.get('name') + ':' + t.get('code') for t in (e.get('tickers') or [])]} "
                f"industries={(e.get('industries') or [])[:3]} "
                f"summary={(e.get('summary') or '')[:80]}"
                for i, e in enumerate(usable)
            )
            from . import llm
            data = llm.chat_json(_HYPOTHESIS_SYSTEM, block, max_tokens=2500)
            hyps = []
            for h in (data or {}).get("hypotheses") or []:
                try:
                    ev_idx = int(h.get("event_idx", -1))
                except (TypeError, ValueError):
                    ev_idx = -1
                if ev_idx < 0 or ev_idx >= len(usable):
                    continue
                hyps.append({**h, "event_idx": ev_idx})
            if hyps:
                return hyps
        except Exception as exc:  # noqa: BLE001 — LLM 失败规则降级
            logger.warning("假设 LLM 失败，规则降级: %s", exc)

    # 规则降级
    hyps = []
    for i, e in enumerate(usable):
        codes = [t.get("code") for t in (e.get("tickers") or []) if t.get("code")]
        for c in (e.get("impact_codes") or []):  # C 间接波及标的也进候选
            if c not in codes:
                codes.append(c)
        dirn = e.get("direction")
        if dirn == "利好":
            hyps.append({"event_idx": i, "symbols": codes, "direction": dirn,
                         "kind": "momentum", "params": {"n": 10},
                         "rationale": e.get("summary") or "", "holding_window_days": 20})
        else:
            hyps.append({"event_idx": i, "symbols": codes, "direction": dirn,
                         "kind": "rsi_reversal", "params": {"n": 14, "oversold": 30, "overbought": 70},
                         "rationale": e.get("summary") or "", "holding_window_days": 20})
    return hyps


# ---- 校验与候选入库 ----


def _normalize_symbol(code) -> str | None:
    """裸代码 → 6 位可交易 A 股代码（剥 sh./sz. 前缀，剔北交所 4/8、B 股 2/9）。"""
    m = re.search(r"(\d{6})", str(code))
    if not m:
        return None
    s = m.group(1)
    if not s.startswith(_ALLOWED_PREFIXES):
        return None
    return s


def _clamp_params(kind: str, params: dict) -> dict:
    default = dict(_DEFAULT_PARAMS.get(kind, {}))
    if kind == "ma_cross":
        fast = int(params.get("fast", default["fast"]))
        slow = int(params.get("slow", default["slow"]))
        slow = max(fast + 1, min(120, slow))
        fast = max(2, min(slow - 1, fast))
        return {"fast": fast, "slow": slow}
    if kind == "rsi_reversal":
        n = max(5, min(60, int(params.get("n", default["n"]))))
        lo = max(5, min(45, float(params.get("oversold", default["oversold"]))))
        hi = max(55, min(95, float(params.get("overbought", default["overbought"]))))
        if lo >= hi:
            lo, hi = default["oversold"], default["overbought"]
        return {"n": n, "oversold": lo, "overbought": hi}
    return {"n": max(2, min(60, int(params.get("n", default["n"]))))}


def create_candidates(events: list[dict], hypotheses: list[dict]) -> list[str]:
    """假设 → 校验 → 落 strategies 集合（status=candidate）。返回新候选 id 列表。"""
    if not hypotheses:
        return []
    store = JsonStore()
    ids = []
    for h in hypotheses:
        try:
            ev_idx = int(h.get("event_idx", -1))
        except (TypeError, ValueError):
            continue
        if ev_idx < 0 or ev_idx >= len(events):
            continue
        ev = events[ev_idx]
        symbols = [c for s in (h.get("symbols") or []) if (c := _normalize_symbol(s))]
        kind = h.get("kind")
        direction = h.get("direction")
        if kind not in KINDS or direction not in ("利好", "利空") or not symbols:
            continue
        if direction == "利空" and kind != "rsi_reversal":
            kind = "rsi_reversal"  # 系统只做多
        params = _clamp_params(kind, h.get("params") or {})
        sid = "strat-" + _str2md5(ev.get("id", "") + kind + "".join(sorted(symbols)))
        if store.get("strategies", sid):
            continue  # 去重
        name = f"{direction}·{kind}·{symbols[0]}{('+' + str(len(symbols) - 1)) if len(symbols) > 1 else ''}"
        store.set("strategies", sid, {
            "id": sid, "name": name, "kind": kind, "params": params,
            "symbols": symbols, "direction": direction,
            "hypothesis": h.get("rationale") or ev.get("summary") or "",
            "source_event_id": ev.get("id", ""),
            "source_event_summary": ev.get("summary") or "",
            "holding_window_days": int(h.get("holding_window_days", 20)),
            "status": "candidate",
            "backtest": None,
            "created_at": _now(), "updated_at": _now(),
        })
        ids.append(sid)
    return ids


# ---- 回测 runner（注册进 TaskManager）----


class StrategyBacktestRunner:
    """规则策略历史+样本外回测。纯逻辑（baostock+pandas），无 LLM。"""

    name = "strategy-backtest"

    def __init__(self, store: JsonStore | None = None):
        self.store = store or JsonStore()
        self._hist_cache: dict[str, list] = {}

    def _fetch_hist(self, sym: str, start: str, end: str) -> list:
        """带实例缓存拉 OHLC；北交所/失败抛异常由调用方标 symbol_errors。"""
        if sym in self._hist_cache:
            return self._hist_cache[sym]
        from .holdings_runner import _a_share_code, _bs_hist

        code = _a_share_code(sym)
        hist = _bs_hist(code, start, end, fields="date,open,high,low,close")
        self._hist_cache[sym] = hist
        return hist

    def run(self, params: dict, progress_cb: Callable) -> dict:
        sid = params.get("strategy_id", "")
        strategy = self.store.get("strategies", sid)
        if not strategy:
            raise ValueError(f"策略不存在: {sid}")
        symbols = strategy.get("symbols") or []
        kind = strategy.get("kind")
        p = strategy.get("params") or {}
        lookback_years = float(params.get("lookback_years", 2.0))
        oos_frac = float(params.get("oos_frac", 0.3))
        capital = float(params.get("initial_capital") or settings.shadow_initial_capital)
        min_oos = int(params.get("min_oos_trades", 4))

        end = date.today().isoformat()
        start = (date.today() - timedelta(days=int(lookback_years * 366))).isoformat()

        progress_cb(f"📐 策略 {kind} {symbols} · {lookback_years}年 · 样本外{oos_frac:.0%}")

        all_in: list[dict] = []
        all_out: list[dict] = []
        symbol_errors: dict[str, str] = {}
        per_in: dict[str, tuple] = {}
        per_out: dict[str, tuple] = {}
        per_symbol: dict[str, dict] = {}

        for i, sym in enumerate(symbols):
            progress_cb(f"🧮 回测 {i + 1}/{len(symbols)} {sym}…")
            try:
                hist = self._fetch_hist(sym, start, end)
                if not hist:
                    symbol_errors[sym] = "无历史行情（baostock 空）"
                    continue
                df = _make_df(hist)
                if len(df) < 40:
                    symbol_errors[sym] = f"历史过短({len(df)}根，需≥40)"
                    continue
                sig = signal_series(df, kind, p)
                df_in, sig_in, df_out, sig_out = split_in_out(df, sig, oos_frac)
                trades_in = simulate_trades(df_in, sig_in)
                trades_out = simulate_trades(df_out, sig_out)
                all_in += trades_to_decision_rows(trades_in, sym, strategy.get("direction"))
                all_out += trades_to_decision_rows(trades_out, sym, strategy.get("direction"))
                per_in[sym] = (df_in, sig_in)
                per_out[sym] = (df_out, sig_out)
                per_symbol[sym] = {"trades_in": len(trades_in), "trades_out": len(trades_out),
                                   "last_in_ret": round(trades_in[-1]["ret_pct"], 2) if trades_in else None,
                                   "last_out_ret": round(trades_out[-1]["ret_pct"], 2) if trades_out else None}
            except Exception as exc:  # noqa: BLE001 — 单 symbol 失败不整任务 failed
                symbol_errors[sym] = f"{type(exc).__name__}: {exc}"
                per_symbol[sym] = {"error": symbol_errors[sym]}

        n = max(len(symbols), 1)
        capital_per = capital / n

        def _agg(rows: list[dict], per: dict, label: str) -> dict:
            from .backtest_engine import compute_summary

            summary = compute_summary(
                rows, engine_version="strategy-v1", eval_window_days=20,
                n_decisions_total=len(rows), n_candidates_evaluated=len(rows),
            )
            summary["portfolio"] = curve_stats(portfolio_equity_curve(per, capital_per))
            return summary

        progress_cb("📈 聚合样本内/样本外指标 + 组合净值…")
        in_summary = _agg(all_in, per_in, "in")
        out_summary = _agg(all_out, per_out, "out")

        # 阈值：OOS 成交不足 → 保持 candidate；够且胜率/均收益达标 → active；否则 rejected
        oos_n = int(out_summary.get("n_evaluated") or 0)
        oos_wr = out_summary.get("win_rate_pct")
        oos_avg = out_summary.get("avg_simulated_return_pct")
        if oos_n < min_oos:
            status, passed, reason = "candidate", False, f"样本外成交不足({oos_n}<{min_oos})"
        elif oos_wr is not None and oos_avg is not None and oos_wr >= 50.0 and oos_avg > 0:
            status, passed, reason = "active", True, "样本外胜率/均收益达标"
        else:
            status, passed, reason = "rejected", False, f"样本外未达标(wr={oos_wr}, avg={oos_avg})"

        # 手动退役过的策略，回测不擅自改回
        if (strategy.get("status") == "retired" and status != "retired"):
            status = strategy.get("status")

        backtest = {
            "in_sample": in_summary,
            "out_of_sample": out_summary,
            "thresholds_pass": passed,
            "reason": reason,
            "ran_at": _now(),
            "per_symbol": per_symbol,
            "symbol_errors": symbol_errors,
        }
        self.store.update("strategies", sid, status=status, backtest=backtest, updated_at=_now())
        progress_cb(f"🏁 状态 → {status}（{reason}）")
        return {"strategy_id": sid, "status": status, "backtest": backtest,
                "symbol_errors": symbol_errors}
