-- 研究实体库 v1：类型、实体、别名、标识、关系、集合、Scope、审计。
-- 只存运行时实例；实体类型的事实源仍是代码注册表。

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_types (
    type_code TEXT PRIMARY KEY,
    parent_code TEXT NOT NULL,
    type_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL,
    is_dynamic INTEGER NOT NULL DEFAULT 0,
    normalization_keys_json TEXT NOT NULL DEFAULT '[]',
    default_tool_ids_json TEXT NOT NULL DEFAULT '[]',
    schema_version TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
    entity_id TEXT PRIMARY KEY,
    entity_type_code TEXT NOT NULL,
    canonical_name TEXT NOT NULL COLLATE NOCASE,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    source TEXT,
    last_verified_at TEXT,
    status TEXT NOT NULL,
    source_version TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entities_type_name
    ON entities(entity_type_code, canonical_name);
CREATE INDEX IF NOT EXISTS ix_entities_name
    ON entities(canonical_name);

CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id TEXT NOT NULL,
    alias TEXT NOT NULL COLLATE NOCASE,
    alias_type TEXT NOT NULL DEFAULT 'alias',
    source TEXT,
    confidence REAL,
    PRIMARY KEY (entity_id, alias)
);
CREATE INDEX IF NOT EXISTS ix_entity_aliases_alias ON entity_aliases(alias);

CREATE TABLE IF NOT EXISTS entity_identifiers (
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (entity_id, key, value)
);
CREATE INDEX IF NOT EXISTS ix_entity_identifiers_lookup
    ON entity_identifiers(key, value);

CREATE TABLE IF NOT EXISTS entity_relations (
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    source TEXT,
    confidence REAL,
    valid_from TEXT,
    valid_to TEXT,
    PRIMARY KEY (from_entity_id, to_entity_id, relation_type)
);
CREATE INDEX IF NOT EXISTS ix_entity_relations_from
    ON entity_relations(from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS ix_entity_relations_to
    ON entity_relations(to_entity_id, relation_type);

CREATE TABLE IF NOT EXISTS entity_collections (
    collection_id TEXT PRIMARY KEY,
    collection_type TEXT NOT NULL,
    source TEXT NOT NULL,
    as_of TEXT,
    filter_definition_json TEXT NOT NULL DEFAULT '{}',
    authorization_status TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_members (
    collection_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (collection_id, entity_id)
);

CREATE TABLE IF NOT EXISTS scope_requests (
    request_id TEXT PRIMARY KEY,
    raw_query TEXT NOT NULL,
    status TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_scope_requests_created ON scope_requests(created_at);

CREATE TABLE IF NOT EXISTS mentions (
    mention_id TEXT PRIMARY KEY,
    request_id TEXT,
    raw_text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    resolution_status TEXT NOT NULL,
    resolved_entity_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mentions_request ON mentions(request_id);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_audit_events_request ON audit_events(request_id);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
