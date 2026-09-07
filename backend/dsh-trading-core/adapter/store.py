# -*- coding: utf-8 -*-
"""本地 JSON 持久化（MongoDB 已禁用，持仓/自选/简报落本地文件）。

线程安全 + 原子写（写临时文件再 rename），并发读改写互斥。
collection 是 data/adapter/ 下的一个 JSON 文件，每文件一个 dict。
"""

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator


_FILE_LOCKS: dict[Path, threading.Lock] = {}
_FILE_LOCKS_GUARD = threading.Lock()
_TRANSACTION_LOCKS: dict[Path, threading.RLock] = {}
_TRANSACTION_LOCKS_GUARD = threading.Lock()
_TRANSFER_CONTEXT = threading.local()


class JsonStoreCorruptionError(RuntimeError):
    """持久化文件存在但不是可读取的 JSON 对象。"""


class JsonStoreTransferBusyError(RuntimeError):
    """数据目录已被一个持久化导入或重置事务预留。"""


class JsonStore:
    def __init__(self, base_dir: Path | None = None):
        from .config import settings

        if base_dir is not None:
            self.base_dir = base_dir
        elif settings.state_root is not None:
            self.base_dir = settings.data_dir
        else:
            self.base_dir = settings.root / "data" / "adapter"
        self.base_dir.mkdir(parents=True, exist_ok=True)
    def _path(self, collection: str) -> Path:
        # 集合名只允许字母数字下划线，防路径穿越
        if not collection.replace("_", "").isalnum():
            raise ValueError(f"非法集合名: {collection}")
        return self.base_dir / f"{collection}.json"

    def _lock(self, collection: str) -> threading.Lock:
        path = self._path(collection).resolve()
        with _FILE_LOCKS_GUARD:
            lock = _FILE_LOCKS.get(path)
            if lock is None:
                lock = threading.Lock()
                _FILE_LOCKS[path] = lock
            return lock

    def _transaction_lock(self) -> threading.RLock:
        root = self.base_dir.resolve()
        with _TRANSACTION_LOCKS_GUARD:
            lock = _TRANSACTION_LOCKS.get(root)
            if lock is None:
                lock = threading.RLock()
                _TRANSACTION_LOCKS[root] = lock
            return lock

    @property
    def transfer_directory(self) -> Path:
        return self.base_dir / "_transfer_transactions"

    def active_transfer_id(self) -> str | None:
        try:
            value = (self.transfer_directory / "active").read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        return value or None

    def reserve_transfer(self, transaction_id: str) -> None:
        active = self.active_transfer_id()
        if active is not None and active != transaction_id:
            raise JsonStoreTransferBusyError("另一个数据导入或重置正在进行")
        self.transfer_directory.mkdir(parents=True, exist_ok=True)
        self._write_path(self.transfer_directory / "active", transaction_id)

    def release_transfer(self, transaction_id: str) -> None:
        active_path = self.transfer_directory / "active"
        if self.active_transfer_id() != transaction_id:
            return
        try:
            active_path.unlink()
        except FileNotFoundError:
            pass

    def _write_path(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        temporary_path = Path(temporary)
        stream = None
        try:
            stream = os.fdopen(fd, "w", encoding="utf-8")
            with stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, path)
        finally:
            if stream is None:
                os.close(fd)
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass

    @contextmanager
    def transaction(self, transaction_id: str | None = None) -> Iterator[None]:
        """阻止跨集合并发；持久化传输期间仅允许持有同一事务 ID 的调用。"""
        root = str(self.base_dir.resolve())
        contexts = getattr(_TRANSFER_CONTEXT, "transactions", {})
        inherited = contexts.get(root)
        authorized = transaction_id or inherited
        with self._transaction_lock():
            active = self.active_transfer_id()
            if active is not None and active != authorized:
                raise JsonStoreTransferBusyError("数据导入或重置正在进行，请稍后重试")
            previous = inherited
            if transaction_id is not None:
                contexts = dict(contexts)
                contexts[root] = transaction_id
                _TRANSFER_CONTEXT.transactions = contexts
            try:
                yield
            finally:
                if transaction_id is not None:
                    contexts = dict(getattr(_TRANSFER_CONTEXT, "transactions", {}))
                    if previous is None:
                        contexts.pop(root, None)
                    else:
                        contexts[root] = previous
                    _TRANSFER_CONTEXT.transactions = contexts

    def _read(self, collection: str) -> dict:
        path = self._path(collection)
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except UnicodeDecodeError as exc:
            raise JsonStoreCorruptionError(
                f"持久化文件不是有效 UTF-8: {path}"
            ) from exc
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise JsonStoreCorruptionError(
                f"持久化文件损坏，无法读取: {path}"
            ) from exc
        if not isinstance(data, dict):
            raise JsonStoreCorruptionError(
                f"持久化文件顶层必须是 JSON 对象: {path}"
            )
        return data

    def _write(self, collection: str, data: dict) -> None:
        path = self._path(collection)
        content = json.dumps(data, ensure_ascii=False, indent=2)
        self._write_path(path, content)

    # ---- API -----------------------------------------------------

    def get(self, collection: str, key: str, default: Any = None) -> Any:
        with self.transaction():
            with self._lock(collection):
                return self._read(collection).get(key, default)

    def set(self, collection: str, key: str, value: Any) -> None:
        with self.transaction():
            with self._lock(collection):
                data = self._read(collection)
                data[key] = value
                self._write(collection, data)

    def mutate(
        self,
        collection: str,
        key: str,
        transform: Callable[[Any], Any],
        default: Any = None,
    ) -> Any:
        """在单次文件锁内变换一个 key，并返回已提交的新值。

        回调只接收当前 key 的值（不存在时为 default），必须返回替换值；
        回调抛错时不写文件，也不得在回调内重入同一 collection。
        """
        with self.transaction():
            with self._lock(collection):
                data = self._read(collection)
                value = transform(data.get(key, default))
                data[key] = value
                self._write(collection, data)
                return value

    def mutate_document(
        self,
        collection: str,
        transform: Callable[[dict], dict],
    ) -> dict:
        """在单次文件锁内变换整个集合文档，并返回已提交的新文档。"""
        with self.transaction():
            with self._lock(collection):
                current = self._read(collection)
                value = transform(dict(current))
                if not isinstance(value, dict):
                    raise TypeError("集合变换必须返回 dict")
                self._write(collection, value)
                return value

    def update(self, collection: str, key: str, **fields: Any) -> None:
        with self.transaction():
            with self._lock(collection):
                data = self._read(collection)
                item = data.get(key, {})
                if not isinstance(item, dict):
                    item = {}
                item.update(fields)
                data[key] = item
                self._write(collection, data)

    def delete(self, collection: str, key: str) -> None:
        with self.transaction():
            with self._lock(collection):
                data = self._read(collection)
                data.pop(key, None)
                self._write(collection, data)

    def all(self, collection: str) -> dict:
        with self.transaction():
            with self._lock(collection):
                return self._read(collection)
