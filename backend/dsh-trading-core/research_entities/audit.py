# -*- coding: utf-8 -*-
"""审计事件构造与敏感字段脱敏。

审计记录抽取、消歧、Scope 与工具推荐的依据，不记录凭证与完整敏感数据。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from .models import AuditEvent

_SENSITIVE_MARKERS = (
    "password", "passwd", "secret", "token", "api_key", "apikey",
    "authorization", "cookie", "credential", "private_key",
)


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if any(marker in lowered for marker in _SENSITIVE_MARKERS):
                result[str(key)] = "[REDACTED]"
            else:
                result[str(key)] = redact(item)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def make_event(
    *,
    request_id: str,
    stage: str,
    payload: dict[str, Any],
    event_id: str | None = None,
    created_at: datetime | None = None,
) -> AuditEvent:
    return AuditEvent(
        event_id=event_id or f"AUDIT_{uuid.uuid4().hex}",
        request_id=request_id,
        stage=stage,
        created_at=created_at or datetime.now(timezone.utc),
        payload=redact(payload),
    )
