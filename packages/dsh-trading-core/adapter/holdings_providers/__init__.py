# -*- coding: utf-8 -*-
"""持仓数据源抽象（功能3b）。

选型结论见 docs/券商接入方案.md：
  - Manual    现用：手动结构化输入，落本地 store
  - JoinQuant 数据源：聚宽 jqdatasdk 只出行情数据，不出真实持仓，且需年费授权
  - QMT       真持仓接入（miniQMT/xtquant），有 10 万资产门槛，留 NotImplementedError

用法：
    provider = get_provider()
    holdings = provider.get_holdings()   # list[HoldingItem dict] 或抛 ProviderUnavailable
"""

from .base import HoldingsProvider, ProviderUnavailable, get_provider
from .joinquant import JoinQuantProvider
from .manual import ManualProvider
from .qmt import QMTProvider

__all__ = [
    "HoldingsProvider",
    "ProviderUnavailable",
    "ManualProvider",
    "JoinQuantProvider",
    "QMTProvider",
    "get_provider",
]
