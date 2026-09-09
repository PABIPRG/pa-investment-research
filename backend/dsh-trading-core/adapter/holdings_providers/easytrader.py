# -*- coding: utf-8 -*-
"""EasyTraderProvider：通过 easytrader 操控券商客户端获取持仓（CLI/GUI 自动化）。

原理：
  easytrader 是开源 Python 库，底层用 pywinauto 操控通达信/同花顺客户端窗口，
  通过 GUI 自动化读取持仓、资金、委托等信息。

优势（vs QMT）：
  - 零券商门槛：不需要开通 QMT 权限，只要有通达信/同花顺客户端即可
  - 内核生态覆盖广：同花顺内核覆盖 80+ 贴牌券商（平安/国金/银河…），
    通达信内核覆盖 60+ 家，见 broker_profiles.py 注册表

局限：
  - 仅 Windows（依赖 pywinauto）
  - 客户端窗口需保持打开且已登录
  - UI 自动化受客户端版本更新影响，控件定位可能失效
  - 查询速度较慢（秒级，需操作 GUI）

配置（.env，二选一）：
  # 方式 A：按券商档案选（推荐，配合 holdings_cli.py detect 自动发现）
  EASYTRADER_BROKER=pingan           # broker_profiles.py 里的 broker_id
  EASYTRADER_CLIENT_PATH=C:\\平安证券\\同花顺版\\xiadan.exe
  # 方式 B：按内核选（不区分具体券商）
  EASYTRADER_CLIENT_TYPE=thstrader   # thstrader(同花顺) | tdxtrader(通达信)
  EASYTRADER_CLIENT_PATH=C:\\同花顺\\xiadan.exe

用法：
  HOLDINGS_PROVIDER=easytrader
  provider = get_provider()
  holdings = provider.get_holdings()
"""

from __future__ import annotations

import logging
import re

from ..config import settings
from ..schemas import HoldingItem
from .base import HoldingsProvider, ProviderUnavailable
from .broker_profiles import GENERIC_THS, BrokerProfile, resolve_profile

log = logging.getLogger(__name__)

# easytrader position 返回的 dict 字段名 → HoldingItem 字段
# 同花顺/通达信内核字段名在此取并集，运行时按实际返回适配
_FIELD_MAP: dict[str, list[str]] = {
    "ticker": ["证券代码", "stock_code"],
    "quantity": ["股票余额", "持仓数量", "volume"],
    # THS 同花顺持仓页成本列实际叫「参考成本价」，通达信/各券商版本有叫「成本价」的
    "cost_price": ["成本价", "参考成本价", "avg_price"],
}


def _extract(pos: dict, target: str) -> float | str | None:
    """从 easytrader position dict 中按候选字段名提取值。"""
    candidates = _FIELD_MAP.get(target, [target])
    for key in candidates:
        val = pos.get(key)
        if val is not None:
            return val
    return None


def _normalize_ticker(raw: str | None) -> str | None:
    """将证券代码规范化为6位纯数字（HoldingItem 要求 pattern ^\\d{6}$）。

    easytrader 可能返回 '000001' 或 '000001.SZ' 等格式。
    """
    if not raw:
        return None
    # 取前6位数字
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) >= 6:
        return digits[:6]
    return None


