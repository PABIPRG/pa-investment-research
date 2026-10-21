-- 研究证据：每次工具执行按 request_id 落库，供报告层回放与引用。

CREATE TABLE IF NOT EXISTS evidence_items (
    evidence_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    status TEXT NOT NULL,
    entity_ids_json TEXT NOT NULL DEFAULT '[]',
    source TEXT,
    fetched_at TEXT NOT NULL,
    record_count INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL DEFAULT '{}',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    duration_ms INTEGER,
    authorization TEXT NOT NULL DEFAULT 'not_required'
);
CREATE INDEX IF NOT EXISTS ix_evidence_items_request
    ON evidence_items(request_id, fetched_at);
