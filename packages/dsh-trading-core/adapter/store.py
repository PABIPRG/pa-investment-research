# -*- coding: utf-8 -*-
"""本地 JSON 持久化（MongoDB 已禁用，持仓/自选/简报落本地文件）。

线程安全 + 原子写（写临时文件再 rename），并发读改写互斥。
collection 是 data/adapter/ 下的一个 JSON 文件，每文件一个 dict。
"""

import json
import threading
from pathlib import Path
from typing import Any


class JsonStore:
    def __init__(self, base_dir: Path | None = None):
        from .config import settings

        self.base_dir = base_dir or (settings.root / "data" / "adapter")
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}

    def _path(self, collection: str) -> Path:
        # 集合名只允许字母数字下划线，防路径穿越
        if not collection.replace("_", "").isalnum():
            raise ValueError(f"非法集合名: {collection}")
        return self.base_dir / f"{collection}.json"

    def _lock(self, collection: str) -> threading.Lock:
        lock = self._locks.get(collection)
        if lock is None:
            lock = threading.Lock()
            self._locks[collection] = lock
        return lock

    def _read(self, collection: str) -> dict:
        path = self._path(collection)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _write(self, collection: str, data: dict) -> None:
        path = self._path(collection)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        tmp.replace(path)  # 原子写

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
