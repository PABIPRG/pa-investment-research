-- 时间事件：委托版本的到期日程。

CREATE TABLE IF NOT EXISTS mandate_schedules (
    schedule_id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (
        mode IN ('condition', 'scheduled_delivery', 'due_reminder', 'periodic_check')
    ),
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    catchup_seconds INTEGER NOT NULL DEFAULT 86400,
    trading_days_only INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_due_at TEXT NOT NULL,
    last_instance_key TEXT,
    skipped_missed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mandate_schedules_due
    ON mandate_schedules(enabled, next_due_at);
CREATE INDEX IF NOT EXISTS ix_mandate_schedules_mandate
    ON mandate_schedules(mandate_id, revision);
