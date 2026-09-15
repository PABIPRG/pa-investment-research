# -*- coding: utf-8 -*-
"""同花顺 macOS 持仓与成交明细读取。

AXUIElement 为默认被动读取路径。权限属于实际 Python 读取进程；检测不触发
TCC 弹窗。需要导航时返回稳定状态；只有经认证的 Electron 本次同意入口允许
激活窗口和固定路径点击，AX 导航失败后才使用 AppleScript，并尽力恢复前台。
表格或账户身份无法完整确认时拒绝读取，不以部分结果覆盖当前持仓。

成交明细与持仓共用同一套 AX 会话（权限、账户身份校验、超时预算），差别只有
导航路径与认表签名。**成交路径没有 AppleScript 降级**：持仓的降级脚本是针对
「持仓」页写死并验证过的，成交页的对应脚本尚未在任何真机上跑通（闸门 4 未做），
与其塞一份看起来能用的未验证脚本，不如让用户手动切页——见 read_trades。
"""

from __future__ import annotations

import logging
import math
import subprocess
import sys
from typing import Callable

from ..config import settings
from ..schemas import HoldingItem, TradeItem
from ._ths_fields import (
    classify_table,
    is_blank,
    label,
    locate_columns,
    normalize_ticker,
    parse_number,
    required_fields,
)
from ._ths_trades import rows_to_trades
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

# 表格定位：在若干 scroll area 中粗筛表头含「代码」的表，再交给 Python 侧判定。
# AppleScript 里没法调用 classify_table，所以它只做粗筛——成交表同样含「证券代码」，
# 最终由 rows_to_items 的表签名判定拒绝非持仓表，报错文案在 _table_mismatch_message。
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
				click button "交易" of window 1
				click button accountTab of window 1
				if value of button accountTab of window 1 is not 1 then
					return "ERR" & tab & "无法确认当前账户类型，已取消读取。"
				end if
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
				on error
					return "ERR" & tab & "部分持仓行读取失败，已取消替换。"
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


def _table_mismatch_message(header: list[str], kind: str | None) -> str:
    """按判定结果生成可操作的报错文案：读错表 / 缺列是两种不同的用户动作。"""
    shown = " | ".join(header)
    if kind == "trades":
        return (
            "当前读到的是一张成交明细表，不是持仓表。"
            f"实际表头：{shown}。请在客户端切换到「持仓」页后重试。"
        )
    columns = locate_columns(header)
    missing = [field for field in required_fields("holdings") if field not in columns]
    if "ticker" in missing:
        return (
            "同花顺持仓表列名无法识别（未找到代码列）。"
            f"实际表头：{shown}。请把这条信息反馈给开发者补充列名映射。"
        )
    return (
        f"同花顺持仓表缺少必要列：{'、'.join(label(field) for field in missing)}。"
        f"实际表头：{shown}。请把这条信息反馈给开发者补充列名映射。"
    )


def rows_to_items(header: list[str], rows: list[list[str]]) -> list[HoldingItem]:
    """按表头名映射列，把数据行转成 HoldingItem（过滤零持仓/坏行）。

    Raises:
        MacThsScriptError: 表头不满足持仓表签名——要么取错了表（例如停在了成交页），
            要么列名映射需要补充。两种情况都回传实际表头便于排查。
    """
    kind = classify_table(header)
    if kind != "holdings":
        raise MacThsScriptError(_table_mismatch_message(header, kind))
    columns = locate_columns(header)

    items: list[HoldingItem] = []
    for row in rows:
        # 列号已在 locate_columns 里定好，直接按列取值——不要再走 extract()，
        # 那是给「键即客户端列名」的 easytrader dict 用的，这里会取空。
        def cell(field: str) -> str | None:
            index = columns.get(field)
            return row[index] if index is not None and index < len(row) else None

        ticker = normalize_ticker(cell("ticker"))
        if ticker is None:
            if any(str(value).strip() for value in row):
                raise ProviderUnavailable("部分持仓行无法识别，未覆盖本地持仓。", "partial_read")
            continue
        quantity_raw = cell("quantity")
        # 刻意比 is_blank 严：这里只认字面占位符，清洗后才变空的「¥」之类仍走下面的
        # 数值解析（→ 0.0 → 按已清仓跳过）。换成 is_blank 会把这类行从「跳过」改成
        # 「拒绝整批」，是行为变更，不要顺手统一。
        if quantity_raw is None or quantity_raw.strip() in ("", "--", "-", "—"):
            raise ProviderUnavailable("部分持仓数量缺失，未覆盖本地持仓。", "partial_read")
        cost_raw = cell("cost_price")
        try:
            quantity = _to_float(quantity_raw)
            cost_price = _to_float(cost_raw)
        except ValueError:
            raise ProviderUnavailable("部分持仓数值无法识别，未覆盖本地持仓。", "partial_read")
        if quantity == 0:
            continue
        if not math.isfinite(quantity) or not math.isfinite(cost_price) or quantity < 0 or cost_price <= 0:
            raise ProviderUnavailable("部分持仓成本或数量缺失，未覆盖本地持仓。", "partial_read")
        items.append(HoldingItem(ticker=ticker, quantity=quantity, cost_price=cost_price))
    return items


