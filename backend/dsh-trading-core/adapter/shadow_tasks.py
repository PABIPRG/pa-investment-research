# -*- coding: utf-8 -*-
"""影子验证持久任务及逐策略结果账本。"""

import time
from typing import Optional

from .store import JsonStore


TASK_COLLECTION = "shadow_tasks"
RESULT_COLLECTION = "shadow_task_results"
TERMINAL_STATUSES = frozenset(
    {"completed", "partial", "failed", "cancelled", "interrupted"}
)
RESULT_STATUSES = frozenset({"success", "failed", "skipped"})


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _next_sequence(document: dict, field: str) -> int:
    return max(
        (int(row.get(field) or 0) for row in document.values() if isinstance(row, dict)),
        default=0,
    ) + 1


def normalize_source(value: object) -> str:
    return "scheduled" if str(value or "") in ("scheduled", "auto") else "manual"


def scope_key(trade_date: str, scope: str, strategy_ids: list[str]) -> str:
    subject = ",".join(sorted(str(item) for item in strategy_ids)) if scope == "single" else "all"
    return f"shadow:{trade_date}:{scope}:{subject}"


def find_latest_for_scope(
    store: JsonStore, trade_date: str, scope: str, strategy_ids: list[str]
) -> Optional[dict]:
    expected = scope_key(trade_date, scope, strategy_ids)
    matches = [
        dict(row) for row in store.all(TASK_COLLECTION).values()
        if isinstance(row, dict)
        and row.get("trade_date") == trade_date
        and scope_key(
            str(row.get("trade_date") or ""),
            str(row.get("scope") or ""),
            list(row.get("strategy_ids") or []),
        ) == expected
    ]
    matches.sort(
        key=lambda row: (int(row.get("created_sequence") or 0), str(row.get("task_id") or "")),
        reverse=True,
    )
    return matches[0] if matches else None


def create_pending_task(
    store: JsonStore,
    *,
    task_id: str,
    source: str,
    scope: str,
    strategy_ids: list[str],
    trade_date: str,
    force: bool,
    request_params: dict,
    dedupe_key: Optional[str] = None,
    rerun_of_task_id: Optional[str] = None,
) -> dict:
    now = _now()
    selected: dict = {}
    should_dispatch = True

    def insert(document: dict) -> dict:
        nonlocal selected, should_dispatch
        if task_id in document and isinstance(document[task_id], dict):
            selected = dict(document[task_id])
            should_dispatch = False
            return document
        if dedupe_key and not force:
            for current in document.values():
                if isinstance(current, dict) and current.get("dedupe_key") == dedupe_key:
                    selected = dict(current)
                    should_dispatch = False
                    return document
        selected = {
            "task_id": task_id,
            "source": normalize_source(source),
            "scope": scope,
            "strategy_ids": list(strategy_ids),
            "trade_date": trade_date,
            "force": bool(force),
            "rerun_of_task_id": rerun_of_task_id,
            "dedupe_key": dedupe_key,
            "status": "pending",
            "created_at": now,
            "created_sequence": _next_sequence(document, "created_sequence"),
            "started_at": None,
            "completed_at": None,
            "ended_at": None,
            "error": None,
            "failure_reason": None,
            "summary": {"total": len(strategy_ids), "success": 0, "failed": 0, "skipped": 0},
            "result_ids": [],
            "report_ids": [],
            "request_params": {
                key: value for key, value in dict(request_params).items()
                if key != "_cancel_event"
            },
        }
        document[task_id] = selected
        return document

    store.mutate_document(TASK_COLLECTION, insert)
    return {**selected, "should_dispatch": should_dispatch}


def claim_task(store: JsonStore, task_id: str) -> bool:
    claimed = False
    now = _now()

    def claim(current):
        nonlocal claimed
        row = dict(current or {})
        if row.get("status") != "pending":
            return row
        row.update(status="running", started_at=now)
        claimed = True
        return row

    store.mutate(TASK_COLLECTION, task_id, claim)
    return claimed


