# -*- coding: utf-8 -*-
"""内存实体库：用于单元测试与临时会话。语义必须与 SQLite 适配器一致。"""

from __future__ import annotations

import copy
from contextlib import contextmanager
from typing import Iterable, Iterator, Sequence

from ..errors import InvalidRecord
from ..models import (
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
    SourceImport,
)
from ..merge import merge_entity
from ..normalizer import normalize_name
from ..ports import IndexTerm


class InMemoryEntityRepository:
    def __init__(self) -> None:
        self._types: dict[str, EntityTypeDef] = {}
        self._entities: dict[str, EntityInstance] = {}
        self._aliases: dict[str, set[str]] = {}
        self._identifiers: dict[tuple[str, str], set[str]] = {}
        self._collections: dict[str, EntityCollection] = {}
        self._scopes: dict[str, ResearchScope] = {}
        self._audits: list[AuditEvent] = []
        self._mentions: dict[str, EntityMention] = {}
        self._evidence: dict[str, EvidenceItem] = {}
        self._reports: dict[str, ReportDraft] = {}
        self._source_imports: list[SourceImport] = []
        self._version = 0

    # ── 事务 ────────────────────────────────────────────────────────
    @contextmanager
    def transaction(self) -> Iterator[None]:
        snapshot = copy.deepcopy(
            (
                self._entities,
                self._aliases,
                self._identifiers,
                self._collections,
                self._scopes,
                self._audits,
                self._mentions,
                self._evidence,
                self._reports,
                self._source_imports,
                self._version,
            )
        )
        try:
            yield
        except Exception:
            (
                self._entities,
                self._aliases,
                self._identifiers,
                self._collections,
                self._scopes,
                self._audits,
                self._mentions,
                self._evidence,
                self._reports,
                self._source_imports,
                self._version,
            ) = snapshot
            raise

    # ── 类型 ────────────────────────────────────────────────────────
    def list_types(self) -> list[EntityTypeDef]:
        return sorted(self._types.values(), key=lambda item: item.type_code)

    def upsert_types(self, types: Iterable[EntityTypeDef]) -> None:
        for item in types:
            self._types[item.type_code] = item

    # ── 读 ──────────────────────────────────────────────────────────
    def get(self, entity_id: str) -> EntityInstance | None:
        value = self._entities.get(entity_id)
        return value.model_copy(deep=True) if value is not None else None

    def get_many(self, entity_ids: Sequence[str]) -> list[EntityInstance]:
        return [
            self._entities[entity_id].model_copy(deep=True)
            for entity_id in entity_ids
            if entity_id in self._entities
        ]

    def find_by_identifier(self, key: str, value: str) -> list[EntityInstance]:
        ids = self._identifiers.get((key, str(value)), set())
        return [self._entities[entity_id].model_copy(deep=True) for entity_id in sorted(ids)]

    def find_by_name(
        self,
        text: str,
        *,
        type_codes: Sequence[str] | None = None,
        limit: int = 20,
    ) -> list[EntityCandidate]:
        wanted = normalize_name(text)
        allowed = set(type_codes) if type_codes else None
        matches: list[EntityCandidate] = []
        for entity in self._entities.values():
            if allowed is not None and entity.entity_type_code not in allowed:
                continue
            reasons: list[str] = []
            confidence = 0.0
            if normalize_name(entity.canonical_name) == wanted:
                reasons.append("exact_name_match")
                confidence = 0.95
            elif any(normalize_name(alias) == wanted for alias in entity.aliases):
                reasons.append("alias_match")
                confidence = 0.90
            if reasons:
                matches.append(
                    EntityCandidate(
                        entity_id=entity.entity_id,
                        entity_type_code=entity.entity_type_code,
                        canonical_name=entity.canonical_name,
                        match_reason=reasons,
                        confidence=confidence,
                        source=entity.source,
                    )
                )
        matches.sort(key=lambda item: (-item.confidence, item.entity_id))
        return matches[:limit]

    def list_by_type(
        self, type_code: str, *, limit: int = 100, cursor: str | None = None
    ) -> tuple[list[EntityInstance], str | None]:
        ids = sorted(
            entity_id
            for entity_id, entity in self._entities.items()
            if entity.entity_type_code == type_code and (cursor is None or entity_id > cursor)
        )
        page = ids[:limit]
        next_cursor = page[-1] if len(ids) > limit else None
        return [self._entities[entity_id].model_copy(deep=True) for entity_id in page], next_cursor

    def relations_from(
        self, entity_id: str, *, relation_type: str | None = None
    ) -> list[EntityRelation]:
        entity = self._entities.get(entity_id)
        if entity is None:
            return []
        return [
            relation.model_copy(deep=True)
            for relation in entity.relations
            if relation_type is None or relation.relation_type == relation_type
        ]

    def index_terms(self) -> list[IndexTerm]:
        terms: list[IndexTerm] = []
        for entity in self._entities.values():
            terms.append(
                IndexTerm(entity.canonical_name, entity.entity_id, entity.entity_type_code, "canonical_name", 20)
            )
            for alias in entity.aliases:
                terms.append(IndexTerm(alias, entity.entity_id, entity.entity_type_code, "alias", 15))
        return terms

    def index_version(self) -> str:
        return f"memory:{self._version}"

    # ── 写 ──────────────────────────────────────────────────────────
    def upsert_entities(self, entities: Iterable[EntityInstance], *, source_version: str) -> int:
        count = 0
        for entity in entities:
            if not entity.entity_id or not entity.canonical_name:
                raise InvalidRecord("实体必须有 entity_id 与 canonical_name")
            existing = self._entities.get(entity.entity_id)
            if existing is not None:
                entity = merge_entity(existing, entity)
            self._remove_indexes(entity.entity_id)
            self._entities[entity.entity_id] = entity.model_copy(deep=True)
            self._add_indexes(entity)
            count += 1
        self._version += 1
        return count

    def _remove_indexes(self, entity_id: str) -> None:
        for alias, ids in list(self._aliases.items()):
            ids.discard(entity_id)
            if not ids:
                del self._aliases[alias]
        for key, ids in list(self._identifiers.items()):
            ids.discard(entity_id)
            if not ids:
                del self._identifiers[key]

    def _add_indexes(self, entity: EntityInstance) -> None:
        for alias in entity.aliases:
            self._aliases.setdefault(normalize_name(alias), set()).add(entity.entity_id)
        for key, value in entity.identifiers.items():
            self._identifiers.setdefault((key, str(value)), set()).add(entity.entity_id)

    def get_collection(self, collection_id: str) -> EntityCollection | None:
        value = self._collections.get(collection_id)
        return value.model_copy(deep=True) if value is not None else None

    def replace_collection(self, collection: EntityCollection) -> None:
        self._collections[collection.collection_id] = collection.model_copy(deep=True)

    def save_scope(self, scope: ResearchScope) -> None:
        self._scopes[scope.request_id] = scope.model_copy(deep=True)

    def get_scope(self, request_id: str) -> ResearchScope | None:
        value = self._scopes.get(request_id)
        return value.model_copy(deep=True) if value is not None else None

    def save_mention(self, mention: EntityMention) -> None:
        self._mentions[mention.mention_id] = mention.model_copy(deep=True)

    def list_mentions(self) -> list[EntityMention]:
        return [value.model_copy(deep=True) for value in self._mentions.values()]

    def record_source_import(self, record: SourceImport) -> None:
        self._source_imports.append(record.model_copy(deep=True))

    def list_source_imports(self, *, limit: int = 500) -> list[SourceImport]:
        items = sorted(
            self._source_imports,
            key=lambda item: (item.imported_at, item.import_id),
            reverse=True,
        )
        return [item.model_copy(deep=True) for item in items[:limit]]

    def append_audit(self, event: AuditEvent) -> None:
        self._audits.append(event.model_copy(deep=True))

    def list_audit(self, request_id: str) -> list[AuditEvent]:
        return [
            event.model_copy(deep=True)
            for event in self._audits
            if event.request_id == request_id
        ]

    def save_evidence(self, item: EvidenceItem) -> None:
        self._evidence[item.evidence_id] = item.model_copy(deep=True)

    def list_evidence(self, request_id: str) -> list[EvidenceItem]:
        items = [
            item.model_copy(deep=True)
            for item in self._evidence.values()
            if item.request_id == request_id
        ]
        return sorted(items, key=lambda item: (item.fetched_at, item.evidence_id))

    def save_report(self, report: ReportDraft) -> None:
        self._reports[report.report_id] = report.model_copy(deep=True)

    def get_report(self, report_id: str) -> ReportDraft | None:
        value = self._reports.get(report_id)
        return value.model_copy(deep=True) if value is not None else None

    def list_reports(self, request_id: str) -> list[ReportDraft]:
        items = [
            report.model_copy(deep=True)
            for report in self._reports.values()
            if report.request_id == request_id
        ]
        return sorted(items, key=lambda item: (item.created_at, item.report_id))
