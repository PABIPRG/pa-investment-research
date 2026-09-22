"""持仓账户正常写入的私有预写日志；业务 JSON 不携带审计元数据。

调用方必须持有 JsonStore 根目录事务锁。单一 pending 在下一次写入前解决，
因此恢复只能接受精确旧状态或精确新状态；不推断、不回滚未知的外部修改。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


_LOCK_CONTEXT = threading.local()
COLLECTIONS = {"holdings", "trades"}


def sync_directory(path: Path) -> None:
    if os.name == "nt":
        return  # Windows 目录 fsync 不支持；文件仍 flush/fsync 后原子替换。
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def process_lock(root: Path):
    """与进程内 RLock 配合；同线程重入不重复获取 OS 文件锁。"""
    identity = str(root.resolve())
    held = getattr(_LOCK_CONTEXT, "held", set())
    if identity in held:
        yield
        return
    root.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(root / ".json-store.lock", os.O_RDWR | os.O_CREAT, 0o600)
    locked = False
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        locked = True
        _LOCK_CONTEXT.held = held | {identity}
        yield
    finally:
        _LOCK_CONTEXT.held = held
        if locked:
            if os.name == "nt":
                import msvcrt
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(document: dict, exists: bool) -> str:
    return hashlib.sha256(_encode([exists, document]).encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def pending_path(store) -> Path:
    return store.base_dir / "_holdings_mutation_wal" / "pending.json"


def _delta(before, after) -> dict:
    # 多重集合差，不能把同价同量的多笔真实成交当成一笔。
    if not isinstance(before, list) or not isinstance(after, list):
        return {"before": before, "after": after, "unclassified": True}
    left, right = Counter(map(_encode, before)), Counter(map(_encode, after))
    return {
        "added": [json.loads(row) for row, count in (right - left).items() for _ in range(count)],
        "removed": [json.loads(row) for row, count in (left - right).items() for _ in range(count)],
    }


def prepare(store, collection: str, after: dict) -> dict | None:
    if collection not in COLLECTIONS:
        return None
    before = store._read(collection)
    fields = ("default", "manual_trades", "snapshots", "history_start_override") if collection == "holdings" else ("entries",)
    changes = {}
    for field in fields:
        if (field in before, before.get(field)) == (field in after, after.get(field)):
            continue
        if field in {"manual_trades", "entries", "snapshots"}:
            changes[field] = _delta(before.get(field, []), after.get(field, []))
        else:
            changes[field] = {"before": before.get(field), "after": after.get(field),
                              "beforePresent": field in before, "afterPresent": field in after}
    if not changes:
        return None
    identity, timestamp = str(uuid.uuid4()), _now()
    record = {
        "schemaVersion": 1, "transactionId": identity, "kind": f"{collection}_update",
        "startedAt": timestamp, "observedAt": timestamp,
        "confirmation": "local_atomic_replace", "changes": changes,
    }
    intent = {"schemaVersion": 1, "collection": collection,
              "beforeHash": _digest(before, store._path(collection).exists()),
              "afterHash": _digest(after, True), "record": record}
    write_intent(store, intent)
    return intent


def write_intent(store, intent: dict) -> None:
    """调用方持有账户根锁；已校验导出事件与普通写入共享一个待恢复槽位。"""
    path = pending_path(store)
    if path.exists():
        raise RuntimeError("账户留痕仍待恢复，不能覆盖预写日志")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    sync_directory(store.base_dir)
    store._write_path(path, _encode(intent))
    sync_directory(path.parent)


def publish(store, record: dict) -> None:
    directory = store.base_dir / "_holdings_operation_history"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    sync_directory(store.base_dir)
    path = directory / f"{record['transactionId']}.json"
    content = _encode(record).encode("utf-8")
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=".pending-", suffix=".tmp")
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError:
            if path.is_symlink() or path.read_bytes() != content:
                raise RuntimeError("账户操作编号冲突，历史不能覆盖")
        sync_directory(directory)
    finally:
        temporary_path.unlink(missing_ok=True)


def discard(store) -> None:
    path = pending_path(store)
    path.unlink()
    sync_directory(path.parent)


def complete(store, intent: dict) -> None:
    from .holdings_operation_index import append

    # 在发布成功事件之前，确保业务 rename 已持久化。
    sync_directory(store.base_dir)
    publish(store, intent["record"])
    append(store, intent["record"])
    discard(store)


def recover(store) -> None:
    path = pending_path(store)
    if not path.exists():
        return
    if store.active_transfer_id() is not None:
        raise RuntimeError("账户留痕与导入事务同时待恢复，请人工核验")
    try:
        intent = json.loads(path.read_text(encoding="utf-8"))
        collection, record = intent["collection"], intent["record"]
        if intent.get("schemaVersion") == 1 and collection is None:
            from .holdings_export_history import validate_record
            validate_record(record)
            complete(store, intent)
            return
        if (intent.get("schemaVersion") != 1 or collection not in COLLECTIONS
                or record.get("schemaVersion") != 1 or record.get("kind") != f"{collection}_update"
                or str(uuid.UUID(record["transactionId"])) != record["transactionId"]
                or any(re.fullmatch(r"[0-9a-f]{64}", intent[key]) is None for key in ("beforeHash", "afterHash"))):
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise RuntimeError("账户留痕预写日志损坏，保留现场等待核验") from exc
    current = _digest(store._read(collection), store._path(collection).exists())
    if current == intent["afterHash"]:
        complete(store, intent)
    elif current == intent["beforeHash"]:
        sync_directory(store.base_dir)
        discard(store)
    else:
        raise RuntimeError("账户留痕无法判定写入结果，保留现场等待核验")
