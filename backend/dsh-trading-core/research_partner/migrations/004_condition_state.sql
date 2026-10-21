-- 时间状态：按委托与条件键保存“当前是否满足”及其持续时间。

CREATE TABLE IF NOT EXISTS condition_states (
    mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id) ON DELETE CASCADE,
    condition_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('met', 'unmet')),
    state_since TEXT NOT NULL,
    met_episodes INTEGER NOT NULL DEFAULT 0,
    last_met_at TEXT,
    last_evaluated_at TEXT NOT NULL,
    PRIMARY KEY (mandate_id, condition_key)
);
