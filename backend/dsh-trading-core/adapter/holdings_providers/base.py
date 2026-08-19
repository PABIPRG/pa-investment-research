# -*- coding: utf-8 -*-
"""HoldingsProvider 抽象基类与工厂。

持仓数据源可插拔，run 内部不关心数据从哪来：
  POST /holdings/analyze 请求体里带 holdings → 直接用（优先）
  不带 → provider.get_holdings() 读已配置数据源
"""

from abc import ABC, abstractmethod

from ..config import settings
from ..schemas import HoldingItem


class ProviderUnavailable(Exception):
    """数据源不可用（未授权/未安装/未登录），给上层明确的降级信号。"""


class HoldingsProvider(ABC):
    """持仓数据源接口。

    name:   人类可读名，用于日志/诊断
    is_available() 为 False 时 get_holdings() 必须抛 ProviderUnavailable
    """

    name: str = "abstract"

    @abstractmethod
    def is_available(self) -> bool:
        """数据源是否可用（依赖是否安装、凭证是否配置）。"""

    @abstractmethod
    def get_holdings(self) -> list[HoldingItem]:
        """返回当前持仓，空列表表示空仓。失败抛 ProviderUnavailable。"""


def get_provider() -> HoldingsProvider:
    """按 settings.holdings_provider 实例化数据源。"""
    name = settings.holdings_provider.lower()
    # 延迟 import，避免无关数据源的依赖（jqdatasdk/xtquant）污染启动
    if name == "manual":
        from .manual import ManualProvider

        return ManualProvider()
    if name == "joinquant":
        from .joinquant import JoinQuantProvider

        return JoinQuantProvider()
    if name == "qmt":
        from .qmt import QMTProvider

        return QMTProvider()
    raise ValueError(
        f"未知 HOLDINGS_PROVIDER: {settings.holdings_provider}"
        f"（可选: manual/joinquant/qmt）"
    )