class EasyTraderProvider(HoldingsProvider):
    """easytrader 持仓数据源：通过 GUI 自动化读取券商客户端持仓。"""

    name = "easytrader"

    def __init__(self) -> None:
        self._imported = False
        self._trader = None
        self.profile: BrokerProfile | None = None
        self._profile_error: str | None = None
        try:
            import easytrader  # noqa: F401

            self._imported = True
        except ImportError:
            pass
        self._resolve_profile()

    def _resolve_profile(self) -> None:
        """解析券商档案：EASYTRADER_BROKER 优先，缺省按内核通用档。"""
        broker_id = (getattr(settings, "easytrader_broker", "") or "").strip()
        if broker_id:
            profile = resolve_profile(broker_id)
            if profile is None:
                self._profile_error = (
                    f"未知 EASYTRADER_BROKER: {broker_id}。"
                    f"运行 holdings_cli.py detect --list 查看支持的券商档案。"
                )
                return
            self.profile = profile
            return
        # 未指定券商：按内核选通用档
        client_type = settings.easytrader_client_type.lower()
        if client_type in ("ths", "thstrader", "thstrader ", "universal_client"):
            self.profile = GENERIC_THS
        elif client_type in ("tdx", "tdxtrader"):
            self._profile_error = (
                "easytrader 0.23.x 已移除通达信客户端交易器：通达信内核用户请安装"
                "对应券商的同花顺版客户端，或使用 QMT(xtquant) 通道。"
            )
        else:
            self._profile_error = (
                f"不支持的 EASYTRADER_CLIENT_TYPE: {client_type}，"
                f"可选: thstrader(同花顺内核)；详见 docs/券商接入方案.md。"
            )

    # ---- HoldingsProvider 接口 ----

    def is_available(self) -> bool:
        """数据源是否可用。

        需同时满足：
          1. easytrader 已安装
          2. 券商档案解析成功（EASYTRADER_BROKER 合法或内核类型合法）
          3. 客户端路径已配置
          4. 客户端进程正在运行（best-effort 检测）
        """
        if not self._imported:
            return False
        if self.profile is None:
            return False
        if not settings.easytrader_client_path:
            return False
        # 客户端进程检测（best-effort，不阻塞）
        if not self._client_running():
            return False
        return True

    def get_holdings(self) -> list[HoldingItem]:
        """从券商客户端读取当前持仓。

        Returns:
            list[HoldingItem]: 当前非零持仓列表

        Raises:
            ProviderUnavailable: easytrader 未安装 / 客户端未运行 / 连接失败
        """
        label = self.profile.label if self.profile else "券商客户端"
        if not self._imported:
            raise ProviderUnavailable(
                "easytrader 未安装：pip install easytrader pywinauto。"
                "详见 docs/券商接入方案.md §easytrader。"
            )
        if self.profile is None:
            raise ProviderUnavailable(self._profile_error or "券商档案解析失败。")
        if not settings.easytrader_client_path:
            raise ProviderUnavailable(
                "EASYTRADER_CLIENT_PATH 未配置：需指定券商客户端的下单程序路径。"
                f"可运行 holdings_cli.py detect 自动发现本机已装的客户端（当前档案: {label}）。"
                "详见 docs/券商接入方案.md §easytrader。"
            )
        if not self._client_running():
            raise ProviderUnavailable(
                f"券商客户端未运行：请先启动并登录 {label} "
                f"（{settings.easytrader_client_path}）。窗口需保持打开。"
            )

        # 连接客户端并查询持仓
        try:
            trader = self._connect()
            raw_positions: list[dict] = trader.position  # type: ignore[attr-defined]
        except Exception as exc:
            log.error("easytrader 连接/查询失败: %s", exc, exc_info=True)
            raise ProviderUnavailable(
                f"easytrader 连接或查询持仓失败: {exc}。"
                f"请确认 {label} 已登录且窗口未被遮挡。"
            ) from exc

        # 字段映射 + 过滤零持仓
        items: list[HoldingItem] = []
        for pos in raw_positions:
            ticker = _normalize_ticker(_extract(pos, "ticker"))
            if not ticker:
                continue
            quantity_raw = _extract(pos, "quantity")
            cost_price_raw = _extract(pos, "cost_price")
            try:
                quantity = float(quantity_raw) if quantity_raw else 0.0
                cost_price = float(cost_price_raw) if cost_price_raw else 0.0
            except (ValueError, TypeError):
                log.warning("easytrader 持仓字段转换失败，跳过: %s", pos)
                continue
            if quantity <= 0 or cost_price <= 0:
                continue
            items.append(HoldingItem(ticker=ticker, quantity=quantity, cost_price=cost_price))

        log.info("easytrader(%s) 获取持仓 %d 条", self.profile.broker_id, len(items))
        return items

    # ---- 内部方法 ----

    def _connect(self):
        """连接券商客户端，返回 easytrader 实例（懒初始化 + 缓存）。"""
        if self._trader is not None:
            return self._trader

        import easytrader

        assert self.profile is not None
        trader = easytrader.use(self.profile.trader_type)
        trader.connect(settings.easytrader_client_path)
        self._fix_main_window(trader)
        self._trader = trader
        return trader

    @staticmethod
    def _fix_main_window(trader) -> None:
        """修正 easytrader 的主窗口选择。

        同花顺内核客户端进程里带有隐藏的 IE 内嵌窗口，easytrader 默认取
        top_window() 时可能选中它而非真正的交易窗口，导致菜单树定位失败。
        这里按 THS 标准交易窗口标题（网上股票交易系统）在已连接进程内
        重新锁定可见主窗口；找不到时保持默认行为。
        """
        try:
            for w in trader._app.windows(enabled_only=True, visible_only=True):
                if "网上股票交易系统" in (w.window_text() or ""):
                    # easytrader 内部把 _main 当 WindowSpecification 用，
                    # 这里按句柄重新生成规格而非直接赋 wrapper
                    trader._main = trader._app.window(handle=w.handle)
                    return
        except Exception:
            pass

    def _client_running(self) -> bool:
        """Best-effort 检测券商客户端进程是否在运行（按档案进程名）。"""
        if self.profile is None:
            return False
        try:
            import subprocess

            targets = [t for t in self.profile.processes if t]
            if not targets:
                # 无法检测，乐观返回 True
                return True
            result = subprocess.run(
                ["tasklist", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            running = result.stdout.lower()
            return any(t.lower() in running for t in targets)
        except Exception:
            # 检测失败时乐观返回 True，让连接阶段报更精确的错误
            return True
