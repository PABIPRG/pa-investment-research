# -*- coding: utf-8 -*-
"""研究委托核心的组合根：只在这里决定默认存储位置。"""

from __future__ import annotations

import os
from pathlib import Path

from .adapters import SqliteBusinessStore
from .service import MandateService


def default_store_path() -> Path:
    explicit = os.getenv("RESEARCH_PARTNER_SQLITE_PATH", "").strip()
    if explicit:
        return Path(explicit)
    try:
        from adapter.config import settings

        data_dir = Path(settings.data_dir)
    except Exception:
        data_dir = Path(__file__).resolve().parent.parent / "data"
    return data_dir / "research_partner.sqlite3"


def build_store(path: str | Path | None = None) -> SqliteBusinessStore:
    return SqliteBusinessStore(path or default_store_path())


def build_service(
    path: str | Path | None = None, *, now=None, calendar=None
) -> tuple[SqliteBusinessStore, MandateService]:
    store = build_store(path)
    return store, MandateService(store, now=now, calendar=calendar)


def build_evolution_port(*, url=None, timeout: float = 5.0):
    """自进化只读端口；地址由 ``STRATEGY_EVOLUTION_URL`` 决定，默认 :8000。"""

    from adapter.evolution_client import HttpStrategyEvolutionClient

    return HttpStrategyEvolutionClient(url, timeout=timeout)


def build_runner(store, *, now=None, evolution_port=None, fallback=None):
    """默认研究执行器：策略事件走自进化能力，其余事件保持原 stub 行为。

    研究核心可以独立部署（trading-core 不在同一安装目录）——此时拿不到
    HTTP 客户端，就退回原执行器，不伪造自进化结果。
    """

    from .worker import StubResearchRunner

    fallback = fallback or StubResearchRunner(now=now)
    try:
        port = evolution_port or build_evolution_port()
        from .evolution_runner import StrategyEvolutionRunner
    except Exception:  # noqa: BLE001 — 能力装配失败时保持既有执行链
        return fallback
    return StrategyEvolutionRunner(
        store, port, fallback=fallback, now=now
    )
