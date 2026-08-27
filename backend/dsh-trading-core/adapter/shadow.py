# -*- coding: utf-8 -*-
"""实时影子策略验证（架构图 I 的落点）。

每个 active 策略在影子账户里独立记账：每 symbol 独立子账户（等权），
统一「bar t 信号 → bar t+1 开盘成交」状态机，与策略回测共用信号/成交约定（无 look-ahead）。

关键约定（与 plan 的坑 11/12 一致）：
- 激活不立即建仓：策略首次被影子跟踪那天的信号不进场，从次一 bar 起按状态机自然进出。
  track_from 持久化在 shadows/meta，之后每天都重放 track_from 以来的历史确定当前持仓
  （确定性单一路径，等价于逐日增量，天然幂等）。
- 当日数据滞后：baostock 日线收盘后才出现当日 bar。缺当日 bar 时，重放止于最近 bar，
  只 mark-to-market 不成交当天；次日 bar 出现后按 t-1 意图→t 开盘自然补成交。
- 幂等：shadow_equity/{trade_date} 已存在且非 force → skipped。

数据落点（collection/key）：
  shadows/meta            {sid: {track_from, initial_capital, activated_at}}
  shadows/pos/{sid}:{sym} {qty, entry_price, entry_date, avg_cost, cash, last_price}
  shadows/trades/{sid}    平仓明细列表（追加）
  shadow_equity/{date}    {sid: {equity, nav, per_symbol}, overall_nav, as_of}
  shadows/latest          最近一次运行汇总（指针 + 快照摘要）
"""

import logging
import time
from datetime import date, timedelta

from .config import settings
from .store import JsonStore
from .strategies import _make_df, pd_notna, signal_series
from .task_report_render import render_shadow_report

logger = logging.getLogger("adapter.shadow")

# 覆盖指标 warmup（ma slow 最大 120 根）+ 跟踪窗口
_HIST_LOOKBACK_DAYS = 400


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _latest_trade_date() -> str:
    from .brief_engine import _latest_trade_date as _ltd  # lazy: akshare 重

    return _ltd()


def _replay_pos(df_track, sig_track, capital: float, symbol: str) -> dict:
    """track_from 起的单一路径重放 → 当前持仓状态 + 平仓记录。

    状态机：bar t 信号（收盘后意图）→ bar t+1 开盘成交。t=0 无条件（track_from 首日不建仓）。
    开盘缺失（停牌）用收盘兜底，与回测 _px 一致。
    返回 {qty, entry_price, entry_date, avg_cost, cash, last_close, equity, signal_intent, closed}。
    """
    n = len(df_track)
    qty, cash = 0.0, float(capital)
    entry_price = entry_date = avg_cost = None
    closed: list[dict] = []
    prev_intent = 0
    for t in range(n):
        row = df_track.iloc[t]
        d = str(row["date"])
        if t > 0:
            op = row["open"]
            if not pd_notna(op):
                op = row["close"]
            op = float(op)
            if prev_intent == 1 and qty == 0 and op > 0:
                qty = cash / op
                cash = 0.0
                entry_price = avg_cost = op
                entry_date = d
            elif prev_intent == 0 and qty > 0 and op > 0:
                proceeds = qty * op
                cash = proceeds
                closed.append({
                    "symbol": symbol, "entry_date": entry_date, "exit_date": d,
                    "entry_price": round(entry_price, 4), "exit_price": round(op, 4),
                    "ret_pct": round((op - entry_price) / entry_price * 100.0, 4)
                    if entry_price else 0.0,
                })
                qty, entry_price, entry_date, avg_cost = 0.0, None, None, None
        prev_intent = int(sig_track.iloc[t]) if pd_notna(sig_track.iloc[t]) else 0
    last_close = float(df_track["close"].iloc[-1]) if n else None
    equity = cash + (qty * last_close if last_close else 0.0)
    return {
        "qty": round(qty, 4),
        "entry_price": entry_price, "entry_date": entry_date, "avg_cost": avg_cost,
        "cash": round(cash, 4), "last_close": last_close,
        "equity": round(equity, 4),
        "signal_intent": int(prev_intent),
        "closed": closed,
    }


