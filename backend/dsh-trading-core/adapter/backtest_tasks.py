# -*- coding: utf-8 -*-
"""独立策略回测任务模型（集合 `strategy_backtests`）。

背景：策略回测原先只覆盖式写回 `strategies.{sid}.backtest`（最新一次证据），没有任务/历史。
本模块把每次手动或自动回测登记为一条**独立任务**，自动（首测/15 天复测巡检）与手动统一进入
同一历史清单；最新一次证据仍照常写回策略记录（latest 快照），历史回溯走本集合。

任务记录（键 = task_id）：
    {task_id, strategy_id,
     source: "manual" | "initial_auto" | "periodic_retest" | "auto_legacy",
     window: {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
     lookback_years: 2.0 | None,          # 预设窗口的年数（显式区间时 None）
     initial_capital: 100000.0,
     status: "pending" | "running" | "completed" | "failed" | "cancelled",
     created_at / started_at / completed_at: "YYYY-MM-DD HH:MM:SS",
     verification_status: None | "passed" | "not_passed" | "insufficient",
     thresholds_pass: None | True | False,
     failure_reason: None | str,
     result: None | {与 strategies.{sid}.backtest 同构的最新证据快照}}

写入点单一：StrategyBacktestRunner 在提交 worker 前落 pending，执行时原子 claim，
收尾时 complete/fail/cancel；手动、首测和自动复测共用同一历史。
"""

import logging
import threading
import time
import uuid
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

from .store import JsonStore

COLLECTION = "strategy_backtests"
SOURCES = frozenset({"manual", "initial_auto", "periodic_retest", "auto_legacy"})
VERIFICATION_STATUSES = frozenset({"passed", "not_passed", "insufficient"})


def normalize_source(source: object) -> str:
    """将历史 auto 兼容值投影到明确来源，新写入不再混用 auto。"""
    value = str(source or "manual")
    if value == "auto":
        return "auto_legacy"
    return value if value in SOURCES else "manual"


def normalize_verification_status(value: object, result: object = None) -> str:
    """把旧任务的 pending/failed 投影为 rc.10 三态验证分类。"""
    raw = str(value or "")
    if raw in VERIFICATION_STATUSES:
        return raw
    if raw == "failed":
        return "not_passed"
    if isinstance(result, dict):
        nested = str(result.get("verification_status") or "")
        if nested in VERIFICATION_STATUSES:
            return nested
        if nested == "failed":
            return "not_passed"
    return "insufficient"


def _iso_now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _next_sequence(document: dict, field: str) -> int:
    """返回集合内单调递增序号；由 mutate_document 锁保证不重复。"""
    return max(
        (
            int(row.get(field) or 0)
            for row in document.values()
            if isinstance(row, dict)
        ),
        default=0,
    ) + 1


def create_pending_task(
    store: JsonStore,
    *,
    task_id: str,
    strategy_id: str,
    source: str,
    window_start: str,
    window_end: str,
    lookback_years: Optional[float] = None,
    initial_capital: Optional[float] = None,
    request_params: Optional[dict] = None,
    dedupe_key: Optional[str] = None,
    retry_of_task_id: Optional[str] = None,
) -> dict:
    """Persist a queued task before any worker can claim it.

    ``dedupe_key`` is checked and inserted while the collection lock is held, so
    concurrent first-run/retest schedulers cannot create duplicate local tasks.
    """
    now = _iso_now()
    selected: dict = {}

    def insert(document: dict) -> dict:
        nonlocal selected
        if task_id in document and isinstance(document[task_id], dict):
            selected = dict(document[task_id])
            return document
        if dedupe_key:
            for existing in document.values():
                if isinstance(existing, dict) and existing.get("dedupe_key") == dedupe_key:
                    selected = dict(existing)
                    return document
        selected = {
            "task_id": task_id,
            "strategy_id": strategy_id,
            "source": normalize_source(source),
            "window": {"start": window_start, "end": window_end},
            "lookback_years": lookback_years,
            "initial_capital": initial_capital,
            "request_params": dict(request_params or {}),
            "dedupe_key": dedupe_key,
            "retry_of_task_id": retry_of_task_id,
            "status": "pending",
            "created_at": now,
            "created_sequence": _next_sequence(document, "created_sequence"),
            "started_at": None,
            "completed_at": None,
            "verification_status": None,
            "thresholds_pass": None,
            "failure_reason": None,
            "report_id": None,
            "result": None,
        }
        document[task_id] = selected
        return document

    store.mutate_document(COLLECTION, insert)
    return dict(selected)


