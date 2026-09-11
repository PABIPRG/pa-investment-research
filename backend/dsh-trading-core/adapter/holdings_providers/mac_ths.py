# -*- coding: utf-8 -*-
"""MacThsProvider：macOS 上通过 AppleScript 读取同花顺 Mac 版持仓。

为什么需要单独的 provider：
  Windows 走 easytrader + pywinauto 操控 Win32 控件树；macOS 上既没有
  pywinauto，也没有券商自研的下单客户端（xiadan.exe 等全是 Windows PE）。
  唯一在 macOS 上能登录券商并看到持仓的现成客户端是「同花顺 Mac 版」
  （内置 80+ 券商账号登录，含平安、国金、银河、中信、广发等）。
  因此 macOS 侧改用系统自带的 AppleScript + System Events 辅助功能 API
  遍历同花顺的 Cocoa 控件树，等价于 pywinauto 在 Windows 上做的事。

AppleScript 常量来源：
  https://github.com/zetatez/evolving （MIT，最后更新 2026-08）
  上游把「交易 → A股 → 股票 → 持仓」的点击序列和控件路径沉淀成了常量，
  本模块按 MIT 许可引用其控件路径知识，并做了三处改造：
    1. 只取持仓，去掉下单/撤单/银证转账等资金操作入口；
    2. 返回值改为 TAB/换行分隔的文本，避免上游 return 一个 AppleScript
       list 时被 osascript 用逗号拼接——千分位（"1,000"）会被拆错列；
    3. 表格定位由「写死 scroll area 4 / 5」改为在 1..8 里找表头含「代码」
       的表，并按表头名映射列，降低客户端改版造成的脆性。

前置条件（缺一不可，UI 会逐条提示）：
  * macOS
  * 同花顺 Mac 版已安装并登录券商交易账号
  * 系统设置 → 隐私与安全性：授予运行本应用的进程自动化与辅助功能权限
  * 客户端窗口停在「交易」模块

局限：
  * 与 easytrader 同为 GUI 自动化，同花顺改版会导致控件路径失效
  * 需要用户在系统设置里授权，属一次性信任成本
  * 部分券商在同花顺 Mac 版上无交易权限（只能看行情），此时点「交易」
    会失败并返回 ERR，本 provider 会原样把原因透出
"""

from __future__ import annotations

import logging
import subprocess
import sys
from typing import Callable

from ..config import settings
from ..schemas import HoldingItem
from ._ths_fields import locate_columns, normalize_ticker
from .base import HoldingsProvider, ProviderUnavailable, current_account_mode

log = logging.getLogger(__name__)

# 同花顺 Mac 版的应用名（AppleScript 进程名 == .app 名）
DEFAULT_APP_NAME = "同花顺"

# AppleScript 运行器签名：(脚本正文) -> (returncode, stdout, stderr)
ScriptRunner = Callable[[str], "tuple[int, str, str]"]

# TCC 会分别拒绝 Apple Events(-1743) 和辅助功能(-25211)，两者的授权入口不同。
_AUTOMATION_PERMISSION_MARKERS = (
    "-1743",
    "Not authorized to send Apple events",
    "未获得授权将Apple事件发送给System Events",
)
_ACCESSIBILITY_PERMISSION_MARKERS = (
    "-25211",
    "not allowed assistive access",
    "不允许辅助访问",
)

_AUTOMATION_PERMISSION_HINT = (
    "需要 macOS 自动化授权。请到「系统设置 → 隐私与安全性 → 自动化」中，"
    "允许运行投研智能体的应用（Codex 或终端）控制“System Events”。"
    "同花顺可能已打开或切换了部分页面，但未授权时无法完整读取持仓；"
    "授权后请重启投研智能体再试。"
)

_ACCESSIBILITY_PERMISSION_HINT = (
    "需要 macOS 辅助功能授权。请到「系统设置 → 隐私与安全性 → 辅助功能」中，"
    "把运行投研智能体的应用（Codex 或终端）勾选上；若列表里没有，先点“+”手动添加。"
    "同花顺可能已打开或切换了部分页面，但未授权时无法完整读取持仓；"
    "授权后请重启投研智能体再试。"
)

# 表格定位：在若干 scroll area 中寻找表头含「代码」的持仓表
_FIELD_SEP = "\t"

