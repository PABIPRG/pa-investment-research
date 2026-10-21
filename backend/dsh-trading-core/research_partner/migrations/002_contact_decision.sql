-- 消推算法：条件键、消推配置、暂缓。

ALTER TABLE contact_decisions
    ADD COLUMN condition_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ix_contact_decisions_condition
    ON contact_decisions(mandate_id, condition_key, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
    principal_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    quiet_hours_json TEXT,
    channels_json TEXT NOT NULL DEFAULT '["app"]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, instance_id)
);

CREATE TABLE IF NOT EXISTS notification_snoozes (
    snooze_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('mandate', 'decision')),
    scope_id TEXT NOT NULL,
    until TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notification_snoozes_owner
    ON notification_snoozes(principal_id, instance_id, until);
CREATE INDEX IF NOT EXISTS ix_notification_snoozes_scope
    ON notification_snoozes(scope_type, scope_id, until);
