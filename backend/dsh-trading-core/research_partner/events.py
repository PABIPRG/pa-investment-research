# -*- coding: utf-8 -*-
"""委托领域事件的 outbox 工厂。

业务状态与事件在同一事务写出；发布由 worker 负责，命令层不直接调用通知。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

from .models import OutboxMessage


def mandate_event(
    event_type: str,
    mandate_id: str,
    *,
    revision: int,
    payload: dict[str, Any] | None = None,
    occurred_at: datetime | None = None,
) -> OutboxMessage:
    at = occurred_at or datetime.now(timezone.utc)
    return OutboxMessage(
        outbox_id=f"OUT_{secrets.token_hex(16)}",
        aggregate_type="mandate",
        aggregate_id=mandate_id,
        event_type=event_type,
        payload={"mandate_id": mandate_id, "revision": revision, **(payload or {})},
        available_at=at,
        created_at=at,
    )
