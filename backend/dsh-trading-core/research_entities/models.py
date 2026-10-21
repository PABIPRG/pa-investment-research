# -*- coding: utf-8 -*-
"""研究实体 Schema v1.0 的领域模型。

与设计文档 ``docs/design/0.2.0/研究实体.md`` 第五、七、八章保持一致。
模型只描述领域字段，不包含任何存储层对象（sqlite3.Row、DataFrame 等）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0"

EntityPriority = Literal["P0", "P1"]
EntityTypeStatus = Literal["active", "inactive", "deprecated"]
EntityInstanceStatus = Literal["verified", "unverified", "imported_unverified", "retired"]
ResolutionStatus = Literal["resolved", "ambiguous", "pending", "unresolved"]
ScopeStatus = Literal[
    "pending_entity_resolution",
    "pending_clarification",
    "scope_ready",
    "scope_incomplete",
    "failed",
]
ToolAvailability = Literal["configured", "unconfigured", "external_service"]
ToolExecutionMode = Literal["preload_only", "on_demand", "not_executable"]
EvidenceStatus = Literal["ok", "empty", "unavailable", "error", "needs_authorization"]
SourceImportStatus = Literal["success", "failed"]
ReportMode = Literal["deterministic", "llm_assisted"]
ReportClaimKind = Literal["fact", "analysis", "assumption", "risk"]
AuthorizationStatus = Literal["authorized", "unauthorized", "unknown", "not_required"]
EntityRole = Literal[
    "primary_subject",
    "research_theme",
    "comparison_target",
    "benchmark",
    "event",
    "macro_factor",
    "constraint_source",
    "member",
]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class EntityTypeDef(_StrictModel):
    """实体类型定义（静态注册表条目）。"""

    type_code: str = Field(pattern=r"^ENTITY_\d{2}_\d{2}$")
    parent_code: str = Field(pattern=r"^ENTITY_\d{2}$")
    type_name: str = Field(min_length=1)
    description: str = ""
    priority: EntityPriority
    is_dynamic: bool = False
    normalization_keys: list[str] = Field(default_factory=list)
    default_tool_ids: list[str] = Field(default_factory=list)
    schema_version: str = SCHEMA_VERSION
    status: EntityTypeStatus = "active"


class SourceImport(_StrictModel):
    """一次主数据导入尝试的记录；成功与失败都要留痕，供新鲜度判断。"""

    import_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    source_version: str = ""
    imported_count: int = Field(default=0, ge=0)
    status: SourceImportStatus
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    imported_at: datetime


class EntityRelation(_StrictModel):
    """实体之间的关联关系。"""

    target_entity_id: str = Field(min_length=1)
    relation_type: str = Field(min_length=1)
    attributes: dict[str, Any] = Field(default_factory=dict)
    source: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    valid_from: str | None = None
    valid_to: str | None = None


class EntityInstance(_StrictModel):
    """标准实体实例。"""

    entity_id: str = Field(min_length=1)
    entity_type_code: str = Field(pattern=r"^ENTITY_\d{2}_\d{2}$")
    canonical_name: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    identifiers: dict[str, str] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    relations: list[EntityRelation] = Field(default_factory=list)
    source: str | None = None
    last_verified_at: datetime | None = None
    status: EntityInstanceStatus = "unverified"


class EntityCandidate(_StrictModel):
    """候选实体及匹配依据。"""

    entity_id: str = Field(min_length=1)
    entity_type_code: str = Field(pattern=r"^ENTITY_\d{2}_\d{2}$")
    canonical_name: str = ""
    match_reason: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    source: str | None = None


class EntityMention(_StrictModel):
    """用户原文中的一次实体提及。"""

    mention_id: str = Field(min_length=1)
    raw_text: str = Field(min_length=1)
    normalized_text: str = ""
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    candidate_entity_ids: list[str] = Field(default_factory=list)
    resolved_entity_id: str | None = None
    entity_type_candidates: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    resolution_status: ResolutionStatus = "pending"
    candidates: list[EntityCandidate] = Field(default_factory=list)
    resolution_reason: str | None = None
    # 动态集合不是静态实体类型，单独记录，避免混入 20 个二级编码。
    dynamic_collection_types: list[str] = Field(default_factory=list)

    @field_validator("entity_type_candidates")
    @classmethod
    def _validate_type_codes(cls, value: list[str]) -> list[str]:
        for code in value:
            if not code.startswith("ENTITY_"):
                raise ValueError(f"非法实体类型编码: {code}")
        return value

    @model_validator(mode="after")
    def _validate_offsets_and_resolution(self) -> "EntityMention":
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset 必须大于 start_offset")
        if self.end_offset - self.start_offset != len(self.raw_text):
            raise ValueError("偏移区间长度必须与 raw_text 字符数一致")
        if self.resolution_status == "resolved" and not self.resolved_entity_id:
            raise ValueError("resolved 状态必须提供 resolved_entity_id")
        if self.resolution_status != "resolved" and self.resolved_entity_id is not None:
            raise ValueError("未解决状态不得写入 resolved_entity_id")
        if self.resolved_entity_id is not None and self.resolved_entity_id not in self.candidate_entity_ids:
            raise ValueError("resolved_entity_id 必须来自候选实体列表")
        return self


class EntityCollection(_StrictModel):
    """动态实体集合（用户持仓、自选等）。"""

    collection_id: str = Field(min_length=1)
    collection_type: str = Field(min_length=1)
    source: str
    as_of: datetime | None = None
    member_entity_ids: list[str] = Field(default_factory=list)
    filter_definition: dict[str, Any] = Field(default_factory=dict)
    authorization_status: AuthorizationStatus = "unknown"


class IntentItem(_StrictModel):
    """识别出的研究意图。"""

    intent_code: str = Field(min_length=1)
    description: str = ""
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class Constraints(_StrictModel):
    """研究约束。"""

    time_range: str | None = None
    market_scope: str = "A股"
    other_constraints: list[str] = Field(default_factory=list)


class ScopeEntity(_StrictModel):
    """Scope 中的实体条目。"""

    mention_id: str = Field(min_length=1)
    entity_id: str | None = None
    entity_type_code: str | None = None
    raw_text: str = Field(min_length=1)
    role: EntityRole = "primary_subject"
    resolution_status: ResolutionStatus = "pending"
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    canonical_name: str | None = None


class PreloadTool(_StrictModel):
    """预挂载工具条目。推荐不等于执行。"""

    tool_id: str = Field(min_length=1)
    reason: str = ""
    required: bool = False
    entity_ids: list[str] = Field(default_factory=list)
    status: ToolAvailability = "unconfigured"
    execution_mode: ToolExecutionMode = "preload_only"
    requires_authorization: bool = False


class ResearchScope(_StrictModel):
    """研究 Scope 的标准输出协议。"""

    schema_version: str = SCHEMA_VERSION
    request_id: str = Field(min_length=1)
    raw_query: str = Field(min_length=1)
    intent_list: list[IntentItem] = Field(default_factory=list)
    entity_list: list[ScopeEntity] = Field(default_factory=list)
    constraints: Constraints = Field(default_factory=Constraints)
    preload_tool_ids: list[str] = Field(default_factory=list)
    preload_tools: list[PreloadTool] = Field(default_factory=list)
    clarification_questions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    status: ScopeStatus = "pending_entity_resolution"

    @model_validator(mode="after")
    def _validate_ready_scope(self) -> "ResearchScope":
        if self.status == "scope_ready":
            unresolved = [
                item
                for item in self.entity_list
                if item.resolution_status in ("unresolved", "pending", "ambiguous")
            ]
            if unresolved:
                raise ValueError("存在未确认实体时不得标记 scope_ready")
            if self.clarification_questions:
                raise ValueError("scope_ready 不得包含待澄清问题")
        return self


class ToolDefinition(_StrictModel):
    """逻辑工具注册表条目。"""

    tool_id: str = Field(min_length=1)
    name: str = ""
    category: str = ""
    availability: ToolAvailability = "unconfigured"
    implementation: str | None = None
    requires_authorization: bool = False
    description: str = ""
    supported_entity_types: list[str] = Field(default_factory=list)


class EvidenceItem(_StrictModel):
    """一次工具执行留下的可回放证据。"""

    evidence_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    status: EvidenceStatus
    entity_ids: list[str] = Field(default_factory=list)
    source: str | None = None
    fetched_at: datetime
    record_count: int = 0
    data: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    duration_ms: int | None = None
    authorization: AuthorizationStatus = "not_required"
    cache_hit: bool = False


class EvidenceBundle(_StrictModel):
    """同一研究请求的全部证据与缺口。"""

    request_id: str = Field(min_length=1)
    created_at: datetime
    items: list[EvidenceItem] = Field(default_factory=list)
    summary: dict[str, int] = Field(default_factory=dict)
    gaps: list[dict[str, Any]] = Field(default_factory=list)


class ReportCitation(_StrictModel):
    """报告脚注：把 [E1] 之类的引用锚定到一条落库证据。"""

    citation_id: str = Field(min_length=1)
    evidence_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    source: str | None = None
    status: EvidenceStatus
    fetched_at: datetime
    record_count: int = 0


class ReportClaim(_StrictModel):
    """报告中的一条判断。

    ``fact`` 必须带证据引用；``analysis``/``assumption``/``risk`` 是模型观点，
    但一旦引用证据，引用必须真实存在。
    """

    claim_id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    kind: ReportClaimKind = "analysis"
    evidence_ids: list[str] = Field(default_factory=list)
    evidence_refs: list[str] = Field(default_factory=list)


class ReportTable(_StrictModel):
    """报告中的数据表。行数据直接来自证据，不做二次计算。"""

    title: str = Field(min_length=1)
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    evidence_id: str | None = None


class ReportSection(_StrictModel):
    section_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    paragraphs: list[str] = Field(default_factory=list)
    claims: list[ReportClaim] = Field(default_factory=list)
    tables: list[ReportTable] = Field(default_factory=list)


class ReportDraft(_StrictModel):
    """结构化研究报告草稿，可由代码或 LLM 生成，但证据引用必须可校验。"""

    report_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    mode: ReportMode = "deterministic"
    title: str = Field(min_length=1)
    created_at: datetime
    raw_query: str = ""
    summary: str = ""
    sections: list[ReportSection] = Field(default_factory=list)
    citations: list[ReportCitation] = Field(default_factory=list)
    gaps: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class AuditEvent(_StrictModel):
    """审计事件。只记录必要字段，敏感键在写入前脱敏。"""

    event_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    stage: str = Field(min_length=1)
    created_at: datetime
    payload: dict[str, Any] = Field(default_factory=dict)


class SourceEntityRecord(_StrictModel):
    """数据源适配器输出的标准化实体记录。"""

    entity_id: str | None = None
    external_code: str | None = None
    name: str = Field(min_length=1)
    entity_type_code: str = Field(pattern=r"^ENTITY_\d{2}_\d{2}$")
    aliases: list[str] = Field(default_factory=list)
    identifiers: dict[str, str] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    related: list[EntityRelation] = Field(default_factory=list)


class SourceCapabilities(_StrictModel):
    """数据源能力声明。"""

    source_id: str
    authoritative: bool = False
    supports_incremental: bool = False
    entity_type_codes: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class SourceHealth(_StrictModel):
    """数据源健康状态。"""

    source_id: str
    available: bool
    detail: str = ""
    checked_at: datetime | None = None


class SourceBatch(_StrictModel):
    """跨适配器边界的唯一数据包。"""

    source_id: str = Field(min_length=1)
    source_version: str = Field(min_length=1)
    as_of: datetime | None = None
    fetched_at: datetime
    records: list[SourceEntityRecord] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