def complete_task(store: JsonStore, task_id: str) -> bool:
    completed = False
    now = _now()

    def complete(document: dict) -> dict:
        nonlocal completed
        row = dict(document.get(task_id) or {})
        if row.get("status") != "running":
            return document
        row.update(
            status="completed",
            completed_at=now,
            ended_at=now,
            completed_sequence=_next_sequence(document, "completed_sequence"),
            error=None,
            failure_reason=None,
        )
        document[task_id] = row
        completed = True
        return document

    store.mutate_document(TASK_COLLECTION, complete)
    return completed


def save_strategy_result(
    store: JsonStore,
    *,
    task_id: str,
    strategy_id: str,
    status: str,
    reason: Optional[str],
    snapshot: Optional[dict],
    trade_date: str,
    started_at: Optional[str] = None,
    completed_at: Optional[str] = None,
) -> dict:
    if status not in RESULT_STATUSES:
        raise ValueError(f"非法逐策略状态: {status}")
    result_id = f"{task_id}:{strategy_id}"
    started = started_at or _now()
    completed = completed_at or _now()
    row = {
        "result_id": result_id,
        "task_id": task_id,
        "strategy_id": strategy_id,
        "status": status,
        "reason": reason,
        "started_at": started,
        "completed_at": completed,
        "report_id": None,
        "equity_ref": {
            "collection": "shadow_equity",
            "key": trade_date,
            "task_id": task_id,
        },
        "snapshot": dict(snapshot) if isinstance(snapshot, dict) else None,
    }
    store.set(RESULT_COLLECTION, result_id, row)

    def attach(current):
        task = dict(current or {})
        result_ids = list(task.get("result_ids") or [])
        if result_id not in result_ids:
            result_ids.append(result_id)
        task["result_ids"] = result_ids
        return task

    store.mutate(TASK_COLLECTION, task_id, attach)
    return dict(row)


def list_task_results(store: JsonStore, task_id: str) -> list[dict]:
    task = get_task(store, task_id) or {}
    rows = []
    for result_id in task.get("result_ids") or []:
        row = store.get(RESULT_COLLECTION, str(result_id))
        if isinstance(row, dict):
            rows.append(dict(row))
    return rows


def aggregate_status(results: list[dict]) -> str:
    counts = {
        status: sum(1 for row in results if row.get("status") == status)
        for status in ("success", "failed", "skipped")
    }
    total = len(results)
    if total and counts["failed"] == total:
        return "failed"
    elif total and counts["skipped"] == total:
        return "completed"
    elif counts["success"] == total:
        return "completed"
    return "partial"


def finalize_task(
    store: JsonStore,
    task_id: str,
    *,
    overall_nav: Optional[float],
    result: Optional[dict] = None,
) -> bool:
    results = list_task_results(store, task_id)
    counts = {
        status: sum(1 for row in results if row.get("status") == status)
        for status in ("success", "failed", "skipped")
    }
    total = len(results)
    aggregate = aggregate_status(results)
    now = _now()
    finalized = False

    def update(document: dict) -> dict:
        nonlocal finalized
        task = dict(document.get(task_id) or {})
        if task.get("status") != "running":
            return document
        task.update(
            status=aggregate,
            completed_at=now,
            ended_at=now,
            completed_sequence=_next_sequence(document, "completed_sequence"),
            error=None if aggregate != "failed" else "全部策略运行失败",
            failure_reason=None if aggregate != "failed" else "全部策略运行失败",
            summary={
                "total": total,
                "success": counts["success"],
                "failed": counts["failed"],
                "skipped": counts["skipped"],
                "overall_nav": overall_nav,
                "all_skipped": counts["skipped"] == total,
            },
            result=dict(result) if isinstance(result, dict) else None,
        )
        document[task_id] = task
        finalized = True
        return document

    store.mutate_document(TASK_COLLECTION, update)
    return finalized


