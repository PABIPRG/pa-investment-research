# -*- coding: utf-8 -*-
"""持仓数据源抽象（功能3b）。

选型结论见 docs/券商接入方案.md：
  - Manual      现用：手动结构化输入，落本地 store
  - EasyTrader  CLI 接入：easytrader + pywinauto 操控通达信/同花顺客户端，零券商门槛
  - QMT         SDK 接入：miniQMT/xtquant 官方 Python API，需券商开通（10万门槛）
  - JoinQuant   数据源：聚宽 jqdatasdk 只出行情数据，不出真实持仓，且需年费授权

用法：
    provider = get_provider()
    holdings = provider.get_holdings()   # list[HoldingItem dict] 或抛 ProviderUnavailable
"""

from .base import HoldingsProvider, ProviderUnavailable, get_provider
from .easytrader import EasyTraderProvider
from .joinquant import JoinQuantProvider
from .manual import ManualProvider
from .qmt import QMTProvider

__all__ = [
    "HoldingsProvider",
    "ProviderUnavailable",
    "ManualProvider",
    "EasyTraderProvider",
    "JoinQuantProvider",
    "QMTProvider",
    "get_provider",
]
