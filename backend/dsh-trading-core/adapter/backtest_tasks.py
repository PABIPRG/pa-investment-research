# -*- coding: utf-8 -*-
"""独立策略回测任务模型（集合 `strategy_backtests`）。

背景：策略回测原先只覆盖式写回 `strategies.{sid}.backtest`（最新一次证据），没有任务/历史。
本模块把每次手动或自动回测登记为一条**独立任务**，自动（首测/15 天复测巡检）与手动统一进入
同一历史清单；最新一次证据仍照常写回策略记录（latest 快照），历史回溯走本集合。

任务记录（键 = task_id）：
    {task_id, strategy_id,
     source: "manual" | "auto",
     window: {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
     lookback_years: 2.0 | None,          # 预设窗口的年数（显式区间时 None）
     initial_capital: 100000.0,
     status: "queued" | "running" | "completed" | "failed",
     created_at / started_at / completed_at: "YYYY-MM-DD HH:MM:SS",
     verification_status: None | "pending" | "passed" | "failed",
     thresholds_pass: None | True | False,
     failure_reason: None | str,
     result: None | {与 strategies.{sid}.backtest 同构的最新证据快照}}

写入点单一：StrategyBacktestRunner.run()（adapter/strategies.py）在启动时 begin、收尾时
complete/fail；手动（TaskManager 注入 task_id）、闭环 Step C、自动巡检三条调用链都走同一处。
"""

import logging
import threading
import time
import uuid
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

from .store import JsonStore

COLLECTION = "strategy_backtests"


def _iso_now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def begin_task(
    store: JsonStore,
    *,
    task_id: str,
    strategy_id: str,
    source: str,
    window_start: str,
    window_end: str,
    lookback_years: Optional[float] = None,
    initial_capital: Optional[float] = None,
) -> None:
    """任务启动：登记/复用任务行并置 running + started_at（幂等）。"""
    source = "auto" if source == "auto" else "manual"
    now = _iso_now()
    row = store.get(COLLECTION, task_id) or {}

    def ensure(current):
        rec = dict(current or {})
        rec.update(
            task_id=task_id,
            strategy_id=strategy_id,
            source=source,
            window={"start": window_start, "end": window_end},
            lookback_years=lookback_years,
            initial_capital=initial_capital,
            status="running",
            started_at=now,
        )
        rec.setdefault("created_at", now)
        return rec

    store.mutate(COLLECTION, task_id, ensure)


def complete_task(
    store: JsonStore,
    task_id: str,
    *,
    verification_status: str,
    thresholds_pass: bool,
    result: dict,
) -> None:
    """任务成功收尾：写 completed + 验证分类 + 最新证据快照。"""
    now = _iso_now()

    def update(current):
        rec = dict(current or {})
        rec.update(
            status="completed",
            completed_at=now,
            verification_status=verification_status,
            thresholds_pass=thresholds_pass,
            result=result,
            failure_reason=None,
        )
        return rec

    store.mutate(COLLECTION, task_id, update)


def fail_task(
    store: JsonStore,
    task_id: str,
    reason: str,
    *,
    strategy_id: Optional[str] = None,
    source: str = "manual",
) -> None:
    """任务失败收尾：写 failed + failure_reason；行不存在（如入口校验就抛）也补记。"""
    now = _iso_now()
    source = "auto" if source == "auto" else "manual"
    existing = store.get(COLLECTION, task_id)

    def update(current):
        rec = dict(current or {})
        rec.update(status="failed", failure_reason=reason, completed_at=now)
        rec.setdefault("task_id", task_id)
        rec.setdefault("strategy_id", strategy_id)
        rec.setdefault("source", source)
        rec.setdefault("created_at", now)
        rec.setdefault("started_at", now)
        return rec

    # existing 缺失时仍要落一条失败记录（便于历史里看到失败任务）
    if existing is None:
        store.mutate(COLLECTION, task_id, update)
        return
    store.mutate(COLLECTION, task_id, update)