_APPLESCRIPT_TEMPLATE = '''
on joinList(theList, theDelim)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to theDelim
	set theText to theList as text
	set AppleScript's text item delimiters to oldDelims
	return theText
end joinList

on run
	set appName to "__APP__"
	set accountTab to "__ACCOUNT_TAB__"
	set navigationPath to "__NAVIGATION_PATH__"
	tell application "System Events"
		set appRunning to (exists (processes where name is appName))
	end tell
	if appRunning is false then
		return "ERR" & tab & "同花顺 Mac 版未运行：请先启动同花顺并登录券商交易账号，窗口保持打开。"
	end if

	tell application appName to activate
	delay 0.8

	tell application "System Events"
		tell process appName
			try
				click button 1 of window 1
				click button 6 of window 1
				click button accountTab of window 1
				click button "股票" of window 1
				click button "持仓" of window 1
				delay 0.6
			on error errMsg
				return "ERR" & tab & "无法切换到「" & navigationPath & "」：" & errMsg
			end try

			set targetTable to missing value
			set headCells to {}
			repeat with i from 1 to 8
				try
					set candidate to table 1 of scroll area i of window 1
					set candidateHead to (value of every static text of row 1 of candidate)
					if (my joinList(candidateHead, "|")) contains "代码" then
						set targetTable to candidate
						set headCells to candidateHead
						exit repeat
					end if
				end try
			end repeat

			if targetTable is missing value then
				return "ERR" & tab & "未在交易窗口找到持仓表格：请确认已登录券商账号，且行情/交易窗口停在第 1 页。"
			end if

			set outText to (my joinList(headCells, tab)) & linefeed
			set rowCount to (count of rows of targetTable)
			repeat with r from 2 to rowCount
				try
					set cells to (value of every static text of row r of targetTable)
					set outText to outText & (my joinList(cells, tab)) & linefeed
				end try
			end repeat
			return "OK" & tab & outText
		end tell
	end tell
end run
'''


class MacThsScriptError(Exception):
    """脚本已执行但同花顺侧返回了可读的失败原因（原文透出给用户）。"""


def permission_hint(message: str) -> str | None:
    """把 AppleScript/TCC 错误映射到对应的 macOS 授权入口。"""
    if any(marker in message for marker in _AUTOMATION_PERMISSION_MARKERS):
        return _AUTOMATION_PERMISSION_HINT
    if any(marker in message for marker in _ACCESSIBILITY_PERMISSION_MARKERS):
        return _ACCESSIBILITY_PERMISSION_HINT
    return None


def apple_script(app_name: str = DEFAULT_APP_NAME, account_mode: str = "real") -> str:
    """生成读取同花顺 Mac 版持仓的 AppleScript 正文。

    返回的是纯 AppleScript 源码，交给 `osascript -e` 直接执行；
    不要在外面再套 `osascript -e '...'`（上游 Go 版就踩了这个坑）。
    """
    account_tab = "模拟" if account_mode == "simulated" else "A股"
    navigation_path = f"交易 → {account_tab} → 股票 → 持仓"
    return (
        _APPLESCRIPT_TEMPLATE
        .replace("__APP__", app_name)
        .replace("__ACCOUNT_TAB__", account_tab)
        .replace("__NAVIGATION_PATH__", navigation_path)
        .strip()
    )


