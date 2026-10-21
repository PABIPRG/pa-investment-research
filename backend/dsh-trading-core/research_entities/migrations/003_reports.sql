-- 研究报告：按 request_id 保存结构化报告，便于回放与对比模型输出。

CREATE TABLE IF NOT EXISTS reports (
    report_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reports_request
    ON reports(request_id, created_at);
