# -*- coding: utf-8 -*-
"""常驻服务形态：单一权威实例锁。

委托核心只能有一个实例写同一个业务库。锁文件记录持有者 PID 与启动时间；
进程崩溃留下的锁在 PID 已不存在时视为过期，可被新实例接管。锁不阻止只读
排查，但任何写入路径都应先通过 ``acquire``。

Electron 前台关闭不影响本服务；部署方式（Windows 计划任务/服务、容器、
systemd）只负责拉起进程，权威性由这把锁与单一数据目录共同保证。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOCK_NAME = "research_partner.lock"


class InstanceLockError(RuntimeError):
    """已有存活实例持有同一业务库。"""


def default_lock_path() -> Path:
    from .factory import default_store_path

    return default_store_path().parent / LOCK_NAME


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # 进程存在但属于其他用户；保守视为存活。
        return True
    except OSError:
        return False
    return True


def _read(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


class InstanceLock:
    """进程级单实例锁；``acquire`` 失败表示应退出而不是继续写数据。"""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else default_lock_path()
        self.held = False

    def status(self) -> dict[str, Any]:
        record = _read(self.path)
        if record is None:
            return {"held": False, "stale": self.path.exists()}
        pid = record.get("pid")
        alive = isinstance(pid, int) and _pid_alive(pid)
        return {
            "held": alive,
            "stale": not alive,
            "pid": pid,
            "startedAt": record.get("startedAt"),
            "host": record.get("host"),
        }

    def acquire(self) -> dict[str, Any]:
        if self.held:
            return self._record()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _attempt in range(2):
            record = self._record()
            try:
                descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                current = _read(self.path)
                if current is None:
                    # 损坏的锁没有可信持有者，按过期处理。
                    self._unlink()
                    continue
                pid = current.get("pid")
                if isinstance(pid, int) and _pid_alive(pid):
                    raise InstanceLockError(
                        f"已有实例在运行（pid={pid}），本进程不应写同一业务库"
                    )
                self._unlink()
                continue
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            self.held = True
            return record
        raise InstanceLockError("无法取得实例锁，请检查锁文件权限")

    def release(self) -> None:
        if not self.held:
            return
        current = _read(self.path)
        if current is not None and current.get("pid") == os.getpid():
            self._unlink()
        self.held = False

    def _record(self) -> dict[str, Any]:
        host = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or ""
        if not host and hasattr(os, "uname"):
            host = os.uname().nodename
        return {
            "pid": os.getpid(),
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "host": host,
        }

    def _unlink(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()