def default_runner(script: str) -> tuple[int, str, str]:
    """默认运行器：/usr/bin/osascript -e <脚本正文>。"""
    proc = subprocess.run(
        ["/usr/bin/osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=settings.mac_ths_timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def osascript_available() -> bool:
    """macOS 自带 osascript；非 macOS 或异常时返回 False。"""
    if sys.platform != "darwin":
        return False
    try:
        import shutil

        return shutil.which("osascript") is not None
    except Exception:
        return False


def app_bundles(app_name: str = DEFAULT_APP_NAME) -> list[str]:
    """同花顺 Mac 版 .app 的可能位置（存在才返回）。

    macOS 上券商没有独立的下单程序可扫，能「发现」的只有这一个交易客户端，
    因此这里不做 Windows 那种磁盘递归。
    """
    if sys.platform != "darwin":
        return []
    from pathlib import Path

    candidates = [
        Path("/Applications") / f"{app_name}.app",
        Path.home() / "Applications" / f"{app_name}.app",
    ]
    return [str(path) for path in candidates if path.exists()]


def app_running(app_name: str = DEFAULT_APP_NAME) -> bool:
    """检测同花顺 Mac 版进程是否在运行（best-effort）。"""
    if sys.platform != "darwin":
        return False
    try:
        proc = subprocess.run(
            ["pgrep", "-x", app_name],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return proc.returncode == 0
    except Exception:
        # 检测手段不可用时不要乐观判真：交给脚本自己报「未运行」
        return False


def parse_output(raw: str) -> tuple[list[str], list[list[str]]]:
    """解析 osascript 输出 → (表头单元格, 数据行列表)。

    Raises:
        MacThsScriptError: 脚本返回 ERR，或输出结构不符合约定。
    """
    text = raw.strip()
    if text == "":
        raise MacThsScriptError("同花顺没有返回任何内容，请确认交易窗口已打开且停留在持仓页。")
    status, _, body = text.partition(_FIELD_SEP)
    status = status.strip()
    if status == "ERR":
        raise MacThsScriptError(body.strip() or "同花顺返回了未知错误。")
    if status != "OK":
        raise MacThsScriptError(f"无法识别的脚本输出：{text[:200]}")

    lines = [line for line in body.splitlines() if line.strip() != ""]
    if not lines:
        raise MacThsScriptError("同花顺返回了空表格，请确认交易窗口停留在「持仓」页。")
    header = [cell.strip() for cell in lines[0].split(_FIELD_SEP)]
    rows = [[cell.strip() for cell in line.split(_FIELD_SEP)] for line in lines[1:]]
    return header, rows


def rows_to_items(header: list[str], rows: list[list[str]]) -> list[HoldingItem]:
    """按表头名映射列，把数据行转成 HoldingItem（过滤零持仓/坏行）。

    Raises:
        MacThsScriptError: 表头里找不到代码列——通常是取错了表，
            把实际表头回给用户便于排查。
    """
    columns = locate_columns(header)
    if "ticker" not in columns:
        raise MacThsScriptError(
            "同花顺持仓表列名无法识别（未找到代码列）。"
            f"实际表头：{' | '.join(header)}。请把这条信息反馈给开发者补充列名映射。"
        )

    items: list[HoldingItem] = []
    for row in rows:
        # 列号已在 locate_columns 里定好，直接按列取值——不要再走 extract()，
        # 那是给「键即客户端列名」的 easytrader dict 用的，这里会取空。
        def cell(field: str) -> str | None:
            index = columns.get(field)
            return row[index] if index is not None and index < len(row) else None

        ticker = normalize_ticker(cell("ticker"))
        if ticker is None:
            continue
        quantity_raw = cell("quantity")
        cost_raw = cell("cost_price")
        try:
            quantity = _to_float(quantity_raw)
            cost_price = _to_float(cost_raw)
        except ValueError:
            log.warning("mac_ths 持仓字段转换失败，跳过: %s", row)
            continue
        if quantity <= 0 or cost_price <= 0:
            continue
        items.append(HoldingItem(ticker=ticker, quantity=quantity, cost_price=cost_price))
    return items


def _to_float(raw: str | None) -> float:
    """把客户端展示值转成 float（容忍千分位逗号、货币符号、空值）。"""
    if raw is None:
        return 0.0
    cleaned = str(raw).replace(",", "").replace("¥", "").replace("￥", "").strip()
    if cleaned in ("", "--", "-", "—"):
        return 0.0
    return float(cleaned)


class MacThsProvider(HoldingsProvider):
    """macOS 持仓数据源：AppleScript 读同花顺 Mac 版持仓。"""

    name = "mac_ths"

    def __init__(
        self,
        platform: str | None = None,
        runner: ScriptRunner | None = None,
        app_name: str | None = None,
        account_mode: str | None = None,
    ) -> None:
        # platform 可注入：让单元测试在非 macOS 上也能覆盖全部分支
        self._platform = platform or sys.platform
        self._runner = runner or default_runner
        self._app_name = app_name or settings.mac_ths_app_name or DEFAULT_APP_NAME
        self._account_mode = account_mode or current_account_mode()

    # ---- HoldingsProvider 接口 ----

    def is_available(self) -> bool:
        """需同时满足：macOS + osascript 存在 + 同花顺 Mac 版在运行。"""
        if self._platform != "darwin":
            return False
        if not osascript_available():
            return False
        return app_running(self._app_name)

    def get_holdings(self) -> list[HoldingItem]:
        """读取同花顺 Mac 版当前持仓。

        Raises:
            ProviderUnavailable: 平台/依赖/权限/客户端状态任一不满足
        """
        if self._platform != "darwin":
            raise ProviderUnavailable(
                "持仓自动同步目前仅支持 Windows（easytrader）与 macOS（同花顺 Mac 版 AppleScript）；"
                f"当前平台为 {self._platform}，请改用「导入持仓」手动维护。"
            )
        if not osascript_available():
            raise ProviderUnavailable("未找到 osascript：该能力依赖 macOS 自带的 AppleScript 运行时。")
        if not app_running(self._app_name):
            raise ProviderUnavailable(
                f"同花顺 Mac 版未运行：请先启动并登录 {self._app_name} 的券商交易账号，窗口保持打开。"
            )

        script = apple_script(self._app_name, self._account_mode)
        try:
            code, stdout, stderr = self._runner(script)
        except subprocess.TimeoutExpired as exc:
            raise ProviderUnavailable(
                f"读取同花顺持仓超时（>{settings.mac_ths_timeout:g}s）："
                "客户端可能被弹窗/验证码阻塞，请处理后重试。"
            ) from exc
        except Exception as exc:  # 运行器本身不可用
            raise ProviderUnavailable(f"无法执行 AppleScript：{exc}") from exc

        if code != 0:
            message = (stderr or stdout).strip()
            hint = permission_hint(message)
            if hint is not None:
                raise ProviderUnavailable(hint)
            raise ProviderUnavailable(f"AppleScript 执行失败：{message or '未知错误'}。请确认同花顺已登录券商账号。")

        try:
            header, rows = parse_output(stdout)
            items = rows_to_items(header, rows)
        except MacThsScriptError as exc:
            message = str(exc)
            raise ProviderUnavailable(permission_hint(message) or message) from exc

        log.info("mac_ths(%s) 获取持仓 %d 条", self._app_name, len(items))
        return items
