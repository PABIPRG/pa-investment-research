# -*- coding: utf-8 -*-
"""本地单用户动态集合适配器（持仓 / 自选）。

只读取现有 adapter 数据目录；文件不存在或结构异常时返回 unknown，
不得推断用户持有某只证券，也不得虚构集合成员。
"""

from __future__ import annotations

from pathlib import Path

from ..models import EntityCollection
from ..normalizer import entity_id_for_security


class LocalCollectionProvider:
    def __init__(self, store=None, *, data_dir: Path | None = None) -> None:
        # 延迟导入，避免领域包在 import 阶段拉起 adapter 的配置加载。
        if store is None:
            if data_dir is not None:
                from adapter.store import JsonStore

                store = JsonStore(base_dir=Path(data_dir))
            else:
                from adapter.store import JsonStore

                store = JsonStore()
        self.store = store

    def get_collection(self, collection_type: str) -> EntityCollection | None:
        if collection_type == "USER_PORTFOLIO":
            collection, codes = self._read_holdings()
            return self._build("USER_PORTFOLIO", collection, codes)
        if collection_type == "USER_WATCHLIST":
            collection, codes = self._read_watchlist()
            return self._build("USER_WATCHLIST", collection, codes)
        return None

    def _file_exists(self, collection: str) -> bool:
        return (Path(self.store.base_dir) / f"{collection}.json").is_file()

    def _read_holdings(self) -> tuple[str, list[str]]:
        if not self._file_exists("holdings"):
            return "unknown", []
        try:
            items = self.store.get("holdings", "default", [])
        except Exception:
            return "unknown", []
        if not isinstance(items, list):
            return "unknown", []
        codes = sorted(
            {
                str(item.get("ticker", "")).strip()
                for item in items
                if isinstance(item, dict) and len(str(item.get("ticker", "")).strip()) == 6
            }
        )
        return "authorized", codes

    def _read_watchlist(self) -> tuple[str, list[str]]:
        if not self._file_exists("watchlist"):
            return "unknown", []
        try:
            items = self.store.get("watchlist", "default", [])
        except Exception:
            return "unknown", []
        if not isinstance(items, list):
            return "unknown", []
        codes = sorted(
            {
                str(item).strip()
                for item in items
                if len(str(item).strip()) == 6 and str(item).strip().isdigit()
            }
        )
        return "authorized", codes

    @staticmethod
    def _build(
        collection_type: str, authorization: str, codes: list[str]
    ) -> EntityCollection:
        return EntityCollection(
            collection_id=collection_type,
            collection_type=collection_type,
            source="adapter.store:local",
            as_of=None,
            member_entity_ids=[
                entity_id_for_security("ENTITY_01_01", code) for code in codes
            ],
            filter_definition={"kind": "local_user_data"},
            authorization_status=authorization,  # type: ignore[arg-type]
        )