def attach_report(store: JsonStore, task_id: str, report_id: str) -> bool:
    attached = False

    def update(current):
        nonlocal attached
        task = dict(current or {})
        if task.get("status") not in TERMINAL_STATUSES:
            return task
        report_ids = list(task.get("report_ids") or [])
        if report_id not in report_ids:
            report_ids.append(report_id)
        task["report_ids"] = report_ids
        task["report_id"] = report_id
        attached = True
        return task

    store.mutate(TASK_COLLECTION, task_id, update)
    if not attached:
        return False
    for result in list_task_results(store, task_id):
        result_id = str(result.get("result_id") or "")
        if result_id:
            store.update(RESULT_COLLECTION, result_id, report_id=report_id)
    return True


def recover_tasks(store: JsonStore) -> dict[str, int]:
    now = _now()
    counts = {"interrupted": 0}

    def recover(document: dict) -> dict:
        for task_id, current in list(document.items()):
            if not isinstance(current, dict) or current.get("status") not in ("pending", "running"):
                continue
            row = dict(current)
            reason = "服务重启导致影子验证任务中断，可重新运行"
            row.update(
                status="interrupted",
                completed_at=now,
                ended_at=now,
                error=reason,
                failure_reason=reason,
            )
            document[task_id] = row
            counts["interrupted"] += 1
        return document

    store.mutate_document(TASK_COLLECTION, recover)
    return counts


def get_task(store: JsonStore, task_id: str) -> Optional[dict]:
    row = store.get(TASK_COLLECTION, task_id)
    return dict(row) if isinstance(row, dict) else None


def get_task_with_results(store: JsonStore, task_id: str) -> Optional[dict]:
    task = get_task(store, task_id)
    if task is None:
        return None
    return {**task, "results": list_task_results(store, task_id)}


def task_summary(store: JsonStore, row: dict) -> dict:
    summary = {key: value for key, value in row.items() if key not in ("result", "request_params")}
    summary["results"] = list_task_results(store, str(row.get("task_id") or ""))
    return summary


def list_tasks(store: JsonStore, *, strategy_id: Optional[str] = None, limit: int = 200) -> list[dict]:
    rows = []
    for current in store.all(TASK_COLLECTION).values():
        if not isinstance(current, dict):
            continue
        if strategy_id and strategy_id not in (current.get("strategy_ids") or []):
            continue
        rows.append(task_summary(store, dict(current)))
    rows.sort(
        key=lambda row: (
            int(row.get("created_sequence") or 0),
            str(row.get("created_at") or ""),
            str(row.get("task_id") or ""),
        ),
        reverse=True,
    )
    return rows[: max(1, min(int(limit), 500))]


def latest_task(store: JsonStore) -> Optional[dict]:
    rows = list_tasks(store, limit=1)
    return rows[0] if rows else None


def fail_task(store: JsonStore, task_id: str, reason: str) -> bool:
    failed = False
    now = _now()

    def update(current):
        nonlocal failed
        task = dict(current or {})
        if task.get("status") not in ("pending", "running", "completed", "partial"):
            return task
        task.update(
            status="failed", completed_at=now, ended_at=now,
            error=reason, failure_reason=reason,
        )
        failed = True
        return task

    store.mutate(TASK_COLLECTION, task_id, update)
    return failed


def cancel_task(store: JsonStore, task_id: str) -> bool:
    cancelled = False
    now = _now()

    def update(current):
        nonlocal cancelled
        task = dict(current or {})
        if task.get("status") not in ("pending", "running"):
            return task
        reason = "用户取消影子验证任务"
        task.update(
            status="cancelled", completed_at=now, ended_at=now,
            error=reason, failure_reason=reason,
        )
        cancelled = True
        return task

    store.mutate(TASK_COLLECTION, task_id, update)
    return cancelled
