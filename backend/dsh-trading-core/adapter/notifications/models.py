# -*- coding: utf-8 -*-
"""通知事件与固定业务分类。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping


class NotificationValidationError(ValueError):
    """通知事件不符合已注册的确定性契约。"""


EVENT_REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "market.price_alert.triggered.v1": ("securityName", "ruleName", "condition"),
    "market.event.matched.v1": ("headline", "sourceName"),
    "research.brief.completed.v1": ("briefId", "briefName"),
    "research.brief.failed.v1": ("briefName", "reasonCode"),
    "portfolio.plan.due.v1": ("planId", "planName", "dueAt"),
    "portfolio.plan.threshold_reached.v1": ("planId", "planName", "triggerName"),
    "portfolio.plan.expired.v1": ("planId", "planName"),
    "portfolio.plan.reconciliation_required.v1": ("planId", "planName", "reasonCode"),
    "holdings.snapshot.changed.v1": ("syncRunId", "sourceName", "changeSummary"),
    "holdings.sync.action_required.v1": ("sourceName", "reasonCode"),
    "holdings.sync.failed.v1": ("sourceName", "reasonCode", "retryable"),
    "holdings.sync.stale.v1": ("sourceName", "lastSuccessfulAt"),
    "holdings.sync.recovered.v1": ("sourceName", "recoveredAt"),
    "evolution.closed_loop.completed.v1": ("runId", "summary"),
}

SUBJECT_KINDS = {"security", "portfolio-plan", "holdings-sync", "report", "evolution", "none"}


def _required_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise NotificationValidationError(f"{field} 必须是非空字符串")
    return value.strip()


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise NotificationValidationError(f"{field} 必须是 ISO-8601 时间")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise NotificationValidationError(f"{field} 必须是 ISO-8601 时间") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise NotificationValidationError(f"{field} 必须包含时区")
    return result.astimezone(timezone.utc)


@dataclass(frozen=True)
class NotificationEvent:
    """业务模块在状态提交后发布的不可变事实。"""

    event_id: str
    schema_version: int
    event_type: str
    producer: str
    occurred_at: datetime
    subject_kind: str
    subject_id: str
    payload: dict[str, Any]
    correlation_id: str | None = None
    causation_id: str | None = None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "NotificationEvent":
        if not isinstance(value, Mapping):
            raise NotificationValidationError("通知事件必须是对象")
        schema_version = value.get("schemaVersion")
        if schema_version != 1:
            raise NotificationValidationError("不支持的通知事件版本")
        event_type = _required_text(value.get("type"), "type")
        required = EVENT_REQUIREMENTS.get(event_type)
        if required is None:
            raise NotificationValidationError(f"不支持的通知事件类型: {event_type}")
        raw_subject = value.get("subject")
        if not isinstance(raw_subject, Mapping):
            raise NotificationValidationError("subject 必须是对象")
        subject_kind = _required_text(raw_subject.get("kind"), "subject.kind")
        if subject_kind not in SUBJECT_KINDS:
            raise NotificationValidationError("subject.kind 不在允许范围内")
        subject_id = _required_text(raw_subject.get("id"), "subject.id")
        raw_payload = value.get("payload")
        if not isinstance(raw_payload, Mapping):
            raise NotificationValidationError("payload 必须是对象")
        payload = dict(raw_payload)
        missing = [field for field in required if field not in payload]
        if missing:
            raise NotificationValidationError(f"payload 缺少字段: {', '.join(missing)}")
        for field in required:
            if field in {"retryable"}:
                if not isinstance(payload[field], bool):
                    raise NotificationValidationError(f"payload.{field} 必须是布尔值")
            elif not isinstance(payload[field], (str, int, float)) or payload[field] == "":
                raise NotificationValidationError(f"payload.{field} 不能为空")
        return cls(
            event_id=_required_text(value.get("eventId"), "eventId"),
            schema_version=1,
            event_type=event_type,
            producer=_required_text(value.get("producer"), "producer"),
            occurred_at=_timestamp(value.get("occurredAt"), "occurredAt"),
            subject_kind=subject_kind,
            subject_id=subject_id,
            payload=payload,
            correlation_id=(str(value["correlationId"]).strip() or None) if value.get("correlationId") is not None else None,
            causation_id=(str(value["causationId"]).strip() or None) if value.get("causationId") is not None else None,
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "eventId": self.event_id,
            "schemaVersion": self.schema_version,
            "type": self.event_type,
            "producer": self.producer,
            "occurredAt": self.occurred_at.isoformat(),
            "subject": {"kind": self.subject_kind, "id": self.subject_id},
            "payload": dict(self.payload),
            "correlationId": self.correlation_id,
            "causationId": self.causation_id,
        }
