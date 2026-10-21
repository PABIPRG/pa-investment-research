-- 研究委托核心业务库 v1：委托、版本、依赖、事件、任务、联系决定、幂等回执。
-- 设计对照：docs/design/0.2.0/火火投研伙伴-产品与架构设计-2026-10-21-v1.3.md 第 5、9 章。
-- 约定：所有时间为带时区的 ISO-8601 字符串（UTC）；JSON 字段只存领域数据。

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ── 委托与版本 ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mandates (
    mandate_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending_requirements', 'tracking', 'paused', 'ended')
    ),
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    source_session_id TEXT,
    source_message_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_mandates_owner
    ON mandates(principal_id, instance_id, updated_at DESC, mandate_id DESC);
CREATE INDEX IF NOT EXISTS ix_mandates_status
    ON mandates(principal_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mandate_revisions (
    mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    goal TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    triggers_json TEXT NOT NULL DEFAULT '[]',
    contact_policy_json TEXT NOT NULL DEFAULT '{}',
    basis_json TEXT NOT NULL DEFAULT '{}',
    change_summary TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (mandate_id, revision)
);

CREATE TABLE IF NOT EXISTS mandate_subjects (
    mandate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    entity_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary_subject',
    scope_mode TEXT NOT NULL CHECK (scope_mode IN ('fixed', 'dynamic')),
    collection_version TEXT,
    PRIMARY KEY (mandate_id, revision, entity_id, role),
    FOREIGN KEY (mandate_id, revision)
        REFERENCES mandate_revisions(mandate_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_mandate_subjects_entity
    ON mandate_subjects(entity_id, mandate_id);

CREATE TABLE IF NOT EXISTS mandate_requirements (
    requirement_id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    code TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'waived')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (mandate_id, revision)
        REFERENCES mandate_revisions(mandate_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_mandate_requirements_open
    ON mandate_requirements(mandate_id, status);

CREATE TABLE IF NOT EXISTS tracking_dependencies (
    mandate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    dependency_id TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    subject_id TEXT,
    event_type TEXT,
    feature_key TEXT,
    scope_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    rule_version TEXT NOT NULL DEFAULT '1',
    created_at TEXT NOT NULL,
    PRIMARY KEY (mandate_id, revision, dependency_id),
    FOREIGN KEY (mandate_id, revision)
        REFERENCES mandate_revisions(mandate_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_tracking_dependencies_route
    ON tracking_dependencies(active, hook_type, subject_id, event_type);
CREATE INDEX IF NOT EXISTS ix_tracking_dependencies_mandate
    ON tracking_dependencies(mandate_id, revision, active);

CREATE TABLE IF NOT EXISTS mandate_progress (
    mandate_id TEXT PRIMARY KEY REFERENCES mandates(mandate_id) ON DELETE CASCADE,
    mandate_revision INTEGER NOT NULL,
    baseline_json TEXT NOT NULL DEFAULT '{}',
    last_checked_at TEXT,
    last_result_id TEXT,
    last_notified_at TEXT,
    updated_at TEXT NOT NULL
);

-- ── 事件接收与可靠发布 ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS domain_events (
    event_id TEXT PRIMARY KEY,
    hook_type TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    producer TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source_version TEXT,
    content_hash TEXT,
    correlation_id TEXT,
    causation_id TEXT,
    origin_run_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_domain_events_type_time
    ON domain_events(hook_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_domain_events_observed
    ON domain_events(observed_at DESC);

CREATE TABLE IF NOT EXISTS event_subjects (
    event_id TEXT NOT NULL REFERENCES domain_events(event_id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY (event_id, subject_id)
);
CREATE INDEX IF NOT EXISTS ix_event_subjects_subject
    ON event_subjects(subject_id, event_id);

CREATE TABLE IF NOT EXISTS event_inbox (
    event_id TEXT PRIMARY KEY REFERENCES domain_events(event_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'processing', 'processed', 'failed', 'ignored')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS ix_event_inbox_status
    ON event_inbox(status, received_at);

CREATE TABLE IF NOT EXISTS consumer_cursors (
    consumer TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_outbox (
    outbox_id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'published', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS ix_event_outbox_due
    ON event_outbox(status, available_at);

-- ── 持久研究任务 ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_jobs (
    job_id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id) ON DELETE CASCADE,
    mandate_revision INTEGER NOT NULL,
    trigger_event_id TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'waiting_data', 'completed', 'failed', 'cancelled')
    ),
    lease_token TEXT,
    lease_expires_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    budget_json TEXT NOT NULL DEFAULT '{}',
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    cancel_generation INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_research_jobs_claim
    ON research_jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS ix_research_jobs_mandate
    ON research_jobs(mandate_id, mandate_revision);

CREATE TABLE IF NOT EXISTS research_job_results (
    result_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES research_jobs(job_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    structured_result_json TEXT NOT NULL DEFAULT '{}',
    evidence_batch_id TEXT,
    gaps_json TEXT NOT NULL DEFAULT '[]',
    change_summary TEXT NOT NULL DEFAULT '',
    contact_suggestion_json TEXT NOT NULL DEFAULT '{}',
    stale INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_research_job_results_job
    ON research_job_results(job_id, received_at DESC);

-- ── 联系决定与投递结果 ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_decisions (
    decision_id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id) ON DELETE CASCADE,
    mandate_revision INTEGER NOT NULL,
    job_id TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('send', 'suppress', 'defer', 'aggregate')),
    reason_code TEXT NOT NULL,
    condition_result TEXT NOT NULL CHECK (
        condition_result IN ('met', 'unmet', 'unknown', 'error')
    ),
    detail TEXT NOT NULL DEFAULT '',
    evidence_ref TEXT,
    dedupe_key TEXT NOT NULL,
    eligible_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (mandate_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_contact_decisions_mandate
    ON contact_decisions(mandate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_records (
    decision_id TEXT NOT NULL REFERENCES contact_decisions(decision_id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    sent_at TEXT,
    delivery_job_id TEXT,
    detail TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (decision_id, channel)
);

-- ── 命令幂等回执 ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS command_idempotency (
    principal_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, operation, idempotency_key)
);
