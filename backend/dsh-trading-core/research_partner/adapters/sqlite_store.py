# -*- coding: utf-8 -*-
"""SQLite 业务库适配器（标准库 sqlite3，零额外依赖）。

连接口径：
- WAL + FOREIGN KEYS + busy_timeout，短事务。
- 写事务使用 BEGIN IMMEDIATE，避免并发写升级锁冲突。
- 适配器内部对象（sqlite3.Row、连接、游标）不会返回给上层。
- 业务写入与 outbox 消息在同一事务内提交；失败整体回滚。
"""

from __future__ import annotations

import base64
import json
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Iterator, Sequence

from ..errors import (
    Conflict,
    InvalidRequest,
    LeaseExpired,
    NotFound,
    StorageUnavailable,
)
from ..models import (
    ConditionState,
    ContactDecision,
    ContactRecord,
    EventEnvelope,
    IdempotentResponse,
    InboxRecord,
    Mandate,
    MandateRequirement,
    MandateRevision,
    MandateSchedule,
    MandateSubject,
    NotificationPreferences,
    OutboxMessage,
    ResearchJob,
    ResearchJobResult,
    SnoozeEntry,
    TrackingDependency,
)

_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

_MANDATE_STATUSES = {"pending_requirements", "tracking", "paused", "ended"}
_ALLOWED_TRANSITIONS = {
    "pending_requirements": {"tracking", "paused", "ended"},
    "tracking": {"pending_requirements", "paused", "ended"},
    "paused": {"pending_requirements", "tracking", "ended"},
    "ended": set(),
}
_INBOX_STATUSES = {"pending", "processing", "processed", "failed", "ignored"}
_OUTBOX_STATUSES = {"pending", "sending", "published", "failed"}
_JOB_STATUSES = {
    "pending",
    "running",
    "waiting_data",
    "completed",
    "failed",
    "cancelled",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise InvalidRequest("时间必须包含时区")
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _as_utc(value).isoformat()


def _parse(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(value)


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _loads(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:  # pragma: no cover - 损坏库
        raise InvalidRequest("业务库 JSON 字段损坏") from exc


def _encode_cursor(updated_at: str, mandate_id: str) -> str:
    raw = json.dumps({"u": updated_at, "m": mandate_id}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded))
        return str(data["u"]), str(data["m"])
    except (ValueError, KeyError, TypeError) as exc:
        raise InvalidRequest("分页游标无效") from exc


def _translate_errors(func):
    """把 sqlite 异常转换成领域异常；领域异常原样透出。"""

    @wraps(func)
    def wrapper(self, *args, **kwargs):
        try:
            return func(self, *args, **kwargs)
        except sqlite3.IntegrityError as exc:
            message = str(exc).lower()
            if "unique" in message or "primary key" in message:
                raise Conflict("业务对象已存在或幂等键冲突") from exc
            if "foreign key" in message:
                raise InvalidRequest("引用对象不存在") from exc
            raise InvalidRequest("业务库约束不满足") from exc
        except sqlite3.OperationalError as exc:
            raise StorageUnavailable(f"业务库操作失败: {exc}") from exc

    return wrapper


class SqliteBusinessStore:
    """委托核心的 SQLite 存储适配器。"""

    def __init__(self, path: str | Path, *, now=None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._depth = threading.local()
        self._connections: list[sqlite3.Connection] = []
        self._connections_lock = threading.Lock()
        self._now = now or _utcnow
        self._migrate()

    # ── 连接、迁移、事务 ────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            return connection
        try:
            # 每线程独立连接；check_same_thread=False 只用于停机时跨线程 close()。
            # 连接本身仍由线程本地持有，不会被多个线程并发使用。
            connection = sqlite3.connect(
                self.path, timeout=10, isolation_level=None, check_same_thread=False
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=5000")
        except sqlite3.Error as exc:  # pragma: no cover - 环境相关
            raise StorageUnavailable(f"无法打开业务库: {self.path}") from exc
        self._local.connection = connection
        with self._connections_lock:
            self._connections.append(connection)
        return connection

    def close(self) -> None:
        """关闭本进程内所有线程的连接；用于服务停机与测试清理。"""
        with self._connections_lock:
            connections, self._connections = self._connections, []
        for connection in connections:
            try:
                connection.close()
            except sqlite3.Error:  # pragma: no cover - 已关闭
                pass
        self._local.connection = None

    @property
    def _tx_depth(self) -> int:
        return getattr(self._depth, "value", 0)

    @_tx_depth.setter
    def _tx_depth(self, value: int) -> None:
        self._depth.value = value

    def _migrate(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            applied = {
                row["version"]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations"
                ).fetchall()
            }
            for path in sorted(_MIGRATIONS_DIR.glob("*.sql")):
                version = path.stem
                if version in applied:
                    continue
                connection.executescript(path.read_text(encoding="utf-8"))
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) "
                    "VALUES (?, ?)",
                    (version, _utcnow().isoformat()),
                )
            connection.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1.0')"
            )
        except sqlite3.Error as exc:
            raise StorageUnavailable("业务库迁移失败") from exc

    @contextmanager
    def transaction(self) -> Iterator[None]:
        connection = self._connect()
        if self._tx_depth > 0:
            self._tx_depth = self._tx_depth + 1
            try:
                yield
            finally:
                self._tx_depth = self._tx_depth - 1
            return
        try:
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.Error as exc:
            raise StorageUnavailable("无法开启业务库写事务") from exc
        self._tx_depth = 1
        try:
            yield
        except Exception:
            connection.execute("ROLLBACK")
            raise
        else:
            connection.execute("COMMIT")
        finally:
            self._tx_depth = 0

    def _now_utc(self, value: datetime | None = None) -> datetime:
        return _as_utc(value) if value is not None else _as_utc(self._now())

    def schema_version(self) -> str:
        row = self._connect().execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
        return str(row["value"]) if row else "0"

    # ── 行转换 ──────────────────────────────────────────────────────

    @staticmethod
    def _mandate_from_row(row: sqlite3.Row) -> Mandate:
        return Mandate(
            mandate_id=row["mandate_id"],
            principal_id=row["principal_id"],
            instance_id=row["instance_id"],
            status=row["status"],
            current_revision=row["current_revision"],
            source_session_id=row["source_session_id"],
            source_message_ref=row["source_message_ref"],
            created_at=_parse(row["created_at"]),
            updated_at=_parse(row["updated_at"]),
            ended_at=_parse(row["ended_at"]),
        )

    @staticmethod
    def _revision_from_row(row: sqlite3.Row) -> MandateRevision:
        return MandateRevision(
            mandate_id=row["mandate_id"],
            revision=row["revision"],
            goal=row["goal"],
            scope=_loads(row["scope_json"], {}),
            triggers=_loads(row["triggers_json"], []),
            contact_policy=_loads(row["contact_policy_json"], {}),
            basis=_loads(row["basis_json"], {}),
            change_summary=row["change_summary"],
            created_by=row["created_by"],
            created_at=_parse(row["created_at"]),
        )

    @staticmethod
    def _subject_from_row(row: sqlite3.Row) -> MandateSubject:
        return MandateSubject(
            mandate_id=row["mandate_id"],
            revision=row["revision"],
            entity_id=row["entity_id"],
            role=row["role"],
            scope_mode=row["scope_mode"],
            collection_version=row["collection_version"],
        )

    @staticmethod
    def _requirement_from_row(row: sqlite3.Row) -> MandateRequirement:
        return MandateRequirement(
            requirement_id=row["requirement_id"],
            mandate_id=row["mandate_id"],
            revision=row["revision"],
            code=row["code"],
            detail=row["detail"],
            status=row["status"],
            created_at=_parse(row["created_at"]),
            resolved_at=_parse(row["resolved_at"]),
        )

    @staticmethod
    def _dependency_from_row(row: sqlite3.Row) -> TrackingDependency:
        return TrackingDependency(
            dependency_id=row["dependency_id"],
            mandate_id=row["mandate_id"],
            revision=row["revision"],
            hook_type=row["hook_type"],
            subject_id=row["subject_id"],
            event_type=row["event_type"],
            feature_key=row["feature_key"],
            scope_key=row["scope_key"],
            active=bool(row["active"]),
            rule_version=row["rule_version"],
            created_at=_parse(row["created_at"]),
        )

    @staticmethod
    def _job_from_row(row: sqlite3.Row) -> ResearchJob:
        return ResearchJob(
            job_id=row["job_id"],
            mandate_id=row["mandate_id"],
            mandate_revision=row["mandate_revision"],
            trigger_event_id=row["trigger_event_id"],
            action=row["action"],
            status=row["status"],
            lease_token=row["lease_token"],
            lease_expires_at=_parse(row["lease_expires_at"]),
            attempt_count=row["attempt_count"],
            budget=_loads(row["budget_json"], {}),
            checkpoint=_loads(row["checkpoint_json"], {}),
            cancel_generation=row["cancel_generation"],
            next_run_at=_parse(row["next_run_at"]),
            dedupe_key=row["dedupe_key"],
            last_error=row["last_error"],
            created_at=_parse(row["created_at"]),
            updated_at=_parse(row["updated_at"]),
        )

    @staticmethod
    def _result_from_row(row: sqlite3.Row) -> ResearchJobResult:
        return ResearchJobResult(
            result_id=row["result_id"],
            job_id=row["job_id"],
            run_id=row["run_id"],
            outcome=row["outcome"],
            structured_result=_loads(row["structured_result_json"], {}),
            evidence_batch_id=row["evidence_batch_id"],
            gaps=_loads(row["gaps_json"], []),
            change_summary=row["change_summary"],
            contact_suggestion=_loads(row["contact_suggestion_json"], {}),
            stale=bool(row["stale"]),
            received_at=_parse(row["received_at"]),
        )

    @staticmethod
    def _decision_from_row(row: sqlite3.Row) -> ContactDecision:
        return ContactDecision(
            decision_id=row["decision_id"],
            mandate_id=row["mandate_id"],
            mandate_revision=row["mandate_revision"],
            job_id=row["job_id"],
            decision=row["decision"],
            reason_code=row["reason_code"],
            condition_result=row["condition_result"],
            detail=row["detail"],
            evidence_ref=row["evidence_ref"],
            dedupe_key=row["dedupe_key"],
            condition_key=row["condition_key"] or "",
            eligible_at=_parse(row["eligible_at"]),
            expires_at=_parse(row["expires_at"]),
            created_at=_parse(row["created_at"]),
        )

    @staticmethod
    def _schedule_from_row(row: sqlite3.Row) -> MandateSchedule:
        return MandateSchedule(
            schedule_id=row["schedule_id"],
            mandate_id=row["mandate_id"],
            revision=row["revision"],
            mode=row["mode"],
            cron=row["cron"],
            timezone=row["timezone"],
            catchup_seconds=row["catchup_seconds"],
            trading_days_only=bool(row["trading_days_only"]),
            enabled=bool(row["enabled"]),
            next_due_at=_parse(row["next_due_at"]),
            last_instance_key=row["last_instance_key"],
            skipped_missed=row["skipped_missed"],
            created_at=_parse(row["created_at"]),
            updated_at=_parse(row["updated_at"]),
        )

    @staticmethod
    def _preferences_from_row(row: sqlite3.Row) -> NotificationPreferences:
        return NotificationPreferences(
            principal_id=row["principal_id"],
            instance_id=row["instance_id"],
            timezone=row["timezone"],
            quiet_hours=_loads(row["quiet_hours_json"], None),
            channels=_loads(row["channels_json"], ["app"]),
            updated_at=_parse(row["updated_at"]),
        )

    @staticmethod
    def _snooze_from_row(row: sqlite3.Row) -> SnoozeEntry:
        return SnoozeEntry(
            snooze_id=row["snooze_id"],
            principal_id=row["principal_id"],
            instance_id=row["instance_id"],
            scope_type=row["scope_type"],
            scope_id=row["scope_id"],
            until=_parse(row["until"]),
            reason=row["reason"],
            created_at=_parse(row["created_at"]),
        )

    @staticmethod
    def _inbox_from_row(row: sqlite3.Row) -> InboxRecord:
        return InboxRecord(
            event_id=row["event_id"],
            status=row["status"],
            attempts=row["attempts"],
            received_at=_parse(row["received_at"]),
            processed_at=_parse(row["processed_at"]),
            last_error=row["last_error"],
        )

    @staticmethod
    def _outbox_from_row(row: sqlite3.Row) -> OutboxMessage:
        return OutboxMessage(
            outbox_id=row["outbox_id"],
            aggregate_type=row["aggregate_type"],
            aggregate_id=row["aggregate_id"],
            event_type=row["event_type"],
            payload=_loads(row["payload_json"], {}),
            status=row["status"],
            attempts=row["attempts"],
            available_at=_parse(row["available_at"]),
            created_at=_parse(row["created_at"]),
            published_at=_parse(row["published_at"]),
            last_error=row["last_error"],
        )

    # ── 委托 ────────────────────────────────────────────────────────

    @_translate_errors
    def create_mandate(
        self,
        mandate: Mandate,
        revision: MandateRevision,
        *,
        subjects: Sequence[MandateSubject] = (),
        requirements: Sequence[MandateRequirement] = (),
        dependencies: Sequence[TrackingDependency] = (),
        outbox: Sequence[OutboxMessage] = (),
    ) -> None:
        if revision.revision != 1 or mandate.current_revision != 1:
            raise InvalidRequest("新建委托的版本必须为 1")
        if revision.mandate_id != mandate.mandate_id:
            raise InvalidRequest("委托与版本标识不一致")
        for item in (*subjects, *requirements, *dependencies):
            if item.mandate_id != mandate.mandate_id:
                raise InvalidRequest("附属对象与委托标识不一致")
        with self.transaction():
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO mandates(
                    mandate_id, principal_id, instance_id, status, current_revision,
                    source_session_id, source_message_ref, created_at, updated_at, ended_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mandate.mandate_id,
                    mandate.principal_id,
                    mandate.instance_id,
                    mandate.status,
                    mandate.current_revision,
                    mandate.source_session_id,
                    mandate.source_message_ref,
                    _iso(mandate.created_at),
                    _iso(mandate.updated_at),
                    _iso(mandate.ended_at) if mandate.ended_at else None,
                ),
            )
            self._insert_revision(connection, revision)
            self._insert_subjects(connection, subjects)
            self._insert_requirements(connection, requirements)
            self._insert_dependencies(connection, dependencies)
            self._insert_outbox(connection, outbox)
            connection.execute(
                "INSERT INTO mandate_progress("
                "mandate_id, mandate_revision, baseline_json, updated_at"
                ") VALUES (?, ?, '{}', ?)",
                (mandate.mandate_id, mandate.current_revision, _iso(mandate.updated_at)),
            )

    @_translate_errors
    def import_mandate(
        self,
        mandate: Mandate,
        revisions: Sequence[MandateRevision],
        *,
        subjects: Sequence[MandateSubject] = (),
        requirements: Sequence[MandateRequirement] = (),
        dependencies: Sequence[TrackingDependency] = (),
        schedules: Sequence[MandateSchedule] = (),
    ) -> None:
        """导入历史委托：原标识、修订链与时间保留；导入后只能处于暂停或归档。

        不写 outbox、不建任务、不恢复租约或在途投递；启用须由用户显式恢复。
        """

        if mandate.status not in ("paused", "ended"):
            raise InvalidRequest("导入的委托只能保持暂停或已归档状态")
        numbers = sorted(item.revision for item in revisions)
        if numbers != list(range(1, mandate.current_revision + 1)):
            raise InvalidRequest("导入的委托版本链必须从 1 连续到当前版本")
        for item in (*revisions, *subjects, *requirements, *dependencies, *schedules):
            if item.mandate_id != mandate.mandate_id:
                raise InvalidRequest("导入对象与委托标识不一致")
        with self.transaction():
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO mandates(
                    mandate_id, principal_id, instance_id, status, current_revision,
                    source_session_id, source_message_ref, created_at, updated_at, ended_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mandate.mandate_id,
                    mandate.principal_id,
                    mandate.instance_id,
                    mandate.status,
                    mandate.current_revision,
                    mandate.source_session_id,
                    mandate.source_message_ref,
                    _iso(mandate.created_at),
                    _iso(mandate.updated_at),
                    _iso(mandate.ended_at) if mandate.ended_at else None,
                ),
            )
            for item in sorted(revisions, key=lambda value: value.revision):
                self._insert_revision(connection, item)
            self._insert_subjects(connection, subjects)
            self._insert_requirements(connection, requirements)
            self._insert_dependencies(connection, dependencies)
            for item in schedules:
                connection.execute(
                    """
                    INSERT INTO mandate_schedules(
                        schedule_id, mandate_id, revision, mode, cron, timezone,
                        catchup_seconds, trading_days_only, enabled, next_due_at,
                        last_instance_key, skipped_missed, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.schedule_id,
                        item.mandate_id,
                        item.revision,
                        item.mode,
                        item.cron,
                        item.timezone,
                        item.catchup_seconds,
                        1 if item.trading_days_only else 0,
                        1 if item.enabled else 0,
                        _iso(item.next_due_at),
                        item.last_instance_key,
                        item.skipped_missed,
                        _iso(item.created_at),
                        _iso(item.updated_at),
                    ),
                )
            connection.execute(
                "INSERT INTO mandate_progress("
                "mandate_id, mandate_revision, baseline_json, updated_at"
                ") VALUES (?, ?, '{}', ?)",
                (mandate.mandate_id, mandate.current_revision, _iso(mandate.updated_at)),
            )

    @_translate_errors
    def delete_mandate(self, mandate_id: str) -> bool:
        with self.transaction():
            cursor = self._connect().execute(
                "DELETE FROM mandates WHERE mandate_id = ?", (mandate_id,)
            )
        return cursor.rowcount > 0

    @_translate_errors
    def get_mandate(self, mandate_id: str, *, principal_id: str) -> Mandate | None:
        row = self._connect().execute(
            "SELECT * FROM mandates WHERE mandate_id = ? AND principal_id = ?",
            (mandate_id, principal_id),
        ).fetchone()
        return self._mandate_from_row(row) if row else None

    @_translate_errors
    def get_mandate_internal(self, mandate_id: str) -> Mandate | None:
        row = self._connect().execute(
            "SELECT * FROM mandates WHERE mandate_id = ?", (mandate_id,)
        ).fetchone()
        return self._mandate_from_row(row) if row else None

    @_translate_errors
    def list_mandates(
        self,
        principal_id: str,
        *,
        instance_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> tuple[list[Mandate], str | None]:
        if status is not None and status not in _MANDATE_STATUSES:
            raise InvalidRequest("不支持的委托状态")
        if not 1 <= limit <= 200:
            raise InvalidRequest("分页大小必须在 1 到 200 之间")
        sql = "SELECT * FROM mandates WHERE principal_id = ?"
        params: list[Any] = [principal_id]
        if instance_id is not None:
            sql += " AND instance_id = ?"
            params.append(instance_id)
        if status is not None:
            sql += " AND status = ?"
            params.append(status)
        if cursor is not None:
            updated_at, mandate_id = _decode_cursor(cursor)
            sql += " AND (updated_at < ? OR (updated_at = ? AND mandate_id < ?))"
            params.extend([updated_at, updated_at, mandate_id])
        sql += " ORDER BY updated_at DESC, mandate_id DESC LIMIT ?"
        params.append(limit + 1)
        rows = self._connect().execute(sql, params).fetchall()
        items = [self._mandate_from_row(row) for row in rows[:limit]]
        next_cursor = (
            _encode_cursor(rows[limit - 1]["updated_at"], rows[limit - 1]["mandate_id"])
            if len(rows) > limit
            else None
        )
        return items, next_cursor

    @_translate_errors
    def get_revision(self, mandate_id: str, revision: int) -> MandateRevision | None:
        row = self._connect().execute(
            "SELECT * FROM mandate_revisions WHERE mandate_id = ? AND revision = ?",
            (mandate_id, revision),
        ).fetchone()
        return self._revision_from_row(row) if row else None

    @_translate_errors
    def list_subjects(self, mandate_id: str, revision: int) -> list[MandateSubject]:
        rows = self._connect().execute(
            "SELECT * FROM mandate_subjects WHERE mandate_id = ? AND revision = ? "
            "ORDER BY role, entity_id",
            (mandate_id, revision),
        ).fetchall()
        return [self._subject_from_row(row) for row in rows]

    @_translate_errors
    def list_requirements(
        self,
        mandate_id: str,
        *,
        revision: int | None = None,
        status: str | None = None,
    ) -> list[MandateRequirement]:
        sql = "SELECT * FROM mandate_requirements WHERE mandate_id = ?"
        params: list[Any] = [mandate_id]
        if revision is not None:
            sql += " AND revision = ?"
            params.append(revision)
        if status is not None:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at, requirement_id"
        rows = self._connect().execute(sql, params).fetchall()
        return [self._requirement_from_row(row) for row in rows]

    @_translate_errors
    def get_requirement(self, requirement_id: str) -> MandateRequirement | None:
        row = self._connect().execute(
            "SELECT * FROM mandate_requirements WHERE requirement_id = ?",
            (requirement_id,),
        ).fetchone()
        return self._requirement_from_row(row) if row else None

    @_translate_errors
    def update_requirement(
        self,
        requirement_id: str,
        *,
        status: str,
        resolved_at: datetime | None,
    ) -> MandateRequirement:
        if status not in {"open", "resolved", "waived"}:
            raise InvalidRequest("不支持的待补充项状态")
        with self.transaction():
            connection = self._connect()
            cursor = connection.execute(
                "UPDATE mandate_requirements SET status = ?, resolved_at = ? "
                "WHERE requirement_id = ?",
                (status, _iso(resolved_at) if resolved_at else None, requirement_id),
            )
            if cursor.rowcount == 0:
                raise NotFound("待补充项不存在")
            row = connection.execute(
                "SELECT * FROM mandate_requirements WHERE requirement_id = ?",
                (requirement_id,),
            ).fetchone()
            return self._requirement_from_row(row)

    @_translate_errors
    def add_revision(
        self,
        revision: MandateRevision,
        *,
        expected_revision: int,
        subjects: Sequence[MandateSubject] = (),
        requirements: Sequence[MandateRequirement] = (),
        dependencies: Sequence[TrackingDependency] = (),
        outbox: Sequence[OutboxMessage] = (),
        status: str | None = None,
    ) -> Mandate:
        if revision.revision != expected_revision + 1:
            raise InvalidRequest("新版本号必须是当前版本加一")
        if status is not None and status not in _MANDATE_STATUSES:
            raise InvalidRequest("不支持的委托状态")
        for item in (*subjects, *requirements, *dependencies):
            if item.mandate_id != revision.mandate_id:
                raise InvalidRequest("附属对象与委托标识不一致")
        with self.transaction():
            connection = self._connect()
            row = connection.execute(
                "SELECT * FROM mandates WHERE mandate_id = ?", (revision.mandate_id,)
            ).fetchone()
            if row is None:
                raise NotFound("委托不存在")
            if row["status"] == "ended":
                raise Conflict("已结束的委托不能调整")
            if row["current_revision"] != expected_revision:
                raise Conflict("委托已被其他请求修改，请重新读取")
            self._insert_revision(connection, revision)
            self._insert_subjects(connection, subjects)
            self._insert_requirements(connection, requirements)
            connection.execute(
                "UPDATE tracking_dependencies SET active = 0 "
                "WHERE mandate_id = ? AND active = 1",
                (revision.mandate_id,),
            )
            self._insert_dependencies(connection, dependencies)
            self._insert_outbox(connection, outbox)
            next_status = status or row["status"]
            if next_status not in _ALLOWED_TRANSITIONS.get(row["status"], set()) and next_status != row["status"]:
                raise Conflict(f"不允许从 {row['status']} 切换到 {next_status}")
            connection.execute(
                "UPDATE mandates SET current_revision = ?, status = ?, updated_at = ? "
                "WHERE mandate_id = ?",
                (
                    revision.revision,
                    next_status,
                    _iso(revision.created_at),
                    revision.mandate_id,
                ),
            )
            connection.execute(
                "UPDATE mandate_progress SET mandate_revision = ?, updated_at = ? "
                "WHERE mandate_id = ?",
                (revision.revision, _iso(revision.created_at), revision.mandate_id),
            )
            updated = connection.execute(
                "SELECT * FROM mandates WHERE mandate_id = ?", (revision.mandate_id,)
            ).fetchone()
            return self._mandate_from_row(updated)

    @_translate_errors
    def set_status(
        self,
        mandate_id: str,
        *,
        principal_id: str,
        expected_revision: int,
        status: str,
        outbox: Sequence[OutboxMessage] = (),
        now: datetime | None = None,
    ) -> Mandate:
        if status not in _MANDATE_STATUSES:
            raise InvalidRequest("不支持的委托状态")
        at = self._now_utc(now)
        with self.transaction():
            connection = self._connect()
            row = connection.execute(
                "SELECT * FROM mandates WHERE mandate_id = ? AND principal_id = ?",
                (mandate_id, principal_id),
            ).fetchone()
            if row is None:
                raise NotFound("委托不存在")
            if row["current_revision"] != expected_revision:
                raise Conflict("委托已被其他请求修改，请重新读取")
            current = row["status"]
            if status == current:
                self._insert_outbox(connection, outbox)
                return self._mandate_from_row(row)
            if status not in _ALLOWED_TRANSITIONS[current]:
                raise Conflict(f"不允许从 {current} 切换到 {status}")
            ended_at = _iso(at) if status == "ended" else row["ended_at"]
            connection.execute(
                "UPDATE mandates SET status = ?, updated_at = ?, ended_at = ? "
                "WHERE mandate_id = ?",
                (status, _iso(at), ended_at, mandate_id),
            )
            if status in {"paused", "ended"}:
                # 保留 running 任务的租约，让执行方能把迟到结果留档；
                # 是否允许联系由联系评估按委托状态重新判定。
                connection.execute(
                    "UPDATE research_jobs SET status = 'cancelled', "
                    "cancel_generation = cancel_generation + 1, updated_at = ? "
                    "WHERE mandate_id = ? AND status IN "
                    "('pending', 'running', 'waiting_data')",
                    (_iso(at), mandate_id),
                )
            if status == "ended":
                connection.execute(
                    "UPDATE tracking_dependencies SET active = 0 WHERE mandate_id = ?",
                    (mandate_id,),
                )
            self._insert_outbox(connection, outbox)
            updated = connection.execute(
                "SELECT * FROM mandates WHERE mandate_id = ?", (mandate_id,)
            ).fetchone()
            return self._mandate_from_row(updated)

    # ── 依赖 ────────────────────────────────────────────────────────

    @_translate_errors
    def replace_active_dependencies(
        self,
        mandate_id: str,
        revision: int,
        dependencies: Sequence[TrackingDependency],
    ) -> None:
        for item in dependencies:
            if item.mandate_id != mandate_id:
                raise InvalidRequest("依赖与委托标识不一致")
        with self.transaction():
            connection = self._connect()
            connection.execute(
                "UPDATE tracking_dependencies SET active = 0 "
                "WHERE mandate_id = ? AND active = 1",
                (mandate_id,),
            )
            self._insert_dependencies(connection, dependencies)

    @_translate_errors
    def find_active_dependencies(
        self,
        *,
        hook_type: str,
        subject_ids: Sequence[str] | None = None,
        event_type: str | None = None,
    ) -> list[TrackingDependency]:
        if subject_ids is not None and len(subject_ids) > 200:
            raise InvalidRequest("单次事件的主体数量不能超过 200")
        sql = (
            "SELECT d.* FROM tracking_dependencies d "
            "JOIN mandates m ON m.mandate_id = d.mandate_id "
            "WHERE d.active = 1 AND m.status = 'tracking' AND d.hook_type = ?"
        )
        params: list[Any] = [hook_type]
        if subject_ids is not None:
            if not subject_ids:
                # 无主体事件只能命中“全局依赖”，不能拼出非法的 IN ()。
                sql += " AND d.subject_id IS NULL"
            else:
                placeholders = ", ".join("?" for _ in subject_ids)
                sql += f" AND (d.subject_id IS NULL OR d.subject_id IN ({placeholders}))"
                params.extend(subject_ids)
        if event_type is None:
            # 事件没有细分类型时，只匹配“不限定类型”的依赖。
            sql += " AND d.event_type IS NULL"
        else:
            sql += " AND (d.event_type IS NULL OR d.event_type = ?)"
            params.append(event_type)
        sql += " ORDER BY d.mandate_id, d.revision DESC, d.dependency_id"
        rows = self._connect().execute(sql, params).fetchall()
        return [self._dependency_from_row(row) for row in rows]

    @_translate_errors
    def list_dependencies(
        self,
        mandate_id: str,
        *,
        revision: int | None = None,
        active_only: bool = True,
    ) -> list[TrackingDependency]:
        sql = "SELECT * FROM tracking_dependencies WHERE mandate_id = ?"
        params: list[Any] = [mandate_id]
        if revision is not None:
            sql += " AND revision = ?"
            params.append(revision)
        if active_only:
            sql += " AND active = 1"
        sql += " ORDER BY revision DESC, dependency_id"
        rows = self._connect().execute(sql, params).fetchall()
        return [self._dependency_from_row(row) for row in rows]

    def _insert_dependencies(
        self, connection: sqlite3.Connection, dependencies: Sequence[TrackingDependency]
    ) -> None:
        for item in dependencies:
            connection.execute(
                """
                INSERT INTO tracking_dependencies(
                    mandate_id, revision, dependency_id, hook_type, subject_id,
                    event_type, feature_key, scope_key, active, rule_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.mandate_id,
                    item.revision,
                    item.dependency_id,
                    item.hook_type,
                    item.subject_id,
                    item.event_type,
                    item.feature_key,
                    item.scope_key,
                    1 if item.active else 0,
                    item.rule_version,
                    _iso(item.created_at),
                ),
            )

    # ── 日程 ────────────────────────────────────────────────────────

    @_translate_errors
    def replace_schedules(
        self,
        mandate_id: str,
        revision: int,
        schedules: Sequence[MandateSchedule],
        *,
        now: datetime,
    ) -> None:
        with self.transaction():
            connection = self._connect()
            connection.execute(
                "UPDATE mandate_schedules SET enabled = 0, updated_at = ? "
                "WHERE mandate_id = ? AND enabled = 1",
                (_iso(now), mandate_id),
            )
            for item in schedules:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO mandate_schedules(
                        schedule_id, mandate_id, revision, mode, cron, timezone,
                        catchup_seconds, trading_days_only, enabled, next_due_at,
                        last_instance_key, skipped_missed, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.schedule_id,
                        item.mandate_id,
                        item.revision,
                        item.mode,
                        item.cron,
                        item.timezone,
                        item.catchup_seconds,
                        1 if item.trading_days_only else 0,
                        1 if item.enabled else 0,
                        _iso(item.next_due_at),
                        item.last_instance_key,
                        item.skipped_missed,
                        _iso(item.created_at),
                        _iso(item.updated_at),
                    ),
                )
                # 幂等重放同一版本时不重置已有的下次到期时间。
                connection.execute(
                    "UPDATE mandate_schedules SET enabled = 1, updated_at = ? "
                    "WHERE schedule_id = ?",
                    (_iso(now), item.schedule_id),
                )

    @_translate_errors
    def list_schedules(
        self,
        mandate_id: str,
        *,
        revision: int | None = None,
        active_only: bool = True,
    ) -> list[MandateSchedule]:
        sql = "SELECT * FROM mandate_schedules WHERE mandate_id = ?"
        params: list[Any] = [mandate_id]
        if revision is not None:
            sql += " AND revision = ?"
            params.append(revision)
        if active_only:
            sql += " AND enabled = 1"
        sql += " ORDER BY revision DESC, next_due_at, schedule_id"
        rows = self._connect().execute(sql, params).fetchall()
        return [self._schedule_from_row(row) for row in rows]

    @_translate_errors
    def get_schedule(self, schedule_id: str) -> MandateSchedule | None:
        row = self._connect().execute(
            "SELECT * FROM mandate_schedules WHERE schedule_id = ?", (schedule_id,)
        ).fetchone()
        return None if row is None else self._schedule_from_row(row)

    @_translate_errors
    def list_due_schedules(
        self, *, now: datetime, limit: int = 50
    ) -> list[MandateSchedule]:
        rows = self._connect().execute(
            "SELECT s.* FROM mandate_schedules AS s "
            "JOIN mandates AS m ON m.mandate_id = s.mandate_id "
            "WHERE s.enabled = 1 AND m.status = 'tracking' AND s.next_due_at <= ? "
            "ORDER BY s.next_due_at, s.schedule_id LIMIT ?",
            (_iso(now), limit),
        ).fetchall()
        return [self._schedule_from_row(row) for row in rows]

    @_translate_errors
    def advance_schedule(
        self,
        schedule_id: str,
        *,
        next_due_at: datetime,
        last_instance_key: str | None = None,
        skipped_missed: int = 0,
        enabled: bool = True,
        now: datetime,
    ) -> MandateSchedule:
        with self.transaction():
            connection = self._connect()
            updated = connection.execute(
                "UPDATE mandate_schedules SET next_due_at = ?, last_instance_key = ?, "
                "skipped_missed = skipped_missed + ?, enabled = ?, updated_at = ? "
                "WHERE schedule_id = ?",
                (
                    _iso(next_due_at),
                    last_instance_key,
                    skipped_missed,
                    1 if enabled else 0,
                    _iso(now),
                    schedule_id,
                ),
            )
            if updated.rowcount == 0:
                raise NotFound("日程不存在")
            row = connection.execute(
                "SELECT * FROM mandate_schedules WHERE schedule_id = ?",
                (schedule_id,),
            ).fetchone()
            return self._schedule_from_row(row)

    # ── 事件 ────────────────────────────────────────────────────────

    @_translate_errors
    def record_event(self, envelope: EventEnvelope) -> bool:
        with self.transaction():
            connection = self._connect()
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO domain_events(
                    event_id, hook_type, schema_version, producer, occurred_at,
                    observed_at, source_version, content_hash, correlation_id,
                    causation_id, origin_run_id, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    envelope.event_id,
                    envelope.hook_type,
                    envelope.schema_version,
                    envelope.producer,
                    _iso(envelope.occurred_at),
                    _iso(envelope.observed_at),
                    envelope.source_version,
                    envelope.content_hash,
                    envelope.correlation_id,
                    envelope.causation_id,
                    envelope.origin_run_id,
                    _dumps(envelope.payload),
                ),
            )
            if cursor.rowcount == 0:
                existing = connection.execute(
                    "SELECT content_hash FROM domain_events WHERE event_id = ?",
                    (envelope.event_id,),
                ).fetchone()
                if (
                    existing is not None
                    and envelope.content_hash
                    and existing["content_hash"]
                    and existing["content_hash"] != envelope.content_hash
                ):
                    raise Conflict("同一事件标识出现了不同内容")
                return False
            for subject_id in envelope.subject_ids:
                connection.execute(
                    "INSERT OR IGNORE INTO event_subjects(event_id, subject_id) VALUES (?, ?)",
                    (envelope.event_id, subject_id),
                )
            connection.execute(
                "INSERT INTO event_inbox(event_id, status, attempts, received_at) "
                "VALUES (?, 'pending', 0, ?)",
                (envelope.event_id, _iso(envelope.observed_at)),
            )
            return True

    @_translate_errors
    def get_event(self, event_id: str) -> EventEnvelope | None:
        connection = self._connect()
        row = connection.execute(
            "SELECT * FROM domain_events WHERE event_id = ?", (event_id,)
        ).fetchone()
        if row is None:
            return None
        subjects = [
            item["subject_id"]
            for item in connection.execute(
                "SELECT subject_id FROM event_subjects WHERE event_id = ? "
                "ORDER BY subject_id",
                (event_id,),
            ).fetchall()
        ]
        return EventEnvelope(
            event_id=row["event_id"],
            hook_type=row["hook_type"],
            schema_version=row["schema_version"],
            producer=row["producer"],
            occurred_at=_parse(row["occurred_at"]),
            observed_at=_parse(row["observed_at"]),
            subject_ids=subjects,
            source_version=row["source_version"],
            content_hash=row["content_hash"],
            correlation_id=row["correlation_id"],
            causation_id=row["causation_id"],
            origin_run_id=row["origin_run_id"],
            payload=_loads(row["payload_json"], {}),
        )

    @_translate_errors
    def list_inbox(
        self, *, status: str | None = None, limit: int = 100
    ) -> list[InboxRecord]:
        if status is not None and status not in _INBOX_STATUSES:
            raise InvalidRequest("不支持的收件状态")
        sql = "SELECT * FROM event_inbox"
        params: list[Any] = []
        if status is not None:
            sql += " WHERE status = ?"
            params.append(status)
        sql += " ORDER BY received_at, event_id LIMIT ?"
        params.append(limit)
        rows = self._connect().execute(sql, params).fetchall()
        return [self._inbox_from_row(row) for row in rows]

    @_translate_errors
    def claim_inbox(self, *, limit: int, now: datetime) -> list[InboxRecord]:
        at = _iso(self._now_utc(now))
        claimed: list[InboxRecord] = []
        with self.transaction():
            connection = self._connect()
            rows = connection.execute(
                "SELECT * FROM event_inbox WHERE status = 'pending' "
                "ORDER BY received_at, event_id LIMIT ?",
                (limit,),
            ).fetchall()
            for row in rows:
                cursor = connection.execute(
                    "UPDATE event_inbox SET status = 'processing', attempts = attempts + 1 "
                    "WHERE event_id = ? AND status = 'pending'",
                    (row["event_id"],),
                )
                if cursor.rowcount == 1:
                    claimed.append(
                        InboxRecord(
                            event_id=row["event_id"],
                            status="processing",
                            attempts=row["attempts"] + 1,
                            received_at=_parse(row["received_at"]),
                        )
                    )
        return claimed

    @_translate_errors
    def mark_inbox(self, event_id: str, status: str, error: str | None = None) -> None:
        if status not in _INBOX_STATUSES:
            raise InvalidRequest("不支持的收件状态")
        with self.transaction():
            cursor = self._connect().execute(
                "UPDATE event_inbox SET status = ?, processed_at = ?, last_error = ? "
                "WHERE event_id = ?",
                (
                    status,
                    _iso(_utcnow()) if status in {"processed", "failed", "ignored"} else None,
                    error,
                    event_id,
                ),
            )
            if cursor.rowcount == 0:
                raise NotFound("事件不在收件箱中")

    @_translate_errors
    def enqueue_outbox(self, messages: Sequence[OutboxMessage]) -> None:
        with self.transaction():
            self._insert_outbox(self._connect(), messages)

    @_translate_errors
    def claim_outbox(self, *, limit: int, now: datetime) -> list[OutboxMessage]:
        at = self._now_utc(now)
        claimed: list[OutboxMessage] = []
        with self.transaction():
            connection = self._connect()
            rows = connection.execute(
                "SELECT * FROM event_outbox WHERE status IN ('pending', 'sending') "
                "AND available_at <= ? ORDER BY available_at, outbox_id LIMIT ?",
                (_iso(at), limit),
            ).fetchall()
            for row in rows:
                retry_at = at + timedelta(seconds=60)
                cursor = connection.execute(
                    "UPDATE event_outbox SET status = 'sending', attempts = attempts + 1, "
                    "available_at = ? WHERE outbox_id = ? AND status IN ('pending', 'sending')",
                    (_iso(retry_at), row["outbox_id"]),
                )
                if cursor.rowcount == 1:
                    claimed.append(
                        OutboxMessage(
                            outbox_id=row["outbox_id"],
                            aggregate_type=row["aggregate_type"],
                            aggregate_id=row["aggregate_id"],
                            event_type=row["event_type"],
                            payload=_loads(row["payload_json"], {}),
                            status="sending",
                            attempts=row["attempts"] + 1,
                            available_at=retry_at,
                            created_at=_parse(row["created_at"]),
                            published_at=_parse(row["published_at"]),
                            last_error=row["last_error"],
                        )
                    )
        return claimed

    @_translate_errors
    def mark_outbox(self, outbox_id: str, status: str, error: str | None = None) -> None:
        if status not in _OUTBOX_STATUSES:
            raise InvalidRequest("不支持的发布状态")
        with self.transaction():
            cursor = self._connect().execute(
                "UPDATE event_outbox SET status = ?, published_at = ?, last_error = ? "
                "WHERE outbox_id = ?",
                (
                    status,
                    _iso(_utcnow()) if status == "published" else None,
                    error,
                    outbox_id,
                ),
            )
            if cursor.rowcount == 0:
                raise NotFound("发布记录不存在")

    def _insert_outbox(
        self, connection: sqlite3.Connection, messages: Sequence[OutboxMessage]
    ) -> None:
        for message in messages:
            connection.execute(
                """
                INSERT INTO event_outbox(
                    outbox_id, aggregate_type, aggregate_id, event_type, payload_json,
                    status, attempts, available_at, created_at, published_at, last_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message.outbox_id,
                    message.aggregate_type,
                    message.aggregate_id,
                    message.event_type,
                    _dumps(message.payload),
                    message.status,
                    message.attempts,
                    _iso(message.available_at),
                    _iso(message.created_at),
                    _iso(message.published_at) if message.published_at else None,
                    message.last_error,
                ),
            )

    # ── 任务 ────────────────────────────────────────────────────────

    @_translate_errors
    def create_job(self, job: ResearchJob) -> ResearchJob:
        with self.transaction():
            self._connect().execute(
                """
                INSERT INTO research_jobs(
                    job_id, mandate_id, mandate_revision, trigger_event_id, action,
                    status, lease_token, lease_expires_at, attempt_count, budget_json,
                    checkpoint_json, cancel_generation, next_run_at, dedupe_key,
                    last_error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.job_id,
                    job.mandate_id,
                    job.mandate_revision,
                    job.trigger_event_id,
                    job.action,
                    job.status,
                    job.lease_token,
                    _iso(job.lease_expires_at) if job.lease_expires_at else None,
                    job.attempt_count,
                    _dumps(job.budget),
                    _dumps(job.checkpoint),
                    job.cancel_generation,
                    _iso(job.next_run_at),
                    job.dedupe_key,
                    job.last_error,
                    _iso(job.created_at),
                    _iso(job.updated_at),
                ),
            )
            row = self._connect().execute(
                "SELECT * FROM research_jobs WHERE job_id = ?", (job.job_id,)
            ).fetchone()
            return self._job_from_row(row)

    @_translate_errors
    def get_job(self, job_id: str) -> ResearchJob | None:
        row = self._connect().execute(
            "SELECT * FROM research_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        return self._job_from_row(row) if row else None

    @_translate_errors
    def get_job_by_dedupe(self, dedupe_key: str) -> ResearchJob | None:
        row = self._connect().execute(
            "SELECT * FROM research_jobs WHERE dedupe_key = ?", (dedupe_key,)
        ).fetchone()
        return self._job_from_row(row) if row else None

    @_translate_errors
    def claim_jobs(
        self, *, limit: int, lease_seconds: int, now: datetime
    ) -> list[ResearchJob]:
        if lease_seconds <= 0:
            raise InvalidRequest("租约时长必须大于零")
        at = self._now_utc(now)
        claimed: list[ResearchJob] = []
        with self.transaction():
            connection = self._connect()
            rows = connection.execute(
                "SELECT * FROM research_jobs WHERE status IN ('pending', 'waiting_data') "
                "AND next_run_at <= ? ORDER BY next_run_at, job_id LIMIT ?",
                (_iso(at), limit),
            ).fetchall()
            for row in rows:
                token = secrets.token_hex(16)
                expires = at + timedelta(seconds=lease_seconds)
                cursor = connection.execute(
                    "UPDATE research_jobs SET status = 'running', lease_token = ?, "
                    "lease_expires_at = ?, attempt_count = attempt_count + 1, "
                    "updated_at = ? WHERE job_id = ? AND status IN ('pending', 'waiting_data')",
                    (token, _iso(expires), _iso(at), row["job_id"]),
                )
                if cursor.rowcount == 1:
                    claimed.append(
                        self._job_from_row(
                            connection.execute(
                                "SELECT * FROM research_jobs WHERE job_id = ?",
                                (row["job_id"],),
                            ).fetchone()
                        )
                    )
        return claimed

    @_translate_errors
    def renew_job_lease(
        self,
        job_id: str,
        lease_token: str,
        *,
        lease_seconds: int,
        now: datetime,
    ) -> ResearchJob:
        if lease_seconds <= 0:
            raise InvalidRequest("租约时长必须大于零")
        at = self._now_utc(now)
        with self.transaction():
            connection = self._connect()
            cursor = connection.execute(
                "UPDATE research_jobs SET lease_expires_at = ?, updated_at = ? "
                "WHERE job_id = ? AND lease_token = ? AND status = 'running'",
                (_iso(at + timedelta(seconds=lease_seconds)), _iso(at), job_id, lease_token),
            )
            if cursor.rowcount == 0:
                raise LeaseExpired("任务租约已失效")
            row = connection.execute(
                "SELECT * FROM research_jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            return self._job_from_row(row)

    @_translate_errors
    def complete_job(
        self,
        job_id: str,
        lease_token: str,
        result: ResearchJobResult,
        *,
        now: datetime,
    ) -> ResearchJobResult:
        if result.job_id != job_id:
            raise InvalidRequest("结果与任务标识不一致")
        at = self._now_utc(now)
        with self.transaction():
            connection = self._connect()
            row = connection.execute(
                "SELECT * FROM research_jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise NotFound("任务不存在")
            if row["status"] not in {"running", "cancelled"} or row["lease_token"] != lease_token:
                raise LeaseExpired("任务租约已失效，结果只能留档")
            if row["status"] == "running" and _parse(row["lease_expires_at"]) < at:
                raise LeaseExpired("任务租约已过期")
            connection.execute(
                """
                INSERT INTO research_job_results(
                    result_id, job_id, run_id, outcome, structured_result_json,
                    evidence_batch_id, gaps_json, change_summary,
                    contact_suggestion_json, stale, received_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result.result_id,
                    result.job_id,
                    result.run_id,
                    result.outcome,
                    _dumps(result.structured_result),
                    result.evidence_batch_id,
                    _dumps(result.gaps),
                    result.change_summary,
                    _dumps(result.contact_suggestion),
                    1 if result.stale else 0,
                    _iso(result.received_at),
                ),
            )
            if row["status"] == "running":
                connection.execute(
                    "UPDATE research_jobs SET status = 'completed', lease_token = NULL, "
                    "lease_expires_at = NULL, updated_at = ? WHERE job_id = ?",
                    (_iso(at), job_id),
                )
            else:
                connection.execute(
                    "UPDATE research_jobs SET lease_token = NULL, "
                    "lease_expires_at = NULL, updated_at = ? WHERE job_id = ?",
                    (_iso(at), job_id),
                )
            return result

    @_translate_errors
    def fail_job(
        self,
        job_id: str,
        lease_token: str,
        error: str,
        *,
        now: datetime,
        retry_at: datetime | None = None,
    ) -> ResearchJob:
        at = self._now_utc(now)
        with self.transaction():
            connection = self._connect()
            row = connection.execute(
                "SELECT * FROM research_jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise NotFound("任务不存在")
            if row["status"] not in {"running", "cancelled"} or row["lease_token"] != lease_token:
                raise LeaseExpired("任务租约已失效")
            if row["status"] == "cancelled":
                connection.execute(
                    "UPDATE research_jobs SET lease_token = NULL, lease_expires_at = NULL, "
                    "last_error = ?, updated_at = ? WHERE job_id = ?",
                    (error, _iso(at), job_id),
                )
                return self._job_from_row(
                    connection.execute(
                        "SELECT * FROM research_jobs WHERE job_id = ?", (job_id,)
                    ).fetchone()
                )
            budget = _loads(row["budget_json"], {})
            max_attempts = int(budget.get("max_attempts", 3) or 3)
            can_retry = retry_at is not None and row["attempt_count"] < max_attempts
            if can_retry:
                connection.execute(
                    "UPDATE research_jobs SET status = 'pending', next_run_at = ?, "
                    "lease_token = NULL, lease_expires_at = NULL, last_error = ?, "
                    "updated_at = ? WHERE job_id = ?",
                    (_iso(retry_at), error, _iso(at), job_id),
                )
            else:
                connection.execute(
                    "UPDATE research_jobs SET status = 'failed', lease_token = NULL, "
                    "lease_expires_at = NULL, last_error = ?, updated_at = ? "
                    "WHERE job_id = ?",
                    (error, _iso(at), job_id),
                )
            updated = connection.execute(
                "SELECT * FROM research_jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            return self._job_from_row(updated)

    # ── 恢复与补偿 ──────────────────────────────────────────────────

    @_translate_errors
    def reclaim_expired_leases(
        self,
        *,
        now: datetime,
        limit: int = 50,
        retry_delay_seconds: int = 30,
    ) -> list[ResearchJob]:
        """回收过期租约：预算内重新排队，超出预算记为失败并保留原因。

        执行方可能已经崩溃、重启或断网；这里不猜测结果，只把“这次尝试已经
        失去租约”这一事实写回任务，让下一次领取重新执行。
        """

        at = self._now_utc(now)
        reclaimed: list[ResearchJob] = []
        with self.transaction():
            connection = self._connect()
            rows = connection.execute(
                "SELECT * FROM research_jobs WHERE status = 'running' "
                "AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? "
                "ORDER BY lease_expires_at, job_id LIMIT ?",
                (_iso(at), limit),
            ).fetchall()
            for row in rows:
                budget = _loads(row["budget_json"], {})
                max_attempts = int(budget.get("max_attempts", 3) or 3)
                if row["attempt_count"] < max_attempts:
                    connection.execute(
                        "UPDATE research_jobs SET status = 'pending', next_run_at = ?, "
                        "lease_token = NULL, lease_expires_at = NULL, "
                        "last_error = 'lease_expired', updated_at = ? WHERE job_id = ?",
                        (
                            _iso(at + timedelta(seconds=retry_delay_seconds)),
                            _iso(at),
                            row["job_id"],
                        ),
                    )
                else:
                    connection.execute(
                        "UPDATE research_jobs SET status = 'failed', "
                        "lease_token = NULL, lease_expires_at = NULL, "
                        "last_error = 'lease_expired', updated_at = ? WHERE job_id = ?",
                        (_iso(at), row["job_id"]),
                    )
                reclaimed.append(
                    self._job_from_row(
                        connection.execute(
                            "SELECT * FROM research_jobs WHERE job_id = ?",
                            (row["job_id"],),
                        ).fetchone()
                    )
                )
        return reclaimed

    @_translate_errors
    def requeue_abandoned_inbox(
        self, *, older_than: datetime, limit: int = 100
    ) -> int:
        """把卡在 processing 的收件记录放回待处理。

        路由是短事务；长时间停留在 processing 只可能来自进程中断。重新排队后
        仍按 event_id 与任务去重键保证不会重复建任务。
        """

        threshold = _iso(self._now_utc(older_than))
        requeued = 0
        with self.transaction():
            connection = self._connect()
            rows = connection.execute(
                "SELECT event_id FROM event_inbox WHERE status = 'processing' "
                "AND received_at <= ? ORDER BY received_at LIMIT ?",
                (threshold, limit),
            ).fetchall()
            for row in rows:
                cursor = connection.execute(
                    "UPDATE event_inbox SET status = 'pending', "
                    "last_error = 'recovered_after_crash' "
                    "WHERE event_id = ? AND status = 'processing'",
                    (row["event_id"],),
                )
                requeued += 1 if cursor.rowcount == 1 else 0
        return requeued

    @_translate_errors
    def retry_failed_outbox(
        self, *, now: datetime, limit: int = 50, max_attempts: int = 5
    ) -> int:
        """把未超过预算的失败发布记录重新放回待发；超过预算的留在失败态。"""

        at = self._now_utc(now)
        retried = 0
        with self.transaction():
            connection = self._connect()
            rows = connection.execute(
                "SELECT outbox_id FROM event_outbox WHERE status = 'failed' "
                "AND attempts < ? ORDER BY created_at LIMIT ?",
                (max_attempts, limit),
            ).fetchall()
            for row in rows:
                cursor = connection.execute(
                    "UPDATE event_outbox SET status = 'pending', available_at = ?, "
                    "last_error = NULL WHERE outbox_id = ? AND status = 'failed'",
                    (_iso(at), row["outbox_id"]),
                )
                retried += 1 if cursor.rowcount == 1 else 0
        return retried

    @_translate_errors
    def list_job_results(self, job_id: str) -> list[ResearchJobResult]:
        rows = self._connect().execute(
            "SELECT * FROM research_job_results WHERE job_id = ? "
            "ORDER BY received_at, result_id",
            (job_id,),
        ).fetchall()
        return [self._result_from_row(row) for row in rows]

    # ── 联系决定与投递结果 ──────────────────────────────────────────

    @_translate_errors
    def save_contact_decision(self, decision: ContactDecision) -> ContactDecision:
        with self.transaction():
            connection = self._connect()
            connection.execute(
                """
                INSERT OR IGNORE INTO contact_decisions(
                    decision_id, mandate_id, mandate_revision, job_id, decision,
                    reason_code, condition_result, detail, evidence_ref, dedupe_key,
                    condition_key, eligible_at, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    decision.decision_id,
                    decision.mandate_id,
                    decision.mandate_revision,
                    decision.job_id,
                    decision.decision,
                    decision.reason_code,
                    decision.condition_result,
                    decision.detail,
                    decision.evidence_ref,
                    decision.dedupe_key,
                    decision.condition_key,
                    _iso(decision.eligible_at) if decision.eligible_at else None,
                    _iso(decision.expires_at) if decision.expires_at else None,
                    _iso(decision.created_at),
                ),
            )
            row = connection.execute(
                "SELECT * FROM contact_decisions WHERE mandate_id = ? AND dedupe_key = ?",
                (decision.mandate_id, decision.dedupe_key),
            ).fetchone()
            return self._decision_from_row(row)

    @_translate_errors
    def list_contact_decisions(
        self, mandate_id: str, *, limit: int = 50
    ) -> list[ContactDecision]:
        rows = self._connect().execute(
            "SELECT * FROM contact_decisions WHERE mandate_id = ? "
            "ORDER BY created_at DESC, decision_id DESC LIMIT ?",
            (mandate_id, limit),
        ).fetchall()
        return [self._decision_from_row(row) for row in rows]

    @_translate_errors
    def list_contact_decisions_for_job(self, job_id: str) -> list[ContactDecision]:
        rows = self._connect().execute(
            "SELECT * FROM contact_decisions WHERE job_id = ? "
            "ORDER BY created_at, decision_id",
            (job_id,),
        ).fetchall()
        return [self._decision_from_row(row) for row in rows]

    @_translate_errors
    def find_recent_contact_decision(
        self,
        mandate_id: str,
        *,
        since: datetime,
        condition_key: str | None = None,
        kinds: Sequence[str] = ("send", "aggregate"),
    ) -> ContactDecision | None:
        if not kinds:
            return None
        placeholders = ", ".join("?" for _ in kinds)
        params: list[Any] = [mandate_id, _iso(since), *kinds]
        sql = (
            "SELECT * FROM contact_decisions WHERE mandate_id = ? "
            f"AND created_at >= ? AND decision IN ({placeholders})"
        )
        if condition_key is not None:
            sql += " AND condition_key = ?"
            params.append(condition_key)
        sql += " ORDER BY created_at DESC, decision_id DESC LIMIT 1"
        row = self._connect().execute(sql, params).fetchone()
        return None if row is None else self._decision_from_row(row)

    # ── 消推配置与暂缓 ──────────────────────────────────────────────

    @_translate_errors
    def get_notification_preferences(
        self, principal_id: str, instance_id: str
    ) -> NotificationPreferences | None:
        row = self._connect().execute(
            "SELECT * FROM notification_preferences "
            "WHERE principal_id = ? AND instance_id = ?",
            (principal_id, instance_id),
        ).fetchone()
        return None if row is None else self._preferences_from_row(row)

    @_translate_errors
    def save_notification_preferences(
        self, preferences: NotificationPreferences
    ) -> NotificationPreferences:
        with self.transaction():
            self._connect().execute(
                """
                INSERT INTO notification_preferences(
                    principal_id, instance_id, timezone, quiet_hours_json,
                    channels_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(principal_id, instance_id) DO UPDATE SET
                    timezone = excluded.timezone,
                    quiet_hours_json = excluded.quiet_hours_json,
                    channels_json = excluded.channels_json,
                    updated_at = excluded.updated_at
                """,
                (
                    preferences.principal_id,
                    preferences.instance_id,
                    preferences.timezone,
                    _dumps(preferences.quiet_hours)
                    if preferences.quiet_hours is not None
                    else None,
                    _dumps(preferences.channels),
                    _iso(preferences.updated_at),
                ),
            )
        stored = self.get_notification_preferences(
            preferences.principal_id, preferences.instance_id
        )
        if stored is None:  # pragma: no cover - 写入后立即读取不可能为空
            raise StorageUnavailable("消推配置写入后读取失败")
        return stored

    @_translate_errors
    def create_snooze(self, entry: SnoozeEntry) -> SnoozeEntry:
        with self.transaction():
            self._connect().execute(
                """
                INSERT OR IGNORE INTO notification_snoozes(
                    snooze_id, principal_id, instance_id, scope_type, scope_id,
                    until, reason, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry.snooze_id,
                    entry.principal_id,
                    entry.instance_id,
                    entry.scope_type,
                    entry.scope_id,
                    _iso(entry.until),
                    entry.reason,
                    _iso(entry.created_at),
                ),
            )
            row = self._connect().execute(
                "SELECT * FROM notification_snoozes WHERE snooze_id = ?",
                (entry.snooze_id,),
            ).fetchone()
            return self._snooze_from_row(row)

    @_translate_errors
    def list_active_snoozes(
        self,
        *,
        principal_id: str,
        instance_id: str,
        mandate_id: str,
        condition_key: str,
        now: datetime,
    ) -> list[SnoozeEntry]:
        # decision 范围的 scope_id 是条件键：暂缓的是“这类提醒”，
        # 而不是某一条已经过去的消息。
        rows = self._connect().execute(
            "SELECT * FROM notification_snoozes "
            "WHERE principal_id = ? AND instance_id = ? AND until > ? "
            "AND ((scope_type = 'mandate' AND scope_id = ?) "
            "  OR (scope_type = 'decision' AND scope_id = ?)) "
            "ORDER BY until DESC, snooze_id",
            (principal_id, instance_id, _iso(now), mandate_id, condition_key),
        ).fetchall()
        return [self._snooze_from_row(row) for row in rows]

    @_translate_errors
    def list_snoozes(
        self,
        *,
        principal_id: str,
        instance_id: str,
        now: datetime,
        active_only: bool = True,
        limit: int = 100,
    ) -> list[SnoozeEntry]:
        sql = (
            "SELECT * FROM notification_snoozes "
            "WHERE principal_id = ? AND instance_id = ?"
        )
        params: list[Any] = [principal_id, instance_id]
        if active_only:
            sql += " AND until > ?"
            params.append(_iso(now))
        sql += " ORDER BY until, snooze_id LIMIT ?"
        params.append(limit)
        rows = self._connect().execute(sql, params).fetchall()
        return [self._snooze_from_row(row) for row in rows]

    @_translate_errors
    def save_contact_record(self, record: ContactRecord) -> None:
        with self.transaction():
            self._connect().execute(
                """
                INSERT INTO contact_records(
                    decision_id, channel, status, sent_at, delivery_job_id, detail
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(decision_id, channel) DO UPDATE SET
                    status = excluded.status,
                    sent_at = excluded.sent_at,
                    delivery_job_id = excluded.delivery_job_id,
                    detail = excluded.detail
                """,
                (
                    record.decision_id,
                    record.channel,
                    record.status,
                    _iso(record.sent_at) if record.sent_at else None,
                    record.delivery_job_id,
                    record.detail,
                ),
            )

    # ── 条件时间状态 ────────────────────────────────────────────────

    @_translate_errors
    def get_condition_state(
        self, mandate_id: str, condition_key: str
    ) -> ConditionState | None:
        row = self._connect().execute(
            "SELECT * FROM condition_states WHERE mandate_id = ? AND condition_key = ?",
            (mandate_id, condition_key),
        ).fetchone()
        if row is None:
            return None
        return ConditionState(
            mandate_id=row["mandate_id"],
            condition_key=row["condition_key"],
            state=row["state"],
            state_since=_parse(row["state_since"]),
            met_episodes=row["met_episodes"],
            last_met_at=_parse(row["last_met_at"]) if row["last_met_at"] else None,
            last_evaluated_at=_parse(row["last_evaluated_at"]),
        )

    @_translate_errors
    def save_condition_state(self, state: ConditionState) -> ConditionState:
        with self.transaction():
            self._connect().execute(
                """
                INSERT INTO condition_states(
                    mandate_id, condition_key, state, state_since,
                    met_episodes, last_met_at, last_evaluated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(mandate_id, condition_key) DO UPDATE SET
                    state = excluded.state,
                    state_since = excluded.state_since,
                    met_episodes = excluded.met_episodes,
                    last_met_at = excluded.last_met_at,
                    last_evaluated_at = excluded.last_evaluated_at
                """,
                (
                    state.mandate_id,
                    state.condition_key,
                    state.state,
                    _iso(state.state_since),
                    state.met_episodes,
                    _iso(state.last_met_at) if state.last_met_at else None,
                    _iso(state.last_evaluated_at),
                ),
            )
        return state

    # ── 幂等回执 ────────────────────────────────────────────────────

    @_translate_errors
    def get_idempotent_response(
        self, principal_id: str, operation: str, idempotency_key: str
    ) -> IdempotentResponse | None:
        row = self._connect().execute(
            "SELECT * FROM command_idempotency WHERE principal_id = ? AND operation = ? "
            "AND idempotency_key = ?",
            (principal_id, operation, idempotency_key),
        ).fetchone()
        if row is None:
            return None
        return IdempotentResponse(
            principal_id=row["principal_id"],
            operation=row["operation"],
            idempotency_key=row["idempotency_key"],
            request_hash=row["request_hash"],
            response=_loads(row["response_json"], {}),
            created_at=_parse(row["created_at"]),
        )

    @_translate_errors
    def save_idempotent_response(self, record: IdempotentResponse) -> None:
        with self.transaction():
            connection = self._connect()
            existing = connection.execute(
                "SELECT request_hash FROM command_idempotency "
                "WHERE principal_id = ? AND operation = ? AND idempotency_key = ?",
                (record.principal_id, record.operation, record.idempotency_key),
            ).fetchone()
            if existing is not None:
                if existing["request_hash"] != record.request_hash:
                    raise Conflict("该幂等键已用于另一请求")
                return
            connection.execute(
                "INSERT INTO command_idempotency("
                "principal_id, operation, idempotency_key, request_hash, "
                "response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    record.principal_id,
                    record.operation,
                    record.idempotency_key,
                    record.request_hash,
                    _dumps(record.response),
                    _iso(record.created_at),
                ),
            )

    # ── 内部写入辅助 ────────────────────────────────────────────────

    def _insert_revision(
        self, connection: sqlite3.Connection, revision: MandateRevision
    ) -> None:
        connection.execute(
            """
            INSERT INTO mandate_revisions(
                mandate_id, revision, goal, scope_json, triggers_json,
                contact_policy_json, basis_json, change_summary, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                revision.mandate_id,
                revision.revision,
                revision.goal,
                _dumps(revision.scope),
                _dumps(revision.triggers),
                _dumps(revision.contact_policy),
                _dumps(revision.basis),
                revision.change_summary,
                revision.created_by,
                _iso(revision.created_at),
            ),
        )

    def _insert_subjects(
        self, connection: sqlite3.Connection, subjects: Sequence[MandateSubject]
    ) -> None:
        for item in subjects:
            connection.execute(
                """
                INSERT OR REPLACE INTO mandate_subjects(
                    mandate_id, revision, entity_id, role, scope_mode, collection_version
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    item.mandate_id,
                    item.revision,
                    item.entity_id,
                    item.role,
                    item.scope_mode,
                    item.collection_version,
                ),
            )

    def _insert_requirements(
        self, connection: sqlite3.Connection, requirements: Sequence[MandateRequirement]
    ) -> None:
        for item in requirements:
            connection.execute(
                """
                INSERT INTO mandate_requirements(
                    requirement_id, mandate_id, revision, code, detail, status,
                    created_at, resolved_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.requirement_id,
                    item.mandate_id,
                    item.revision,
                    item.code,
                    item.detail,
                    item.status,
                    _iso(item.created_at),
                    _iso(item.resolved_at) if item.resolved_at else None,
                ),
            )
