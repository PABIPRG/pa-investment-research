# -*- coding: utf-8 -*-
"""研究委托核心的持久化端口。

命令层只依赖这里的接口；SQLite 之外的适配器必须通过同一组契约测试。
所有返回对象都是领域模型，不暴露 sqlite3.Row 或连接。
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from datetime import datetime
from typing import Protocol, Sequence, runtime_checkable

from .models import (
    ConditionState,
    ContactDecision,
    ContactRecord,
    EventEnvelope,
    IdempotentResponse,
    InboxRecord,
    Mandate,
    MandateRequirement,
    MandateRevision,
    MandateSchedule,
    MandateSubject,
    NotificationPreferences,
    OutboxMessage,
    ResearchJob,
    ResearchJobResult,
    SnoozeEntry,
    TrackingDependency,
)


@runtime_checkable
class MandateRepository(Protocol):
    def transaction(self) -> AbstractContextManager[None]: ...

    def create_mandate(
        self,
        mandate: Mandate,
        revision: MandateRevision,
        *,
        subjects: Sequence[MandateSubject] = (),
        requirements: Sequence[MandateRequirement] = (),
        dependencies: Sequence[TrackingDependency] = (),
        outbox: Sequence[OutboxMessage] = (),
    ) -> None: ...

    def import_mandate(
        self,
        mandate: Mandate,
        revisions: Sequence[MandateRevision],
        *,
        subjects: Sequence[MandateSubject] = (),
        requirements: Sequence[MandateRequirement] = (),
        dependencies: Sequence[TrackingDependency] = (),
        schedules: Sequence[MandateSchedule] = (),
    ) -> None:
        """导入历史委托：保留原标识、修订链与时间，不写 outbox、不建任务。"""

    def delete_mandate(self, mandate_id: str) -> bool:
        """仅用于导入时显式覆盖；级联删除该委托的版本、任务与历史。"""

    def get_mandate(
        self, mandate_id: str, *, principal_id: str
    ) -> Mandate | None: ...

    def get_mandate_internal(self, mandate_id: str) -> Mandate | None:
        """后台 worker 使用；不经过主体过滤，禁止直接暴露给命令/查询 API。"""

    def list_mandates(
        self,
        principal_id: str,
        *,
        instance_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> tuple[list[Mandate], str | None]: ...

    def get_revision(self, mandate_id: str, revision: int) -> MandateRevision | None: ...

    def list_subjects(self, mandate_id: str, revision: int) -> list[MandateSubject]: ...

    def list_requirements(
        self,
        mandate_id: str,
        *,
        revision: int | None = None,
        status: str | None = None,
    ) -> list[MandateRequirement]: ...

    def get_requirement(self, requirement_id: str) -> MandateRequirement | None: ...

    def update_requirement(
        self,
        requirement_id: str,
        *,
        status: str,
        resolved_at: datetime | None,
    ) -> MandateRequirement: ...

    def add_revision(
        self,
        revision: MandateRevision,
        *,
        expected_revision: int,
        subjects: Sequence[MandateSubject] = (),
        requirements: Sequence[MandateRequirement] = (),
        dependencies: Sequence[TrackingDependency] = (),
        outbox: Sequence[OutboxMessage] = (),
        status: str | None = None,
    ) -> Mandate: ...

    def set_status(
        self,
        mandate_id: str,
        *,
        principal_id: str,
        expected_revision: int,
        status: str,
        outbox: Sequence[OutboxMessage] = (),
        now: datetime | None = None,
    ) -> Mandate: ...


@runtime_checkable
class DependencyRepository(Protocol):
    def replace_active_dependencies(
        self,
        mandate_id: str,
        revision: int,
        dependencies: Sequence[TrackingDependency],
    ) -> None: ...

    def find_active_dependencies(
        self,
        *,
        hook_type: str,
        subject_ids: Sequence[str] | None = None,
        event_type: str | None = None,
    ) -> list[TrackingDependency]: ...

    def list_dependencies(
        self,
        mandate_id: str,
        *,
        revision: int | None = None,
        active_only: bool = True,
    ) -> list[TrackingDependency]: ...


@runtime_checkable
class ScheduleRepository(Protocol):
    def replace_schedules(
        self,
        mandate_id: str,
        revision: int,
        schedules: Sequence[MandateSchedule],
        *,
        now: datetime,
    ) -> None:
        """停用该委托旧版本的日程，并登记新版本日程（同标识幂等）。"""

    def list_schedules(
        self,
        mandate_id: str,
        *,
        revision: int | None = None,
        active_only: bool = True,
    ) -> list[MandateSchedule]: ...

    def get_schedule(self, schedule_id: str) -> MandateSchedule | None: ...

    def list_due_schedules(
        self, *, now: datetime, limit: int = 50
    ) -> list[MandateSchedule]:
        """只返回当前仍处于 tracking 的委托日程。"""

    def advance_schedule(
        self,
        schedule_id: str,
        *,
        next_due_at: datetime,
        last_instance_key: str | None = None,
        skipped_missed: int = 0,
        enabled: bool = True,
        now: datetime,
    ) -> MandateSchedule: ...


@runtime_checkable
class EventRepository(Protocol):
    def record_event(self, envelope: EventEnvelope) -> bool:
        """返回 True 表示首次接收；False 表示重复投递。"""

    def get_event(self, event_id: str) -> EventEnvelope | None: ...

    def list_inbox(self, *, status: str | None = None, limit: int = 100) -> list[InboxRecord]: ...

    def claim_inbox(self, *, limit: int, now: datetime) -> list[InboxRecord]: ...

    def mark_inbox(self, event_id: str, status: str, error: str | None = None) -> None: ...

    def enqueue_outbox(self, messages: Sequence[OutboxMessage]) -> None: ...

    def claim_outbox(self, *, limit: int, now: datetime) -> list[OutboxMessage]: ...

    def mark_outbox(self, outbox_id: str, status: str, error: str | None = None) -> None: ...

    def requeue_abandoned_inbox(
        self, *, older_than: datetime, limit: int = 100
    ) -> int: ...

    def retry_failed_outbox(
        self, *, now: datetime, limit: int = 50, max_attempts: int = 5
    ) -> int: ...


@runtime_checkable
class JobRepository(Protocol):
    def create_job(self, job: ResearchJob) -> ResearchJob: ...

    def get_job(self, job_id: str) -> ResearchJob | None: ...

    def get_job_by_dedupe(self, dedupe_key: str) -> ResearchJob | None: ...

    def claim_jobs(
        self, *, limit: int, lease_seconds: int, now: datetime
    ) -> list[ResearchJob]: ...

    def renew_job_lease(
        self,
        job_id: str,
        lease_token: str,
        *,
        lease_seconds: int,
        now: datetime,
    ) -> ResearchJob: ...

    def complete_job(
        self,
        job_id: str,
        lease_token: str,
        result: ResearchJobResult,
        *,
        now: datetime,
    ) -> ResearchJobResult: ...

    def fail_job(
        self,
        job_id: str,
        lease_token: str,
        error: str,
        *,
        now: datetime,
        retry_at: datetime | None = None,
    ) -> ResearchJob: ...

    def list_job_results(self, job_id: str) -> list[ResearchJobResult]: ...

    def reclaim_expired_leases(
        self,
        *,
        now: datetime,
        limit: int = 50,
        retry_delay_seconds: int = 30,
    ) -> list[ResearchJob]: ...


@runtime_checkable
class ContactRepository(Protocol):
    def save_contact_decision(self, decision: ContactDecision) -> ContactDecision: ...

    def list_contact_decisions(
        self, mandate_id: str, *, limit: int = 50
    ) -> list[ContactDecision]: ...

    def list_contact_decisions_for_job(self, job_id: str) -> list[ContactDecision]: ...

    def find_recent_contact_decision(
        self,
        mandate_id: str,
        *,
        since: datetime,
        condition_key: str | None = None,
        kinds: Sequence[str] = ("send", "aggregate"),
    ) -> ContactDecision | None: ...

    def save_contact_record(self, record: ContactRecord) -> None: ...


@runtime_checkable
class ConditionStateRepository(Protocol):
    def get_condition_state(
        self, mandate_id: str, condition_key: str
    ) -> ConditionState | None: ...

    def save_condition_state(self, state: ConditionState) -> ConditionState: ...


@runtime_checkable
class PreferenceRepository(Protocol):
    def get_notification_preferences(
        self, principal_id: str, instance_id: str
    ) -> NotificationPreferences | None: ...

    def save_notification_preferences(
        self, preferences: NotificationPreferences
    ) -> NotificationPreferences: ...

    def create_snooze(self, entry: SnoozeEntry) -> SnoozeEntry: ...

    def list_active_snoozes(
        self,
        *,
        principal_id: str,
        instance_id: str,
        mandate_id: str,
        condition_key: str,
        now: datetime,
    ) -> list[SnoozeEntry]: ...

    def list_snoozes(
        self,
        *,
        principal_id: str,
        instance_id: str,
        now: datetime,
        active_only: bool = True,
        limit: int = 100,
    ) -> list[SnoozeEntry]: ...


@runtime_checkable
class IdempotencyRepository(Protocol):
    def get_idempotent_response(
        self, principal_id: str, operation: str, idempotency_key: str
    ) -> IdempotentResponse | None: ...

    def save_idempotent_response(self, record: IdempotentResponse) -> None: ...


@runtime_checkable
class BusinessStore(
    MandateRepository,
    DependencyRepository,
    ScheduleRepository,
    EventRepository,
    JobRepository,
    ContactRepository,
    ConditionStateRepository,
    PreferenceRepository,
    IdempotencyRepository,
    Protocol,
):
    """首期由 SQLite 实现；外部数据库适配器按同一契约扩展。"""
