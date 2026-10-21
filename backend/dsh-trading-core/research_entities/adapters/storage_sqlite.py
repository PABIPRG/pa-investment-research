# -*- coding: utf-8 -*-
"""SQLite 实体库适配器（标准库 sqlite3，零额外依赖）。

连接口径：
- WAL + FOREIGN KEYS + busy_timeout，短事务。
- 写事务使用 BEGIN IMMEDIATE，避免并发写升级锁冲突。
- 适配器内部对象（sqlite3.Row、连接）不会返回给上层。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Sequence

from ..errors import InvalidRecord, StorageUnavailable
from ..merge import merge_entity
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
from ..ports import IndexTerm

_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _loads(raw: str | None, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


class SqliteEntityRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._depth = threading.local()
        self._migrate()

    # ── 连接与迁移 ──────────────────────────────────────────────────
    def _connect(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            return connection
        try:
            connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=5000")
        except sqlite3.Error as exc:  # pragma: no cover - 环境相关
            raise StorageUnavailable(f"无法打开研究实体库: {self.path}") from exc
        self._local.connection = connection
        return connection

    @property
    def _tx_depth(self) -> int:
        return getattr(self._depth, "value", 0)

    @_tx_depth.setter
    def _tx_depth(self, value: int) -> None:
        self._depth.value = value

    def _migrate(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            applied = {
                row["version"]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations"
                ).fetchall()
            }
            # 迁移文件按文件名顺序累加执行；已应用的版本跳过。
            for path in sorted(_MIGRATIONS_DIR.glob("*.sql")):
                version = path.stem
                if version in applied:
                    continue
                connection.executescript(path.read_text(encoding="utf-8"))
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, _utcnow()),
                )
            connection.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('index_version', '0')"
            )
        except sqlite3.Error as exc:
            raise StorageUnavailable("研究实体库迁移失败") from exc

    @contextmanager
    def transaction(self) -> Iterator[None]:
        connection = self._connect()
        if self._tx_depth > 0:
            self._tx_depth = self._tx_depth + 1
            try:
                yield
            finally:
                self._tx_depth = self._tx_depth - 1
            return
        try:
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.Error as exc:
            raise StorageUnavailable("无法开启研究实体库写事务") from exc
        self._tx_depth = 1
        try:
            yield
        except Exception:
            connection.execute("ROLLBACK")
            raise
        else:
            connection.execute("COMMIT")
        finally:
            self._tx_depth = 0

    def _bump_index_version(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_version'"
        )

    def index_version(self) -> str:
        row = self._connect().execute(
            "SELECT value FROM meta WHERE key = 'index_version'"
        ).fetchone()
        return f"sqlite:{row['value'] if row else '0'}"

    # ── 类型 ────────────────────────────────────────────────────────
    def list_types(self) -> list[EntityTypeDef]:
        rows = self._connect().execute(
            "SELECT * FROM entity_types ORDER BY type_code"
        ).fetchall()
        return [self._type_from_row(row) for row in rows]

    def upsert_types(self, types: Iterable[EntityTypeDef]) -> None:
        with self.transaction():
            connection = self._connect()
            for item in types:
                connection.execute(
                    """
                    INSERT INTO entity_types(
                        type_code, parent_code, type_name, description, priority,
                        is_dynamic, normalization_keys_json, default_tool_ids_json,
                        schema_version, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(type_code) DO UPDATE SET
                        parent_code=excluded.parent_code,
                        type_name=excluded.type_name,
                        description=excluded.description,
                        priority=excluded.priority,
                        is_dynamic=excluded.is_dynamic,
                        normalization_keys_json=excluded.normalization_keys_json,
                        default_tool_ids_json=excluded.default_tool_ids_json,
                        schema_version=excluded.schema_version,
                        status=excluded.status
                    """,
                    (
                        item.type_code,
                        item.parent_code,
                        item.type_name,
                        item.description,
                        item.priority,
                        1 if item.is_dynamic else 0,
                        json.dumps(item.normalization_keys, ensure_ascii=False),
                        json.dumps(item.default_tool_ids, ensure_ascii=False),
                        item.schema_version,
                        item.status,
                    ),
                )

    @staticmethod
    def _type_from_row(row: sqlite3.Row) -> EntityTypeDef:
        return EntityTypeDef(
            type_code=row["type_code"],
            parent_code=row["parent_code"],
            type_name=row["type_name"],
            description=row["description"],
            priority=row["priority"],
            is_dynamic=bool(row["is_dynamic"]),
            normalization_keys=_loads(row["normalization_keys_json"], []),
            default_tool_ids=_loads(row["default_tool_ids_json"], []),
            schema_version=row["schema_version"],
            status=row["status"],
        )

    # ── 读 ──────────────────────────────────────────────────────────
    def get(self, entity_id: str) -> EntityInstance | None:
        connection = self._connect()
        row = connection.execute(
            "SELECT * FROM entities WHERE entity_id = ?", (entity_id,)
        ).fetchone()
        if row is None:
            return None
        return self._hydrate(connection, row)

    def get_many(self, entity_ids: Sequence[str]) -> list[EntityInstance]:
        result: list[EntityInstance] = []
        for entity_id in entity_ids:
            entity = self.get(entity_id)
            if entity is not None:
                result.append(entity)
        return result

    def find_by_identifier(self, key: str, value: str) -> list[EntityInstance]:
        connection = self._connect()
        rows = connection.execute(
            """
            SELECT e.* FROM entities e
            JOIN entity_identifiers i ON i.entity_id = e.entity_id
            WHERE i.key = ? AND i.value = ?
            ORDER BY e.entity_id
            """,
            (key, str(value)),
        ).fetchall()
        return [self._hydrate(connection, row) for row in rows]

    def find_by_name(
        self,
        text: str,
        *,
        type_codes: Sequence[str] | None = None,
        limit: int = 20,
    ) -> list[EntityCandidate]:
        connection = self._connect()
        candidates: dict[str, EntityCandidate] = {}
        sql = "SELECT * FROM entities WHERE canonical_name = ?"
        params: list[object] = [text]
        if type_codes:
            placeholders = ",".join("?" for _ in type_codes)
            sql += f" AND entity_type_code IN ({placeholders})"
            params.extend(type_codes)
        for row in connection.execute(sql, params).fetchall():
            candidates[row["entity_id"]] = EntityCandidate(
                entity_id=row["entity_id"],
                entity_type_code=row["entity_type_code"],
                canonical_name=row["canonical_name"],
                match_reason=["exact_name_match"],
                confidence=0.95,
                source=row["source"],
            )
        sql = """
            SELECT e.* FROM entities e
            JOIN entity_aliases a ON a.entity_id = e.entity_id
            WHERE a.alias = ?
        """
        params = [text]
        if type_codes:
            placeholders = ",".join("?" for _ in type_codes)
            sql += f" AND e.entity_type_code IN ({placeholders})"
            params.extend(type_codes)
        for row in connection.execute(sql, params).fetchall():
            existing = candidates.get(row["entity_id"])
            if existing is not None:
                continue
            candidates[row["entity_id"]] = EntityCandidate(
                entity_id=row["entity_id"],
                entity_type_code=row["entity_type_code"],
                canonical_name=row["canonical_name"],
                match_reason=["alias_match"],
                confidence=0.90,
                source=row["source"],
            )
        ordered = sorted(candidates.values(), key=lambda item: (-item.confidence, item.entity_id))
        return ordered[:limit]

    def list_by_type(
        self, type_code: str, *, limit: int = 100, cursor: str | None = None
    ) -> tuple[list[EntityInstance], str | None]:
        connection = self._connect()
        sql = "SELECT * FROM entities WHERE entity_type_code = ?"
        params: list[object] = [type_code]
        if cursor:
            sql += " AND entity_id > ?"
            params.append(cursor)
        sql += " ORDER BY entity_id LIMIT ?"
        params.append(limit + 1)
        rows = connection.execute(sql, params).fetchall()
        next_cursor = rows[limit]["entity_id"] if len(rows) > limit else None
        return [self._hydrate(connection, row) for row in rows[:limit]], next_cursor

    def _hydrate(self, connection: sqlite3.Connection, row: sqlite3.Row) -> EntityInstance:
        entity_id = row["entity_id"]
        aliases = [
            item["alias"]
            for item in connection.execute(
                "SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias",
                (entity_id,),
            ).fetchall()
        ]
        identifiers = {
            item["key"]: item["value"]
            for item in connection.execute(
                "SELECT key, value FROM entity_identifiers WHERE entity_id = ?",
                (entity_id,),
            ).fetchall()
        }
        relations = [
            EntityRelation(
                target_entity_id=item["to_entity_id"],
                relation_type=item["relation_type"],
                attributes=_loads(item["attributes_json"], {}),
                source=item["source"],
                confidence=item["confidence"],
                valid_from=item["valid_from"],
                valid_to=item["valid_to"],
            )
            for item in connection.execute(
                "SELECT * FROM entity_relations WHERE from_entity_id = ? ORDER BY relation_type, to_entity_id",
                (entity_id,),
            ).fetchall()
        ]
        return EntityInstance(
            entity_id=entity_id,
            entity_type_code=row["entity_type_code"],
            canonical_name=row["canonical_name"],
            aliases=aliases,
            identifiers=identifiers,
            attributes=_loads(row["attributes_json"], {}),
            relations=relations,
            source=row["source"],
            last_verified_at=row["last_verified_at"],
            status=row["status"],
        )

    def relations_from(
        self, entity_id: str, *, relation_type: str | None = None
    ) -> list[EntityRelation]:
        sql = "SELECT * FROM entity_relations WHERE from_entity_id = ?"
        params: list[object] = [entity_id]
        if relation_type:
            sql += " AND relation_type = ?"
            params.append(relation_type)
        sql += " ORDER BY relation_type, to_entity_id"
        rows = self._connect().execute(sql, params).fetchall()
        return [
            EntityRelation(
                target_entity_id=row["to_entity_id"],
                relation_type=row["relation_type"],
                attributes=_loads(row["attributes_json"], {}),
                source=row["source"],
                confidence=row["confidence"],
                valid_from=row["valid_from"],
                valid_to=row["valid_to"],
            )
            for row in rows
        ]

    def index_terms(self) -> list[IndexTerm]:
        connection = self._connect()
        terms: list[IndexTerm] = []
        for row in connection.execute(
            "SELECT entity_id, entity_type_code, canonical_name FROM entities"
        ).fetchall():
            terms.append(
                IndexTerm(row["canonical_name"], row["entity_id"], row["entity_type_code"], "canonical_name", 20)
            )
        for row in connection.execute(
            """
            SELECT a.alias, a.entity_id, e.entity_type_code
            FROM entity_aliases a JOIN entities e ON e.entity_id = a.entity_id
            """
        ).fetchall():
            terms.append(
                IndexTerm(row["alias"], row["entity_id"], row["entity_type_code"], "alias", 15)
            )
        return terms

    # ── 写 ──────────────────────────────────────────────────────────
    def upsert_entities(self, entities: Iterable[EntityInstance], *, source_version: str) -> int:
        items = list(entities)
        for entity in items:
            if not entity.entity_id or not entity.canonical_name:
                raise InvalidRecord("实体必须有 entity_id 与 canonical_name")
        with self.transaction():
            connection = self._connect()
            for entity in items:
                existing = self.get(entity.entity_id)
                if existing is not None:
                    entity = merge_entity(existing, entity)
                now = _utcnow()
                connection.execute(
                    """
                    INSERT INTO entities(
                        entity_id, entity_type_code, canonical_name, attributes_json,
                        source, last_verified_at, status, source_version, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(entity_id) DO UPDATE SET
                        entity_type_code=excluded.entity_type_code,
                        canonical_name=excluded.canonical_name,
                        attributes_json=excluded.attributes_json,
                        source=excluded.source,
                        last_verified_at=excluded.last_verified_at,
                        status=excluded.status,
                        source_version=excluded.source_version,
                        updated_at=excluded.updated_at
                    """,
                    (
                        entity.entity_id,
                        entity.entity_type_code,
                        entity.canonical_name,
                        json.dumps(entity.attributes, ensure_ascii=False),
                        entity.source,
                        entity.last_verified_at.isoformat() if entity.last_verified_at else None,
                        entity.status,
                        source_version,
                        now,
                    ),
                )
                connection.execute(
                    "DELETE FROM entity_aliases WHERE entity_id = ?", (entity.entity_id,)
                )
                for alias in dict.fromkeys(entity.aliases):
                    connection.execute(
                        "INSERT OR IGNORE INTO entity_aliases(entity_id, alias, alias_type, source) "
                        "VALUES (?, ?, 'alias', ?)",
                        (entity.entity_id, alias, entity.source),
                    )
                connection.execute(
                    "DELETE FROM entity_identifiers WHERE entity_id = ?", (entity.entity_id,)
                )
                for key, value in entity.identifiers.items():
                    connection.execute(
                        "INSERT OR IGNORE INTO entity_identifiers(entity_id, key, value) VALUES (?, ?, ?)",
                        (entity.entity_id, key, str(value)),
                    )
                for relation in entity.relations:
                    connection.execute(
                        """
                        INSERT INTO entity_relations(
                            from_entity_id, to_entity_id, relation_type,
                            attributes_json, source, confidence, valid_from, valid_to
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(from_entity_id, to_entity_id, relation_type) DO UPDATE SET
                            attributes_json=excluded.attributes_json,
                            source=excluded.source,
                            confidence=excluded.confidence,
                            valid_from=excluded.valid_from,
                            valid_to=excluded.valid_to
                        """,
                        (
                            entity.entity_id,
                            relation.target_entity_id,
                            relation.relation_type,
                            json.dumps(relation.attributes, ensure_ascii=False),
                            relation.source or entity.source,
                            relation.confidence,
                            relation.valid_from,
                            relation.valid_to,
                        ),
                    )
            self._bump_index_version(connection)
        return len(items)

    def get_collection(self, collection_id: str) -> EntityCollection | None:
        connection = self._connect()
        row = connection.execute(
            "SELECT * FROM entity_collections WHERE collection_id = ?", (collection_id,)
        ).fetchone()
        if row is None:
            return None
        members = [
            item["entity_id"]
            for item in connection.execute(
                "SELECT entity_id FROM collection_members WHERE collection_id = ? ORDER BY entity_id",
                (collection_id,),
            ).fetchall()
        ]
        return EntityCollection(
            collection_id=row["collection_id"],
            collection_type=row["collection_type"],
            source=row["source"],
            as_of=row["as_of"],
            member_entity_ids=members,
            filter_definition=_loads(row["filter_definition_json"], {}),
            authorization_status=row["authorization_status"],
        )

    def replace_collection(self, collection: EntityCollection) -> None:
        with self.transaction():
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO entity_collections(
                    collection_id, collection_type, source, as_of,
                    filter_definition_json, authorization_status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(collection_id) DO UPDATE SET
                    collection_type=excluded.collection_type,
                    source=excluded.source,
                    as_of=excluded.as_of,
                    filter_definition_json=excluded.filter_definition_json,
                    authorization_status=excluded.authorization_status,
                    updated_at=excluded.updated_at
                """,
                (
                    collection.collection_id,
                    collection.collection_type,
                    collection.source,
                    collection.as_of.isoformat() if collection.as_of else None,
                    json.dumps(collection.filter_definition, ensure_ascii=False),
                    collection.authorization_status,
                    _utcnow(),
                ),
            )
            connection.execute(
                "DELETE FROM collection_members WHERE collection_id = ?",
                (collection.collection_id,),
            )
            for entity_id in dict.fromkeys(collection.member_entity_ids):
                connection.execute(
                    "INSERT OR IGNORE INTO collection_members(collection_id, entity_id) VALUES (?, ?)",
                    (collection.collection_id, entity_id),
                )

    def save_scope(self, scope: ResearchScope) -> None:
        with self.transaction():
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO scope_requests(request_id, raw_query, status, scope_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(request_id) DO UPDATE SET
                    raw_query=excluded.raw_query,
                    status=excluded.status,
                    scope_json=excluded.scope_json,
                    created_at=excluded.created_at
                """,
                (
                    scope.request_id,
                    scope.raw_query,
                    scope.status,
                    scope.model_dump_json(),
                    _utcnow(),
                ),
            )

    def get_scope(self, request_id: str) -> ResearchScope | None:
        row = self._connect().execute(
            "SELECT scope_json FROM scope_requests WHERE request_id = ?", (request_id,)
        ).fetchone()
        if row is None:
            return None
        return ResearchScope.model_validate_json(row["scope_json"])

    def save_mention(self, mention: EntityMention) -> None:
        with self.transaction():
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO mentions(
                    mention_id, request_id, raw_text, start_offset, end_offset,
                    resolution_status, resolved_entity_id, payload_json, created_at
                ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(mention_id) DO UPDATE SET
                    raw_text=excluded.raw_text,
                    start_offset=excluded.start_offset,
                    end_offset=excluded.end_offset,
                    resolution_status=excluded.resolution_status,
                    resolved_entity_id=excluded.resolved_entity_id,
                    payload_json=excluded.payload_json,
                    created_at=excluded.created_at
                """,
                (
                    mention.mention_id,
                    mention.raw_text,
                    mention.start_offset,
                    mention.end_offset,
                    mention.resolution_status,
                    mention.resolved_entity_id,
                    mention.model_dump_json(),
                    _utcnow(),
                ),
            )

    def record_source_import(self, record: SourceImport) -> None:
        with self.transaction():
            self._connect().execute(
                """
                INSERT OR REPLACE INTO source_imports(
                    import_id, source_id, source_version, imported_count,
                    status, warnings_json, error, imported_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.import_id,
                    record.source_id,
                    record.source_version,
                    record.imported_count,
                    record.status,
                    json.dumps(record.warnings, ensure_ascii=False),
                    record.error,
                    record.imported_at.isoformat(),
                ),
            )

    def list_source_imports(self, *, limit: int = 500) -> list[SourceImport]:
        rows = self._connect().execute(
            """
            SELECT * FROM source_imports
            ORDER BY imported_at DESC, import_id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [
            SourceImport(
                import_id=row["import_id"],
                source_id=row["source_id"],
                source_version=row["source_version"],
                imported_count=row["imported_count"],
                status=row["status"],
                warnings=_loads(row["warnings_json"], []),
                error=row["error"],
                imported_at=datetime.fromisoformat(row["imported_at"]),
            )
            for row in rows
        ]

    def append_audit(self, event: AuditEvent) -> None:
        with self.transaction():
            self._connect().execute(
                """
                INSERT OR REPLACE INTO audit_events(event_id, request_id, stage, created_at, payload_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.request_id,
                    event.stage,
                    event.created_at.isoformat(),
                    json.dumps(event.payload, ensure_ascii=False),
                ),
            )

    def list_audit(self, request_id: str) -> list[AuditEvent]:
        rows = self._connect().execute(
            "SELECT * FROM audit_events WHERE request_id = ? ORDER BY created_at, event_id",
            (request_id,),
        ).fetchall()
        return [
            AuditEvent(
                event_id=row["event_id"],
                request_id=row["request_id"],
                stage=row["stage"],
                created_at=row["created_at"],
                payload=_loads(row["payload_json"], {}),
            )
            for row in rows
        ]

    def save_evidence(self, item: EvidenceItem) -> None:
        with self.transaction():
            self._connect().execute(
                """
                INSERT OR REPLACE INTO evidence_items(
                    evidence_id, request_id, tool_id, status, entity_ids_json,
                    source, fetched_at, record_count, data_json, warnings_json,
                    error, duration_ms, authorization, cache_hit
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.evidence_id,
                    item.request_id,
                    item.tool_id,
                    item.status,
                    json.dumps(item.entity_ids, ensure_ascii=False),
                    item.source,
                    item.fetched_at.isoformat(),
                    item.record_count,
                    json.dumps(item.data, ensure_ascii=False, default=str),
                    json.dumps(item.warnings, ensure_ascii=False, default=str),
                    item.error,
                    item.duration_ms,
                    item.authorization,
                    1 if item.cache_hit else 0,
                ),
            )

    def save_report(self, report: ReportDraft) -> None:
        with self.transaction():
            self._connect().execute(
                """
                INSERT OR REPLACE INTO reports(
                    report_id, request_id, mode, created_at, report_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    report.report_id,
                    report.request_id,
                    report.mode,
                    report.created_at.isoformat(),
                    report.model_dump_json(),
                ),
            )

    def get_report(self, report_id: str) -> ReportDraft | None:
        row = self._connect().execute(
            "SELECT report_json FROM reports WHERE report_id = ?",
            (report_id,),
        ).fetchone()
        return self._parse_report(row["report_json"]) if row is not None else None

    def list_reports(self, request_id: str) -> list[ReportDraft]:
        rows = self._connect().execute(
            """
            SELECT report_json FROM reports
            WHERE request_id = ?
            ORDER BY created_at, report_id
            """,
            (request_id,),
        ).fetchall()
        return [self._parse_report(row["report_json"]) for row in rows]

    @staticmethod
    def _parse_report(raw: str) -> ReportDraft:
        return ReportDraft.model_validate_json(raw)

    def list_evidence(self, request_id: str) -> list[EvidenceItem]:
        rows = self._connect().execute(
            """
            SELECT * FROM evidence_items
            WHERE request_id = ?
            ORDER BY fetched_at, evidence_id
            """,
            (request_id,),
        ).fetchall()
        return [
            EvidenceItem(
                evidence_id=row["evidence_id"],
                request_id=row["request_id"],
                tool_id=row["tool_id"],
                status=row["status"],
                entity_ids=_loads(row["entity_ids_json"], []),
                source=row["source"],
                fetched_at=datetime.fromisoformat(row["fetched_at"]),
                record_count=row["record_count"],
                data=_loads(row["data_json"], {}),
                warnings=_loads(row["warnings_json"], []),
                error=row["error"],
                duration_ms=row["duration_ms"],
                authorization=row["authorization"],
                cache_hit=bool(row["cache_hit"]),
            )
            for row in rows
        ]

    def close(self) -> None:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None
