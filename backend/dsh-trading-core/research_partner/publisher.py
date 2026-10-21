# -*- coding: utf-8 -*-
"""Outbox 发布器：把委托领域事件转成统一事件信封并写入收件箱。

首期在进程内完成；后续接消息总线时保持同一事件 ID（outbox_id），
消费方按 event_id 去重。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from .models import EventEnvelope, OutboxMessage
from .ports import BusinessStore


class OutboxPublisher:
    def __init__(
        self, store: BusinessStore, *, now: Callable[[], datetime] | None = None
    ) -> None:
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))

    def publish(self, limit: int = 50) -> int:
        messages = self.store.claim_outbox(limit=limit, now=self._now())
        published = 0
        for message in messages:
            try:
                self.store.record_event(self._envelope(message))
            except Exception as exc:  # 单条失败不阻塞其余事件
                self.store.mark_outbox(message.outbox_id, "failed", str(exc))
                continue
            self.store.mark_outbox(message.outbox_id, "published")
            published += 1
        return published

    def _envelope(self, message: OutboxMessage) -> EventEnvelope:
        at = self._now()
        return EventEnvelope(
            event_id=message.outbox_id,
            hook_type=message.event_type,
            producer="research-partner",
            occurred_at=message.created_at,
            observed_at=at,
            subject_ids=self._subjects(message),
            correlation_id=message.aggregate_id,
            payload=message.payload,
        )

    def _subjects(self, message: OutboxMessage) -> list[str]:
        if message.aggregate_type != "mandate":
            return []
        revision = message.payload.get("revision")
        if not isinstance(revision, int):
            return []
        return [
            item.entity_id
            for item in self.store.list_subjects(message.aggregate_id, revision)
        ]