def claim_task(store: JsonStore, task_id: str) -> bool:
    """Atomically claim a pending task for one worker."""
    claimed = False
    now = _iso_now()

    def claim(current):
        nonlocal claimed
        rec = dict(current or {})
        if rec.get("status") not in ("pending", "queued"):
            return rec
        rec.update(status="running", started_at=now)
        rec.pop("dispatch_reserved_at", None)
        claimed = True
        return rec

    store.mutate(COLLECTION, task_id, claim)
    return claimed


def reserve_task(store: JsonStore, task_id: str) -> bool:
    """为后台投递原子预留 pending；状态仍保持 pending，等待 worker 认领。"""
    reserved = False

    def reserve(current):
        nonlocal reserved
        rec = dict(current or {})
        if rec.get("status") not in ("pending", "queued"):
            return rec
        if rec.get("dispatch_reserved_at"):
            return rec
        rec["dispatch_reserved_at"] = _iso_now()
        reserved = True
        return rec

    store.mutate(COLLECTION, task_id, reserve)
    return reserved


def cancel_task(store: JsonStore, task_id: str) -> bool:
    """Cancel a pending/running task without allowing late completion to win."""
    cancelled = False
    now = _iso_now()

    def cancel(current):
        nonlocal cancelled
        rec = dict(current or {})
        if rec.get("status") not in ("pending", "queued", "running"):
            return rec
        rec.update(
            status="cancelled",
            completed_at=now,
            cancel_requested_at=now,
            verification_status=None,
            thresholds_pass=None,
        )
        cancelled = True
        return rec

    store.mutate(COLLECTION, task_id, cancel)
    return cancelled


def recover_tasks(store: JsonStore) -> dict[str, int]:
    """Normalize durable queue state after a service restart."""
    now = _iso_now()
    counts = {"interrupted": 0, "pending": 0}

    def recover(document: dict) -> dict:
        for task_id, current in list(document.items()):
            if not isinstance(current, dict):
                continue
            rec = dict(current)
            rec["source"] = normalize_source(rec.get("source"))
            status = rec.get("status")
            if status == "running":
                rec.update(
                    status="failed",
                    completed_at=now,
                    failure_reason="服务重启导致任务中断，可重新运行",
                    verification_status=None,
                    thresholds_pass=None,
                )
                counts["interrupted"] += 1
            elif status in ("pending", "queued"):
                rec.update(
                    status="pending",
                    verification_status=None,
                    thresholds_pass=None,
                )
                rec.pop("dispatch_reserved_at", None)
                counts["pending"] += 1
            elif status == "completed":
                rec["verification_status"] = normalize_verification_status(
                    rec.get("verification_status"), rec.get("result")
                )
                if isinstance(rec.get("result"), dict):
                    rec["result"] = {
                        **rec["result"],
                        "verification_status": rec["verification_status"],
                    }
            document[task_id] = rec
        return document

    store.mutate_document(COLLECTION, recover)
    return counts


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
    source = normalize_source(source)
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
) -> bool:
    """任务成功收尾：写 completed + 验证分类 + 最新证据快照。"""
    now = _iso_now()

    completed = False

    def update(document: dict) -> dict:
        nonlocal completed
        rec = dict(document.get(task_id) or {})
        if rec.get("status") != "running":
            return document
        rec.update(
            status="completed",
            completed_at=now,
            completed_sequence=_next_sequence(document, "completed_sequence"),
            verification_status=verification_status,
            thresholds_pass=thresholds_pass,
            result=result,
            failure_reason=None,
        )
        document[task_id] = rec
        completed = True
        return document

    store.mutate_document(COLLECTION, update)
    return completed


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
    source = normalize_source(source)
    existing = store.get(COLLECTION, task_id)

    def update(current):
        rec = dict(current or {})
        if rec.get("status") in ("completed", "cancelled"):
            return rec
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


def attach_report(store: JsonStore, task_id: str, report_id: str) -> bool:
    """将统一报告库引用关联到已完成任务。"""
    attached = False

    def update(current):
        nonlocal attached
        rec = dict(current or {})
        if rec.get("status") != "completed":
            return rec
        rec["report_id"] = report_id
        attached = True
        return rec

    store.mutate(COLLECTION, task_id, update)
    return attached


