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
  EASYTRADER_SIM_CLIENT_PATH=          # 模拟窗口使用独立程序时可选

用法：
  HOLDINGS_PROVIDER=easytrader
  provider = get_provider()
  holdings = provider.get_holdings()
"""

from __future__ import annotations

import logging
import math
import sys

from ..config import settings
from ..schemas import HoldingItem, TradeItem
from . import _ocr
from ._ths_export import export_grid as _export_grid
from ._ths_export import read_tab_separated as _read_tab_separated
from ._ths_fields import classify_table as _classify_table
from ._ths_fields import extract as _extract
from ._ths_fields import normalize_ticker as _normalize_ticker
from ._ths_trades import rows_to_trades as _rows_to_trades
from .base import HoldingsProvider, ProviderUnavailable, current_account_mode
from .broker_profiles import GENERIC_THS, BrokerProfile, resolve_profile

log = logging.getLogger(__name__)

# 「历史成交」的左树路径现在由券商档案给出（见 broker_profiles.DEFAULT_TRADES_MENU_PATH）。
# easytrader 只封装了「当日成交」，历史成交要自己走这条路径；各贴牌版本的菜单树
# 未必一致，所以不再写成模块级常量。


class EasyTraderProvider(HoldingsProvider):
    """easytrader 持仓数据源：通过 GUI 自动化读取券商客户端持仓。"""

    name = "easytrader"

    def __init__(self, account_mode: str | None = None) -> None:
        self._imported = False
        self._trader = None
        self.profile: BrokerProfile | None = None
        self._profile_error: str | None = None
        self._account_mode = account_mode or current_account_mode()
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
          0. 运行在 Windows 上（pywinauto 只操控 Win32 控件）
          1. easytrader 已安装
          2. 券商档案解析成功（EASYTRADER_BROKER 合法或内核类型合法）
          3. 客户端路径已配置
          4. 客户端进程正在运行（best-effort 检测）
        """
        if sys.platform != "win32":
            return False
        if not self._imported:
            return False
        if self.profile is None:
            return False
        if not self._client_path():
            return False
        # 客户端进程检测（best-effort，不阻塞）
        if not self._client_running():
            return False
        return True

    def get_holdings(self) -> list[HoldingItem]:
        """普通调用仅被动读取已暴露的持仓表格。"""
        return self.read_holdings()

    def read_holdings(self, *, foreground: bool = False) -> list[HoldingItem]:
        if not foreground:
            return self._read_visible_table()
        import ctypes
        from ctypes import wintypes
        ctypes.windll.user32.GetForegroundWindow.restype = wintypes.HWND
        ctypes.windll.user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        previous = ctypes.windll.user32.GetForegroundWindow()
        try:
            return self._read_with_navigation()
        finally:
            if previous:
                ctypes.windll.user32.SetForegroundWindow(previous)

    def _read_visible_table(self) -> list[HoldingItem]:
        """读取明确账户窗口的 ListView；不连接 easytrader、不设置焦点。"""
        if sys.platform != "win32":
            raise ProviderUnavailable("此数据源仅支持 Windows。", "unsupported_platform")
        try:
            from pywinauto import Desktop
            from .mac_ths import rows_to_items
            account = self._account_mode
            saw_trades_table = False
            windows = Desktop(backend="win32").windows(visible_only=True)
            for window in windows:
                title = window.window_text() or ""
                matches = "模拟炒股" in title if account == "simulated" else (
                    "网上股票交易系统" in title and "模拟炒股" not in title)
                if not matches:
                    continue
                for table in window.descendants(class_name="SysListView32"):
                    headers = [column["text"] for column in table.columns()]
                    # 成交表同样含「证券代码」，只按「含代码」认表会把成交表读成持仓表。
                    kind = _classify_table(headers)
                    if kind == "trades":
                        saw_trades_table = True
                        continue
                    if kind != "holdings":
                        continue
                    rows = [[table.get_item(row, column).text() for column in range(len(headers))]
                            for row in range(table.item_count())]
                    return rows_to_items(headers, rows)
            if saw_trades_table:
                raise ProviderUnavailable(
                    "当前窗口显示的是成交明细表，不是持仓表。请切换到「持仓」页后重试。",
                    "navigation_required",
                )
        except ProviderUnavailable:
            raise
        except Exception as exc:
            raise ProviderUnavailable("无法被动读取窗口，请进入持仓页或使用桌面端引导。", "navigation_required") from exc
        raise ProviderUnavailable("请进入所选账户的持仓页。", "navigation_required")

    def _read_with_navigation(self) -> list[HoldingItem]:
        """从券商客户端读取当前持仓。

        Returns:
            list[HoldingItem]: 当前非零持仓列表

        Raises:
            ProviderUnavailable: easytrader 未安装 / 客户端未运行 / 连接失败
        """
        self._require_client()

        # 读网格可能撞上风控验证码，easytrader 要用 OCR 识别——先把 tesseract
        # 指给 pytesseract。找不到不在这里报错：验证码不是每次必弹，没装 OCR 的
        # 机器仍然能读到不弹验证码的那些持仓，真撞上了再由下面的异常翻译兜住。
        _ocr.locate_tesseract()

        # 连接客户端并查询持仓
        try:
            trader = self._connect()
            raw_positions: list[dict] = trader.position  # type: ignore[attr-defined]
        except ProviderUnavailable:
            raise
        except Exception as exc:
            log.error("easytrader 连接/查询失败: %s", exc, exc_info=True)
            if _ocr.is_missing_tesseract(exc):
                # 不翻译的话这里会说成「请确认客户端已登录且窗口未被遮挡」，
                # 而客户端好端端开着——排查方向会被整个带偏。
                raise ProviderUnavailable(
                    _ocr.missing_tesseract_hint(), "automation_required"
                ) from exc
            raise ProviderUnavailable(
                f"easytrader 连接或查询持仓失败: {exc}。"
                f"请确认 {self.profile.label if self.profile else '券商客户端'} "
                "已登录且窗口未被遮挡。"
            ) from exc

        # 字段映射 + 过滤零持仓
        items: list[HoldingItem] = []
        for pos in raw_positions:
            ticker = _normalize_ticker(_extract(pos, "ticker"))
            if not ticker:
                raise ProviderUnavailable("部分持仓代码无法识别，已取消替换。", "partial_read")
            quantity_raw = _extract(pos, "quantity")
            cost_price_raw = _extract(pos, "cost_price")
            try:
                quantity = float(quantity_raw) if quantity_raw else 0.0
                cost_price = float(cost_price_raw) if cost_price_raw else 0.0
            except (ValueError, TypeError):
                raise ProviderUnavailable("部分持仓数值无法识别，未覆盖本地持仓。", "partial_read")
            if quantity_raw is None or str(quantity_raw).strip() in ("", "--", "-", "—"):
                raise ProviderUnavailable("部分持仓数量缺失，已取消替换。", "partial_read")
            if quantity == 0:
                continue
            if not math.isfinite(quantity) or not math.isfinite(cost_price) or quantity < 0 or cost_price <= 0:
                raise ProviderUnavailable("部分持仓数值缺失，已取消替换。", "partial_read")
            items.append(HoldingItem(ticker=ticker, quantity=quantity, cost_price=cost_price))

        log.info("easytrader(%s) 获取持仓 %d 条", self.profile.broker_id, len(items))
        return items

    # ---- 内部方法 ----

    def _require_client(self) -> str:
        """前置条件检查（平台/依赖/档案/路径/进程），返回客户端路径。

        持仓与成交两条读取路径共用：这两处的失败文案是用户唯一能照着做的指引，
        复制一份迟早会分叉。
        """
        label = self.profile.label if self.profile else "券商客户端"
        if sys.platform != "win32":
            raise ProviderUnavailable(
                "easytrader 依赖 pywinauto 操控 Win32 控件，仅支持 Windows。"
                "macOS 请改用 HOLDINGS_PROVIDER=mac_ths（同花顺 Mac 版 + AppleScript）；"
                "其他平台请用「导入持仓」手动维护。"
            )
        if not self._imported:
            raise ProviderUnavailable(
                "easytrader 未安装：pip install easytrader pywinauto。"
                "详见 docs/券商接入方案.md §easytrader。"
            )
        if self.profile is None:
            raise ProviderUnavailable(self._profile_error or "券商档案解析失败。")
        client_path = self._client_path()
        if not client_path:
            raise ProviderUnavailable(
                "EASYTRADER_CLIENT_PATH 未配置：需指定券商客户端的下单程序路径。"
                f"可运行 holdings_cli.py detect 自动发现本机已装的客户端（当前档案: {label}）。"
                "详见 docs/券商接入方案.md §easytrader。"
            )
        if not self._client_running():
            raise ProviderUnavailable(
                f"券商客户端未运行：请先启动并登录 {label} "
                f"（{client_path}）。窗口需保持打开。"
            )
        return client_path

    @property
    def trades_menu_path(self) -> tuple[str, ...] | None:
        """本档案读「历史成交」的左树路径；None = 不支持读成交。

        档案没解析出来时也返回 None：连的是哪家都还不知道，谈不上按哪套菜单导航。
        `read_trades` 与 `holdings_source.trades_action_available` 共用这一个判据，
        免得「界面上给不给按钮」和「点了会不会真跑」两处各判一套。
        """
        return self.profile.trades_menu_path if self.profile is not None else None

    def read_trades(self, *, foreground: bool = False) -> list[TradeItem]:
        """读取「历史成交」表的成交明细。

        Windows 上取成交表必须走「Ctrl+S 另存为」——给 grid 发复制命令在这个客户端
        不生效，而另存为会抢焦点并可能弹风控验证码，所以是前台动作：被动调用一律
        拒绝，由经宿主认证的原生入口带 foreground=True 调进来。
        """
        if sys.platform != "win32":
            raise ProviderUnavailable("此数据源仅支持 Windows。", "unsupported_platform")
        if self.trades_menu_path is None:
            raise ProviderUnavailable(
                f"{self.profile.label if self.profile else '当前券商'}不支持读取历史成交明细："
                "专用客户端的交易界面没有同花顺那套「查询 → 历史成交」菜单，"
                "本功能暂未接入。请在券商客户端里自行导出，或改用手动录入。",
                "unsupported_action",
            )
        if not foreground:
            raise ProviderUnavailable(
                "读取成交明细需要把客户端切到「历史成交」页并将整表另存为文件，"
                "过程中会短暂占用前台并可能弹出风控验证码。请在桌面端使用获准的读取入口。",
                "navigation_required",
            )
        self._require_client()
        # 另存为同样会弹风控验证码，_ths_export 用同一套 OCR——这里先把
        # tesseract 指给 pytesseract，否则「本机装了 OCR 也识别不了」。
        _ocr.locate_tesseract()
        trader = self._connect()
        try:
            header, rows = self._read_trade_table(trader)
        except ProviderUnavailable:
            raise
        except Exception as exc:
            log.error("easytrader 读取成交明细失败: %s", exc, exc_info=True)
            # pywinauto 的 ElementNotVisible 之类异常 str() 是空的，直接插值会拼出
            # 「失败: 。」这种什么也没说的文案，所以没消息时退回异常类型名。
            detail = str(exc).strip() or type(exc).__name__
            raise ProviderUnavailable(
                f"读取成交明细失败: {detail}。"
                "请确认客户端已登录、窗口停在「历史成交」页且查到了数据。",
                "read_failed",
            ) from exc
        items = _rows_to_trades(
            header, rows, source=self.name, account_mode=self._account_mode
        )
        log.info("easytrader(%s) 读取成交明细 %d 笔", self.profile.broker_id, len(items))
        return items

    def _read_trade_table(self, trader) -> tuple[list[str], list[list[str]]]:
        """切到「历史成交」页，把整表另存为文件后读回（临时文件用完即删）。

        日期范围由用户在客户端里设定（第一期分工：客户端定范围，程序负责取整表）。
        """
        import tempfile
        from pathlib import Path

        trader._switch_left_menus(list(self.trades_menu_path))
        grid = trader.main.child_window(
            control_id=trader.config.COMMON_GRID_CONTROL_ID, class_name="CVirtualGridCtrl"
        )
        from ._ths_export import _process_id

        # ignore_cleanup_errors：客户端另存为之后仍握着文件句柄（2026-09-16 真机实测
        # WinError 32），清理失败会把一次**已经成功**的读取整个报成 read_failed——
        # 数据都读进内存了，不该毁在删临时文件上。残留文件交给系统清理 TEMP。
        with tempfile.TemporaryDirectory(
            prefix="pa_trades_", ignore_cleanup_errors=True
        ) as folder:
            out_path = Path(folder) / "trades.xls"
            _export_grid(grid, out_path, pid=_process_id())
            return _read_tab_separated(out_path)

    def _connect(self):
        """连接券商客户端，返回 easytrader 实例（懒初始化 + 缓存）。"""
        if self._trader is not None:
            return self._trader

        import easytrader

        assert self.profile is not None
        trader = easytrader.use(self.profile.trader_type)
        trader.connect(self._client_path())
        if not self._fix_main_window(trader, self._account_mode):
            raise ProviderUnavailable(
                "未找到所选账户的交易窗口，请登录并进入对应持仓页。", "navigation_required"
            )
        self._trader = trader
        return trader

    @staticmethod
    def _fix_main_window(trader, account_mode: str = "real") -> bool:
        """修正 easytrader 的主窗口选择。

        同花顺内核客户端进程里带有隐藏的 IE 内嵌窗口，easytrader 默认取
        top_window() 时可能选中它而非真正的交易窗口，导致菜单树定位失败。
        这里按 THS 标准交易窗口标题（网上股票交易系统）在已连接进程内
        重新锁定可见主窗口；找不到时保持默认行为。
        """
        try:
            windows = trader._app.windows(enabled_only=True, visible_only=True)
            for w in windows:
                title = w.window_text() or ""
                is_simulated = "模拟炒股" in title
                matches = is_simulated if account_mode == "simulated" else (
                    "网上股票交易系统" in title and not is_simulated
                )
                if matches:
                    # easytrader 内部把 _main 当 WindowSpecification 用，
                    # 这里按句柄重新生成规格而非直接赋 wrapper
                    trader._main = trader._app.window(handle=w.handle)
                    return True
        except Exception:
            return False
        return False

    def _client_path(self) -> str:
        """模拟账户可配置独立交易程序；缺省复用同花顺的同一 xiadan.exe。"""
        if self._account_mode == "simulated":
            return (
                getattr(settings, "easytrader_sim_client_path", "")
                or settings.easytrader_client_path
            )
        return settings.easytrader_client_path

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
