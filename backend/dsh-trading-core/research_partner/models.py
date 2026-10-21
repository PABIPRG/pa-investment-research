# -*- coding: utf-8 -*-
"""研究委托核心的领域模型（Schema v1.0）。

只描述持久化对象，不包含存储层对象。所有时间必须是带时区的 UTC 时间；
只保存日期精度的信息由调用方先转成明确的 UTC 时间并在 payload 中保留精度标记。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1.0"

MandateStatus = Literal["pending_requirements", "tracking", "paused", "ended"]
RequirementStatus = Literal["open", "resolved", "waived"]
ScopeMode = Literal["fixed", "dynamic"]
ConditionResult = Literal["met", "unmet", "unknown", "error"]
DecisionKind = Literal["send", "suppress", "defer", "aggregate"]
JobStatus = Literal[
    "pending",
    "running",
    "waiting_data",
    "completed",
    "failed",
    "cancelled",
]
InboxStatus = Literal["pending", "processing", "processed", "failed", "ignored"]
OutboxStatus = Literal["pending", "sending", "published", "failed"]
SnoozeScope = Literal["mandate", "decision"]
ContactMode = Literal[
    "condition", "scheduled_delivery", "due_reminder", "periodic_check"
]

HOOK_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("时间必须包含时区")
    return value.astimezone(timezone.utc)


def _utc_optional(value: datetime | None) -> datetime | None:
    return None if value is None else _utc(value)


AwareDatetime = Annotated[datetime, AfterValidator(_utc)]
AwareDatetimeOptional = Annotated[datetime | None, AfterValidator(_utc_optional)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Mandate(_StrictModel):
    """持续委托主档；正文永远由最新 revision 决定。"""

    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    principal_id: str = Field(min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    status: MandateStatus = "pending_requirements"
    current_revision: int = Field(default=1, ge=1)
    source_session_id: str | None = Field(default=None, max_length=200)
    source_message_ref: str | None = Field(default=None, max_length=500)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    ended_at: AwareDatetimeOptional = None


class MandateRevision(_StrictModel):
    """委托版本的不可变快照。调整委托必须新增 revision，不能原地改写。"""

    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    goal: str = Field(min_length=1, max_length=4000)
    scope: dict[str, Any] = Field(default_factory=dict)
    triggers: list[dict[str, Any]] = Field(default_factory=list)
    contact_policy: dict[str, Any] = Field(default_factory=dict)
    basis: dict[str, Any] = Field(default_factory=dict)
    change_summary: str = Field(default="", max_length=2000)
    created_by: str = Field(min_length=1, max_length=200)
    created_at: AwareDatetime


class MandateSubject(_StrictModel):
    """委托版本引用的研究对象；动态集合必须记录实际采用的成员版本。"""

    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    entity_id: str = Field(min_length=1, max_length=200)
    role: str = Field(default="primary_subject", max_length=80)
    scope_mode: ScopeMode = "fixed"
    collection_version: str | None = Field(default=None, max_length=200)


class MandateRequirement(_StrictModel):
    """阻塞执行的待补充项；没有解决前不得宣称已开始持续监测。"""

    requirement_id: str = Field(pattern=r"^REQ_[0-9a-f]{32}$")
    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    code: str = Field(min_length=1, max_length=80)
    detail: str = Field(min_length=1, max_length=2000)
    status: RequirementStatus = "open"
    created_at: AwareDatetime
    resolved_at: AwareDatetimeOptional = None


class TrackingDependency(_StrictModel):
    """由委托版本编译出的追踪依赖；事件路由只认这张表。"""

    dependency_id: str = Field(min_length=8, max_length=200)
    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    hook_type: str = Field(pattern=HOOK_PATTERN)
    subject_id: str | None = Field(default=None, max_length=200)
    event_type: str | None = Field(default=None, max_length=120)
    feature_key: str | None = Field(default=None, max_length=200)
    scope_key: str | None = Field(default=None, max_length=200)
    active: bool = True
    rule_version: str = Field(default="1", max_length=80)
    created_at: AwareDatetime


class MandateSchedule(_StrictModel):
    """委托版本编译出的到期日程；每次到期产生确定的实例标识。"""

    schedule_id: str = Field(pattern=r"^SCH_[0-9a-f]{32}$")
    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    mode: ContactMode
    cron: str = Field(min_length=5, max_length=120)
    timezone: str = Field(min_length=1, max_length=80)
    catchup_seconds: int = Field(default=86400, ge=0)
    trading_days_only: bool = False
    enabled: bool = True
    next_due_at: AwareDatetime
    last_instance_key: str | None = Field(default=None, max_length=80)
    skipped_missed: int = Field(default=0, ge=0)
    created_at: AwareDatetime
    updated_at: AwareDatetime


class EventEnvelope(_StrictModel):
    """统一事件信封（V1.3 §5.6.3）。

    ``event_id`` 由产生方给出；同一来源重复投递必须复用同一标识。
    外部资料事件不携带 mandate_id，由核心负责匹配。
    """

    event_id: str = Field(min_length=1, max_length=200)
    hook_type: str = Field(pattern=HOOK_PATTERN)
    schema_version: str = Field(default=SCHEMA_VERSION, max_length=40)
    producer: str = Field(min_length=1, max_length=200)
    occurred_at: AwareDatetime
    observed_at: AwareDatetime
    subject_ids: list[str] = Field(default_factory=list, max_length=200)
    source_version: str | None = Field(default=None, max_length=200)
    content_hash: str | None = Field(default=None, max_length=200)
    correlation_id: str | None = Field(default=None, max_length=200)
    causation_id: str | None = Field(default=None, max_length=200)
    origin_run_id: str | None = Field(default=None, max_length=200)
    payload: dict[str, Any] = Field(default_factory=dict)


class InboxRecord(_StrictModel):
    """事件接收状态；用于去重、重试与恢复对账。"""

    event_id: str = Field(min_length=1, max_length=200)
    status: InboxStatus = "pending"
    attempts: int = Field(default=0, ge=0)
    received_at: AwareDatetime
    processed_at: AwareDatetimeOptional = None
    last_error: str | None = None


class OutboxMessage(_StrictModel):
    """与业务写入同事务提交的可靠发布记录。"""

    outbox_id: str = Field(pattern=r"^OUT_[0-9a-f]{32}$")
    aggregate_type: str = Field(min_length=1, max_length=80)
    aggregate_id: str = Field(min_length=1, max_length=200)
    event_type: str = Field(pattern=HOOK_PATTERN)
    payload: dict[str, Any] = Field(default_factory=dict)
    status: OutboxStatus = "pending"
    attempts: int = Field(default=0, ge=0)
    available_at: AwareDatetime
    created_at: AwareDatetime
    published_at: AwareDatetimeOptional = None
    last_error: str | None = None


class ResearchJob(_StrictModel):
    """核心持有的持久研究任务；DSH 只负责一次 run。"""

    job_id: str = Field(pattern=r"^JOB_[0-9a-f]{32}$")
    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    mandate_revision: int = Field(ge=1)
    trigger_event_id: str | None = Field(default=None, max_length=200)
    action: str = Field(min_length=1, max_length=80)
    status: JobStatus = "pending"
    lease_token: str | None = Field(default=None, max_length=200)
    lease_expires_at: AwareDatetimeOptional = None
    attempt_count: int = Field(default=0, ge=0)
    budget: dict[str, Any] = Field(default_factory=dict)
    checkpoint: dict[str, Any] = Field(default_factory=dict)
    cancel_generation: int = Field(default=0, ge=0)
    next_run_at: AwareDatetime
    dedupe_key: str = Field(min_length=8, max_length=300)
    last_error: str | None = None
    created_at: AwareDatetime
    updated_at: AwareDatetime


class ResearchJobResult(_StrictModel):
    """一次执行的结果；迟到结果允许留档，但不能获得新的联系许可。"""

    result_id: str = Field(pattern=r"^RES_[0-9a-f]{32}$")
    job_id: str = Field(pattern=r"^JOB_[0-9a-f]{32}$")
    run_id: str = Field(min_length=1, max_length=200)
    outcome: str = Field(min_length=1, max_length=80)
    structured_result: dict[str, Any] = Field(default_factory=dict)
    evidence_batch_id: str | None = Field(default=None, max_length=200)
    gaps: list[dict[str, Any]] = Field(default_factory=list)
    change_summary: str = Field(default="", max_length=4000)
    contact_suggestion: dict[str, Any] = Field(default_factory=dict)
    stale: bool = False
    received_at: AwareDatetime


class ContactDecision(_StrictModel):
    """联系决定；发送、抑制、延后、合并都必须留下原因。"""

    decision_id: str = Field(pattern=r"^DEC_[0-9a-f]{32}$")
    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    mandate_revision: int = Field(ge=1)
    job_id: str | None = Field(default=None, max_length=200)
    decision: DecisionKind
    reason_code: str = Field(min_length=1, max_length=80)
    condition_result: ConditionResult = "unknown"
    detail: str = Field(default="", max_length=4000)
    evidence_ref: str | None = Field(default=None, max_length=500)
    dedupe_key: str = Field(min_length=8, max_length=300)
    condition_key: str = Field(default="", max_length=200)
    eligible_at: AwareDatetimeOptional = None
    expires_at: AwareDatetimeOptional = None
    created_at: AwareDatetime


class ContactRecord(_StrictModel):
    """一次投递的结果；提交不等于送达。"""

    decision_id: str = Field(pattern=r"^DEC_[0-9a-f]{32}$")
    channel: str = Field(min_length=1, max_length=40)
    status: str = Field(min_length=1, max_length=40)
    sent_at: AwareDatetimeOptional = None
    delivery_job_id: str | None = Field(default=None, max_length=200)
    detail: str = Field(default="", max_length=2000)


class ConditionState(_StrictModel):
    """条件的时间状态：用于持续满足、首次进入与重新进入判断。

    ``unknown``/``error`` 不改变状态，避免把“还不知道”当成“已离开条件”。
    """

    mandate_id: str = Field(pattern=r"^MND_[0-9a-f]{32}$")
    condition_key: str = Field(min_length=1, max_length=200)
    state: Literal["met", "unmet"]
    state_since: AwareDatetime
    met_episodes: int = Field(default=0, ge=0)
    last_met_at: AwareDatetimeOptional = None
    last_evaluated_at: AwareDatetime


class NotificationPreferences(_StrictModel):
    """消推配置：渠道、时区、静默时段与默认联系偏好。"""

    principal_id: str = Field(min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=80)
    quiet_hours: dict[str, Any] | None = None
    channels: list[str] = Field(default_factory=lambda: ["app"])
    updated_at: AwareDatetime


class SnoozeEntry(_StrictModel):
    """暂缓：到 until 之前不再针对该对象产生新的发送。"""

    snooze_id: str = Field(pattern=r"^SNO_[0-9a-f]{32}$")
    principal_id: str = Field(min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    scope_type: SnoozeScope
    scope_id: str = Field(min_length=1, max_length=300)
    until: AwareDatetime
    reason: str = Field(default="", max_length=1000)
    created_at: AwareDatetime


class IdempotentResponse(_StrictModel):
    """业务命令的幂等回执。"""

    principal_id: str = Field(min_length=1, max_length=200)
    operation: str = Field(min_length=1, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=200)
    request_hash: str = Field(min_length=16, max_length=200)
    response: dict[str, Any] = Field(default_factory=dict)
    created_at: AwareDatetime
