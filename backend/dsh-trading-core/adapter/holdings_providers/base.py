# -*- coding: utf-8 -*-
"""HoldingsProvider 抽象基类与工厂。

持仓数据源可插拔，run 内部不关心数据从哪来：
  POST /holdings/analyze 请求体里带 holdings → 直接用（优先）
  不带 → provider.get_holdings() 读已配置数据源
"""

from abc import ABC, abstractmethod

from ..config import settings
from ..schemas import HoldingItem, TradeItem


class ProviderUnavailable(Exception):
    """数据源不可用（未授权/未安装/未登录），给上层明确的降级信号。"""

    def __init__(self, message: str, code: str = "read_failed"):
        super().__init__(message)
        self.code = code


ACCOUNT_MODES = ("real", "simulated")


def current_account_mode() -> str:
    """返回规范化的操盘账户类型；拒绝把未知值悄悄当成实盘。"""
    mode = str(getattr(settings, "holdings_account_mode", "simulated") or "simulated").strip().lower()
    if mode not in ACCOUNT_MODES:
        raise ProviderUnavailable(
            f"未知 HOLDINGS_ACCOUNT_MODE: {mode}（可选: real/simulated）。"
        )
    return mode


class HoldingsProvider(ABC):
    """持仓数据源接口。

    name:   人类可读名，用于日志/诊断
    is_available() 为 False 时 get_holdings() 必须抛 ProviderUnavailable

    成交明细是可选能力：只有客户端读表的两个数据源覆写 read_trades，
    其余数据源沿用基类的拒绝实现。因此这两个方法是带默认实现的普通方法，
    不是抽象方法——否则 manual/joinquant/qmt 三个子类会被一起改坏。
    """

    name: str = "abstract"

    @abstractmethod
    def is_available(self) -> bool:
        """数据源是否可用（依赖是否安装、凭证是否配置）。"""

    @abstractmethod
    def get_holdings(self) -> list[HoldingItem]:
        """返回当前持仓，空列表表示空仓。失败抛 ProviderUnavailable。"""

    def get_trades(self) -> list[TradeItem]:
        """返回能读到的成交明细，空列表表示没有成交。

        与 get_holdings 对称：普通调用只允许被动读取，绝不自动激活客户端窗口。
        """
        return self.read_trades()

    def read_trades(self, *, foreground: bool = False) -> list[TradeItem]:
        """读取成交明细。

        foreground 与 read_holdings 对齐：False 时只允许被动读取；需要前台才能取数时
        抛 code="navigation_required"，由调用方决定是否走获准的原生入口。

        Raises:
            ProviderUnavailable: 数据源不支持成交明细（code="unsupported_action"）。
        """
        raise ProviderUnavailable(
            "此数据源不支持成交明细。", "unsupported_action"
        )


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
    if name == "easytrader":
        from .easytrader import EasyTraderProvider

        return EasyTraderProvider()
    if name == "mac_ths":
        from .mac_ths import MacThsProvider

        return MacThsProvider()
    raise ValueError(
        f"未知 HOLDINGS_PROVIDER: {settings.holdings_provider}"
        f"（可选: manual/easytrader/mac_ths/qmt/joinquant）"
    )