def _to_float(raw: str | None) -> float:
    """把客户端展示值转成 float；空值占位返回 0.0，脏数据抛 ValueError。

    解析规则复用 _ths_fields.parse_number，与成交明细读取保持同一套清洗逻辑。

    这里额外保留 ValueError：rows_to_items 靠它区分「客户端表示没有值」（按 0 处理，
    随后被 quantity == 0 正常跳过）与「读到了脏数据」（必须拒绝整批）。
    若把脏数据也压成 0.0，坏行会被当成已清仓静默跳过——那是丢数据，不是容错。
    """
    value = parse_number(raw)
    if value is not None:
        return value
    if is_blank(raw):
        return 0.0
    raise ValueError(f"无法解析数值：{raw}")


class MacThsProvider(HoldingsProvider):
    """macOS 持仓数据源：优先 AX，被动读取与获准导航分离。"""

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
        return accessibility_status() == "granted" and app_running(self._app_name)

    def get_holdings(self) -> list[HoldingItem]:
        """普通调用只允许被动读取，绝不自动激活窗口。"""
        return self.read_holdings()

    def read_holdings(self, *, foreground: bool = False) -> list[HoldingItem]:
        if self._platform != "darwin":
            raise ProviderUnavailable("此数据源仅支持 macOS。", "unsupported_platform")
        permission = accessibility_status()
        if permission != "granted":
            raise ProviderUnavailable("请先授予读取进程辅助功能权限。",
                                      "accessibility_required" if permission == "not_granted" else "dependency_missing")
        if not app_running(self._app_name):
            raise ProviderUnavailable("请先打开同花顺并登录。", "client_not_running")
        try:
            return read_ax_table(self._account_mode)
        except ProviderUnavailable as exc:
            if not foreground or exc.code != "navigation_required":
                raise
        from AppKit import NSWorkspace, NSApplicationActivateIgnoringOtherApps
        workspace = NSWorkspace.sharedWorkspace()
        previous = workspace.frontmostApplication()
        activated = False
        try:
            target = next((app for app in workspace.runningApplications()
                           if app.localizedName() == DEFAULT_APP_NAME), None)
            if target is None:
                raise ProviderUnavailable("同花顺已经退出。", "client_not_running")
            if accessibility_status() != "granted":
                raise ProviderUnavailable("读取进程的辅助功能权限已失效。", "accessibility_required")
            target.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
            activated = True
            try:
                return read_ax_table(self._account_mode, navigate=True)
            except ProviderUnavailable as exc:
                if exc.code != "navigation_required":
                    raise
            # Apple Events are used only after an actual AX navigation failure.
            code, stdout, stderr = self._runner(apple_script(DEFAULT_APP_NAME, self._account_mode))
            message = stderr or stdout
            if any(marker in message for marker in _AUTOMATION_PERMISSION_MARKERS):
                raise ProviderUnavailable("辅助功能已授权；本次降级读取需要自动化权限。", "automation_required")
            if any(marker in message for marker in _ACCESSIBILITY_PERMISSION_MARKERS):
                raise ProviderUnavailable("读取进程的辅助功能权限已失效。", "accessibility_required")
            if code != 0:
                raise ProviderUnavailable("读取失败，请检查登录、验证码或客户端弹窗。", "read_failed")
            try:
                header, rows = parse_output(stdout)
                return rows_to_items(header, rows)
            except MacThsScriptError as exc:
                raise ProviderUnavailable(str(exc), "read_failed") from exc
        except subprocess.TimeoutExpired as exc:
            raise ProviderUnavailable("读取超时，请处理客户端弹窗后重试。", "read_timeout") from exc
        except ProviderUnavailable:
            raise
        except Exception as exc:
            raise ProviderUnavailable("读取组件执行失败，请重新检查客户端。", "read_failed") from exc
        finally:
            if activated and previous is not None:
                try:
                    previous.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
                except Exception:
                    log.warning("未能恢复原前台应用")

    def get_trades(self) -> list[TradeItem]:
        """普通调用只允许被动读取，绝不自动激活窗口。"""
        return self.read_trades()

    def read_trades(self, *, foreground: bool = False) -> list[TradeItem]:
        """读取成交明细；被动优先，只有获准的本次同意入口才允许激活并导航。

        与 read_holdings 的唯一结构差别：AX 导航失败后**不降级到 AppleScript**。
        持仓那份降级脚本是针对「持仓」页写死且验证过的，成交页的对应脚本还没在
        任何 Mac 真机上跑通，写一份看起来能用的反而会把失败伪装成「已尝试全部手段」。
        这里改为明确告诉用户手动切页。
        """
        if self._platform != "darwin":
            raise ProviderUnavailable("此数据源仅支持 macOS。", "unsupported_platform")
        permission = accessibility_status()
        if permission != "granted":
            raise ProviderUnavailable("请先授予读取进程辅助功能权限。",
                                      "accessibility_required" if permission == "not_granted" else "dependency_missing")
        if not app_running(self._app_name):
            raise ProviderUnavailable("请先打开同花顺并登录。", "client_not_running")
        try:
            return read_ax_trades(self._account_mode)
        except ProviderUnavailable as exc:
            if not foreground or exc.code != "navigation_required":
                raise
        from AppKit import NSWorkspace, NSApplicationActivateIgnoringOtherApps
        workspace = NSWorkspace.sharedWorkspace()
        previous = workspace.frontmostApplication()
        activated = False
        try:
            target = next((app for app in workspace.runningApplications()
                           if app.localizedName() == DEFAULT_APP_NAME), None)
            if target is None:
                raise ProviderUnavailable("同花顺已经退出。", "client_not_running")
            if accessibility_status() != "granted":
                raise ProviderUnavailable("读取进程的辅助功能权限已失效。", "accessibility_required")
            target.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
            activated = True
            try:
                return read_ax_trades(self._account_mode, navigate=True)
            except ProviderUnavailable as exc:
                if exc.code != "navigation_required":
                    raise
                path = " → ".join(trades_navigation_path(self._account_mode))
                raise ProviderUnavailable(
                    f"自动切换到「历史成交」页失败。请在同花顺里手动打开 {path}，"
                    "设定好要导入的日期范围并查到数据后再读取。"
                    f"（{exc}）",
                    "navigation_required",
                ) from exc
        finally:
            if activated and previous is not None:
                try:
                    previous.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
                except Exception:
                    log.warning("未能恢复原前台应用")


