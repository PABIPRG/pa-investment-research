# -*- coding: utf-8 -*-
"""把委托版本中的触发条件编译成可路由的追踪依赖。

规则：
- 依赖只描述“什么事件可能需要复核这个委托”，不表达条件是否成立。
- 同一版本内按 (hook_type, subject_id, event_type, feature_key, scope_key) 去重。
- 显式 ``subject_ids`` 优先；否则继承版本主体；都没有则是全局依赖。
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Iterable, Sequence

from .errors import InvalidRequest
from .models import HOOK_PATTERN, MandateSubject, TrackingDependency

_HOOK_RE = re.compile(HOOK_PATTERN)


def dependency_id(
    mandate_id: str,
    revision: int,
    *,
    hook_type: str,
    subject_id: str | None,
    event_type: str | None,
    feature_key: str | None,
    scope_key: str | None,
) -> str:
    raw = "|".join(
        [
            mandate_id,
            str(revision),
            hook_type,
            subject_id or "",
            event_type or "",
            feature_key or "",
            scope_key or "",
        ]
    )
    return "dep_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def compile_dependencies(
    mandate_id: str,
    revision: int,
    *,
    subjects: Sequence[MandateSubject],
    triggers: Iterable[dict],
    now: datetime,
) -> list[TrackingDependency]:
    """只接受已经过 schema 校验的触发器；未知字段在这里被忽略。"""

    default_subjects = [item.entity_id for item in subjects]
    compiled: dict[str, TrackingDependency] = {}
    for trigger in triggers:
        hook_type = str(trigger.get("hook_type") or "").strip()
        if not _HOOK_RE.match(hook_type):
            raise InvalidRequest(f"不支持的触发类型: {hook_type!r}")
        event_type = trigger.get("event_type") or None
        feature_key = trigger.get("feature_key") or None
        scope_key = trigger.get("scope_key") or None
        rule_version = str(trigger.get("rule_version") or "1")
        explicit = trigger.get("subject_ids")
        if explicit is None:
            target_subjects: list[str | None] = default_subjects or [None]
        else:
            target_subjects = list(explicit) or [None]
        for subject_id in target_subjects:
            dep_id = dependency_id(
                mandate_id,
                revision,
                hook_type=hook_type,
                subject_id=subject_id,
                event_type=event_type,
                feature_key=feature_key,
                scope_key=scope_key,
            )
            compiled[dep_id] = TrackingDependency(
                dependency_id=dep_id,
                mandate_id=mandate_id,
                revision=revision,
                hook_type=hook_type,
                subject_id=subject_id,
                event_type=event_type,
                feature_key=feature_key,
                scope_key=scope_key,
                rule_version=rule_version,
                created_at=now,
            )
    return list(compiled.values())
