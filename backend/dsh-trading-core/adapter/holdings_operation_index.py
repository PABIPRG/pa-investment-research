"""业务写入方维护的可重建投影；匿名读取只打开既有 SQLite 索引。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import struct
import time
from contextlib import contextmanager
from datetime import datetime, timezone

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .holdings_mutation_history import pending_path, sync_directory
from .public_holdings_operations import ARCHIVE_NAME, _project, _timestamp
from .store import JsonStoreTransferBusyError


SCHEMA_VERSION = 1
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SUMMARY_BYTES = 4096
MAX_DETAIL_BYTES = 512 * 1024
SUMMARY_FIELDS = ("public_id", "category", "status", "occurred_at", "title", "summary")
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class CursorExpired(Exception):
    """许可或索引代次变化，调用方必须重新读取第一页。"""


def micros(value: datetime) -> int:
    delta = value.astimezone(timezone.utc) - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def path_for(store):
    return store.base_dir / "_holdings_operation_index" / "projection.sqlite3"


def _encode(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _guard(store):
    if store.active_transfer_id() is not None or pending_path(store).exists():
        raise JsonStoreTransferBusyError("账户操作正在归档")


@contextmanager
def _connection(store, *, writable=False):
    path = path_for(store)
    if path.parent.is_symlink() or path.is_symlink():
        raise RuntimeError("操作索引路径无效")
    if writable:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
        sync_directory(store.base_dir)
    elif not path.is_file():
        raise RuntimeError("操作索引尚未就绪")
    connection = None
    try:
        connection = sqlite3.connect(path.as_uri() + ("?mode=rw" if writable else "?mode=ro"),
                                     uri=True, timeout=5 if writable else 0.05)
        connection.execute("PRAGMA trusted_schema=OFF")
        if writable:
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
        else:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA temp_store=MEMORY")
            deadline, remaining = time.monotonic() + 0.3, 1000

            def budget():
                nonlocal remaining
                remaining -= 1
                return int(remaining <= 0 or time.monotonic() > deadline)

            connection.set_progress_handler(budget, 1000)
        yield connection
    except sqlite3.Error as exc:
        raise RuntimeError("操作索引暂不可用") from exc
    finally:
        if connection is not None:
            connection.close()


def _metadata(connection):
    if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise RuntimeError("操作索引版本不匹配")
    row = connection.execute("SELECT CASE WHEN length(generation)=8 THEN generation END, CASE WHEN length(secret)=32 THEN secret END, CASE WHEN ready=1 THEN 1 END FROM metadata WHERE singleton=1").fetchone()
    if row is None or row[2] != 1 or not isinstance(row[0], bytes) or len(row[0]) != 8 or not isinstance(row[1], bytes) or len(row[1]) != 32:
        raise RuntimeError("操作索引尚未就绪")
    return row[0], row[1]


def _archives(store):
    directory = store.base_dir / "_holdings_operation_history"
    if directory.is_symlink():
        raise RuntimeError("操作归档目录无效")
    if not directory.exists():
        return
    with os.scandir(directory) as entries:
        for entry in entries:
            if not ARCHIVE_NAME.fullmatch(entry.name):
                continue
            if not entry.is_file(follow_symlinks=False):
                raise RuntimeError("操作归档不是普通文件")
            descriptor = os.open(entry.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(descriptor, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_SOURCE_BYTES:
                    raise RuntimeError("单份操作归档超限")
                raw = stream.read(MAX_SOURCE_BYTES + 1)
            if len(raw) > MAX_SOURCE_BYTES:
                raise RuntimeError("单份操作归档超限")
            yield entry.name[:-5], json.loads(raw)


def _insert(connection, identity, record, secret):
    source = hashlib.sha256(identity.encode()).digest()
    digest = hashlib.sha256(_encode(record)).digest()
    previous = connection.execute("SELECT source_hash FROM records WHERE source=?", (source,)).fetchone()
    if previous:
        if previous[0] != digest:
            raise RuntimeError("操作索引编号冲突")
        return
    started, occurred, row, invalid = None, None, None, 0
    try:
        if isinstance(record, dict) and record.get("startedAt") is not None:
            started = micros(_timestamp(record["startedAt"]))
        row = _project(record, identity, datetime.min.replace(tzinfo=timezone.utc))
        if row is not None:
            occurred = micros(_timestamp(row["occurred_at"]))
            summary, detail = _encode({key: row[key] for key in SUMMARY_FIELDS}), _encode(row)
            if len(summary) > MAX_SUMMARY_BYTES or len(detail) > MAX_DETAIL_BYTES:
                raise RuntimeError("操作投影超限")
    except (RuntimeError, ValueError, OverflowError):
        # 坏资料不伪造、也不丢弃；当前许可覆盖它时，读取明确失败关闭。
        row, invalid = None, 1
    if row is None:
        summary = detail = b""
    inserted = connection.execute(
        "INSERT INTO records(source,source_hash,public_id,started,occurred,status,invalid,summary,detail,signature) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (source, digest, row["public_id"] if row else None, started, occurred, row["status"] if row else None,
         invalid, summary, detail, b""),
    )
    route = (inserted.lastrowid, row["public_id"] if row else None, started, occurred, row["status"] if row else None, invalid)
    prefix = _encode(route) + b"\0"
    signature = hmac.digest(secret, prefix + summary, "sha256") + hmac.digest(secret, prefix + summary + b"\0" + detail, "sha256")
    connection.execute("UPDATE records SET route_signature=?, signature=? WHERE seq=?", (hmac.digest(secret, _encode(route), "sha256"), signature, inserted.lastrowid))


def _rebuild_locked(store):
    with _connection(store, writable=True) as connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, SCHEMA_VERSION):
            raise RuntimeError("操作索引版本不匹配")
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("CREATE TABLE IF NOT EXISTS metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation BLOB, secret BLOB, ready INTEGER)")
            connection.execute("CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY, source BLOB UNIQUE NOT NULL, source_hash BLOB NOT NULL, public_id TEXT UNIQUE, started INTEGER, occurred INTEGER, status TEXT, invalid INTEGER NOT NULL, summary BLOB, detail BLOB, signature BLOB, route_signature BLOB)")
            connection.execute("CREATE INDEX IF NOT EXISTS chronology ON records(occurred DESC, public_id DESC)")
            connection.execute("CREATE INDEX IF NOT EXISTS status_chronology ON records(status, occurred DESC, public_id DESC)")
            connection.execute("CREATE INDEX IF NOT EXISTS invalid_started ON records(invalid, started)")
            connection.execute("DELETE FROM records")
            secret = os.urandom(32)
            for identity, record in _archives(store):
                _insert(connection, identity, record, secret)
            connection.execute("INSERT OR REPLACE INTO metadata VALUES(1,?,?,1)", (os.urandom(8), secret))
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        sync_directory(path_for(store).parent)


def ensure(store):
    """私有启动／写入入口迁移旧归档；已有完整索引不重新扫描。"""
    with store.transaction():
        if path_for(store).exists():
            # 私有 owner 允许 SQLite 回滚崩溃遗留的 hot journal；GET 永远只读。
            with _connection(store, writable=True) as connection:
                uninitialized = connection.execute("PRAGMA user_version").fetchone()[0] == 0 and connection.execute(
                    "SELECT 1 FROM sqlite_master LIMIT 1").fetchone() is None
                if not uninitialized:
                    _metadata(connection)
            if uninitialized:
                _rebuild_locked(store)
        else:
            _rebuild_locked(store)


def rebuild(store):
    """私有维护：持有根目录锁，单事务替换派生数据，失败保留旧完整索引。"""
    with store.transaction():
        _rebuild_locked(store)


def append(store, record):
    """归档持久化后、清恢复材料前调用；根目录锁由既有业务事务持有。"""
    ensure(store)
    with _connection(store, writable=True) as connection:
        _, secret = _metadata(connection)
        with connection:
            _insert(connection, record["transactionId"], record, secret)


@contextmanager
def reader(store):
    _guard(store)
    with _connection(store) as connection:
        # 同一只读快照内获取代次、上界与数据，不混入并发重建或新提交。
        connection.execute("BEGIN")
        generation, secret = _metadata(connection)
        yield ProjectionReader(connection, generation, secret)
        _guard(store)


class ProjectionReader:
    def __init__(self, connection, generation, secret):
        self.connection, self.generation, self.secret = connection, generation, secret
        self.highwater = connection.execute("SELECT COALESCE(MAX(seq),0) FROM records").fetchone()[0]

    def validate_policy(self, since):
        invalid = self.connection.execute(
            "SELECT 1 FROM records WHERE invalid=1 AND (started IS NULL OR started>=?) LIMIT 1", (since,),
        ).fetchone()
        if invalid:
            raise RuntimeError("已许可操作的投影无法核验")

    def _verify_route(self, route):
        fields, signature = route[:-1], route[-1]
        if not isinstance(signature, bytes) or not hmac.compare_digest(hmac.digest(self.secret, _encode(fields), "sha256"), signature):
            raise RuntimeError("操作索引许可校验失败")

    def page(self, since, cutoff, status, highwater, anchor, limit):
        self.validate_policy(since)
        clauses, parameters = ["occurred < ?", "occurred >= ?", "started >= ?", "seq <= ?"], [cutoff, since, since, highwater]
        if status != "all":
            clauses.append("status = ?")
            parameters.append(status)
        if anchor is not None:
            clauses.append("(occurred, public_id) < (?, ?)")
            parameters.extend(anchor)
        # 列表不读明细；字节上限在 SQLite 内判断，损坏大值不带出。
        rows = self.connection.execute(
            "SELECT CASE WHEN length(summary)<=? THEN summary END, CASE WHEN length(signature)=64 THEN signature END, "
            "seq, CASE WHEN length(public_id)=24 THEN public_id END, CASE WHEN typeof(started)='integer' THEN started END, CASE WHEN typeof(occurred)='integer' THEN occurred END, CASE WHEN length(status)<=9 THEN status END, CASE WHEN invalid IN (0,1) THEN invalid END, "
            "CASE WHEN length(route_signature)=32 THEN route_signature END FROM records WHERE "
            + " AND ".join(clauses) + " ORDER BY occurred DESC,public_id DESC LIMIT ?",
            [MAX_SUMMARY_BYTES, *parameters, limit],
        ).fetchall()
        result = []
        for summary, signature, *route in rows:
            self._verify_route(route)
            if not isinstance(summary, bytes) or not isinstance(signature, bytes) or len(signature) != 64 or not hmac.compare_digest(
                    hmac.digest(self.secret, _encode(route[:-1]) + b"\0" + summary, "sha256"), signature[:32]):
                raise RuntimeError("操作摘要校验失败")
            result.append(json.loads(summary))
        return result

    def detail(self, public_id, since):
        self.validate_policy(since)
        row = self.connection.execute(
            "SELECT CASE WHEN length(summary)<=? THEN summary END, CASE WHEN length(detail)<=? THEN detail END, CASE WHEN length(signature)=64 THEN signature END, "
            "seq, CASE WHEN length(public_id)=24 THEN public_id END, CASE WHEN typeof(started)='integer' THEN started END, CASE WHEN typeof(occurred)='integer' THEN occurred END, CASE WHEN length(status)<=9 THEN status END, CASE WHEN invalid IN (0,1) THEN invalid END, "
            "CASE WHEN length(route_signature)=32 THEN route_signature END FROM records WHERE public_id=? AND started>=?",
            (MAX_SUMMARY_BYTES, MAX_DETAIL_BYTES, public_id, since),
        ).fetchone()
        if row is None:
            return None
        summary, detail, signature, *route = row
        self._verify_route(route)
        if (not isinstance(summary, bytes) or not isinstance(detail, bytes) or not isinstance(signature, bytes) or len(signature) != 64
                or not hmac.compare_digest(hmac.digest(self.secret, _encode(route[:-1]) + b"\0" + summary + b"\0" + detail, "sha256"), signature[32:])):
            raise RuntimeError("操作明细校验失败")
        return json.loads(detail)

    def cursor(self, highwater, anchor, context):
        header, nonce = b"\x01" + self.generation, os.urandom(12)
        payload = struct.pack(">Qq12s16s", highwater, anchor[0], bytes.fromhex(anchor[1]), context)
        return base64.urlsafe_b64encode(header + nonce + AESGCM(self.secret).encrypt(nonce, payload, header)).decode().rstrip("=")

    def open_cursor(self, cursor, context):
        if re.fullmatch(r"[A-Za-z0-9_-]{108}", cursor) is None:
            raise ValueError("cursor 无效")
        raw = base64.urlsafe_b64decode(cursor)
        if raw[0] != 1:
            raise ValueError("cursor 无效")
        if raw[1:9] != self.generation:
            raise CursorExpired()
        try:
            payload = AESGCM(self.secret).decrypt(raw[9:21], raw[21:], raw[:9])
        except InvalidTag as exc:
            raise ValueError("cursor 无效") from exc
        highwater, occurred, public_id, original_context = struct.unpack(">Qq12s16s", payload)
        if not hmac.compare_digest(original_context, context):
            raise CursorExpired()
        if highwater > self.highwater:
            raise ValueError("cursor 无效")
        return highwater, (occurred, public_id.hex())
