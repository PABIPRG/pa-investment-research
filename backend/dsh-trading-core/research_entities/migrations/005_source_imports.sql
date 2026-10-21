-- 主数据导入记录：每次导入尝试（成功/失败）都留痕，用于新鲜度与过期标记。
-- 实体表不记录导入时间来源；新鲜度以本表最近一次成功导入为准。

CREATE TABLE IF NOT EXISTS source_imports (
    import_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_version TEXT NOT NULL DEFAULT '',
    imported_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_source_imports_source
    ON source_imports(source_id, imported_at);
