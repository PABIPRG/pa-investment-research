# -*- coding: utf-8 -*-
"""策略自进化事件的委托核心侧出口（outbox）。

自进化闭环每日跑完一轮后，把“本轮完成”和“策略阶段变化”落成统一事件信封，
先写入本地 outbox，再交给委托核心（``research_partner`` 存储）。跨库无法共享
事务，所以投递成功才标记已发布；失败保留待发，事件标识确定，重试幂等。

只有用户显式创建的委托会订阅这些事件——旧策略不会自动转成生效委托
（V1.3 §6.1：可迁入新版委托的持续事项必须具有明确的用户授权依据）。
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable

from .store import JsonStore

OUTBOX_COLLECTION = "evolution_previews"
OUTBOX_KEY = "_mandate_outbox"
PUBLISHED_KEY = "_mandate_outbox_published"
_MAX_PUBLISHED = 200

PRODUCER = "trading-core-evolution"
POOL_SUBJECT = "strategy_pool:default"
COMPLETED_HOOK = "strategy.evolution_completed"
CHANGED_HOOK = "strategy.condition_changed"

# 动作类型 → 阶段变化；用于事件 payload 与委托侧摘要，避免各自维护映射。
_STAGE_TRANSITIONS = {
    "promote": ("watch", "active"),
    "demote": ("active", "watch"),
    "retire": ("active", "retired"),
    "mutate": ("candidate", "candidate"),
}


def strategy_subject(strategy_id: str) -> str:
    return f"strategy:{strategy_id}"


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


def _envelope(
    *,
    event_id: str,
    hook_type: str,
    occurred_at: str,
    observed_at: str,
    subject_ids: list[str],
    payload: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    content_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return {
        "event_id": event_id,
        "hook_type": hook_type,
        "schema_version": "1",
        "producer": PRODUCER,
        "occurred_at": occurred_at,
        "observed_at": observed_at,
        "subject_ids": subject_ids,
        "content_hash": content_hash,
        "correlation_id": run_id,
        "origin_run_id": run_id,
        "payload": payload,
    }


def closed_loop_events(
    *,
    run_id: str,
    occurred_at: datetime,
    actions: Iterable[dict[str, Any]],
    status_value: str,
) -> list[dict[str, Any]]:
    """构造一轮闭环的事件：每个动作一条阶段变化 + 一条本轮完成。

    ``run_id`` 由日期构成，同一轮重复登记会得到相同 ``event_id``，
    因此写入与投递都可重入。
    """

    at = occurred_at.astimezone(timezone.utc).isoformat()
    action_list = [item for item in actions if isinstance(item, dict)]
    events: list[dict[str, Any]] = []
    for action in action_list:
        action_type = str(action.get("type") or "").strip()
        strategy_id = str(action.get("sid") or "").strip()
        if not action_type or not strategy_id:
            continue
        from_stage, to_stage = _STAGE_TRANSITIONS.get(
            action_type, ("unknown", "unknown")
        )
        events.append(
            _envelope(
                event_id=f"strategy-change:{run_id}:{strategy_id}:{action_type}",
                hook_type=CHANGED_HOOK,
                occurred_at=at,
                observed_at=at,
                subject_ids=[strategy_subject(strategy_id), POOL_SUBJECT],
                payload={
                    "event_type": action_type,
                    "run_id": run_id,
                    "strategy_id": strategy_id,
                    "from_stage": from_stage,
                    "to_stage": to_stage,
                    "reason": str(action.get("reason") or ""),
                    "parent": action.get("parent"),
                },
                run_id=run_id,
            )
        )
    events.append(
        _envelope(
            event_id=f"strategy-evolution:{run_id}",
            hook_type=COMPLETED_HOOK,
            occurred_at=at,
            observed_at=at,
            subject_ids=[POOL_SUBJECT]
            + [strategy_subject(str(item.get("sid"))) for item in action_list if item.get("sid")],
            payload={
                "run_id": run_id,
                "status": status_value,
                "action_count": len(action_list),
                "actions": _json_safe(
                    [
                        {
                            "type": item.get("type"),
                            "sid": item.get("sid"),
                            "reason": item.get("reason"),
                        }
                        for item in action_list
                    ]
                ),
            },
            run_id=run_id,
        )
    )
    return events


def stage_events(store: JsonStore, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """把新事件追加到 outbox；已在待发/已发布中的标识不会重复登记。"""

    incoming = [event for event in events if event.get("event_id")]
    if not incoming:
        return []

    added: list[dict[str, Any]] = []

    def update(document: dict) -> dict:
        outbox = [
            item
            for item in document.get(OUTBOX_KEY, []) or []
            if isinstance(item, dict)
        ]
        known = {str(item.get("event_id")) for item in outbox}
        published = [
            item
            for item in document.get(PUBLISHED_KEY, []) or []
            if isinstance(item, dict)
        ]
        known.update(str(item.get("event_id")) for item in published)
        for event in incoming:
            if event["event_id"] in known:
                continue
            known.add(event["event_id"])
            added.append(event)
            outbox.append(event)
        return {**document, OUTBOX_KEY: outbox}

    # 变换在单次文件锁内完成，闭包收集的就是实际新增的事件。
    store.mutate_document(OUTBOX_COLLECTION, update)
    return added


def pending_events(store: JsonStore) -> list[dict[str, Any]]:
    records = store.get(OUTBOX_COLLECTION, OUTBOX_KEY, []) or []
    return [
        record
        for record in records
        if isinstance(record, dict) and record.get("event_id")
    ]


def _to_envelope(record: dict[str, Any]) -> Any:
    from research_partner.models import EventEnvelope

    return EventEnvelope(
        event_id=record["event_id"],
        hook_type=record["hook_type"],
        schema_version=record.get("schema_version", "1"),
        producer=record.get("producer", PRODUCER),
        occurred_at=record["occurred_at"],
        observed_at=record.get("observed_at") or record["occurred_at"],
        subject_ids=list(record.get("subject_ids") or []),
        content_hash=record.get("content_hash"),
        correlation_id=record.get("correlation_id"),
        causation_id=record.get("causation_id"),
        origin_run_id=record.get("origin_run_id"),
        payload=dict(record.get("payload") or {}),
    )


def mark_published(
    store: JsonStore, event_ids: set[str], *, now: datetime | None = None
) -> None:
    if not event_ids:
        return
    now = now or datetime.now(timezone.utc)

    def update(document: dict) -> dict:
        moving = [
            {**record, "published_at": now.isoformat()}
            for record in document.get(OUTBOX_KEY, []) or []
            if isinstance(record, dict) and record.get("event_id") in event_ids
        ]
        remaining = [
            record
            for record in document.get(OUTBOX_KEY, []) or []
            if not (isinstance(record, dict) and record.get("event_id") in event_ids)
        ]
        audit = list(document.get(PUBLISHED_KEY, []) or [])
        audit.extend(moving)
        return {
            **document,
            OUTBOX_KEY: remaining,
            PUBLISHED_KEY: audit[-_MAX_PUBLISHED:],
        }

    store.mutate_document(OUTBOX_COLLECTION, update)


def publish_pending(
    store: JsonStore, sink, *, now: datetime | None = None
) -> dict[str, Any]:
    """把待发事件写入 ``sink``（需提供 ``record_event(envelope)``）。"""

    now = now or datetime.now(timezone.utc)
    published: list[str] = []
    failed: list[dict[str, str]] = []
    for record in pending_events(store):
        try:
            envelope = _to_envelope(record)
            sink.record_event(envelope)
        except Exception as exc:  # noqa: BLE001 — 单条失败保留待发，不中断整批
            failed.append({"event_id": str(record.get("event_id")), "error": str(exc)})
            continue
        published.append(envelope.event_id)
    mark_published(store, set(published), now=now)
    return {
        "published": len(published),
        "failed": failed,
        "pending": len(pending_events(store)),
    }


def publish_to_partner(store: JsonStore, *, now: datetime | None = None) -> dict[str, Any]:
    """把待发事件直接交给委托核心的存储；装配失败不影响闭环留痕。"""

    try:
        from research_partner.factory import build_store
    except Exception as exc:  # noqa: BLE001 — 独立部署时委托核心可能不存在
        return {"published": 0, "failed": [], "pending": None, "error": str(exc)}
    partner_store = build_store()
    try:
        return publish_pending(store, partner_store, now=now)
    finally:
        partner_store.close()


def stage_closed_loop(
    store: JsonStore,
    *,
    run_id: str,
    occurred_at: datetime,
    actions: Iterable[dict[str, Any]],
    status_value: str,
) -> list[dict[str, Any]]:
    """闭环留痕后的便捷入口：构造并登记事件，返回本次新增的事件。"""

    return stage_events(
        store,
        closed_loop_events(
            run_id=run_id,
            occurred_at=occurred_at,
            actions=actions,
            status_value=status_value,
        ),
    )
