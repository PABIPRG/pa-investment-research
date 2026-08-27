# -*- coding: utf-8 -*-
"""产业链种子数据状态与显式首次下载。

模块导入和状态查询都不会联网。只有 ``SeedDataManager.bootstrap`` 会从配置的
固定数据源下载完整五文件数据集；下载先落同文件系统的临时目录，全部通过大小、
JSON 与最低结构校验后再发布，避免查询层看到半成品。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Callable, Literal, TypedDict

import requests


SEED_FILES = (
    "stats.json",
    "companies.json",
    "market-caps.json",
    "view-data-all.json",
    "network-data.json",
)
FILES_TOTAL = len(SEED_FILES)
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 64 * 1024
DOWNLOAD_TIMEOUT = (5, 60)

DataState = Literal["missing", "downloading", "ready", "error"]


class DataStatus(TypedDict):
    status: DataState
    files_completed: int
    files_total: int
    downloaded_bytes: int
    current_file: str | None
    error: str | None


class SeedDataError(RuntimeError):
    """可安全展示给本地产品界面的种子数据错误。"""


def _is_non_empty_dict(value: object) -> bool:
    return isinstance(value, dict) and bool(value)


def _validate_structure(name: str, value: object) -> None:
    valid = False
    if name == "stats.json":
        valid = _is_non_empty_dict(value)
    elif name == "companies.json":
        valid = (
            isinstance(value, list)
            and bool(value)
            and any(
                isinstance(item, dict)
                and isinstance(item.get("code"), str)
                and isinstance(item.get("name"), str)
                for item in value
            )
        )
    elif name == "market-caps.json":
        valid = (
            _is_non_empty_dict(value)
            and any(
                isinstance(item, dict) and isinstance(item.get("code"), str)
                for item in value.values()
            )
        )
    elif name == "view-data-all.json":
        valid = (
            isinstance(value, dict)
            and _is_non_empty_dict(value.get("companies"))
        )
    elif name == "network-data.json":
        valid = (
            isinstance(value, dict)
            and isinstance(value.get("nodes"), list)
            and bool(value.get("nodes"))
            and isinstance(value.get("links"), list)
        )
    if not valid:
        raise SeedDataError(f"{name} 数据结构不完整")


def _validate_file(path: Path, name: str) -> int:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise SeedDataError(f"{name} 不可读取") from exc
    if size <= 0:
        raise SeedDataError(f"{name} 为空文件")
    if size > MAX_FILE_BYTES:
        raise SeedDataError(f"{name} 超过允许的大小上限")
    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SeedDataError(f"{name} 不是有效的 JSON 数据") from exc
    _validate_structure(name, value)
    return size


def _validate_dataset(data_dir: Path) -> int:
    total = 0
    for name in SEED_FILES:
        path = data_dir / name
        if not path.is_file():
            raise FileNotFoundError(name)
        total += _validate_file(path, name)
        if total > MAX_TOTAL_BYTES:
            raise SeedDataError("种子数据总大小超过允许的上限")
    return total


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


class SeedDataManager:
    """维护进程内下载状态，并让并发请求复用同一次下载。"""

    def __init__(
        self,
        data_dir: Path,
        base_url: str,
        *,
        http_get: Callable[..., object] = requests.get,
    ) -> None:
        self._data_dir = Path(data_dir)
        self._base_url = base_url.rstrip("/")
        self._http_get = http_get
        self._condition = threading.Condition()
        self._initialized = False
        self._disk_signature: tuple[tuple[str, int, int], ...] | None = None
        self._status: DataState = "missing"
        self._files_completed = 0
        self._downloaded_bytes = 0
        self._current_file: str | None = None
        self._error: str | None = None

    def _snapshot_locked(self) -> DataStatus:
        return {
            "status": self._status,
            "files_completed": self._files_completed,
            "files_total": FILES_TOTAL,
            "downloaded_bytes": self._downloaded_bytes,
            "current_file": self._current_file,
            "error": self._error,
        }

    def _dataset_signature(self) -> tuple[tuple[str, int, int], ...] | None:
        signature: list[tuple[str, int, int]] = []
        for name in SEED_FILES:
            path = self._data_dir / name
            try:
                stat = path.stat()
            except OSError:
                return None
            if not path.is_file():
                return None
            signature.append((name, stat.st_size, stat.st_mtime_ns))
        return tuple(signature)

    def _inspect_locked(self) -> None:
        if self._status == "downloading":
            return
        signature = self._dataset_signature()
        if self._initialized and signature == self._disk_signature:
            return
        self._initialized = True
        self._disk_signature = signature
        self._files_completed = 0
        self._downloaded_bytes = 0
        self._current_file = None
        self._error = None
        if signature is None:
            self._status = "missing"
            return
        try:
            self._downloaded_bytes = _validate_dataset(self._data_dir)
        except (FileNotFoundError, SeedDataError) as exc:
            self._status = "error"
            self._error = str(exc)
            return
        self._status = "ready"
        self._files_completed = FILES_TOTAL

    def status(self) -> DataStatus:
        """返回本地状态；首次调用仅校验磁盘数据，不联网。"""
        with self._condition:
            self._inspect_locked()
            return self._snapshot_locked()

    def _update_progress(self, *, name: str | None = None, byte_count: int = 0, completed: bool = False) -> None:
        with self._condition:
            if name is not None:
                self._current_file = name
            self._downloaded_bytes += byte_count
            if completed:
                self._files_completed += 1

    def _download_file(self, staging: Path, name: str) -> None:
        self._update_progress(name=name)
        part = staging / f"{name}.part"
        url = f"{self._base_url}/{name}"
        try:
            with self._http_get(url, timeout=DOWNLOAD_TIMEOUT, stream=True) as response:
                response.raise_for_status()
                raw_length = response.headers.get("Content-Length")
                if raw_length is not None:
                    try:
                        declared_length = int(raw_length)
                    except ValueError as exc:
                        raise SeedDataError(f"{name} 返回了无效的文件大小") from exc
                    if declared_length <= 0 or declared_length > MAX_FILE_BYTES:
                        raise SeedDataError(f"{name} 超过允许的大小上限")
                file_bytes = 0
                with part.open("wb") as handle:
                    for chunk in response.iter_content(DOWNLOAD_CHUNK_BYTES):
                        if not chunk:
                            continue
                        file_bytes += len(chunk)
                        if file_bytes > MAX_FILE_BYTES:
                            raise SeedDataError(f"{name} 超过允许的大小上限")
                        with self._condition:
                            if self._downloaded_bytes + len(chunk) > MAX_TOTAL_BYTES:
                                raise SeedDataError("种子数据总大小超过允许的上限")
                        handle.write(chunk)
                        self._update_progress(byte_count=len(chunk))
                    handle.flush()
                    os.fsync(handle.fileno())
        except SeedDataError:
            raise
        except Exception as exc:
            raise SeedDataError(f"{name} 下载失败，请检查网络后重试") from exc
        _validate_file(part, name)
        os.replace(part, staging / name)
        self._update_progress(completed=True)

    def _publish(self, staging: Path) -> None:
        target = self._data_dir
        if target.is_symlink():
            raise SeedDataError("种子数据目录不能是符号链接")
        backup = target.parent / f".{target.name}-previous-{uuid.uuid4().hex}"
        moved_existing = False
        if target.exists():
            os.replace(target, backup)
            moved_existing = True
        try:
            os.replace(staging, target)
        except Exception:
            if moved_existing:
                if target.exists() or target.is_symlink():
                    _remove_path(target)
                os.replace(backup, target)
            raise
        if moved_existing:
            try:
                _remove_path(backup)
            except OSError:
                pass

    def _download_and_publish(self) -> None:
        if not self._base_url:
            raise SeedDataError("种子数据下载源未配置")
        parent = self._data_dir.parent
        parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{self._data_dir.name}-download-", dir=parent))
        try:
            for name in SEED_FILES:
                self._download_file(staging, name)
            _validate_dataset(staging)
            self._publish(staging)
        finally:
            if staging.exists() or staging.is_symlink():
                _remove_path(staging)

    def bootstrap(self) -> DataStatus:
        """显式下载完整数据集；并发调用等待并复用当前任务。"""
        with self._condition:
            self._inspect_locked()
            if self._status == "ready":
                return self._snapshot_locked()
            if self._status == "downloading":
                self._condition.wait_for(lambda: self._status != "downloading")
                return self._snapshot_locked()
            self._status = "downloading"
            self._files_completed = 0
            self._downloaded_bytes = 0
            self._current_file = None
            self._error = None

        try:
            self._download_and_publish()
        except Exception as exc:
            detail = str(exc) if isinstance(exc, SeedDataError) else "种子数据保存失败，请重试"
            with self._condition:
                self._status = "error"
                self._files_completed = 0
                self._current_file = None
                self._error = detail[:300]
                self._condition.notify_all()
                return self._snapshot_locked()

        with self._condition:
            self._status = "ready"
            self._files_completed = FILES_TOTAL
            self._current_file = None
            self._error = None
            self._disk_signature = self._dataset_signature()
            self._condition.notify_all()
            return self._snapshot_locked()