def task_summary(row: dict) -> dict:
    """列表行：剔掉大块 result 曲线，只留可审计摘要字段。"""
    result = row.get("result") or {}
    out = result.get("out_of_sample") or {}
    meta = {
        "task_id": row.get("task_id"),
        "strategy_id": row.get("strategy_id"),
        "source": row.get("source"),
        "window": row.get("window"),
        "lookback_years": row.get("lookback_years"),
        "initial_capital": row.get("initial_capital"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "started_at": row.get("started_at"),
        "completed_at": row.get("completed_at"),
        "verification_status": row.get("verification_status"),
        "thresholds_pass": row.get("thresholds_pass"),
        "failure_reason": row.get("failure_reason"),
        "summary": {
            "oos_trades": out.get("n_evaluated"),
            "oos_win_rate_pct": out.get("win_rate_pct"),
            "reason": result.get("reason"),
            "symbol_error_count": len((result.get("symbol_errors") or {})),
        },
    }
    return meta


def list_tasks(
    store: JsonStore,
    *,
    strategy_id: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    """策略回测任务历史（created_at 倒序）。支持按策略/来源/状态过滤。"""
    rows = []
    for row in (store.all(COLLECTION) or {}).values():
        if not isinstance(row, dict):
            continue
        if strategy_id and row.get("strategy_id") != strategy_id:
            continue
        if source and row.get("source") != source:
            continue
        if status and row.get("status") != status:
            continue
        rows.append(task_summary(row))
    rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return rows[: max(1, min(limit, 500))]


def has_inflight(store: JsonStore, strategy_id: str) -> bool:
    """该策略是否有 queued/running 任务（防止巡检同日重复触发）。"""
    for row in (store.all(COLLECTION) or {}).values():
        if not isinstance(row, dict):
            continue
        if row.get("strategy_id") != strategy_id:
            continue
        if row.get("status") in ("queued", "running"):
            return True
    return False


def latest_completed_at(store: JsonStore, strategy_id: str) -> Optional[str]:
    """最近一次 completed 任务的 completed_at；无任务记录时回退策略 backtest.ran_at。

    兼容改造前的历史：老 active 策略没有任务行，用 strategies.backtest.ran_at 视为最近完成。
    """
    best: Optional[str] = None
    for row in (store.all(COLLECTION) or {}).values():
        if not isinstance(row, dict):
            continue
        if row.get("strategy_id") != strategy_id:
            continue
        if row.get("status") != "completed":
            continue
        at = row.get("completed_at")
        if at and (best is None or at > best):
            best = at
    if best is not None:
        return best
    rec = store.get("strategies", strategy_id) or {}
    ran_at = (rec.get("backtest") or {}).get("ran_at")
    return str(ran_at) if ran_at else None


def is_auto_eligible(strategy: dict) -> bool:
    """是否仍参与自动回测：status 为 candidate/active，且验证分类不在退出集合。

    已归档(retired)、已淘汰(rejected)、验证失败(failed)/archived 的不再建新自动任务。
    """
    if not isinstance(strategy, dict):
        return False
    status_value = str(strategy.get("status") or "")
    if status_value not in ("candidate", "active"):
        return False
    vstatus = str(strategy.get("verification_status") or "")
    return vstatus not in ("archived", "failed")


# ---- 候选落池即触发首测（策略生成 → 立即自动首测，默认 lookback 年）--------
# 产品语义：hypothesize「从事件新建策略」等生成入口写入新候选后，不等每日巡检，
# 立即在后台发起默认 lookback 年首测（source=auto，写回本任务历史），
# 使新候选生成当下就有回测证据。与巡检首测一致：通过只落 passed（人工确认生效，
# 不自动激活）；失败且 CANDIDATE_AUTO_REJECT=on 时淘汰（不再建新自动任务）。


def _default_auto_lookback() -> float:
    from .config import settings

    return float(settings.auto_backtest_lookback_years)


def run_first_backtests(store: JsonStore, strategy_ids: Iterable[str]) -> dict:
    """同步跑一批刚落池候选的**首测**（source=auto，默认 lookback 年）。

    只处理尚无任何回测证据的新候选：非 candidate/active、已有 queued/running
    任务（in-flight）、或已有完成记录/backtest.ran_at 的均跳过——防与巡检/闭环重复。
    通过不激活、失败按 CANDIDATE_AUTO_REJECT 淘汰。返回计数便于日志/测试断言。
    """
    from .config import settings
    from .strategies import StrategyBacktestRunner, transition_strategy

    started = completed = rejected = skipped = failed = 0
    for sid in strategy_ids:
        sid = str(sid)
        rec = store.get("strategies", sid) or {}
        if not is_auto_eligible(rec):
            skipped += 1
            continue
        if has_inflight(store, sid):
            skipped += 1
            continue
        if latest_completed_at(store, sid):
            skipped += 1
            continue
        started += 1
        try:
            res = StrategyBacktestRunner(store).run(
                {"strategy_id": sid, "source": "auto",
                 "lookback_years": _default_auto_lookback(),
                 "oos_frac": 0.3, "min_oos_trades": 4},
                lambda m: None,
            )
            completed += 1
            vstatus = res.get("verification_status")
            if str(rec.get("status")) == "candidate" and vstatus == "failed" \
                    and settings.candidate_auto_reject:
                transition_strategy(store, sid, "reject")
                rejected += 1
                logger.info("候选 %s 生成即首测未达标 → 自动淘汰", sid)
            elif str(rec.get("status")) == "candidate" and vstatus == "passed":
                logger.info("候选 %s 生成即首测通过 → 落 passed（人工确认生效，不自动激活）", sid)
        except Exception as exc:  # noqa: BLE001 — 单候选失败不拖垮整批
            failed += 1
            logger.warning("候选 %s 生成即首测失败: %s", sid, exc)
    return {"started": started, "completed": completed, "rejected": rejected,
            "skipped": skipped, "failed": failed}


def trigger_first_backtests(strategy_ids: Iterable[str]) -> dict:
    """候选落池即触发（异步后台）：新候选生成后立即发起默认 lookback 年首测。

    生成入口（hypothesize 等）拿到新建候选 id 后调用；后台 daemon 线程串行跑，
    不阻塞请求。返回入队 id 数（实际跳过数见后台日志，测试用 run_first_backtests）。
    """
    ids = [str(s) for s in (strategy_ids or []) if str(s).strip()]
    if not ids:
        return {"enqueued": 0}

    def _run() -> None:
        try:
            run_first_backtests(JsonStore(), ids)
        except Exception as exc:  # noqa: BLE001 — 后台批次异常不静默
            logger.exception("生成即首测后台批次失败: %s", exc)

    threading.Thread(target=_run, name="first-backtest", daemon=True).start()
    return {"enqueued": len(ids)}
