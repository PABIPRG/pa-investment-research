# -*- coding: utf-8 -*-
"""ManualProvider：手动结构化持仓（代码 + 股数 + 成本价），落本地 JsonStore。

当前默认数据源。用户通过 dsh 对话或 POST /holdings/save 维护，
store 的 collection='holdings' key='default' 存 list[HoldingItem dict]。
"""

from ..schemas import HoldingItem
from ..store import JsonStore
from .base import HoldingsProvider, ProviderUnavailable


class ManualProvider(HoldingsProvider):
    name = "manual"

    def __init__(self, store: JsonStore | None = None):
        self.store = store or JsonStore()

    def is_available(self) -> bool:
        # 手动数据源始终可用；空持仓是合法状态（返回空列表而非抛错）
        return True

    def get_holdings(self) -> list[HoldingItem]:
        raw = self.store.get("holdings", "default", []) or []
        return [HoldingItem(**item) for item in raw]

    def save(self, items: list[HoldingItem]) -> int:
        """整体替换持仓。返回保存条数。"""
        self.store.set("holdings", "default", [i.model_dump() for i in items])
        return len(items)
