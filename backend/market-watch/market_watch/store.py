# -*- coding: utf-8 -*-
"""本地 JSON 持久化（线程安全 + 原子写）。

collection 是 data/ 下的一个 JSON 文件，每文件一个 dict。
base_dir 默认模块根 data/（不带 /adapter，避免与 trading-core 的 data/adapter 撞车）。
"""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from .config import settings


_FILE_LOCKS: dict[Path, threading.Lock] = {}
_FILE_LOCKS_GUARD = threading.Lock()


class JsonStoreCorruptionError(RuntimeError):
    """持久化文件存在但不是可读取的 JSON 对象。"""


class JsonStore:
    def __init__(self, base_dir: Path | None = None):
        self.base_dir = base_dir if base_dir is not None else settings.data_dir
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
        fd, temporary = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
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

    # ---- API -----------------------------------------------------

    def get(self, collection: str, key: str, default: Any = None) -> Any:
        with self._lock(collection):
            return self._read(collection).get(key, default)

    def set(self, collection: str, key: str, value: Any) -> None:
        with self._lock(collection):
            data = self._read(collection)
            data[key] = value
            self._write(collection, data)

    def update(self, collection: str, key: str, **fields: Any) -> None:
        with self._lock(collection):
            data = self._read(collection)
            item = data.get(key, {})
            if not isinstance(item, dict):
                item = {}
            item.update(fields)
            data[key] = item
            self._write(collection, data)

    def delete(self, collection: str, key: str) -> None:
        with self._lock(collection):
            data = self._read(collection)
            data.pop(key, None)
            self._write(collection, data)

    def all(self, collection: str) -> dict:
        with self._lock(collection):
            return self._read(collection)
