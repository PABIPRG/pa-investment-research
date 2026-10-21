-- 证据缓存标记：命中本地缓存时仍记录证据，但要能区分"新抓取"与"复用"。

ALTER TABLE evidence_items
    ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0;
