# -*- coding: utf-8 -*-
"""投资事实修订事件的投资记录侧出口（outbox）。

修订与事件在同一份 holdings 文档里原子落盘（``investment_outbox``），本模块负责
把尚未投递的事件交给委托核心。跨库无法共享事务，所以采用标准的“先落库、后投递”
模式：投递成功才标记已发布；投递失败保留待发，重试幂等（事件标识确定）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .store import JsonStore

OUTBOX_KEY = "investment_outbox"
_MAX_PUBLISHED = 200


def pending_events(store: JsonStore) -> list[dict[str, Any]]:
    records = store.get("holdings", OUTBOX_KEY, []) or []
    return [
        record
        for record in records
        if isinstance(record, dict) and record.get("event_id")
    ]


def _to_envelope(record: dict[str, Any]) -> Any:
    # 延迟导入：投资记录侧不依赖委托核心的包结构，只有桥接时才需要信封类型。
    from research_partner.models import EventEnvelope

    return EventEnvelope(
        event_id=record["event_id"],
        hook_type=record["hook_type"],
        schema_version=record.get("schema_version", "1"),
        producer=record.get("producer", "trading-core-investment-records"),
        occurred_at=record["occurred_at"],
        observed_at=record.get("observed_at") or record["occurred_at"],
        subject_ids=list(record.get("subject_ids") or []),
        content_hash=record.get("content_hash"),
        correlation_id=record.get("correlation_id"),
        causation_id=record.get("causation_id"),
        origin_run_id=record.get("origin_run_id"),
        payload=dict(record.get("payload") or {}),
    )


def mark_published(store: JsonStore, event_ids: set[str], *, now: datetime | None = None) -> None:
    """把已投递事件移入 ``_published`` 尾部，保留有限审计。"""

    if not event_ids:
        return
    now = now or datetime.now(timezone.utc)

    def update(document: dict) -> dict:
        published = [
            record
            for record in document.get(OUTBOX_KEY, []) or []
            if isinstance(record, dict) and record.get("event_id") in event_ids
        ]
        for record in published:
            record["published_at"] = now.isoformat()
        remaining = [
            record
            for record in document.get(OUTBOX_KEY, []) or []
            if not (isinstance(record, dict) and record.get("event_id") in event_ids)
        ]
        audit = list(document.get("investment_outbox_published", []) or [])
        audit.extend(published)
        return {
            **document,
            OUTBOX_KEY: remaining,
            "investment_outbox_published": audit[-_MAX_PUBLISHED:],
        }

    store.mutate_document("holdings", update)


def publish_pending(store: JsonStore, sink, *, now: datetime | None = None) -> dict[str, Any]:
    """把待发事件写入 ``sink``（需提供 ``record_event(envelope)``）。

    返回 ``{"published": n, "failed": [...], "pending": n}``；单条失败不影响其余，
    也不会丢掉事件——下次调用会重试同一事件标识。
    """

    now = now or datetime.now(timezone.utc)
    published: list[str] = []
    failed: list[dict[str, str]] = []
    for record in pending_events(store):
        try:
            envelope = _to_envelope(record)
            sink.record_event(envelope)
        except Exception as exc:  # noqa: BLE001 — 单条事件失败留下重试，不中断整批
            failed.append({"event_id": str(record.get("event_id")), "error": str(exc)})
            continue
        published.append(envelope.event_id)
    mark_published(store, set(published), now=now)
    return {
        "published": len(published),
        "failed": failed,
        "pending": len(pending_events(store)),
    }


def drain_to_jsonl(store: JsonStore, path, *, now: datetime | None = None) -> int:
    """开发/联调用的文件出口：避免联调时必须先启动委托服务。"""

    now = now or datetime.now(timezone.utc)
    records = pending_events(store)
    if not records:
        return 0
    with open(path, "a", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps({**record, "published_at": now.isoformat()}, ensure_ascii=False) + "\n")
    mark_published(store, {record["event_id"] for record in records}, now=now)
    return len(records)
