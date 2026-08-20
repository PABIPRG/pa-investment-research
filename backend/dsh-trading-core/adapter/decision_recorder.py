# -*- coding: utf-8 -*-
"""决策记录器：把每次股票分析的最终 signal 落盘 JsonStore `decisions`。

背景：结构化决策 {action, target_price, confidence, risk_score} 原本只存在
TaskManager._results（内存），进程重启即丢；full_states_log.json 只有纯文本
final_trade_decision。记录器让回测引擎有结构化决策可回放（主数据源）。

key = f"{ticker}_{trade_date}"。trade_date 用分析日期（params.date or today），
与引擎 engine_bridge.run 保持一致，不是 wall-clock。
"""

import time
from datetime import date, datetime, timezone
from typing import Optional

from .store import JsonStore

VALID_ACTIONS = {"买入", "持有", "卖出", "观望"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DecisionRecorder:
    def __init__(self, store: JsonStore | None = None):
        self.store = store or JsonStore()

    def record(self, signal: dict, trade_date: str, source: str = "engine") -> Optional[str]:
        """落盘一条结构化决策。signal 不合法（非 final/未知 action）则 no-op。"""
        if not isinstance(signal, dict):
            return None
        if signal.get("signal_type") != "final":
            return None
        action = signal.get("action")
        if action not in VALID_ACTIONS:
            return None
        ticker = signal.get("ticker")
        if not ticker:
            return None

        key = f"{ticker}_{trade_date}"
        record = {
            "ticker": ticker,
            "company_name": signal.get("company_name"),
            "trade_date": trade_date,
            "signal_type": "final",
            "action": action,
            "target_price": signal.get("target_price"),
            "confidence": signal.get("confidence"),
            "risk_score": signal.get("risk_score"),
            "reasoning": signal.get("reasoning"),
            "risk_profile": signal.get("risk_profile"),
            "calibration": signal.get("calibration"),
            "calibration_note": signal.get("calibration_note"),
            "model_info": signal.get("model_info"),
            "source": source,
            "recorded_at": _now_iso(),
        }
        self.store.set("decisions", key, record)
        return key

    def maybe_record(self, task_type: str, params: dict, result: dict,
                     source: Optional[str] = None) -> Optional[str]:
        """TaskManager._run_sync 钩子：仅股票分析记录（holdings L2 逐股不记）。

        source 由调用方按 runner.name 判定：FakeRunner 记 "fake"（无 LLM 的
        演示种子），真引擎记 "engine"。缺省 "engine"。
        """
        if task_type != "stock":
            return None
        signal = (result or {}).get("signal") or {}
        trade_date = (params or {}).get("date") or date.today().isoformat()
        return self.record(signal, trade_date, source or "engine")

    def all_structured(self) -> list[dict]:
        """全部已记录的结构化决策（值列表）。

        只返回 source∈{engine,fake} 的真人/演示记录；回测 runner 写入的
        `decision_source="text_inferred"` 轻量记录（无 source）不会被误当
        结构化候选，文本兜底每次运行都从 eval_results 重新推断。
        """
        return [
            rec for rec in self.store.all("decisions").values()
            if rec.get("source") in ("engine", "fake")
        ]

    def update_eval_meta(self, key: str, **fields) -> None:
        """回测引擎幂等更新某条决策的 eval_meta。"""
        self.store.update("decisions", key, eval_meta=fields)


def load_evaluated_results(code: Optional[str] = None) -> list[dict]:
    """从 decisions 取出所有已评估（eval_meta.eval_status=="evaluated"）的结果条目。

    供 GET /backtest/performance 重算 summary。可选按 code 过滤。
    """
    out: list[dict] = []
    store = JsonStore()
    for rec in store.all("decisions").values():
        meta = rec.get("eval_meta") or {}
        if meta.get("eval_status") != "evaluated":
            continue
        item = meta.get("last_eval")
        if not isinstance(item, dict):
            continue
        if code and item.get("ticker") != code:
            continue
        out.append(item)
    return out
