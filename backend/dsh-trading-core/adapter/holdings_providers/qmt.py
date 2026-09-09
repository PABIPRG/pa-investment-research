# -*- coding: utf-8 -*-
"""QMTProvider：真券商持仓接入（miniQMT / xtquant）。

原理：
  QMT（迅投）是券商提供的量化交易终端，miniQMT/xtquant 是其 Python 接口。
  xtquant 通过本地 IPC 连接 miniQMT 客户端进程，获取持仓/资金/委托等数据。

门槛：
  - 需在券商开通 QMT 权限（通常 10 万资产门槛，华鑫等门槛较低）
  - miniQMT 客户端需已登录运行
  - xtquant 通过 pip 安装

优势（vs easytrader）：
  - 官方 Python API，稳定可靠
  - 数据完整（持仓/资金/委托/成交）
  - 支持 60+ 家券商
  - 查询速度快（毫秒级 IPC，非 GUI 自动化）

配置（.env）：
  QMT_ACCOUNT_ID=                     # 券商资金账号
  QMT_SESSION_ID=888888               # xtquant 会话 ID（可自定义）

用法：
  HOLDINGS_PROVIDER=qmt
  provider = get_provider()
  holdings = provider.get_holdings()

字段映射（xtquant → HoldingItem）：
  stock_code  → ticker   （如 "600519.SH" → "600519"）
  volume      → quantity
  avg_price   → cost_price
"""

from __future__ import annotations

import logging
import re

from ..config import settings
from ..schemas import HoldingItem
from .base import HoldingsProvider, ProviderUnavailable

log = logging.getLogger(__name__)


def _qmt_code_to_ticker(stock_code: str) -> str | None:
    """将 QMT 证券代码规范化为6位纯数字。

    QMT 格式：'600519.SH'、'000001.SZ'、'300750.SZ' 等。
    HoldingItem 要求 pattern ^\\d{6}$。
    """
    if not stock_code:
        return None
    digits = re.sub(r"\D", "", stock_code)
    if len(digits) >= 6:
        return digits[:6]
    return None


class QMTProvider(HoldingsProvider):
    """QMT(xtquant) 持仓数据源：通过 miniQMT Python API 读取券商真实持仓。"""

    name = "qmt"

    def __init__(self) -> None:
        self._imported = False
        self._session = None
        try:
            import xtquant  # noqa: F401

            self._imported = True
        except ImportError:
            pass

    # ---- HoldingsProvider 接口 ----

    def is_available(self) -> bool:
        """数据源是否可用。

        需同时满足：
          1. xtquant 已安装
          2. QMT_ACCOUNT_ID 已配置
          3. miniQMT 进程在运行（best-effort 检测）
        """
        if not self._imported:
            return False
        if not settings.qmt_account_id:
            return False
        if not self._miniqmt_running():
            return False
        return True

    def get_holdings(self) -> list[HoldingItem]:
        """从 miniQMT 读取当前持仓。

        Returns:
            list[HoldingItem]: 当前非零持仓列表

        Raises:
            ProviderUnavailable: xtquant 未安装 / 账号未配置 / miniQMT 未运行
        """
        if not self._imported:
            raise ProviderUnavailable(
                "xtquant 未安装：pip install xtquant。"
                "详见 docs/券商接入方案.md §QMT。"
            )
        if not settings.qmt_account_id:
            raise ProviderUnavailable(
                "QMT_ACCOUNT_ID 未配置：需提供券商资金账号。"
                "详见 docs/券商接入方案.md §QMT。"
            )
        if not self._miniqmt_running():
            raise ProviderUnavailable(
                "miniQMT 客户端未运行：请先启动 miniQMT 并登录。"
            )

        try:
            from xtquant.xttype import StockAccount

            session = self._get_session()
            account = StockAccount(settings.qmt_account_id, "STOCK")
            raw_positions = session.query_stock_positions(account)
        except Exception as exc:
            log.error("QMT 连接/查询失败: %s", exc, exc_info=True)
            raise ProviderUnavailable(
                f"QMT(xtquant) 连接或查询持仓失败: {exc}。"
                f"请确认 miniQMT 已登录。"
            ) from exc

        # 字段映射 + 过滤零持仓
        items: list[HoldingItem] = []
        for pos in raw_positions:
            ticker = _qmt_code_to_ticker(pos.stock_code)
            if not ticker:
                continue
            quantity = float(pos.volume) if pos.volume else 0.0
            cost_price = float(pos.avg_price) if pos.avg_price else 0.0
            if quantity <= 0 or cost_price <= 0:
                continue
            items.append(HoldingItem(ticker=ticker, quantity=quantity, cost_price=cost_price))

        log.info("QMT 获取持仓 %d 条", len(items))
        return items

    def get_asset(self) -> dict:
        """获取账户资金信息（扩展接口，供投研分析使用）。

        Returns:
            dict: {total_asset, cash, market_value, frozen_cash, ...}
        """
        if not self.is_available():
            raise ProviderUnavailable("QMT 不可用，无法查询资金。")
        try:
            from xtquant.xttype import StockAccount

            session = self._get_session()
            account = StockAccount(settings.qmt_account_id, "STOCK")
            asset = session.query_stock_asset(account)
            return {
                "total_asset": float(asset.total_asset) if asset.total_asset else 0.0,
                "cash": float(asset.cash) if asset.cash else 0.0,
                "market_value": float(asset.market_value) if asset.market_value else 0.0,
                "frozen_cash": float(asset.frozen_cash) if asset.frozen_cash else 0.0,
            }
        except Exception as exc:
            log.error("QMT 资金查询失败: %s", exc, exc_info=True)
            raise ProviderUnavailable(f"QMT 资金查询失败: {exc}") from exc

    # ---- 内部方法 ----

    def _get_session(self):
        """获取/缓存 XtQuantTrader 会话（懒初始化）。"""
        if self._session is not None:
            return self._session

        from xtquant.xttrader import XtQuantTrader

        session_id = settings.qmt_session_id
        session = XtQuantTrader(session_id=session_id)
        session.start()
        # miniQMT 登录后自动连接，无需显式 connect
        self._session = session
        return session

    @staticmethod
    def _miniqmt_running() -> bool:
        """Best-effort 检测 miniQMT 进程是否在运行。"""
        try:
            import subprocess

            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq xtitrade.exe"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if "xtitrade.exe" in result.stdout.lower():
                return True
            # 部分 miniQMT 版本进程名不同，再试 QMT
            result2 = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq QMT.exe"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return "qmt.exe" in result2.stdout.lower()
        except Exception:
            # 检测失败时乐观返回 True，让连接阶段报更精确的错误
            return True
