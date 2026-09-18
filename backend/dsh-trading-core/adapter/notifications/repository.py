# -*- coding: utf-8 -*-
"""统一通知中心的 SQLite 权威仓储。"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .presentation import holdings_issue_copy


SCHEMA_VERSION = 1
FINAL_DELIVERY_STATES = {"sent", "dead_letter", "suppressed", "cancelled"}
PORTABLE_TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "notifications": (
        "id", "category", "severity", "title", "summary", "body", "subject_kind",
        "subject_id", "action_kind", "action_id", "payload_json", "dedupe_key",
        "occurrence_count", "occurred_at", "last_occurred_at", "created_at", "updated_at",
        "read_at", "archived_at",
    ),
    "notification_events": (
        "producer", "event_id", "event_type", "notification_id", "occurred_at",
        "correlation_id", "causation_id", "payload_json", "created_at",
    ),
    "delivery_jobs": (
        "id", "notification_id", "channel", "destination", "title", "content",
        "action_kind", "action_id", "status", "attempt_count", "next_attempt_at",
        "lease_token", "lease_expires_at", "last_error_code", "last_error_message",
        "outcome_uncertain", "sent_at", "created_at", "updated_at",
    ),
    "delivery_attempts": (
        "id", "job_id", "attempt_number", "outcome", "error_code", "error_message",
        "outcome_uncertain", "attempted_at",
    ),
    "notification_preferences": ("category", "channel", "enabled", "updated_at"),
    "notification_audit": ("id", "notification_id", "action", "details_json", "created_at"),
}
_SECRET_PATTERN = re.compile(r"(?i)(secret|token|key|password)=([^\s&]+)")
_URL_PATTERN = re.compile(r"https?://\S+")


def _iso(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("时间必须包含时区")
    return value.astimezone(timezone.utc).isoformat()


def _redact(value: str) -> str:
    return _URL_PATTERN.sub("[已脱敏地址]", _SECRET_PATTERN.sub(r"\1=[已脱敏]", value))[:500]


class NotificationNotFoundError(KeyError):
    """通知或投递任务不存在。"""


class NotificationConflictError(RuntimeError):
    """通知状态已被其他操作更新。"""


class NotificationRepository:
    """通过短连接和事务提供跨线程、跨进程安全的通知状态。"""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_lock = threading.Lock()
        self._initialized = False
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def _ensure_schema(self) -> None:
        with self._init_lock:
            if self._initialized:
                return
            with self._connect() as connection:
                version = int(connection.execute("PRAGMA user_version").fetchone()[0])
                if version not in {0, SCHEMA_VERSION}:
                    raise RuntimeError(f"不支持的通知数据库版本: {version}")
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS notifications (
                        id TEXT PRIMARY KEY,
                        category TEXT NOT NULL,
                        severity TEXT NOT NULL,
                        title TEXT NOT NULL,
                        summary TEXT NOT NULL,
                        body TEXT NOT NULL,
                        subject_kind TEXT NOT NULL,
                        subject_id TEXT NOT NULL,
                        action_kind TEXT NOT NULL,
                        action_id TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        dedupe_key TEXT NOT NULL,
                        occurrence_count INTEGER NOT NULL DEFAULT 1,
                        occurred_at TEXT NOT NULL,
                        last_occurred_at TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        read_at TEXT,
                        archived_at TEXT
                    );
                    CREATE INDEX IF NOT EXISTS notifications_listing
                        ON notifications(archived_at, read_at, last_occurred_at DESC, id DESC);
                    CREATE INDEX IF NOT EXISTS notifications_dedupe
                        ON notifications(dedupe_key, last_occurred_at DESC);

                    CREATE TABLE IF NOT EXISTS notification_events (
                        producer TEXT NOT NULL,
                        event_id TEXT NOT NULL,
                        event_type TEXT NOT NULL,
                        notification_id TEXT NOT NULL REFERENCES notifications(id),
                        occurred_at TEXT NOT NULL,
                        correlation_id TEXT,
                        causation_id TEXT,
                        payload_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY(producer, event_id)
                    );

                    CREATE TABLE IF NOT EXISTS delivery_jobs (
                        id TEXT PRIMARY KEY,
                        notification_id TEXT NOT NULL REFERENCES notifications(id),
                        channel TEXT NOT NULL,
                        destination TEXT NOT NULL,
                        title TEXT NOT NULL,
                        content TEXT NOT NULL,
                        action_kind TEXT NOT NULL,
                        action_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        attempt_count INTEGER NOT NULL DEFAULT 0,
                        next_attempt_at TEXT NOT NULL,
                        lease_token TEXT,
                        lease_expires_at TEXT,
                        last_error_code TEXT,
                        last_error_message TEXT,
                        outcome_uncertain INTEGER NOT NULL DEFAULT 0,
                        sent_at TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        UNIQUE(notification_id, channel, destination)
                    );
                    CREATE INDEX IF NOT EXISTS delivery_jobs_due
                        ON delivery_jobs(status, next_attempt_at, lease_expires_at);

                    CREATE TABLE IF NOT EXISTS delivery_attempts (
                        id TEXT PRIMARY KEY,
                        job_id TEXT NOT NULL REFERENCES delivery_jobs(id),
                        attempt_number INTEGER NOT NULL,
                        outcome TEXT NOT NULL,
                        error_code TEXT,
                        error_message TEXT,
                        outcome_uncertain INTEGER NOT NULL DEFAULT 0,
                        attempted_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS notification_preferences (
                        category TEXT NOT NULL,
                        channel TEXT NOT NULL,
                        enabled INTEGER NOT NULL,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY(category, channel)
                    );

                    CREATE TABLE IF NOT EXISTS notification_subscriptions (
                        id TEXT PRIMARY KEY,
                        channel TEXT NOT NULL,
                        device_id TEXT NOT NULL,
                        endpoint TEXT NOT NULL,
                        subscription_json TEXT NOT NULL,
                        active INTEGER NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        UNIQUE(channel, device_id)
                    );

                    CREATE TABLE IF NOT EXISTS notification_audit (
                        id TEXT PRIMARY KEY,
                        notification_id TEXT,
                        action TEXT NOT NULL,
                        details_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    """
                )
                connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            self._initialized = True

    def count(self, table: str) -> int:
        allowed = {
            "notifications", "notification_events", "delivery_jobs", "delivery_attempts",
            "notification_preferences", "notification_subscriptions", "notification_audit",
        }
        if table not in allowed:
            raise ValueError("不支持的通知表")
        with self._connect() as connection:
            return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

    def export_portable(self) -> dict[str, Any]:
        """导出可迁移状态；设备订阅与可再次执行的投递租约不进入快照。"""
        tables: dict[str, list[dict[str, Any]]] = {}
        with self._connect() as connection:
            connection.execute("BEGIN")
            for table, columns in PORTABLE_TABLE_COLUMNS.items():
                rows = connection.execute(
                    f"SELECT {', '.join(columns)} FROM {table} ORDER BY rowid"
                ).fetchall()
                tables[table] = [{column: row[column] for column in columns} for row in rows]
        for job in tables["delivery_jobs"]:
            # 恢复历史用于展示和审计，不得重新激活导出时尚未完成的外部副作用。
            if job["status"] not in FINAL_DELIVERY_STATES:
                job["status"] = "cancelled"
            job["destination"] = "restored"
            job["lease_token"] = None
            job["lease_expires_at"] = None
        return {"schemaVersion": 1, "tables": tables}

    @staticmethod
    def validate_portable(value: Any) -> dict[str, list[dict[str, Any]]]:
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise ValueError("通知快照版本无效")
        raw_tables = value.get("tables")
        if not isinstance(raw_tables, dict) or set(raw_tables) != set(PORTABLE_TABLE_COLUMNS):
            raise ValueError("通知快照表集合无效")
        validated: dict[str, list[dict[str, Any]]] = {}
        for table, columns in PORTABLE_TABLE_COLUMNS.items():
            rows = raw_tables.get(table)
            if not isinstance(rows, list):
                raise ValueError(f"通知快照表 {table} 必须是列表")
            expected = set(columns)
            validated_rows: list[dict[str, Any]] = []
            for row in rows:
                if not isinstance(row, dict) or set(row) != expected:
                    raise ValueError(f"通知快照表 {table} 行格式无效")
                validated_rows.append(dict(row))
            validated[table] = validated_rows
        notification_ids = {str(row["id"]) for row in validated["notifications"]}
        if any(str(row["notification_id"]) not in notification_ids for row in validated["notification_events"]):
            raise ValueError("通知事件引用无效")
        if any(str(row["notification_id"]) not in notification_ids for row in validated["delivery_jobs"]):
            raise ValueError("通知投递引用无效")
        job_ids = {str(row["id"]) for row in validated["delivery_jobs"]}
        if any(str(row["job_id"]) not in job_ids for row in validated["delivery_attempts"]):
            raise ValueError("通知投递尝试引用无效")
        for job in validated["delivery_jobs"]:
            if job["status"] not in FINAL_DELIVERY_STATES:
                raise ValueError("通知快照包含可再次执行的投递任务")
            if job["lease_token"] is not None or job["lease_expires_at"] is not None:
                raise ValueError("通知快照包含投递租约")
        return validated

    def replace_portable(self, value: Any) -> None:
        """用已校验快照替换可迁移状态，同时保留本机设备订阅。"""
        tables = self.validate_portable(value)
        delete_order = (
            "delivery_attempts", "notification_audit", "delivery_jobs",
            "notification_events", "notifications", "notification_preferences",
        )
        insert_order = (
            "notifications", "notification_events", "delivery_jobs",
            "delivery_attempts", "notification_preferences", "notification_audit",
        )
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for table in delete_order:
                connection.execute(f"DELETE FROM {table}")
            for table in insert_order:
                columns = PORTABLE_TABLE_COLUMNS[table]
                placeholders = ", ".join("?" for _ in columns)
                connection.executemany(
                    f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
                    [tuple(row[column] for column in columns) for row in tables[table]],
                )

    @staticmethod
    def _notification(row: sqlite3.Row, delivery: dict[str, str] | None = None) -> dict[str, Any]:
        payload = json.loads(row["payload_json"])
        copy = holdings_issue_copy(payload) if row["category"] == "holdings_sync" and payload.get("reasonCode") else {}
        return {
            "id": row["id"],
            "category": row["category"],
            "severity": row["severity"],
            "title": row["title"],
            "summary": row["summary"],
            "body": row["body"],
            "subject": {"kind": row["subject_kind"], "id": row["subject_id"]},
            "action": {"kind": row["action_kind"], "id": row["action_id"]},
            "payload": payload,
            "occurrenceCount": row["occurrence_count"],
            "occurredAt": row["occurred_at"],
            "lastOccurredAt": row["last_occurred_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "readAt": row["read_at"],
            "archivedAt": row["archived_at"],
            "deliverySummary": delivery or {},
            **copy,
        }

    @staticmethod
    def _job(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "notificationId": row["notification_id"],
            "channel": row["channel"],
            "destination": row["destination"],
            "title": row["title"],
            "content": row["content"],
            "action": {"kind": row["action_kind"], "id": row["action_id"]},
            "status": row["status"],
            "attemptCount": row["attempt_count"],
            "nextAttemptAt": row["next_attempt_at"],
            "leaseToken": row["lease_token"],
            "leaseExpiresAt": row["lease_expires_at"],
            "lastErrorCode": row["last_error_code"],
            "lastErrorMessage": row["last_error_message"],
            "outcomeUncertain": bool(row["outcome_uncertain"]),
            "sentAt": row["sent_at"],
        }

    def _delivery_summary(self, connection: sqlite3.Connection, notification_id: str) -> dict[str, str]:
        rows = connection.execute(
            "SELECT channel, status FROM delivery_jobs WHERE notification_id = ? ORDER BY channel",
            (notification_id,),
        ).fetchall()
        priority = {
            "dead_letter": 7, "retry_wait": 6, "leased": 5, "pending": 4,
            "sent": 3, "suppressed": 2, "cancelled": 1,
        }
        result: dict[str, str] = {}
        for row in rows:
            channel = row["channel"]
            status = row["status"]
            if priority.get(status, 0) > priority.get(result.get(channel, ""), 0):
                result[channel] = status
        return result

    def publish(
        self,
        *,
        event: dict[str, Any],
        notification: dict[str, Any],
        channels: Iterable[tuple[str, str]],
        now: datetime,
        dedupe_window_seconds: int,
    ) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing_event = connection.execute(
                "SELECT notification_id FROM notification_events WHERE producer = ? AND event_id = ?",
                (event["producer"], event["eventId"]),
            ).fetchone()
            if existing_event is not None:
                row = connection.execute(
                    "SELECT * FROM notifications WHERE id = ?", (existing_event["notification_id"],)
                ).fetchone()
                result = self._notification(row, self._delivery_summary(connection, row["id"]))
                result.update({"duplicate": True, "aggregated": False})
                return result

            threshold = _iso(event["occurredAt"] - timedelta(seconds=dedupe_window_seconds))
            aggregate = connection.execute(
                """SELECT * FROM notifications
                   WHERE dedupe_key = ? AND last_occurred_at >= ? AND archived_at IS NULL
                   ORDER BY last_occurred_at DESC LIMIT 1""",
                (notification["dedupeKey"], threshold),
            ).fetchone()
            if aggregate is not None:
                connection.execute(
                    """UPDATE notifications
                       SET occurrence_count = occurrence_count + 1,
                           last_occurred_at = ?, updated_at = ?, summary = ?, body = ?, payload_json = ?
                       WHERE id = ?""",
                    (
                        event["occurredAt"].isoformat(), timestamp, notification["summary"],
                        notification["body"], json.dumps(event["payload"], ensure_ascii=False), aggregate["id"],
                    ),
                )
                self._insert_event(connection, event, aggregate["id"], timestamp)
                row = connection.execute("SELECT * FROM notifications WHERE id = ?", (aggregate["id"],)).fetchone()
                result = self._notification(row, self._delivery_summary(connection, row["id"]))
                result.update({"duplicate": False, "aggregated": True})
                return result

            notification_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO notifications(
                       id, category, severity, title, summary, body, subject_kind, subject_id,
                       action_kind, action_id, payload_json, dedupe_key, occurred_at,
                       last_occurred_at, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    notification_id, notification["category"], notification["severity"],
                    notification["title"], notification["summary"], notification["body"],
                    event["subject"]["kind"], event["subject"]["id"],
                    notification["action"]["kind"], notification["action"]["id"],
                    json.dumps(event["payload"], ensure_ascii=False), notification["dedupeKey"],
                    event["occurredAt"].isoformat(), event["occurredAt"].isoformat(), timestamp, timestamp,
                ),
            )
            self._insert_event(connection, event, notification_id, timestamp)
            for channel, destination in channels:
                connection.execute(
                    """INSERT INTO delivery_jobs(
                           id, notification_id, channel, destination, title, content,
                           action_kind, action_id, status, next_attempt_at, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)""",
                    (
                        str(uuid.uuid4()), notification_id, channel, destination,
                        notification["title"], notification["externalContent"],
                        notification["action"]["kind"], notification["action"]["id"],
                        timestamp, timestamp, timestamp,
                    ),
                )
            self._audit(connection, notification_id, "created", {"eventType": event["type"]}, timestamp)
            row = connection.execute("SELECT * FROM notifications WHERE id = ?", (notification_id,)).fetchone()
            result = self._notification(row, self._delivery_summary(connection, notification_id))
            result.update({"duplicate": False, "aggregated": False})
            return result

    def _insert_event(
        self, connection: sqlite3.Connection, event: dict[str, Any], notification_id: str, created_at: str
    ) -> None:
        connection.execute(
            """INSERT INTO notification_events(
                   producer, event_id, event_type, notification_id, occurred_at,
                   correlation_id, causation_id, payload_json, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event["producer"], event["eventId"], event["type"], notification_id,
                event["occurredAt"].isoformat(), event.get("correlationId"), event.get("causationId"),
                json.dumps(event["payload"], ensure_ascii=False), created_at,
            ),
        )

    def _audit(
        self, connection: sqlite3.Connection, notification_id: str | None,
        action: str, details: dict[str, Any], created_at: str,
    ) -> None:
        connection.execute(
            "INSERT INTO notification_audit(id, notification_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), notification_id, action, json.dumps(details, ensure_ascii=False), created_at),
        )

    def get(self, notification_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM notifications WHERE id = ?", (notification_id,)).fetchone()
            if row is None:
                raise NotificationNotFoundError(notification_id)
            return self._notification(row, self._delivery_summary(connection, notification_id))

    def list(
        self,
        *,
        view: str,
        archived: bool,
        category: str | None = None,
        severity: str | None = None,
        delivery: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        clauses = ["n.archived_at IS NOT NULL" if archived else "n.archived_at IS NULL"]
        values: list[Any] = []
        # Historical cancellations were persisted as failures; filters use the same effective severity as the inbox.
        effective_severity = (
            "(CASE WHEN n.category = 'holdings_sync' "
            "AND json_extract(n.payload_json, '$.reasonCode') = 'read_cancelled' "
            "THEN 'information' ELSE n.severity END)"
        )
        if view == "unread":
            clauses.append("n.read_at IS NULL")
        elif view == "actionable":
            clauses.append(effective_severity + " = 'action_required'")
        elif view != "all":
            raise ValueError("不支持的通知视图")
        if category:
            clauses.append("n.category = ?")
            values.append(category)
        if severity:
            clauses.append(effective_severity + " = ?")
            values.append(severity)
        if cursor:
            cursor_time, separator, cursor_id = cursor.rpartition("|")
            if separator and cursor_time and cursor_id:
                clauses.append("(n.last_occurred_at < ? OR (n.last_occurred_at = ? AND n.id < ?))")
                values.extend((cursor_time, cursor_time, cursor_id))
            else:
                # 兼容旧客户端只传时间戳的游标。
                clauses.append("n.last_occurred_at < ?")
                values.append(cursor)
        join = ""
        if delivery:
            join = " JOIN delivery_jobs d ON d.notification_id = n.id"
            if delivery == "failed":
                clauses.append("d.status = 'dead_letter'")
            else:
                clauses.append("d.status = ?")
                values.append(delivery)
        query = (
            "SELECT DISTINCT n.* FROM notifications n" + join
            + " WHERE " + " AND ".join(clauses)
            + " ORDER BY n.last_occurred_at DESC, n.id DESC LIMIT ?"
        )
        values.append(max(1, min(limit, 100)))
        with self._connect() as connection:
            rows = connection.execute(query, values).fetchall()
            unread = int(connection.execute(
                "SELECT COUNT(*) FROM notifications WHERE archived_at IS NULL AND read_at IS NULL"
            ).fetchone()[0])
            items = [self._notification(row, self._delivery_summary(connection, row["id"])) for row in rows]
            return {
                "items": items,
                "unreadCount": unread,
                "nextCursor": (
                    f"{items[-1]['lastOccurredAt']}|{items[-1]['id']}"
                    if len(items) == values[-1] else None
                ),
            }

    def set_read(self, notification_id: str, read: bool, now: datetime) -> dict[str, Any]:
        with self._connect() as connection:
            timestamp = _iso(now)
            result = connection.execute(
                "UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ?",
                (timestamp if read else None, timestamp, notification_id),
            )
            if result.rowcount == 0:
                raise NotificationNotFoundError(notification_id)
            self._audit(connection, notification_id, "marked_read" if read else "marked_unread", {}, timestamp)
        return self.get(notification_id)

    def mark_all_read(self, now: datetime) -> list[str]:
        with self._connect() as connection:
            timestamp = _iso(now)
            rows = connection.execute(
                "SELECT id FROM notifications WHERE archived_at IS NULL AND read_at IS NULL ORDER BY id"
            ).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                connection.executemany(
                    "UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ?",
                    [(timestamp, timestamp, value) for value in ids],
                )
                self._audit(connection, None, "marked_all_read", {"notificationIds": ids}, timestamp)
            return ids

    def bulk_set_read(self, notification_ids: Iterable[str], read: bool, now: datetime) -> list[str]:
        ids = list(dict.fromkeys(notification_ids))
        if not ids:
            return []
        with self._connect() as connection:
            timestamp = _iso(now)
            placeholders = ",".join("?" for _ in ids)
            existing = {
                row["id"] for row in connection.execute(
                    f"SELECT id FROM notifications WHERE id IN ({placeholders})", ids
                ).fetchall()
            }
            selected = [value for value in ids if value in existing]
            connection.executemany(
                "UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ?",
                [(timestamp if read else None, timestamp, value) for value in selected],
            )
            self._audit(connection, None, "bulk_read" if read else "bulk_unread", {"notificationIds": selected}, timestamp)
            return selected

    def set_archived(self, notification_id: str, archived: bool, now: datetime) -> dict[str, Any]:
        with self._connect() as connection:
            timestamp = _iso(now)
            result = connection.execute(
                "UPDATE notifications SET archived_at = ?, updated_at = ? WHERE id = ?",
                (timestamp if archived else None, timestamp, notification_id),
            )
            if result.rowcount == 0:
                raise NotificationNotFoundError(notification_id)
            self._audit(connection, notification_id, "archived" if archived else "restored", {}, timestamp)
        return self.get(notification_id)

    def preference(self, category: str, channel: str) -> bool | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT enabled FROM notification_preferences WHERE category = ? AND channel = ?",
                (category, channel),
            ).fetchone()
            return None if row is None else bool(row["enabled"])

    def set_preference(self, category: str, channel: str, enabled: bool, now: datetime) -> None:
        timestamp = _iso(now)
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO notification_preferences(category, channel, enabled, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(category, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at""",
                (category, channel, int(enabled), timestamp),
            )
            if not enabled:
                connection.execute(
                    """UPDATE delivery_jobs SET status = 'cancelled', updated_at = ?
                       WHERE channel = ? AND status IN ('pending', 'retry_wait')
                         AND notification_id IN (SELECT id FROM notifications WHERE category = ?)""",
                    (timestamp, channel, category),
                )

    def list_preferences(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return [
                {"category": row["category"], "channel": row["channel"], "enabled": bool(row["enabled"]), "updatedAt": row["updated_at"]}
                for row in connection.execute(
                    "SELECT * FROM notification_preferences ORDER BY category, channel"
                ).fetchall()
            ]

    def save_subscription(
        self,
        *,
        channel: str,
        device_id: str,
        endpoint: str,
        subscription: dict[str, Any],
        now: datetime,
    ) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO notification_subscriptions(
                       id, channel, device_id, endpoint, subscription_json, active, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                   ON CONFLICT(channel, device_id) DO UPDATE SET
                       endpoint = excluded.endpoint,
                       subscription_json = excluded.subscription_json,
                       active = 1,
                       updated_at = excluded.updated_at""",
                (
                    str(uuid.uuid4()), channel, device_id, endpoint,
                    json.dumps(subscription, ensure_ascii=False), timestamp, timestamp,
                ),
            )
            row = connection.execute(
                "SELECT * FROM notification_subscriptions WHERE channel = ? AND device_id = ?",
                (channel, device_id),
            ).fetchone()
            return self._subscription(row)

    @staticmethod
    def _subscription(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "channel": row["channel"],
            "deviceId": row["device_id"],
            "endpoint": row["endpoint"],
            "subscription": json.loads(row["subscription_json"]),
            "active": bool(row["active"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def active_subscriptions(self, channel: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM notification_subscriptions WHERE channel = ? AND active = 1 ORDER BY created_at",
                (channel,),
            ).fetchall()
            return [self._subscription(row) for row in rows]

    def active_subscription(self, channel: str, device_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT * FROM notification_subscriptions
                   WHERE channel = ? AND device_id = ? AND active = 1""",
                (channel, device_id),
            ).fetchone()
            return None if row is None else self._subscription(row)

    def deactivate_subscription(self, channel: str, device_id: str, now: datetime) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            result = connection.execute(
                """UPDATE notification_subscriptions SET active = 0, updated_at = ?
                   WHERE channel = ? AND device_id = ?""",
                (timestamp, channel, device_id),
            )
            if result.rowcount == 0:
                raise NotificationNotFoundError(f"{channel}:{device_id}")
            row = connection.execute(
                "SELECT * FROM notification_subscriptions WHERE channel = ? AND device_id = ?",
                (channel, device_id),
            ).fetchone()
            return self._subscription(row)

    def suppress_delivery_job(
        self, job_id: str, lease_token: str, *, now: datetime, reason_code: str, reason: str
    ) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM delivery_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise NotificationNotFoundError(job_id)
            if row["status"] != "leased" or row["lease_token"] != lease_token:
                raise NotificationConflictError("投递租约已失效")
            connection.execute(
                """UPDATE delivery_jobs SET status = 'suppressed', updated_at = ?,
                   lease_token = NULL, lease_expires_at = NULL, last_error_code = ?,
                   last_error_message = ?, outcome_uncertain = 0 WHERE id = ?""",
                (timestamp, reason_code[:100], _redact(reason), job_id),
            )
            connection.execute(
                """INSERT INTO delivery_attempts(
                       id, job_id, attempt_number, outcome, error_code, error_message, attempted_at
                   ) VALUES (?, ?, ?, 'suppressed', ?, ?, ?)""",
                (str(uuid.uuid4()), job_id, row["attempt_count"], reason_code[:100], _redact(reason), timestamp),
            )
        return self.get_delivery_job(job_id)

    def claim_delivery_jobs(
        self, *, channels: set[str], now: datetime, lease_seconds: int, limit: int
    ) -> list[dict[str, Any]]:
        if not channels:
            return []
        timestamp = _iso(now)
        expires = _iso(now + timedelta(seconds=lease_seconds))
        placeholders = ",".join("?" for _ in channels)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                f"""SELECT * FROM delivery_jobs
                    WHERE channel IN ({placeholders})
                      AND ((status IN ('pending', 'retry_wait') AND next_attempt_at <= ?)
                           OR (status = 'leased' AND lease_expires_at <= ?))
                    ORDER BY next_attempt_at, created_at LIMIT ?""",
                [*sorted(channels), timestamp, timestamp, max(1, min(limit, 100))],
            ).fetchall()
            claimed: list[dict[str, Any]] = []
            for row in rows:
                token = str(uuid.uuid4())
                connection.execute(
                    """UPDATE delivery_jobs SET status = 'leased', lease_token = ?, lease_expires_at = ?,
                       attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?""",
                    (token, expires, timestamp, row["id"]),
                )
                current = connection.execute("SELECT * FROM delivery_jobs WHERE id = ?", (row["id"],)).fetchone()
                claimed.append(self._job(current))
            return claimed

    def get_delivery_job(self, job_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM delivery_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise NotificationNotFoundError(job_id)
            return self._job(row)

    def complete_delivery_job(self, job_id: str, lease_token: str, now: datetime) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM delivery_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise NotificationNotFoundError(job_id)
            if row["status"] != "leased" or row["lease_token"] != lease_token:
                raise NotificationConflictError("投递租约已失效")
            connection.execute(
                """UPDATE delivery_jobs SET status = 'sent', sent_at = ?, updated_at = ?,
                   lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
                   last_error_message = NULL, outcome_uncertain = 0 WHERE id = ?""",
                (timestamp, timestamp, job_id),
            )
            connection.execute(
                """INSERT INTO delivery_attempts(id, job_id, attempt_number, outcome, attempted_at)
                   VALUES (?, ?, ?, 'sent', ?)""",
                (str(uuid.uuid4()), job_id, row["attempt_count"], timestamp),
            )
        return self.get_delivery_job(job_id)

    def fail_delivery_job(
        self,
        job_id: str,
        lease_token: str,
        *,
        now: datetime,
        error_code: str,
        error_message: str,
        retryable: bool,
        outcome_uncertain: bool,
        max_attempts: int,
    ) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM delivery_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise NotificationNotFoundError(job_id)
            if row["status"] != "leased" or row["lease_token"] != lease_token:
                raise NotificationConflictError("投递租约已失效")
            can_retry = retryable and row["attempt_count"] < max_attempts
            status = "retry_wait" if can_retry else "dead_letter"
            delay = min(3600, 30 * (2 ** max(0, row["attempt_count"] - 1)))
            next_attempt = _iso(now + timedelta(seconds=delay)) if can_retry else timestamp
            message = _redact(error_message)
            connection.execute(
                """UPDATE delivery_jobs SET status = ?, next_attempt_at = ?, updated_at = ?,
                   lease_token = NULL, lease_expires_at = NULL, last_error_code = ?,
                   last_error_message = ?, outcome_uncertain = ? WHERE id = ?""",
                (status, next_attempt, timestamp, error_code[:100], message, int(outcome_uncertain), job_id),
            )
            connection.execute(
                """INSERT INTO delivery_attempts(
                       id, job_id, attempt_number, outcome, error_code, error_message,
                       outcome_uncertain, attempted_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    str(uuid.uuid4()), job_id, row["attempt_count"], status,
                    error_code[:100], message, int(outcome_uncertain), timestamp,
                ),
            )
        return self.get_delivery_job(job_id)

    def retry_delivery(self, notification_id: str, channel: str, now: datetime) -> dict[str, Any]:
        timestamp = _iso(now)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM delivery_jobs WHERE notification_id = ? AND channel = ?",
                (notification_id, channel),
            ).fetchall()
            if not rows:
                raise NotificationNotFoundError(f"{notification_id}:{channel}")
            failed = [row for row in rows if row["status"] == "dead_letter"]
            if not failed:
                raise NotificationConflictError("只有最终失败的渠道可以人工重试")
            connection.executemany(
                """UPDATE delivery_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ?,
                   lease_token = NULL, lease_expires_at = NULL WHERE id = ?""",
                [(timestamp, timestamp, row["id"]) for row in failed],
            )
            self._audit(
                connection, notification_id, "manual_retry",
                {"channel": channel, "jobCount": len(failed)}, timestamp,
            )
            return {
                "notificationId": notification_id,
                "channel": channel,
                "retried": len(failed),
                "deliverySummary": self._delivery_summary(connection, notification_id),
            }
