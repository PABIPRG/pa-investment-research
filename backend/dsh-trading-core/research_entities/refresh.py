# -*- coding: utf-8 -*-
"""主数据刷新：按新鲜度触发导入，并提供进程内定时调度。

刷新不会伪造数据：只重新执行已登记的数据源；失败会写入导入记录，
由新鲜度接口如实显示 ``failed``，上一份成功导入的数据保持不变。
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .errors import ResearchEntityError
from .freshness import source_freshness

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_HOURS = 6.0
LOCK_STALE_SECONDS = 3600.0
AKSHARE_SOURCE_ID = "akshare_security"


class RefreshLocked(ResearchEntityError):
    """另一个进程/线程正在刷新主数据。"""


@contextlib.contextmanager
def refresh_lock(path: Path | None, *, stale_after_seconds: float = LOCK_STALE_SECONDS):
    """基于独占文件的跨进程锁；崩溃遗留的锁超过阈值后自动接管。"""

    if path is None:
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    acquired = _try_acquire(path)
    if not acquired:
        try:
            age = time.time() - path.stat().st_mtime
        except OSError:
            age = stale_after_seconds + 1
        if age > stale_after_seconds:
            with contextlib.suppress(OSError):
                path.unlink()
            acquired = _try_acquire(path)
    if not acquired:
        raise RefreshLocked(f"主数据刷新已被占用：{path}")
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            path.unlink()


def _try_acquire(path: Path) -> bool:
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    except OSError:
        return False
    try:
        os.write(fd, str(os.getpid()).encode("ascii", errors="ignore"))
    finally:
        os.close(fd)
    return True


def default_lock_path(repository) -> Path | None:
    path = getattr(repository, "path", None)
    if path is None:
        return None
    return Path(path).with_suffix(".refresh.lock")


def _default_source_builder(*, include_akshare: bool | None):
    from .factory import build_sources

    return build_sources(include_universe=True, include_akshare=include_akshare)


class MasterDataRefresher:
    """按来源新鲜度决定是否导入；可被 CLI 与后台调度共用。"""

    def __init__(
        self,
        service,
        *,
        source_builder=None,
        lock_path: Path | None = None,
        max_age_hours: float | None = None,
        now=None,
    ) -> None:
        self.service = service
        self.source_builder = source_builder or _default_source_builder
        self.lock_path = (
            lock_path if lock_path is not None else default_lock_path(service.repository)
        )
        self.max_age_hours = max_age_hours
        self._now = now or (lambda: datetime.now(timezone.utc))

    def refresh(
        self,
        *,
        force: bool = False,
        with_akshare: bool | None = None,
    ) -> dict:
        before = source_freshness(
            self.service.repository,
            now=self._now(),
            max_age_hours=self.max_age_hours,
        )
        if with_akshare is None:
            env_flag = os.getenv("RESEARCH_ENTITIES_AKSHARE_SOURCE", "").strip().lower()
            if env_flag in ("0", "false", "no", "off"):
                # 显式关闭联网数据源时，定时刷新也不得偷偷联网。
                with_akshare = False
            else:
                # 只有历史上确实导入过 akshare 主数据时才继续联网刷新，
                # 避免离线环境因为一次手动导入而被动联网。
                with_akshare = any(
                    item["source_id"] == AKSHARE_SOURCE_ID
                    and item["last_success_at"] is not None
                    for item in before
                )
        sources = self.source_builder(include_akshare=with_akshare)
        by_id = {item["source_id"]: item for item in before}
        selected = []
        for source in sources:
            current = by_id.get(source.source_id)
            if force or current is None or current["needs_refresh"]:
                selected.append(source)

        if not selected:
            return {
                "ran": False,
                "reason": "所有主数据均在有效期内",
                "results": [],
                "sources": before,
            }

        try:
            with refresh_lock(self.lock_path):
                results = self.service.import_sources(selected)
        except RefreshLocked as exc:
            return {
                "ran": False,
                "reason": str(exc),
                "results": [],
                "sources": before,
            }

        after = source_freshness(
            self.service.repository,
            now=self._now(),
            max_age_hours=self.max_age_hours,
        )
        return {
            "ran": True,
            "reason": None,
            "results": [
                {
                    "source_id": item.source_id,
                    "source_version": item.source_version,
                    "imported": item.imported,
                    "warnings": list(item.warnings),
                }
                for item in results
            ],
            "sources": after,
        }


class RefreshScheduler:
    """后台线程：按固定间隔检查并刷新过期主数据。"""

    def __init__(
        self,
        refresher: MasterDataRefresher,
        *,
        interval_seconds: float,
        run_immediately: bool = True,
    ) -> None:
        self.refresher = refresher
        self.interval_seconds = max(60.0, float(interval_seconds))
        self.run_immediately = run_immediately
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="research-master-refresh", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        self._thread = None

    def run_once(self) -> dict:
        try:
            result = self.refresher.refresh()
        except Exception as exc:  # 调度线程不能因一次失败退出
            logger.warning("主数据刷新失败：%s: %s", type(exc).__name__, exc)
            return {"ran": False, "reason": f"刷新异常：{exc}", "results": [], "sources": []}
        if result.get("ran"):
            summary = ", ".join(
                f"{item['source_id']}={item['imported']}" for item in result["results"]
            )
            logger.info("主数据已刷新：%s", summary or "无来源")
        return result

    def _loop(self) -> None:
        if self.run_immediately:
            self.run_once()
        while not self._stop.wait(self.interval_seconds):
            self.run_once()


def refresh_interval_seconds() -> float:
    raw = os.getenv("RESEARCH_ENTITIES_REFRESH_INTERVAL_HOURS", "").strip()
    try:
        hours = float(raw) if raw else DEFAULT_INTERVAL_HOURS
    except ValueError:
        hours = DEFAULT_INTERVAL_HOURS
    return max(1.0, hours) * 3600.0
