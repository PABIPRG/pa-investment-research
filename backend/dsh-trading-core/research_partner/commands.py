# -*- coding: utf-8 -*-
"""委托命令的输入 Schema。

命令层只接受这里列出的字段，不整包透传客户端 JSON。
``idempotency_key`` 由调用方为一次业务意图生成，重试必须复用。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import HOOK_PATTERN, AwareDatetime, ScopeMode


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SubjectSpec(_StrictModel):
    entity_id: str = Field(min_length=1, max_length=200)
    role: str = Field(default="primary_subject", min_length=1, max_length=80)
    scope_mode: ScopeMode = "fixed"
    collection_version: str | None = Field(default=None, max_length=200)


class TriggerSpec(_StrictModel):
    hook_type: str = Field(pattern=HOOK_PATTERN)
    event_type: str | None = Field(default=None, max_length=120)
    subject_ids: list[str] | None = Field(default=None, max_length=100)
    feature_key: str | None = Field(default=None, max_length=200)
    scope_key: str | None = Field(default=None, max_length=200)
    rule_version: str = Field(default="1", max_length=80)


class RequirementSpec(_StrictModel):
    code: str = Field(min_length=1, max_length=80)
    detail: str = Field(min_length=1, max_length=2000)


class MandateCreateRequest(_StrictModel):
    goal: str = Field(min_length=1, max_length=4000)
    scope: dict[str, Any] = Field(default_factory=dict)
    subjects: list[SubjectSpec] = Field(default_factory=list, max_length=100)
    triggers: list[TriggerSpec] = Field(default_factory=list, max_length=200)
    contact_policy: dict[str, Any] = Field(default_factory=dict)
    basis: dict[str, Any] = Field(default_factory=dict)
    requirements: list[RequirementSpec] = Field(default_factory=list, max_length=50)
    source_session_id: str | None = Field(default=None, max_length=200)
    source_message_ref: str | None = Field(default=None, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=200)


class MandateReviseRequest(_StrictModel):
    """调整委托必须提交完整的新定义；不提供字段级 patch。"""

    expected_revision: int = Field(ge=1)
    goal: str = Field(min_length=1, max_length=4000)
    scope: dict[str, Any] = Field(default_factory=dict)
    subjects: list[SubjectSpec] = Field(default_factory=list, max_length=100)
    triggers: list[TriggerSpec] = Field(default_factory=list, max_length=200)
    contact_policy: dict[str, Any] = Field(default_factory=dict)
    basis: dict[str, Any] = Field(default_factory=dict)
    requirements: list[RequirementSpec] = Field(default_factory=list, max_length=50)
    change_summary: str = Field(default="", max_length=2000)
    idempotency_key: str = Field(min_length=8, max_length=200)


class MandateStatusRequest(_StrictModel):
    expected_revision: int = Field(ge=1)
    reason: str = Field(default="", max_length=1000)
    idempotency_key: str = Field(min_length=8, max_length=200)


class RequirementResolutionRequest(_StrictModel):
    resolution: Literal["resolved", "waived"]
    note: str = Field(default="", max_length=1000)
    idempotency_key: str = Field(min_length=8, max_length=200)


class NotificationPreferencesRequest(_StrictModel):
    """消推配置；未提供时保持默认（app 渠道、Asia/Shanghai、无静默）。"""

    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=80)
    quiet_hours: dict[str, Any] | None = None
    channels: list[str] = Field(
        default_factory=lambda: ["app"], min_length=1, max_length=10
    )


class SnoozeCreateRequest(_StrictModel):
    """暂缓一类联系；``decision`` 范围的 scope_id 是条件键。"""

    scope_type: Literal["mandate", "decision"]
    scope_id: str = Field(min_length=1, max_length=300)
    until: AwareDatetime
    reason: str = Field(default="", max_length=1000)
