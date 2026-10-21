# -*- coding: utf-8 -*-
"""组合根：读取配置，装配仓储、数据源与集合提供者。

这里是唯一知道“当前用 SQLite、词典来自哪个 JSON”的地方；
上层只拿到 ``ResearchEntityService`` 和端口协议。
"""

from __future__ import annotations

import os
from pathlib import Path

from .adapters.collections_local import LocalCollectionProvider
from .adapters.sources.gazetteer_json import GazetteerJsonSource
from .adapters.sources.universe_json import UniverseJsonSource
from .adapters.storage_memory import InMemoryEntityRepository
from .adapters.storage_sqlite import SqliteEntityRepository
from .errors import StorageUnavailable
from .service import ResearchEntityService


def default_sqlite_path() -> Path:
    try:
        from adapter.config import settings

        data_dir = Path(settings.data_dir)
    except Exception:
        data_dir = Path(__file__).resolve().parent.parent / "data"
    return Path(os.getenv("RESEARCH_ENTITIES_SQLITE_PATH", data_dir / "research_entities.sqlite3"))


def default_universe_path() -> Path:
    explicit = os.getenv("RESEARCH_ENTITIES_UNIVERSE_PATH", "").strip()
    if explicit:
        return Path(explicit)
    backend_root = Path(__file__).resolve().parent.parent.parent
    return backend_root / "industry-chain" / "data" / "a_share_universe.json"


def default_gazetteer_path() -> Path:
    return (
        Path(os.getenv("RESEARCH_ENTITIES_GAZETTEER_PATH", ""))
        if os.getenv("RESEARCH_ENTITIES_GAZETTEER_PATH", "").strip()
        else Path(__file__).resolve().parent / "resources" / "gazetteers.json"
    )


def build_repository(storage: str | None = None):
    kind = (storage or os.getenv("RESEARCH_ENTITIES_STORAGE", "sqlite")).strip().lower()
    if kind == "memory":
        return InMemoryEntityRepository()
    if kind == "sqlite":
        return SqliteEntityRepository(default_sqlite_path())
    if kind == "postgres":
        raise StorageUnavailable(
            "PostgreSQL 适配器尚未实现；当前可用 RESEARCH_ENTITIES_STORAGE=sqlite|memory。"
        )
    raise StorageUnavailable(f"未知的 RESEARCH_ENTITIES_STORAGE: {kind!r}")


def build_collection_provider(enabled: bool | None = None) -> LocalCollectionProvider | None:
    if enabled is None:
        enabled = os.getenv("RESEARCH_ENTITIES_LOCAL_COLLECTIONS", "true").lower() != "false"
    return LocalCollectionProvider() if enabled else None


def build_sources(
    *,
    include_universe: bool = True,
    include_akshare: bool | None = None,
) -> list:
    """构建导入数据源。

    akshare 主数据需要联网，默认关闭；显式传参或设置
    ``RESEARCH_ENTITIES_AKSHARE_SOURCE=true`` 才启用，避免离线/测试
    环境在导入时被动发起外网请求。
    """

    sources: list = [GazetteerJsonSource(default_gazetteer_path())]
    if include_universe:
        sources.append(UniverseJsonSource(default_universe_path()))
    if include_akshare is None:
        include_akshare = (
            os.getenv("RESEARCH_ENTITIES_AKSHARE_SOURCE", "false").strip().lower()
            == "true"
        )
    if include_akshare:
        from .adapters.sources.akshare import AkshareSecuritySource
        from .adapters.sources.exchange_profile import ExchangeProfileSource
        from .toolbox.context import install_curl_ca_bundle, install_no_proxy

        # 导入不在工具进程内执行，但同样会走 akshare/curl_cffi：
        # 定时刷新与 CLI 导入都必须绕过系统代理并处理非 ASCII 证书路径。
        install_no_proxy()
        install_curl_ca_bundle()
        sources.append(AkshareSecuritySource())
        # 交易所名录含部分公司法定名称（上交所/北交所），免费且只需 4 次请求。
        sources.append(ExchangeProfileSource())
    return sources


def build_service(
    *,
    storage: str | None = None,
    with_collections: bool | None = None,
    gazetteer_path: Path | None = None,
) -> ResearchEntityService:
    from .extractor import Gazetteer

    repository = build_repository(storage)
    return ResearchEntityService(
        repository,
        collection_provider=build_collection_provider(with_collections),
        gazetteer=Gazetteer(gazetteer_path or default_gazetteer_path()),
    )


def refresh_enabled(repository) -> bool:
    """是否启用后台主数据刷新。

    默认只在持久化 SQLite 仓储上启用（内存仓储刷新没有意义，且测试
    会反复创建）；可用 ``RESEARCH_ENTITIES_REFRESH_ENABLED`` 显式开关。
    """

    raw = os.getenv("RESEARCH_ENTITIES_REFRESH_ENABLED", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return isinstance(repository, SqliteEntityRepository)


def build_refresher(*, service=None, storage: str | None = None, max_age_hours=None):
    from .refresh import MasterDataRefresher

    service = service or build_service(storage=storage)
    return MasterDataRefresher(service, max_age_hours=max_age_hours)


def build_tool_executor(
    *,
    storage: str | None = None,
    with_collections: bool | None = None,
    context=None,
):
    """构建工具执行器；与 Scope 解析共用同一个仓储/集合适配器。"""

    from .toolbox import ToolContext, ToolExecutor

    repository = build_repository(storage)
    provider = build_collection_provider(with_collections)
    tool_context = context or ToolContext(repository, provider)
    return ToolExecutor(tool_context)
