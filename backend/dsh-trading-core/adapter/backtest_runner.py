# -*- coding: utf-8 -*-
"""回测任务 runner：收集决策 → 拉取行情 → 逐条评估 → 聚合 + 持久化。

作为 TaskManager 的 "backtest" task_type 运行（manager.start(params,
task_type="backtest")），复用 /analyze/{task_id}/stream（SSE 进度）与
/analyze/{task_id}/result（最终结果），产品壳 PA.runTask 零改动接入。

决策候选来源（决策记录器 + 文本兜底，见计划）：
  1. decisions 集合的结构化决策（主，带 confidence/target_price）
  2. eval_results/**/full_states_log.json 纯文本 final_trade_decision（兜底，
     关键词推断，confidence=None）
行情：baostock 前复权日线，经 holdings_runner._bs_hist 共享 _bs_lock 串行拉取。
"""

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

from .backtest_engine import (
    compute_summary,
    evaluate_decision,
    infer_decision_from_text,
    structured_decision,
)
from .config import settings
from .decision_recorder import DecisionRecorder
from .store import JsonStore

ENGINE_VERSION = "v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class BacktestRunner:
    name = "backtest"

    def __init__(self, store: JsonStore | None = None):
        self.store = store or JsonStore()
        self._recorder = DecisionRecorder(self.store)
        self._hist_cache: dict[str, Optional[list]] = {}

    # ---- 入口 -----------------------------------------------------------

    def run(self, params: dict, progress_cb: Callable[[str], None]) -> dict:
        eval_window_days = int(params.get("eval_window_days", 10))
        stop_loss_pct = float(params.get("stop_loss_pct", 5.0))
        take_profit_pct = float(params.get("take_profit_pct", 10.0))
        neutral_band_pct = float(params.get("neutral_band_pct", 2.0))

        progress_cb("🧺 收集决策：decisions 结构化记录 + eval_results 文本回填…")
        candidates, skipped = self._gather_candidates(params)
        progress_cb(f"📥 候选决策 {len(candidates)} 条（跳过已评估 {skipped}）")

        self._hist_cache = {}
        results: list[dict] = []

        # 先取各 ticker 最早的 trade_date，确定行情拉取窗口起点
        by_ticker: dict[str, str] = {}
        for c in candidates:
            td = by_ticker.get(c["ticker"])
            if td is None or c["trade_date"] < td:
                by_ticker[c["ticker"]] = c["trade_date"]

        for i, cand in enumerate(candidates, start=1):
            ticker = cand["ticker"]
            progress_cb(f"🧮 评估 {i}/{len(candidates)} {ticker}（{cand['trade_date']}）…")
            hist = self._fetch_hist(ticker, by_ticker.get(ticker) or cand["trade_date"])
            if hist is None:
                results.append({
                    "key": cand.get("key"), "ticker": ticker,
                    "trade_date": cand.get("trade_date"),
                    "company_name": cand.get("company_name"),
                    "decision_source": cand.get("decision_source"),
                    "action": cand.get("action"),
                    "confidence": cand.get("confidence"),
                    "target_price": cand.get("target_price"),
                    "n_forward_bars": 0,
                    "eval_status": "fetch_failed",
                    "eval_error": f"{ticker} 行情拉取失败（baostock）",
                })
                continue
            item = evaluate_decision(
                cand, hist, eval_window_days,
                stop_loss_pct, take_profit_pct, neutral_band_pct,
            )
            results.append(item)
            if cand.get("key"):
                self._persist_eval(cand, item, params)

        progress_cb("📈 聚合 summary（方向准确率 / 胜率 / Sharpe / 最大回撤）…")
        summary = compute_summary(
            results,
            engine_version=ENGINE_VERSION,
            eval_window_days=eval_window_days,
            min_age_days=params.get("min_age_days"),
            n_decisions_total=len(candidates),
            n_candidates_evaluated=skipped,
        )

        run_id = params.get("task_id")
        if run_id:
            self.store.set("backtests", run_id, {
                "run_id": run_id,
                "task_id": run_id,
                "created_at": _now_iso(),
                "params": params,
                "summary": summary,
                "n_results": len(results),
            })

        return {
            "summary": summary,
            "results": results,
            "params": {k: params.get(k) for k in (
                "code", "force", "eval_window_days", "min_age_days",
                "analysis_date_from", "analysis_date_to", "limit",
                "stop_loss_pct", "take_profit_pct", "neutral_band_pct",
            )},
            "meta": {"engine_version": ENGINE_VERSION, "created_at": _now_iso()},
        }

    # ---- 候选收集 -------------------------------------------------------

    def _gather_candidates(self, params: dict) -> tuple[list[dict], int]:
        """返回 (候选列表, 因缓存跳过的数量)。候选按 (trade_date desc, ticker) 排序。"""
        structured = self._candidates_structured()
        text = self._candidates_from_eval_results(settings.root / "eval_results")
        dedup: dict[str, dict] = {}
        # 结构化优先（覆盖同名文本兜底）
        for cand in structured + text:
            key = f"{cand['ticker']}_{cand['trade_date']}"
            if key not in dedup:
                dedup[key] = cand

        code = (params.get("code") or "").strip()
        date_from = params.get("analysis_date_from")
        date_to = params.get("analysis_date_to")
        min_age_days = int(params.get("min_age_days", 14))
        force = bool(params.get("force"))
        limit = int(params.get("limit", 200))
        cutoff = date.today() - timedelta(days=min_age_days)
        eval_window_days = int(params.get("eval_window_days", 10))

        kept: list[dict] = []
        skipped = 0
        for cand in dedup.values():
            if code and cand["ticker"] != code:
                continue
            try:
                td = date.fromisoformat(cand["trade_date"])
            except (TypeError, ValueError):
                continue
            if date_from and td < date.fromisoformat(date_from):
                continue
            if date_to and td > date.fromisoformat(date_to):
                continue
            if min_age_days > 0 and td > cutoff:
                continue
            meta = cand.get("eval_meta") or {}
            if (
                not force
                and meta.get("engine_version") == ENGINE_VERSION
                and meta.get("eval_window_days") == eval_window_days
                and meta.get("eval_status") == "evaluated"
            ):
                skipped += 1
                continue
            kept.append(cand)

        kept.sort(key=lambda c: (c["trade_date"], c["ticker"]), reverse=True)
        return kept[:limit], skipped

    def _candidates_structured(self) -> list[dict]:
        """decisions 集合的结构化决策 → 候选。source 必须是 engine/fake（排除回测写入的文本记录）。"""
        out: list[dict] = []
        for rec in self._recorder.all_structured():
            action = rec.get("action")
            if action not in ("买入", "持有", "卖出", "观望"):
                continue
            if not rec.get("trade_date"):
                continue
            dec = structured_decision(action)
            out.append({
                **rec,
                "key": f"{rec['ticker']}_{rec['trade_date']}",
                "decision_source": "structured",
                "direction_expected": dec["direction_expected"],
                "position_recommendation": dec["position_recommendation"],
            })
        return out

    def _candidates_from_eval_results(self, root: Path) -> list[dict]:
        """扫描 eval_results/{ticker}/TradingAgentsStrategy_logs/full_states_log.json，
        从纯文本 final_trade_decision 关键词推断出候选（confidence=None）。"""
        if not root.is_dir():
            return []
        out: list[dict] = []
        for ticker_dir in root.iterdir():
            if not ticker_dir.is_dir():
                continue
            log = ticker_dir / "TradingAgentsStrategy_logs" / "full_states_log.json"
            if not log.is_file():
                continue
            try:
                data = json.loads(log.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            for td, v in data.items():
                if not isinstance(v, dict):
                    continue
                text = str(v.get("final_trade_decision") or "").strip()
                if not text:
                    continue
                info = infer_decision_from_text(text)
                out.append({
                    "key": f"{ticker_dir.name}_{td}",
                    "ticker": ticker_dir.name,
                    "company_name": v.get("company_of_interest") or ticker_dir.name,
                    "trade_date": str(td),
                    "action": info["action"],
                    "target_price": info["target_price"],
                    "confidence": None,
                    "risk_score": None,
                    "direction_expected": info["direction_expected"],
                    "position_recommendation": info["position_recommendation"],
                    "reasoning_head": text[:200],
                    "decision_source": "text_inferred",
                })
        return out

    # ---- 行情 / 持久化 --------------------------------------------------

    def _fetch_hist(self, ticker: str, min_trade_date: str) -> Optional[list]:
        """拉取单只股票前复权日线（date,open,high,low,close）。带锁串行，缓存 in-run。

        holdings_runner 延迟到方法内导入：该模块会拖 engine_bridge → tradingagents
        重依赖，保持 app._build_registry 的 lazy 设计（fake 模式不加载引擎依赖）。
        """
        from .holdings_runner import HoldingDataError, _a_share_code, _bs_hist

        if ticker in self._hist_cache:
            return self._hist_cache[ticker]
        try:
            code = _a_share_code(ticker)
            start = (date.fromisoformat(min_trade_date) - timedelta(days=7)).isoformat()
        except (HoldingDataError, ValueError):
            self._hist_cache[ticker] = None
            return None
        try:
            rows = _bs_hist(code, start, date.today().isoformat(),
                            fields="date,open,high,low,close")
        except Exception:  # 网络/数据源抖动，标 fetch_failed 不拖垮任务
            rows = None
        self._hist_cache[ticker] = rows or None
        return self._hist_cache[ticker]

    def _persist_eval(self, cand: dict, item: dict, params: dict) -> None:
        """把评估结果写回 decisions 记录的 eval_meta（幂等）。

        结构化记录：原样 + eval_meta；文本兜底记录：建轻量记录（无 source 字段，
        不会升级为结构化候选）。供 GET /backtest/performance 重算。
        """
        rec = dict(cand)
        rec.pop("key", None)
        rec["eval_meta"] = {
            "engine_version": ENGINE_VERSION,
            "eval_window_days": int(params.get("eval_window_days", 10)),
            "eval_status": item.get("eval_status"),
            "evaluated_at": _now_iso(),
            "last_eval": item,
        }
        self.store.set("decisions", f"{cand['ticker']}_{cand['trade_date']}", rec)
