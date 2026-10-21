# -*- coding: utf-8 -*-
"""把一次工具执行转换为可持久化、可引用的证据。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from ..models import EvidenceBundle, EvidenceItem
from .contracts import ToolResult

_GAP_STATUSES = ("empty", "unavailable", "error", "needs_authorization")


def evidence_from_result(
    request_id: str,
    result: ToolResult,
    *,
    evidence_id: str | None = None,
) -> EvidenceItem:
    return EvidenceItem(
        evidence_id=evidence_id or f"EV_{uuid4().hex}",
        request_id=request_id,
        tool_id=result.tool_id,
        status=result.status,
        entity_ids=list(result.entity_ids),
        source=result.source,
        fetched_at=result.fetched_at,
        record_count=result.record_count,
        data=dict(result.data),
        warnings=list(result.warnings),
        error=result.error,
        duration_ms=result.duration_ms,
        authorization=result.authorization,
        cache_hit=result.cache_hit,
    )


def build_bundle(
    request_id: str,
    items: list[EvidenceItem],
    *,
    created_at: datetime | None = None,
) -> EvidenceBundle:
    summary: dict[str, int] = {}
    gaps: list[dict] = []
    for item in items:
        summary[item.status] = summary.get(item.status, 0) + 1
        if item.status in _GAP_STATUSES:
            reason = (
                item.error
                or str(item.data.get("reason") or "")
                or (item.warnings[0] if item.warnings else "")
            )
            gaps.append(
                {
                    "tool_id": item.tool_id,
                    "status": item.status,
                    "entity_ids": list(item.entity_ids),
                    "evidence_id": item.evidence_id,
                    "reason": reason,
                }
            )
    return EvidenceBundle(
        request_id=request_id,
        created_at=created_at or datetime.now(timezone.utc),
        items=items,
        summary=summary,
        gaps=gaps,
    )
