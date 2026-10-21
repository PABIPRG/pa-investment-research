# -*- coding: utf-8 -*-
"""研究实体服务：把抽取、检索、消歧、Scope 与 Tool 预挂载串起来。

上层（CLI / 未来 API）只依赖本服务与端口，不感知 SQLite、JSON 或数据源细节。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import audit
from .adapters.sources import records_to_entities
from .disambiguator import Context, Disambiguator
from .errors import ResearchEntityError, SourceUnavailable, StorageUnavailable
from .extractor import Gazetteer, MentionExtractor, NameTrie
from .freshness import stale_source_warnings
from .models import (
    EntityCollection,
    EntityMention,
    ResearchScope,
    SourceBatch,
    SourceImport,
)
from .registry.entity_types import ENTITY_TYPE_REGISTRY
from .registry.intents import classify_intents, preferred_entity_types
from .retriever import CandidateRetriever
from .scope_builder import ScopeBuilder
from .tool_preloader import ToolPreloader


@dataclass
class ImportResult:
    source_id: str
    source_version: str
    imported: int
    warnings: list[str] = field(default_factory=list)


class ResearchEntityService:
    def __init__(
        self,
        repository,
        *,
        collection_provider=None,
        gazetteer: Gazetteer | None = None,
        seed_types: bool = True,
    ) -> None:
        self.repository = repository
        self.collection_provider = collection_provider
        self.extractor = MentionExtractor(gazetteer)
        self.retriever = CandidateRetriever(repository)
        self.disambiguator = Disambiguator(repository)
        self.scope_builder = ScopeBuilder()
        self.preloader = ToolPreloader()
        self._trie_cache: tuple[str, NameTrie] | None = None
        if seed_types:
            self.ensure_types()

    def ensure_types(self) -> None:
        if not self.repository.list_types():
            self.repository.upsert_types(ENTITY_TYPE_REGISTRY.values())

    # ── 解析 ────────────────────────────────────────────────────────
    def resolve_scope(
        self,
        raw_query: str,
        *,
        request_id: str | None = None,
        persist: bool = True,
    ) -> ResearchScope:
        request_id = request_id or f"REQ_{uuid.uuid4().hex}"
        intents = classify_intents(raw_query)
        intent_codes = [item.intent_code for item in intents]
        preferred = preferred_entity_types(intents)

        try:
            trie = self._trie()
            mentions = self.extractor.extract(raw_query, trie)
            collections, collection_warnings = self._load_collections(mentions)
            context = Context(
                intent_codes=intent_codes,
                preferred_types=preferred,
                portfolio_members=self._portfolio_members(collections),
            )
            resolved_mentions: list[EntityMention] = []
            for mention in mentions:
                candidates = self.retriever.retrieve(mention)
                resolved_mentions.append(
                    self.disambiguator.resolve(mention, candidates, context)
                )
        except StorageUnavailable as exc:
            return ResearchScope(
                request_id=request_id,
                raw_query=raw_query,
                intent_list=intents,
                status="failed",
                warnings=[f"实体库不可用: {exc}"],
            )

        entity_ids = [
            item.resolved_entity_id
            for item in resolved_mentions
            if item.resolved_entity_id
        ]
        candidate_types: list[str] = []
        for item in resolved_mentions:
            for code in item.entity_type_candidates:
                if code not in candidate_types:
                    candidate_types.append(code)
        dynamic_types = [
            collection_type
            for item in resolved_mentions
            for collection_type in item.dynamic_collection_types
        ]
        primary_collection = next(
            (item for item in collections if item.collection_type == "USER_PORTFOLIO"),
            collections[0] if collections else None,
        )
        entity_sources = {}
        entity_ids_by_type: dict[str, list[str]] = {}
        for entity_id in entity_ids:
            entity = self.repository.get(entity_id)
            if entity is None:
                continue
            if entity.source:
                entity_sources[entity_id] = entity.source
            entity_ids_by_type.setdefault(entity.entity_type_code, []).append(entity_id)

        # 工具路由以实际解析出的实体类型为准；候选类型可能包含未落地的类型
        # （如同一名称同时是证券与公司），按候选类型挂载会产出没有实体的工具。
        entity_types = (
            list(entity_ids_by_type) if entity_ids_by_type else candidate_types
        )

        freshness_warnings = stale_source_warnings(self.repository, entity_sources)
        tools, tool_warnings = self.preloader.preload(
            entity_types=entity_types,
            intent_codes=intent_codes,
            entity_ids=entity_ids,
            entity_ids_by_type=entity_ids_by_type,
            dynamic_collection_types=dynamic_types,
            collection=primary_collection,
        )

        scope = self.scope_builder.build(
            request_id=request_id,
            raw_query=raw_query,
            intents=intents,
            mentions=resolved_mentions,
            collections=collections,
            tools=tools,
            tool_warnings=[*collection_warnings, *tool_warnings, *freshness_warnings],
            entity_sources=entity_sources,
        )

        if persist:
            self._persist(scope, resolved_mentions)
        return scope

    def _trie(self) -> NameTrie:
        version = self.repository.index_version()
        if self._trie_cache is None or self._trie_cache[0] != version:
            self._trie_cache = (version, self.extractor.build_trie(self.repository.index_terms()))
        return self._trie_cache[1]

    def _load_collections(self, mentions: list[EntityMention]) -> tuple[list[EntityCollection], list[str]]:
        if self.collection_provider is None:
            return [], []
        collections: list[EntityCollection] = []
        warnings: list[str] = []
        for collection_type in dict.fromkeys(
            value for item in mentions for value in item.dynamic_collection_types
        ):
            try:
                collection = self.collection_provider.get_collection(collection_type)
            except Exception as exc:  # 适配器异常降级为不可读
                warnings.append(f"读取动态集合失败（{collection_type}）: {exc}")
                collection = None
            if collection is not None:
                collections.append(collection)
        return collections, warnings

    @staticmethod
    def _portfolio_members(collections: list[EntityCollection]) -> set[str]:
        members: set[str] = set()
        for collection in collections:
            if (
                collection.collection_type == "USER_PORTFOLIO"
                and collection.authorization_status == "authorized"
            ):
                for entity_id in collection.member_entity_ids:
                    members.add(entity_id.rsplit(":", 1)[-1])
        return members

    def _persist(self, scope: ResearchScope, mentions: list[EntityMention]) -> None:
        try:
            self.repository.save_scope(scope)
            for mention in mentions:
                self.repository.save_mention(mention)
            self.repository.append_audit(
                audit.make_event(
                    request_id=scope.request_id,
                    stage="scope",
                    payload={
                        "status": scope.status,
                        "intents": [item.intent_code for item in scope.intent_list],
                        "entities": [
                            {
                                "mention_id": item.mention_id,
                                "entity_id": item.entity_id,
                                "status": item.resolution_status,
                                "role": item.role,
                            }
                            for item in scope.entity_list
                        ],
                        "tools": scope.preload_tool_ids,
                        "warnings": scope.warnings,
                    },
                )
            )
        except ResearchEntityError:
            # 持久化失败不应把已经完成的解析结果伪造成成功写入。
            scope.warnings.append("Scope 或审计记录持久化失败。")

    # ── 导入 ────────────────────────────────────────────────────────
    def import_source(self, source, *, source_label: str | None = None) -> ImportResult:
        source_id = getattr(source, "source_id", "unknown")
        try:
            batch: SourceBatch = source.fetch_entities()
            label = source_label or f"{source.source_id}:{batch.source_version}"
            entities = records_to_entities(batch, source_label=label)
            imported = self.repository.upsert_entities(
                entities, source_version=batch.source_version
            )
        except ResearchEntityError as exc:
            self._record_import(
                source_id=source_id,
                status="failed",
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        self._trie_cache = None
        request_id = f"IMPORT_{uuid.uuid4().hex}"
        self.repository.append_audit(
            audit.make_event(
                request_id=request_id,
                stage="import",
                payload={
                    "source_id": batch.source_id,
                    "source_version": batch.source_version,
                    "imported": imported,
                    "warnings": batch.warnings,
                },
            )
        )
        self._record_import(
            source_id=batch.source_id,
            status="success",
            source_version=batch.source_version,
            imported=imported,
            warnings=batch.warnings,
        )
        return ImportResult(
            source_id=batch.source_id,
            source_version=batch.source_version,
            imported=imported,
            warnings=list(batch.warnings),
        )

    def _record_import(
        self,
        *,
        source_id: str,
        status: str,
        source_version: str = "",
        imported: int = 0,
        warnings: list[str] | None = None,
        error: str | None = None,
    ) -> None:
        """把导入尝试写入来源记录；没有该能力的旧仓储直接跳过。"""

        record_source_import = getattr(self.repository, "record_source_import", None)
        if record_source_import is None:
            return
        record_source_import(
            SourceImport(
                import_id=f"IMPORT_{uuid.uuid4().hex}",
                source_id=source_id,
                source_version=source_version,
                imported_count=imported,
                status=status,  # type: ignore[arg-type]
                warnings=list(warnings or []),
                error=error,
                imported_at=datetime.now(timezone.utc),
            )
        )

    def source_freshness(self, **kwargs):
        from .freshness import source_freshness

        return source_freshness(self.repository, **kwargs)

    def import_sources(self, sources) -> list[ImportResult]:
        results: list[ImportResult] = []
        for source in sources:
            try:
                results.append(self.import_source(source))
            except SourceUnavailable as exc:
                results.append(
                    ImportResult(
                        source_id=getattr(source, "source_id", "unknown"),
                        source_version="",
                        imported=0,
                        warnings=[str(exc)],
                    )
                )
        return results
