# -*- coding: utf-8 -*-
"""端口定义：上层依赖的读写契约。

``EntityRepository`` 负责持久化，``MasterDataSource`` 负责只读外部数据，
``CollectionProvider`` 负责用户动态集合（持仓/自选）。三者均不暴露底层实现。
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Iterable, Protocol, Sequence, runtime_checkable

from .models import (
    AuditEvent,
    EntityCandidate,
    EntityCollection,
    EntityInstance,
    EntityMention,
    EntityRelation,
    EntityTypeDef,
    EvidenceItem,
    ReportDraft,
    ResearchScope,
    SourceBatch,
    SourceCapabilities,
    SourceHealth,
    SourceImport,
)


class EntityMatch(Protocol):
    """候选匹配的轻量视图；由适配器返回，不绑定存储实现。"""

    entity_id: str
    entity_type_code: str
    canonical_name: str
    match_reason: list[str]
    confidence: float
    source: str | None


@runtime_checkable
class EntityRepository(Protocol):
    """实体库的读写端口。"""

    def transaction(self) -> AbstractContextManager[None]:
        """开启一个事务；异常时回滚。"""

    def get(self, entity_id: str) -> EntityInstance | None: ...

    def get_many(self, entity_ids: Sequence[str]) -> list[EntityInstance]: ...

    def find_by_identifier(self, key: str, value: str) -> list[EntityInstance]: ...

    def find_by_name(
        self,
        text: str,
        *,
        type_codes: Sequence[str] | None = None,
        limit: int = 20,
    ) -> list[EntityCandidate]:
        """按标准名或别名精确匹配；不含模糊猜测。"""

    def list_by_type(
        self, type_code: str, *, limit: int = 100, cursor: str | None = None
    ) -> tuple[list[EntityInstance], str | None]: ...

    def relations_from(
        self, entity_id: str, *, relation_type: str | None = None
    ) -> list[EntityRelation]: ...

    def upsert_entities(
        self, entities: Iterable[EntityInstance], *, source_version: str
    ) -> int: ...

    def record_source_import(self, record: "SourceImport") -> None:
        """记录一次导入尝试（成功或失败），不改变实体内容。"""

    def list_source_imports(self, *, limit: int = 500) -> list["SourceImport"]:
        """按导入时间倒序返回最近的导入记录。"""

    def get_collection(self, collection_id: str) -> EntityCollection | None: ...

    def replace_collection(self, collection: EntityCollection) -> None: ...

    def save_scope(self, scope: ResearchScope) -> None: ...

    def get_scope(self, request_id: str) -> ResearchScope | None: ...

    def append_audit(self, event: AuditEvent) -> None: ...

    def list_audit(self, request_id: str) -> list[AuditEvent]: ...

    def save_evidence(self, item: EvidenceItem) -> None: ...

    def list_evidence(self, request_id: str) -> list[EvidenceItem]: ...

    def save_report(self, report: ReportDraft) -> None: ...

    def get_report(self, report_id: str) -> ReportDraft | None: ...

    def list_reports(self, request_id: str) -> list[ReportDraft]: ...

    def index_terms(self) -> list["IndexTerm"]: ...

    def index_version(self) -> str: ...

    def save_mention(self, mention: EntityMention) -> None: ...

    def list_types(self) -> list[EntityTypeDef]: ...

    def upsert_types(self, types: Iterable[EntityTypeDef]) -> None: ...


@runtime_checkable
class MasterDataSource(Protocol):
    """只读外部主数据源端口。"""

    source_id: str

    def capabilities(self) -> SourceCapabilities: ...

    def health(self) -> SourceHealth: ...

    def fetch_entities(self, *, since: str | None = None) -> SourceBatch: ...


@runtime_checkable
class CollectionProvider(Protocol):
    """用户动态集合端口；不可读时必须返回 None 或 unknown，不得虚构成员。"""

    def get_collection(self, collection_type: str) -> EntityCollection | None: ...


class IndexTerm:
    """抽取索引项：一段可匹配文本及其指向的实体。"""

    __slots__ = (
        "text",
        "entity_id",
        "entity_type_code",
        "entity_type_codes",
        "alias_type",
        "priority",
    )

    def __init__(
        self,
        text: str,
        entity_id: str,
        entity_type_code: str,
        alias_type: str = "canonical_name",
        priority: int = 0,
        entity_type_codes: tuple[str, ...] = (),
    ) -> None:
        self.text = text
        self.entity_id = entity_id
        self.entity_type_code = entity_type_code
        # 仅类型词可能有多个候选类型（如“降息”既是事件也是趋势）。
        self.entity_type_codes = entity_type_codes
        self.alias_type = alias_type
        self.priority = priority

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"IndexTerm({self.text!r}, {self.entity_id!r}, {self.alias_type})"