def accessibility_status() -> str:
    """检查实际 Python 读取进程的 TCC 权限，不弹出授权请求。"""
    try:
        from ApplicationServices import AXIsProcessTrusted
        return "granted" if AXIsProcessTrusted() else "not_granted"
    except ImportError:
        return "unknown"


def _account_tab(account_mode: str) -> str:
    """账户类型 → 同花顺 Mac 版上的页签名。"""
    return "模拟" if account_mode == "simulated" else "A股"


# 「历史成交」在 Mac 版左树里的位置：与持仓同一层级。**尚未在真机验证**（闸门 4
# 未做）：标签取自 Windows 版客户端的同名入口，Mac 版若叫别的名字（例如分组折叠着），
# AXPress 会找不到按钮并按 navigation_required 中止——不会点错地方，只是失败。
TRADES_NAVIGATION_LABELS = ("交易", "股票", "历史成交")


def trades_navigation_path(account_mode: str) -> tuple[str, ...]:
    """成交页的 AX 导航按钮路径（账户页签按 selected 账户插入）。"""
    return (
        TRADES_NAVIGATION_LABELS[0],
        _account_tab(account_mode),
        *TRADES_NAVIGATION_LABELS[1:],
    )


def _ax_session(account_mode: str, *, labels: tuple[str, ...] | None, page: str):
    """建立 AX 会话：查权限、定位进程、按需导航，返回 (节点列表, attr, walk)。

    持仓与成交共用这一段。TCC 权限、超时预算、尤其是「账户身份必须被证明」这条
    在两张表上完全一样——复制一份迟早会分叉，而漏掉账户校验的后果是读到另一个
    账户的数据，那是错数据而不是缺数据。

    labels 为 None 表示被动读取，不做任何 AXPress。
    """
    import time
    from AppKit import NSWorkspace
    from ApplicationServices import (
        AXUIElementCreateApplication, AXUIElementCopyAttributeValue,
        AXUIElementPerformAction, AXUIElementSetMessagingTimeout,
    )
    if accessibility_status() != "granted":
        raise ProviderUnavailable("请先授予读取进程辅助功能权限。", "accessibility_required")
    target = next((app for app in NSWorkspace.sharedWorkspace().runningApplications()
                   if app.localizedName() == DEFAULT_APP_NAME), None)
    if target is None:
        raise ProviderUnavailable("同花顺未运行。", "client_not_running")
    root = AXUIElementCreateApplication(target.processIdentifier())
    AXUIElementSetMessagingTimeout(root, 1.0)
    deadline = time.monotonic() + settings.mac_ths_timeout
    def attr(node, key):
        if time.monotonic() > deadline:
            raise ProviderUnavailable("读取超时，请重试。", "read_timeout")
        code, value = AXUIElementCopyAttributeValue(node, key, None)
        return value if code == 0 else None
    def walk(node):
        pending = [node]
        count = 0
        while pending:
            current = pending.pop(0)
            count += 1
            if count > 4000:
                raise ProviderUnavailable("窗口内容过多，无法完整读取。", "partial_read")
            yield current
            pending.extend(attr(current, "AXChildren") or [])
    if labels:
        for label in labels:
            button = next((n for n in walk(root) if attr(n, "AXTitle") == label
                           and attr(n, "AXRole") in ("AXButton", "AXRadioButton")), None)
            if button is None or AXUIElementPerformAction(button, "AXPress") != 0:
                raise ProviderUnavailable(f"请进入所选账户的{page}页。", "navigation_required")
    nodes = list(walk(root))
    # Passive reads must prove the selected account, not infer it from a visible tab label.
    account = _account_tab(account_mode)
    if not any(attr(n, "AXTitle") == account and
                                 (attr(n, "AXSelected") is True or attr(n, "AXValue") == 1) for n in nodes):
        raise ProviderUnavailable(f"请进入所选账户的{page}页后再读取。", "navigation_required")
    return nodes, attr, walk


