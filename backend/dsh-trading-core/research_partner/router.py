# -*- coding: utf-8 -*-
"""事件路由：按追踪依赖把外部事件转成持久研究任务。

只负责“是否需要复核”，不判断条件是否成立，也不决定是否联系用户。
同一 (mandate_id, revision, event_id) 只会产生一个任务。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Callable

from .errors import Conflict
from .models import EventEnvelope, ResearchJob
from .ports import BusinessStore

_BASELINE_HOOKS = {"mandate.created", "mandate.requirements_completed"}

# 到期事件按联系规则决定下游动作：直接提醒不做研究，定时交付要产出本次成果，
# 周期检查按条件判断是否需要说话。
_ACTION_BY_MODE = {
    "due_reminder": "due_reminder",
    "scheduled_delivery": "scheduled_delivery",
    "periodic_check": "periodic_check",
}


class EventRouter:
    def __init__(
        self, store: BusinessStore, *, now: Callable[[], datetime] | None = None
    ) -> None:
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))

    def route(self, limit: int = 100) -> int:
        claimed = self.store.claim_inbox(limit=limit, now=self._now())
        created = 0
        for record in claimed:
            try:
                created += self._route_one(record.event_id)
            except Exception as exc:
                self.store.mark_inbox(record.event_id, "failed", str(exc))
            else:
                self.store.mark_inbox(record.event_id, "processed")
        return created

    def _route_one(self, event_id: str) -> int:
        envelope = self.store.get_event(event_id)
        if envelope is None:
            raise ValueError(f"事件 {event_id} 不在事件表中")
        now = self._now()
        created = 0

        if envelope.hook_type in _BASELINE_HOOKS:
            created += self._create_baseline_job(envelope, now)

        event_type = envelope.payload.get("event_type")
        if event_type is not None and not isinstance(event_type, str):
            event_type = None
        dependencies = self.store.find_active_dependencies(
            hook_type=envelope.hook_type,
            subject_ids=list(envelope.subject_ids),
            event_type=event_type,
        )
        feature_key = envelope.payload.get("feature_key")
        if envelope.hook_type == "investment.facts_revised" and isinstance(feature_key, str):
            # 只复核依赖这条事实的委托：限定 feature_key 的依赖必须精确匹配，
            # 未限定 feature_key 的依赖表示“该主体下任何事实变化都值得复核”。
            dependencies = [
                dependency
                for dependency in dependencies
                if dependency.feature_key in (None, feature_key)
            ]
        seen: set[tuple[str, int]] = set()
        for dependency in dependencies:
            key = (dependency.mandate_id, dependency.revision)
            if key in seen:
                continue
            seen.add(key)
            action = "event_review"
            if envelope.hook_type == "schedule.due":
                action = self._schedule_action(envelope, dependency.mandate_id, dependency.revision)
                if action is None:
                    continue
            created += self._create_job(
                mandate_id=dependency.mandate_id,
                revision=dependency.revision,
                event_id=envelope.event_id,
                action=action,
                dedupe_key=f"job:{envelope.event_id}:{dependency.mandate_id}:{dependency.revision}",
                now=now,
            )
        return created

    @staticmethod
    def _schedule_action(
        envelope: EventEnvelope, mandate_id: str, revision: int
    ) -> str | None:
        """日程事件只对产生它的委托版本生效，避免旧版本日程误触发。"""

        if envelope.payload.get("mandate_id") != mandate_id:
            return None
        if envelope.payload.get("revision") != revision:
            return None
        return _ACTION_BY_MODE.get(envelope.payload.get("mode"), "periodic_check")

    def _create_baseline_job(self, envelope: EventEnvelope, now: datetime) -> int:
        mandate_id = envelope.payload.get("mandate_id")
        revision = envelope.payload.get("revision")
        if not isinstance(mandate_id, str) or not isinstance(revision, int):
            return 0
        mandate = self.store.get_mandate_internal(mandate_id)
        if mandate is None or mandate.status != "tracking":
            return 0
        return self._create_job(
            mandate_id=mandate_id,
            revision=revision,
            event_id=envelope.event_id,
            action="baseline_review",
            dedupe_key=f"baseline:{mandate_id}:{revision}",
            now=now,
        )

    def _create_job(
        self,
        *,
        mandate_id: str,
        revision: int,
        event_id: str,
        action: str,
        dedupe_key: str,
        now: datetime,
    ) -> int:
        job = ResearchJob(
            job_id=f"JOB_{secrets.token_hex(16)}",
            mandate_id=mandate_id,
            mandate_revision=revision,
            trigger_event_id=event_id,
            action=action,
            status="pending",
            next_run_at=now,
            dedupe_key=dedupe_key,
            budget={"max_attempts": 3},
            created_at=now,
            updated_at=now,
        )
        try:
            self.store.create_job(job)
        except Conflict:
            return 0
        return 1