class ShadowRunner:
    """影子策略验证 runner：只做多 active 策略的记账，无 LLM。"""

    name = "shadow-validator"

    def __init__(self, store: JsonStore | None = None):
        self.store = store or JsonStore()

    # ---- 数据 ---------------------------------------------------------

    def _fetch_hist(self, sym: str, start: str, end: str) -> list:
        from .holdings_runner import _a_share_code, _bs_hist

        return _bs_hist(_a_share_code(sym), start, end, fields="date,open,high,low,close,volume")

    def _active_strategies(self, strategy_id: str | None) -> list[dict]:
        if strategy_id:
            s = self.store.get("strategies", strategy_id)
            if not s:
                raise ValueError(f"策略不存在: {strategy_id}")
            return [s] if s.get("status") == "active" else []
        all_s = self.store.all("strategies") or {}
        return [s for s in all_s.values() if s.get("status") == "active"]

    # ---- 主流程 -------------------------------------------------------

    def run(self, params: dict, progress_cb) -> dict:
        force = bool(params.get("force", False))
        strategy_id = params.get("strategy_id")

        trade_date = _latest_trade_date()
        progress_cb(f"📅 影子验证 · 交易日 {trade_date}")

        # 幂等：同日已运行且非 force → skipped
        existing = self.store.get("shadow_equity", trade_date)
        if existing and not force:
            return {"skipped": True, "trade_date": trade_date,
                    "reason": f"{trade_date} 已运行（force=true 可重跑）"}

        strategies = self._active_strategies(strategy_id)
        if not strategies:
            return {"skipped": True, "trade_date": trade_date,
                    "reason": "无 active 策略（先回测过阈值激活，或指定 strategy_id）"}

        meta = dict(self.store.get("shadows", "meta") or {})
        initial_meta_keys = set(meta)
        history_start = (date.today() - timedelta(days=_HIST_LOOKBACK_DAYS)).isoformat()
        strategy_results: dict[str, dict] = {}
        strategy_errors: dict[str, str] = {}

        for s in strategies:
            sid = s["id"]
            progress_cb(f"🔄 {s.get('name')}（{sid}）…")
            try:
                res = self._run_strategy(s, trade_date, history_start, meta, progress_cb)
                strategy_results[sid] = res
            except Exception as exc:  # noqa: BLE001 — 单策略失败不拖垮整体
                strategy_errors[sid] = f"{type(exc).__name__}: {exc}"
                logger.warning("影子验证 %s 失败: %s", sid, exc)

        # 汇总
        overall = _overall_nav(strategy_results)
        snapshot = {
            "as_of": _now(), "trade_date": trade_date,
            "strategies": {sid: _snapshot(r) for sid, r in strategy_results.items()},
            "overall_nav": overall,
            "strategy_errors": strategy_errors,
        }
        self.store.set("shadow_equity", trade_date, snapshot)
        self.store.set("shadows", "latest", {
            "trade_date": trade_date, "ran_at": _now(),
            "overall_nav": overall,
            "strategy_count": len(strategy_results),
        })
        new_meta = {sid: rec for sid, rec in meta.items() if sid not in initial_meta_keys}
        if new_meta:
            self.store.mutate(
                "shadows",
                "meta",
                lambda current: {**dict(current or {}), **new_meta},
                {},
            )
        progress_cb("🏁 影子记账完成")
        snapshots = {sid: _snapshot(r) for sid, r in strategy_results.items()}
        return {
            "skipped": False,
            "trade_date": trade_date,
            "strategies": snapshots,
            "overall_nav": overall,
            "strategy_errors": strategy_errors,
            "signal": {
                "signal_type": "shadow_validation",
                "strategy_id": strategy_id,
                "strategy_name": (
                    snapshots.get(strategy_id, {}).get("name") if strategy_id else None
                ),
                "strategy_count": len(snapshots),
                "trade_date": trade_date,
                "overall_nav": overall,
            },
            "reports": {
                "shadow": render_shadow_report(
                    trade_date, snapshots, overall, strategy_errors
                )
            },
        }

    def _run_strategy(self, s: dict, trade_date: str, history_start: str,
                      meta: dict, progress_cb) -> dict:
        sid = s["id"]
        symbols = s.get("symbols") or []
        if not symbols:
            raise ValueError("策略无 symbols")
        kind = s.get("kind")
        cfg = s.get("params") or {}

        rec = meta.get(sid) or {}
        if not rec.get("track_from"):
            rec = {"track_from": trade_date,
                   "initial_capital": settings.shadow_initial_capital,
                   "activated_at": _now()}
            meta[sid] = rec
        track_from = rec["track_from"]
        capital_per = float(rec["initial_capital"]) / len(symbols)

        symbol_results: dict[str, dict] = {}
        symbol_errors: dict[str, str] = {}
        closed_log: list[dict] = []

        for sym in symbols:
            try:
                hist = self._fetch_hist(sym, history_start, trade_date)
                if not hist:
                    symbol_errors[sym] = "无历史行情（baostock 空）"
                    continue
                df = _make_df(hist)
                if len(df) < 10:
                    symbol_errors[sym] = f"历史过短({len(df)}根)"
                    continue
                sig = signal_series(df, kind, cfg)  # 全历史算信号（warmup 在 track_from 前）
                mask = df["date"].astype(str) >= track_from
                df_track = df[mask].reset_index(drop=True)
                sig_track = sig[mask].reset_index(drop=True)
                if len(df_track) == 0:
                    # track_from 之后无 bar（当日 bar 未出）→ 现金不动
                    symbol_results[sym] = {
                        "qty": 0, "entry_price": None, "entry_date": None,
                        "avg_cost": None,
                        "cash": round(capital_per, 4), "last_price": None,
                        "equity": round(capital_per, 4), "signal_intent": 0,
                    }
                    continue
                st = _replay_pos(df_track, sig_track, capital_per, sym)
                symbol_results[sym] = {
                    "qty": st["qty"], "entry_price": st["entry_price"],
                    "entry_date": st["entry_date"], "avg_cost": st["avg_cost"],
                    "cash": st["cash"], "last_price": st["last_close"],
                    "equity": st["equity"], "signal_intent": st["signal_intent"],
                }
                closed_log += st["closed"]
            except Exception as exc:  # noqa: BLE001 — 单 symbol 失败跳过
                symbol_errors[sym] = f"{type(exc).__name__}: {exc}"

        # 持久化持仓 + 平仓台账（append）
        for sym, st in symbol_results.items():
            self.store.set("shadows", f"pos:{sid}:{sym}", {
                "strategy_id": sid, "symbol": sym, "qty": st["qty"],
                "entry_price": st["entry_price"], "entry_date": st["entry_date"],
                "avg_cost": st["avg_cost"], "cash": st["cash"],
                "last_price": st["last_price"], "last_update": _now(),
            })
        if closed_log:
            self.store.mutate(
                "shadows",
                f"trades:{sid}",
                lambda current: (closed_log + list(current or []))[:200],
                [],
            )

        equity_sum = sum(r["equity"] for r in symbol_results.values())
        nav = equity_sum / float(rec["initial_capital"]) if rec["initial_capital"] else None
        return {
            "name": s.get("name"), "kind": kind, "symbols": symbols,
            "initial_capital": float(rec["initial_capital"]),
            "equity": round(equity_sum, 4), "nav": round(nav, 6) if nav else None,
            "per_symbol": symbol_results, "symbol_errors": symbol_errors,
            "closed_count": len(closed_log), "track_from": track_from,
        }


def _snapshot(r: dict) -> dict:
    return {
        "name": r.get("name"), "kind": r.get("kind"), "symbols": r.get("symbols"),
        "initial_capital": r.get("initial_capital"), "equity": r.get("equity"),
        "nav": r.get("nav"), "track_from": r.get("track_from"),
        "closed_count": r.get("closed_count", 0),
        "per_symbol": r.get("per_symbol"), "symbol_errors": r.get("symbol_errors"),
    }


def _overall_nav(results: dict) -> float | None:
    if not results:
        return None
    tot_cap = sum(r["initial_capital"] for r in results.values())
    tot_equity = sum(r["equity"] for r in results.values())
    if not tot_cap:
        return None
    return round(tot_equity / tot_cap, 6)