def task_summary(row: dict) -> dict:
    """列表行：剔掉大块 result 曲线，只留可审计摘要字段。"""
    result = row.get("result") or {}
    out = result.get("out_of_sample") or {}
    meta = {
        "task_id": row.get("task_id"),
        "strategy_id": row.get("strategy_id"),
        "source": normalize_source(row.get("source")),
        "window": row.get("window"),
        "lookback_years": row.get("lookback_years"),
        "initial_capital": row.get("initial_capital"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "created_sequence": row.get("created_sequence"),
        "started_at": row.get("started_at"),
        "completed_at": row.get("completed_at"),
        "verification_status": (
            normalize_verification_status(row.get("verification_status"), result)
            if row.get("status") == "completed"
            else None
        ),
        "thresholds_pass": row.get("thresholds_pass"),
        "failure_reason": row.get("failure_reason"),
        "report_id": row.get("report_id"),
        "retry_of_task_id": row.get("retry_of_task_id"),
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
    rows.sort(
        key=lambda r: (
            int(r.get("created_sequence") or 0),
            str(r.get("created_at") or ""),
            str(r.get("task_id") or ""),
        ),
        reverse=True,
    )
    return rows[: max(1, min(limit, 500))]


def get_task(store: JsonStore, task_id: str) -> Optional[dict]:
    """读取单任务完整记录（包含结果与报告引用）。"""
    row = store.get(COLLECTION, task_id)
    if not isinstance(row, dict):
        return None
    projected = dict(row)
    projected["source"] = normalize_source(projected.get("source"))
    if projected.get("status") == "completed":
        projected["verification_status"] = normalize_verification_status(
            projected.get("verification_status"), projected.get("result")
        )
        if isinstance(projected.get("result"), dict):
            projected["result"] = {
                **projected["result"],
                "verification_status": projected["verification_status"],
            }
    return projected


def has_inflight(store: JsonStore, strategy_id: str) -> bool:
    """该策略是否有 pending/running 任务（防止巡检同日重复触发）。"""
    for row in (store.all(COLLECTION) or {}).values():
        if not isinstance(row, dict):
            continue
        if row.get("strategy_id") != strategy_id:
            continue
        if row.get("status") in ("pending", "queued", "running"):
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

    已归档(retired)、已淘汰(rejected)、验证未通过(not_passed) 的不再建新自动任务。
    failed/archived 仅作为旧数据兼容；insufficient 仍参与复测。
    """
    if not isinstance(strategy, dict):
        return False
    status_value = str(strategy.get("status") or "")
    if status_value not in ("candidate", "active"):
        return False
    vstatus = str(strategy.get("verification_status") or "")
    return vstatus not in ("not_passed", "archived", "failed")


# ---- 候选落池即触发首测（策略生成 → 立即自动首测，默认 lookback 年）--------
# 产品语义：hypothesize「从事件新建策略」等生成入口写入新候选后，不等每日巡检，
# 立即在后台发起默认 lookback 年首测（source=auto，写回本任务历史），
# 使新候选生成当下就有可恢复的 pending 任务。任务完成即由 runner
# 将 candidate 推进 active，验证分类不作为生效开关。


def _default_auto_lookback() -> float:
    from .config import settings

    return float(settings.auto_backtest_lookback_years)


def run_first_backtests(store: JsonStore, strategy_ids: Iterable[str]) -> dict:
    """同步跑一批刚落池候选的**首测**（source=auto，默认 lookback 年）。

    只处理尚无任何回测证据的新候选：非 candidate/active、已有 queued/running
    任务（in-flight）、或已有完成记录/backtest.ran_at 的均跳过——防与巡检/闭环重复。
    生命周期迁移由 runner 在 completed 落库后统一执行。返回计数便于日志/测试断言。
    """
    from .strategies import StrategyBacktestRunner

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
                {"strategy_id": sid, "source": "initial_auto",
                 "dedupe_key": f"initial_auto:{sid}",
                 "lookback_years": _default_auto_lookback(),
                 "oos_frac": 0.3, "min_oos_trades": 4},
                lambda m: None,
            )
            completed += 1
            logger.info("候选 %s 生成即首测完成 → %s", sid, res.get("verification_status"))
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

    store = JsonStore()
    from .strategies import StrategyBacktestRunner

    runner = StrategyBacktestRunner(store)
    prepared_ids: list[str] = []
    for sid in ids:
        params = {
            "strategy_id": sid,
            "source": "initial_auto",
            "dedupe_key": f"initial_auto:{sid}",
            "lookback_years": _default_auto_lookback(),
            "oos_frac": 0.3,
            "min_oos_trades": 4,
        }
        requested_id = uuid.uuid4().hex
        row = runner.prepare_task(requested_id, {**params, "task_id": requested_id})
        selected_id = str(row.get("task_id") or "")
        if row.get("status") == "pending" and reserve_task(store, selected_id) \
                and selected_id not in prepared_ids:
            prepared_ids.append(selected_id)

    def _run() -> None:
        for task_id in prepared_ids:
            row = get_task(store, task_id) or {}
            params = dict(row.get("request_params") or {})
            params["task_id"] = task_id
            try:
                runner.run(params, lambda _message: None)
            except Exception as exc:  # noqa: BLE001 — 单任务失败不拖垮批次
                logger.warning("生成即首测失败 task=%s: %s", task_id, exc)

    if prepared_ids:
        threading.Thread(target=_run, name="first-backtest", daemon=True).start()
    return {"enqueued": len(prepared_ids)}
