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
- 幂等：同交易日、同作用域的非 force 请求复用 shadow_tasks 中的既有任务；force 新建任务并追溯原任务。

数据落点（collection/key）：
  shadows/meta            {sid: {track_from, initial_capital, activated_at}}
  shadows/pos/{sid}:{sym} {qty, entry_price, entry_date, avg_cost, cash, last_price}
  shadows/trades/{sid}    平仓明细列表（追加）
  shadow_tasks/{task_id}  任务状态、来源、作用域、汇总、报告与重跑关系
  shadow_task_results/*   逐策略 success/failed/skipped 结果及净值证据引用
  shadow_equity/{date}    最新兼容快照 + runs/{task_id} 不可变运行证据
  shadows/latest          最近一次运行汇总（指针 + 快照摘要）
"""

import json
import logging
import time
import uuid
from datetime import date, timedelta

from .config import settings
from .store import JsonStore
from .strategies import _make_df, pd_notna, signal_series
from .task_report_render import render_shadow_report

logger = logging.getLogger("adapter.shadow")

# 覆盖指标 warmup（ma slow 最大 120 根）+ 跟踪窗口
_HIST_LOOKBACK_DAYS = 400

# 拉行情失败重试：baostock 登录日期不匹配/瞬时网络抖动是瞬时的，短暂退避后重试一次
_FETCH_RETRIES = 2
_FETCH_RETRY_DELAY = 1.0


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


def _closed_trade_identity(trade: dict) -> tuple:
    """同一历史重放的平仓身份；旧记录缺关键日期时退化为完整内容。"""
    symbol = trade.get("symbol")
    entry_date = trade.get("entry_date")
    exit_date = trade.get("exit_date")
    if symbol and entry_date and exit_date:
        return ("closed", str(symbol), str(entry_date), str(exit_date))
    return (
        "legacy",
        json.dumps(trade, ensure_ascii=False, sort_keys=True, default=str),
    )


def _merge_closed_trades(fresh: list[dict], current: object) -> list[dict]:
    """新鲜重放优先覆盖同身份旧记录，并保留本次未重放到的历史成交。"""
    merged: list[dict] = []
    seen: set[tuple] = set()
    existing = current if isinstance(current, list) else []
    for trade in [*fresh, *existing]:
        if not isinstance(trade, dict):
            continue
        identity = _closed_trade_identity(trade)
        if identity in seen:
            continue
        seen.add(identity)
        merged.append(trade)
    return merged[:200]


class ShadowRunner:
    """影子策略验证 runner：只做多 active 策略的记账，无 LLM。"""

    name = "shadow-validator"

    def __init__(self, store: JsonStore | None = None):
        self.store = store or JsonStore()

    # ---- 数据 ---------------------------------------------------------

    def _fetch_hist(self, sym: str, start: str, end: str) -> list:
        from .holdings_runner import HoldingDataError, _a_share_code, _bs_hist

        code = _a_share_code(sym)
        fields = "date,open,high,low,close,volume"
        for attempt in range(_FETCH_RETRIES):
            try:
                return _bs_hist(code, start, end, fields=fields)
            except HoldingDataError:
                if attempt == _FETCH_RETRIES - 1:
                    raise
                logger.warning("拉行情 %s 失败（第 %d 次），%ss 后重试…",
                               sym, attempt + 1, _FETCH_RETRY_DELAY)
                time.sleep(_FETCH_RETRY_DELAY)

    def _active_strategies(self, strategy_id: str | None) -> list[dict]:
        if strategy_id:
            s = self.store.get("strategies", strategy_id)
            if not s:
                raise ValueError(f"策略不存在: {strategy_id}")
            return [s] if s.get("status") in ("active", "watch") else []
        all_s = self.store.all("strategies") or {}
        return [s for s in all_s.values() if s.get("status") in ("active", "watch")]

    def prepare_task(self, task_id: str, params: dict) -> dict:
        """在 worker 提交前持久化 pending，并原子复用同日同作用域任务。"""
        from . import shadow_tasks as tasks

        trade_date = str(params.get("trade_date") or _latest_trade_date())
        strategy_id = str(params.get("strategy_id") or "").strip() or None
        scope = "single" if strategy_id else "batch"
        if strategy_id:
            strategy_ids = [strategy_id]
        else:
            strategy_ids = sorted(
                str(row.get("id")) for row in self._active_strategies(None)
                if row.get("id")
            )
        force = bool(params.get("force", False))
        dedupe_key = None if force else tasks.scope_key(
            trade_date, scope, strategy_ids
        )
        latest = tasks.find_latest_for_scope(
            self.store, trade_date, scope, strategy_ids
        ) if force else None
        request_params = {
            **params,
            "task_id": task_id,
            "trade_date": trade_date,
            "source": tasks.normalize_source(params.get("source")),
        }
        return tasks.create_pending_task(
            self.store,
            task_id=task_id,
            source=str(request_params["source"]),
            scope=scope,
            strategy_ids=strategy_ids,
            trade_date=trade_date,
            force=force,
            request_params=request_params,
            dedupe_key=dedupe_key,
            rerun_of_task_id=(str(latest.get("task_id")) if latest else None),
        )

    def attach_report(self, task_id: str, report_id: str) -> None:
        from . import shadow_tasks as tasks

        tasks.attach_report(self.store, task_id, report_id)

    def fail_task(self, task_id: str, reason: str) -> None:
        from . import shadow_tasks as tasks

        tasks.fail_task(self.store, task_id, reason)

    def cancel_task(self, task_id: str) -> bool:
        from . import shadow_tasks as tasks

        return tasks.cancel_task(self.store, task_id)

    # ---- 主流程 -------------------------------------------------------

    def run(self, params: dict, progress_cb) -> dict:
        from . import shadow_tasks as tasks

        params = dict(params)
        if not params.get("task_id") and not params.get("source"):
            params["source"] = "scheduled"
        cancel_event = params.get("_cancel_event")

        def ensure_not_cancelled() -> None:
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError("影子验证任务已取消")

        task_id = str(params.get("task_id") or uuid.uuid4().hex)
        force = bool(params.get("force", False))
        strategy_id = params.get("strategy_id")
        row = tasks.get_task(self.store, task_id)
        if row is None:
            prepared = self.prepare_task(task_id, params)
            task_id = str(prepared["task_id"])
            row = tasks.get_task(self.store, task_id)
        if row and row.get("status") in tasks.TERMINAL_STATUSES:
            persisted = row.get("result")
            if isinstance(persisted, dict):
                return dict(persisted)
        if not tasks.claim_task(self.store, task_id):
            raise RuntimeError(f"影子验证任务不可执行: {task_id}")

        trade_date = str((row or {}).get("trade_date") or params.get("trade_date") or _latest_trade_date())
        progress_cb(f"📅 影子验证 · 交易日 {trade_date}")

        requested_ids = list((row or {}).get("strategy_ids") or [])
        strategies = []
        skipped_ids = []
        for sid in requested_ids:
            strategy = self.store.get("strategies", sid)
            if isinstance(strategy, dict) and strategy.get("status") in ("active", "watch"):
                strategies.append(strategy)
            else:
                skipped_ids.append(sid)

        meta = dict(self.store.get("shadows", "meta") or {})
        initial_meta_keys = set(meta)
        history_start = (date.today() - timedelta(days=_HIST_LOOKBACK_DAYS)).isoformat()
        strategy_results: dict[str, dict] = {}
        strategy_errors: dict[str, str] = {}

        for sid in skipped_ids:
            ensure_not_cancelled()
            tasks.save_strategy_result(
                self.store,
                task_id=task_id,
                strategy_id=sid,
                status="skipped",
                reason="无 active 策略（active/watch 参与状态；需先完成首次回测）",
                snapshot=None,
                trade_date=trade_date,
            )

        for s in strategies:
            ensure_not_cancelled()
            sid = s["id"]
            started_at = _now()
            progress_cb(f"🔄 {s.get('name')}（{sid}）…")
            try:
                res = self._run_strategy(s, trade_date, history_start, meta, progress_cb)
                ensure_not_cancelled()
                strategy_results[sid] = res
                tasks.save_strategy_result(
                    self.store,
                    task_id=task_id,
                    strategy_id=sid,
                    status="success",
                    reason=None,
                    snapshot=_snapshot(res),
                    trade_date=trade_date,
                    started_at=started_at,
                    completed_at=_now(),
                )
            except Exception as exc:  # noqa: BLE001 — 单策略失败不拖垮整体
                ensure_not_cancelled()
                strategy_errors[sid] = f"{type(exc).__name__}: {exc}"
                tasks.save_strategy_result(
                    self.store,
                    task_id=task_id,
                    strategy_id=sid,
                    status="failed",
                    reason=strategy_errors[sid],
                    snapshot=None,
                    trade_date=trade_date,
                    started_at=started_at,
                    completed_at=_now(),
                )
                logger.warning("影子验证 %s 失败: %s", sid, exc)

        # 汇总
        ensure_not_cancelled()
        overall = _overall_nav(strategy_results)
        snapshot = {
            "as_of": _now(), "trade_date": trade_date,
            "strategies": {sid: _snapshot(r) for sid, r in strategy_results.items()},
            "overall_nav": overall,
            "strategy_errors": strategy_errors,
        }
        if strategy_results:
            def save_equity(current):
                persisted = dict(current or {})
                runs = dict(persisted.get("runs") or {})
                runs[task_id] = snapshot
                return {**snapshot, "runs": runs, "latest_task_id": task_id}

            self.store.mutate("shadow_equity", trade_date, save_equity, {})
        if strategy_results:
            self.store.set("shadows", "latest", {
                "task_id": task_id, "trade_date": trade_date, "ran_at": _now(),
                "overall_nav": overall, "strategy_count": len(strategy_results),
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
        task_results = tasks.list_task_results(self.store, task_id)
        task_status = tasks.aggregate_status(task_results)
        all_skipped = not task_results or all(
            item.get("status") == "skipped" for item in task_results
        )
        result = {
            "task_id": task_id,
            "task_status": task_status,
            "skipped": all_skipped,
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
            **({"reason": "无 active 策略（active/watch 参与状态；需先完成首次回测）"}
               if all_skipped else {}),
            **({"reports": {
                "shadow": render_shadow_report(
                    trade_date, snapshots, overall, strategy_errors
                )
            }} if not all_skipped else {}),
        }
        tasks.finalize_task(self.store, task_id, overall_nav=overall, result=result)
        return result

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

        # 持久化持仓 + 平仓台账（完整历史重放按平仓身份幂等合并）
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
                lambda current: _merge_closed_trades(closed_log, current),
                [],
            )

        equity_sum = sum(r["equity"] for r in symbol_results.values())
        # 拉数失败的符号按闲置现金计入（等权子账户已为它预留 1/n 资本，失败不吞掉）。
        # 否则 equity 只算成功符号、资本按全量符号等分，NAV 被机械性压低
        # （如 12 符号中 8 成功 → equity 8×capital_per → nav 恰 0.667）。
        if symbol_errors:
            equity_sum += capital_per * len(symbol_errors)
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