def _table_values(table, attr, walk) -> list[list[str]]:
    """一张 AXTable → 单元格文本（第 0 行是表头）。"""
    rows = attr(table, "AXRows") or []
    return [[str(attr(n, "AXValue") or "") for n in walk(row)
             if attr(n, "AXRole") == "AXStaticText"] for row in rows]


def read_ax_table(account_mode: str, *, navigate: bool = False) -> list[HoldingItem]:
    """被动 AX 遍历；仅获准原生调用允许固定账户路径的 AXPress。"""
    labels = ("交易", _account_tab(account_mode), "股票", "持仓") if navigate else None
    nodes, attr, walk = _ax_session(account_mode, labels=labels, page="持仓")
    saw_trades_table = False
    for table in nodes:
        if attr(table, "AXRole") != "AXTable":
            continue
        values = _table_values(table, attr, walk)
        if not values:
            continue
        # 成交表同样含「证券代码」，只按「含代码」认表会把成交表当持仓表，
        # 最终报出「未找到持仓表」这种与事实不符的提示。
        kind = classify_table(values[0])
        if kind == "holdings":
            return rows_to_items(values[0], values[1:])
        if kind == "trades":
            saw_trades_table = True
    if saw_trades_table:
        raise ProviderUnavailable("当前停留在成交明细页，请切换到「持仓」页后再读取。", "navigation_required")
    raise ProviderUnavailable("未找到完整持仓表格，请确认已登录并进入持仓页。", "navigation_required")


def read_ax_trades(account_mode: str, *, navigate: bool = False) -> list[TradeItem]:
    """被动 AX 遍历成交明细表；仅获准原生调用允许固定路径的 AXPress。

    与 read_ax_table 对称，只是认表签名相反：这里要 trades 表，读到 holdings 表
    才是「走错页」。
    """
    labels = trades_navigation_path(account_mode) if navigate else None
    nodes, attr, walk = _ax_session(account_mode, labels=labels, page="历史成交")
    saw_holdings_table = False
    for table in nodes:
        if attr(table, "AXRole") != "AXTable":
            continue
        values = _table_values(table, attr, walk)
        if not values:
            continue
        kind = classify_table(values[0])
        if kind == "trades":
            return rows_to_trades(
                values[0], values[1:], source="mac_ths", account_mode=account_mode
            )
        if kind == "holdings":
            saw_holdings_table = True
    if saw_holdings_table:
        raise ProviderUnavailable(
            "当前停留在持仓页，请切换到「历史成交」页后再读取。", "navigation_required"
        )
    raise ProviderUnavailable(
        "未找到成交明细表格：请确认已登录、进入「历史成交」页且已查到数据。",
        "navigation_required",
    )
