# -*- coding: utf-8 -*-
"""持仓数据源的「检测 + 同步」服务层（产品 UI 用）。

holdings_cli.py 提供的是命令行入口，本模块把其中 detect/sync 的能力
抽成可直接被 FastAPI 路由调用的函数，避免 app.py 变厚：

  provider_snapshot()     当前 HOLDINGS_PROVIDER 的配置与可用性（不扫盘）
  detect_clients(force)   扫描本机已装券商客户端（带 TTL 缓存 + 线程卸载）
  sync_holdings()         拉取真实持仓并整体替换本地 store

设计约束：
  * provider_snapshot 必须「只报告不抛错」——配置缺项、依赖未装、
    非 Windows 平台都要降级成 available=False + 中文 reason，让 UI 展示。
  * discover_clients 会递归扫盘（秒级到分钟级），只在用户开框时才触发，
    且必须放到线程里跑，别堵 FastAPI 事件循环。
  * 空持仓一律拒绝写入：GUI 自动化「查不到」与「窗口没停在持仓页」
    无法区分，静默清空本地持仓不可恢复。
"""

from __future__ import annotations

import asyncio
import copy
import sys
import time
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path

from .config import settings
from .holdings_providers import _ocr, get_provider
from .holdings_providers.base import ProviderUnavailable, current_account_mode
from .holdings_providers.broker_profiles import discover_clients
from .portfolio_performance import holdings_snapshot_matches, record_holdings_snapshot
from .store import JsonStore

# discover_clients 扫盘结果缓存：(写入时间, 投影后列表)。UI 永远用默认 roots，无需分键。
_DETECT_TTL_SECONDS = 600.0
_DETECT_CACHE: tuple[float, list[dict]] | None = None

_PROVIDER_LABELS = {
    "manual": "手动输入",
    "easytrader": "同花顺（Windows）",
    "mac_ths": "同花顺（macOS）",
    "qmt": "QMT 迅投",
    "joinquant": "聚宽（不提供真实持仓）",
}

_ACCOUNT_LABELS = {"real": "真实操盘", "simulated": "模拟操盘"}
_ACCOUNT_MODE_SUPPORT = {
    "manual": ["real"],
    "joinquant": ["real"],
    "easytrader": ["real", "simulated"],
    "mac_ths": ["real", "simulated"],
    "qmt": ["real", "simulated"],
}


class EmptyHoldingsError(Exception):
    """数据源可用但读回 0 条持仓——拒绝覆盖本地已有持仓。"""


def _provider_label(provider) -> str:
    """优先返回券商展示名，否则把 provider 码映射为产品名称。"""
    profile = getattr(provider, "profile", None)
    label = getattr(profile, "label", None)
    if label:
        return str(label)
    name = str(getattr(provider, "name", "")).strip().lower()
    return _PROVIDER_LABELS.get(name, "未知数据源")


# 需要「操控本机券商客户端」的数据源，平台耦合，必须过闸门
_CLIENT_AUTOMATION_PROVIDERS = {"easytrader", "mac_ths"}

# 支持读取成交明细的数据源。本期只有客户端读表这两条路径，QMT/聚宽没有成交查询，
# 手动录入也不产生成交。这份名单决定 provider_snapshot 是否上报 read_trades 动作，
# 必须与各 provider 是否真的覆写 read_trades 一致——test_trades_capability 会核对。
_TRADES_PROVIDERS: set[str] = {"easytrader", "mac_ths"}


def trades_requires_foreground(provider_name: str) -> bool:
    """该数据源读取成交明细是否必须前台。

    Windows 的 easytrader 取成交表只能走「Ctrl+S 另存为」——给 grid 发复制命令在这个
    客户端不生效（见 _ths_export 模块开头的实测记录），而另存为会抢焦点并可能弹风控
    验证码，所以只有经宿主认证的原生入口能触发。macOS 走 AX 被动遍历，不需要。
    """
    return provider_name.strip().lower() == "easytrader"


def trades_action_available(
    provider_name: str, surface: str, *, profile=None
) -> bool:
    """是否该上报「同步成交明细」入口。

    只看数据源名字是不够的，共三道闸门：

    1. 数据源本身要支持读成交（QMT/聚宽/手动录入都没有）；
    2. Windows 网页版（local-web）没有原生入口，成交读取必然以 navigation_required
       失败，提前给出按钮等于让用户点进一个必然失败的入口；
    3. 券商档案要有「历史成交」菜单——同是 easytrader，专用客户端内核的六家
       （银河/华泰/五矿/海通/国金/广发）没有同花顺那套左树，只有 THS 内核才有。
       传 None（如 mac_ths 没有券商档案）表示这道闸门不适用。

    前端也拿得到 platform 与 surface，但这些后端事实留在这里，免得两处各写一份。
    """
    name = provider_name.strip().lower()
    if name not in _TRADES_PROVIDERS:
        return False
    if profile is not None and getattr(profile, "trades_menu_path", None) is None:
        return False
    return not trades_requires_foreground(name) or surface == "electron"


def platform_gate(provider_name: str) -> str | None:
    """校验数据源与当前操作系统是否匹配；不匹配时返回中文原因。

    必须在实例化 provider 之前调用：easytrader 依赖的 pywinauto 在 macOS 上
    不报错（只是不用 win32 后端），乐观的进程探测会让「客户端在跑」误判为真，
    于是 UI 会亮「可用」绿灯、点下去才炸出一段英文 ImportError。
    这里提前按平台给出可执行的中文提示，顺带把用户引到正确的 provider 上。
    """
    name = provider_name.strip().lower()
    # 只拦「操控本机客户端」的数据源；manual/qmt/joinquant 与平台无关，
    # 不该因为跑在 Linux 上就被判定不可用。
    if name not in _CLIENT_AUTOMATION_PROVIDERS:
        return None
    if sys.platform == "win32":
        if name == "mac_ths":
            return (
                "mac_ths 仅支持 macOS（同花顺 Mac 版）。"
                "Windows 请改用 HOLDINGS_PROVIDER=easytrader。"
            )
        return None
    if sys.platform == "darwin":
        if name == "easytrader":
            return (
                "easytrader 依赖 pywinauto 操控 Win32 控件，仅支持 Windows。"
                "macOS 请改用 HOLDINGS_PROVIDER=mac_ths"
                "（同花顺 Mac 版，首次需辅助功能权限）。"
            )
        return None
    return (
        f"当前平台 {sys.platform} 不支持券商客户端自动同步（仅支持 Windows / macOS）。"
        "请改用「导入持仓」手动维护。"
    )


def provider_snapshot(surface: str = "web") -> dict:
    """只探测安装、进程和权限；不读取表格、不导航、不触发权限弹窗。

    surface 由调用方传入（"electron" 表示有原生入口的桌面壳）。它与 platform 一起
    决定成交读取入口是否可用，见 trades_action_available。
    """
    name = settings.holdings_provider.strip().lower()
    platform = sys.platform if sys.platform in {"darwin", "win32"} else "unsupported"
    state = {
        "provider": name, "label": _PROVIDER_LABELS.get(name, "未知数据源"),
        "platform": platform, "surface": surface, "available": False, "reason": None,
        "installation": "unknown", "process": "unknown", "accessibility": "not_applicable",
        "automation": "not_requested" if platform == "darwin" else "not_applicable",
        "navigation": "verified_during_read" if name == "mac_ths" else "not_applicable",
        "session": "unknown", "readiness": "blocked", "blocking_reason": None,
        "available_actions": ["manual", "recheck"],
        "account_mode": str(getattr(settings, "holdings_account_mode", "simulated")),
        "supported_account_modes": _ACCOUNT_MODE_SUPPORT.get(name, ["real"]),
        # 验证码 OCR 只是「读取时可能用到」，不是读取的前置条件；默认不适用，
        # 只有真会用 OCR 的 provider 分支才改写（当前只有 easytrader）。
        "captcha_ocr": "not_applicable", "captcha_ocr_hint": None,
    }
    # 成交能力闸门要看的券商档案；只有 easytrader 分支会填（mac_ths 没有券商档案，
    # 留 None 表示那道闸门不适用）。
    profile = None

    def blocked(code, message):
        state.update(blocking_reason=code, reason=message)
        return state
    try:
        state["account_mode"] = current_account_mode()
    except ProviderUnavailable:
        return blocked("invalid_account", "账户配置无效，请重新选择操盘账户。")
    gate = platform_gate(name)
    if gate:
        return blocked("unsupported_platform", gate)
    if name == "mac_ths":
        from .holdings_providers.mac_ths import app_bundles, app_running, accessibility_status
        state["installation"] = "installed" if app_bundles() else "missing"
        state["process"] = "running" if app_running() else "not_running"
        state["accessibility"] = accessibility_status()
        if state["installation"] == "missing":
            state["available_actions"].append("download")
            return blocked("client_missing", "尚未安装同花顺 Mac 版。")
        if state["accessibility"] != "granted":
            return blocked("accessibility_required" if state["accessibility"] == "not_granted" else "dependency_missing",
                           "请先授予读取进程辅助功能权限。" if state["accessibility"] == "not_granted" else "读取组件不可用，请更新或修复本应用。")
        if state["process"] != "running":
            return blocked("client_not_running", "请打开同花顺并登录所选账户。")
    elif name == "easytrader":
        from .holdings_providers.easytrader import EasyTraderProvider
        # 读网格可能撞上风控验证码，这时要用 tesseract 识别。缺失只提示、不禁用：
        # 验证码不保证每次都弹（见 easytrader._read_with_navigation 的注释），没装
        # OCR 的机器照样能读到不弹验证码的持仓，把 available 打成 False 等于关掉
        # 一个经常可用的功能。所以这里只写提示字段，绝不碰 available/blocking_reason。
        # 位置必须在下面三个 blocked() 之前：客户端没开、没选路径时也要带着这条
        # 提示返回，由前端按 ready 决定显不显示（同一屏最多出现一条原因）。
        try:
            state["captcha_ocr"] = _ocr.tesseract_status()
        except Exception:  # 探测失败不该拖垮整个快照（本模块约定：只报告不抛错）
            state["captcha_ocr"] = "unknown"
        if state["captcha_ocr"] == "missing":
            state["captcha_ocr_hint"] = _ocr.missing_tesseract_notice()
        provider = EasyTraderProvider()
        profile = getattr(provider, "profile", None)
        path = provider._client_path()
        state["installation"] = "installed" if path and Path(path).is_file() else "unknown"
        state["process"] = "running" if provider._client_running() else "not_running"
        if state["installation"] != "installed":
            state["available_actions"].append("download")
            return blocked("client_location_required", "尚未定位同花顺下单客户端，请安装或选择客户端位置。")
        if not provider._imported:
            return blocked("dependency_missing", "持仓读取组件不可用，请修复本应用。")
        if state["process"] != "running":
            return blocked("client_not_running", "请打开同花顺并登录所选账户。")
    else:
        try:
            provider = get_provider()
            if not provider.is_available():
                return blocked("provider_unavailable", "当前数据源不可用，请检查配置或改用手动录入。")
        except Exception:
            return blocked("provider_unavailable", "当前数据源不可用，请检查配置。")
    state.update(available=True, readiness="ready")
    state["available_actions"].append("read")
    # 成交明细只在数据源确实就绪时才上报：客户端没起来时读成交同样读不了，
    # 提前给出动作只会让用户点进一个必然失败的入口。同理，Windows 网页版没有原生
    # 入口，成交读取必然失败，也不上报。
    if trades_action_available(name, surface, profile=profile):
        state["available_actions"].append("read_trades")
    return state


def _project(client) -> dict:
    """DiscoveredClient → JSON 安全原始类型。"""
    profile = client.profile
    return {
        "broker_id": profile.broker_id,
        "label": profile.label,
        "kernel": profile.kernel,
        "trader_type": profile.trader_type,
        "exe_path": str(client.exe_path),
        "main_dir": str(client.main_dir),
        "running": bool(client.running),
        "matched": bool(client.matched),
        "note": profile.note,
    }


_WINDOWS_DETECT_HINT = (
    "未在本机发现券商客户端。自动识别只覆盖同花顺内核的下单程序 xiadan.exe；"
    "银河、华泰、五矿、海通、国金、广发等专用客户端需要在后端 .env 中填写 EASYTRADER_CLIENT_PATH。"
)

_MAC_DETECT_HINT = (
    "未发现同花顺 Mac 版。请从官网下载并登录；首次读取需授予实际读取进程辅助功能权限。"
)


def _mac_clients() -> list[dict]:
    """macOS 的「本机交易客户端」只有一个候选：同花顺 Mac 版。

    .app 不存在时返回空列表而不是一条 matched=False 的记录：UI 把「有记录」
    当成「已发现」，给没装同花顺的用户列一行空路径只会误导。空列表会走
    通用的空态分支，由 _MAC_DETECT_HINT 说明该装什么、该授权什么。
    """
    from .holdings_providers.mac_ths import DEFAULT_APP_NAME, app_bundles, app_running, osascript_available

    app_name = settings.mac_ths_app_name or DEFAULT_APP_NAME
    bundles = app_bundles(app_name)
    if not bundles:
        return []
    return [
        {
            "broker_id": "mac_ths",
            "label": f"同花顺 Mac 版（{app_name}）",
            "kernel": "accessibility",
            "trader_type": "mac_ths",
            "exe_path": bundles[0],
            "main_dir": "/Applications",
            "running": app_running(app_name),
            "matched": True,
            "note": "首次需授予读取进程辅助功能权限",
        }
    ]


async def detect_clients(force: bool = False) -> dict:
    """扫描本机券商客户端；默认走 TTL 缓存，force=True 强制重扫。

    平台差异只体现在「能发现什么」：Windows 递归扫盘找 xiadan.exe，
    macOS 只认同花顺 Mac 版这一个客户端。空列表的提示文案也由后端给出，
    避免前端写死 Windows 的 xiadan.exe / EASYTRADER_CLIENT_PATH 引导。
    """
    global _DETECT_CACHE

    if sys.platform == "darwin":
        clients = _mac_clients()
        return {
            "clients": clients,
            "cached": False,
            "age_seconds": 0.0,
            "hint": None if clients else _MAC_DETECT_HINT,
        }

    now = time.monotonic()
    if _DETECT_CACHE is not None and not force:
        written_at, cached_clients = _DETECT_CACHE
        age = now - written_at
        if age < _DETECT_TTL_SECONDS:
            return {
                "clients": cached_clients,
                "cached": True,
                "age_seconds": round(age, 1),
                "hint": None if cached_clients else _WINDOWS_DETECT_HINT,
            }

    # 扫盘在独立线程里跑：默认 C~H 盘深度 3，UI 场景收窄一层。
    found = await asyncio.to_thread(discover_clients, None, 3)
    clients = [_project(c) for c in found]
    _DETECT_CACHE = (now, clients)
    return {
        "clients": clients,
        "cached": False,
        "age_seconds": 0.0,
        "hint": None if clients else _WINDOWS_DETECT_HINT,
    }


def sync_holdings() -> dict:
    """从所选真实/模拟账户拉取持仓并整体替换本地 store。

    Raises:
        ProviderUnavailable: 数据源不可用（未配置/未安装/客户端未运行）
        EmptyHoldingsError:  读回 0 条持仓，拒绝覆盖本地已有持仓
    """
    gate = platform_gate(settings.holdings_provider)
    if gate is not None:
        raise ProviderUnavailable(gate)

    provider = get_provider()
    label = _provider_label(provider)
    account_mode = current_account_mode()
    account_label = _ACCOUNT_LABELS[account_mode]
    items = provider.get_holdings()
    if not items:
        raise EmptyHoldingsError(
            f"{label} 未读回任何持仓，已取消同步以免清空本地持仓。"
            "请确认券商客户端已登录、窗口停留在「持仓」页，然后重试。"
        )

    store = JsonStore()
    payload = [item.model_dump() for item in items]
    snapshot = record_holdings_snapshot(store, payload, f"broker_{account_mode}")
    result = {
        "provider": getattr(provider, "name", settings.holdings_provider),
        "label": label,
        "account_mode": account_mode,
        "account_label": account_label,
        "saved": len(items),
        "items": [
            {"ticker": item.ticker, "quantity": item.quantity, "cost_price": item.cost_price}
            for item in items
        ],
    }
    if snapshot is not None:
        result["snapshot_id"] = snapshot["snapshot_id"]
        result["effective_at"] = snapshot["effective_at"]
    return result


def reset_cache() -> None:
    """清空发现缓存（测试用）。"""
    global _DETECT_CACHE
    _DETECT_CACHE = None


class PreviewConflict(Exception):
    """预览已过期、已使用或与当前事实不一致。"""


_PREVIEWS: dict[str, dict] = {}
_PREVIEW_LOCK = threading.Lock()
_PREVIEW_TTL = 300
_READ_LOCK = threading.Lock()
_NATIVE_READS: dict[str, threading.Event] = {}
_NATIVE_READS_LOCK = threading.Lock()


def _cancelled(cancelled) -> None:
    if cancelled is not None and cancelled():
        raise ProviderUnavailable("已取消读取，当前持仓保持不变。", "read_cancelled")


def preview_holdings(*, foreground: bool = False, expected_account: str | None = None,
                     cancelled=None) -> dict:
    """读取预览不落盘；foreground 仅由经宿主认证的原生入口传入。"""
    if not _READ_LOCK.acquire(blocking=False):
        raise ProviderUnavailable("另一次持仓读取正在进行，请稍后重试。", "busy")
    try:
        _cancelled(cancelled)
        mode = current_account_mode()
        name = settings.holdings_provider
        if expected_account is not None and expected_account != mode:
            raise ProviderUnavailable("账户选择已变化，请重新读取。", "account_changed")
        gate = platform_gate(name)
        if gate:
            raise ProviderUnavailable(gate, "unsupported_platform")
        provider = get_provider()
        store = JsonStore()
        previous = store.get("holdings", "default", []) or []
        details = None
        if name == "mac_ths":
            result_reader = getattr(provider, "read_holdings_result", None)
            if callable(result_reader):
                read_result = result_reader(
                    foreground=foreground, cancelled=cancelled
                )
                items = read_result.items
                details = {
                    "status": read_result.details_status,
                    "reason": read_result.details_reason,
                    "code": read_result.details_code,
                    "scope": read_result.details_scope,
                    "count": sum(len(item.trades) for item in items),
                }
            else:
                # 测试替身和旧的内嵌 provider 仍可走列表接口；生产 mac_ths 实现
                # 始终提供 read_holdings_result，不会丢失明细状态。
                items = provider.read_holdings(
                    foreground=foreground, cancelled=cancelled
                )
        elif name in _CLIENT_AUTOMATION_PROVIDERS:
            items = provider.read_holdings(foreground=foreground)
        else:
            items = provider.get_holdings()
        _cancelled(cancelled)
        if not items:
            raise EmptyHoldingsError("没有读到持仓，当前持仓保持不变。请确认账户与持仓页后重试。")
        if mode != current_account_mode() or name != settings.holdings_provider:
            raise ProviderUnavailable("读取期间账户或数据源发生变化，请重试。", "account_changed")
        read_at = datetime.now(timezone.utc).isoformat()
        previous_by_ticker = {item.get("ticker"): item for item in previous if isinstance(item, dict)}
        payload = []
        for item in items:
            value = item.model_dump()
            trades = value.get("trades") or []
            if trades:
                value["position_time"] = max(str(trade["executed_at"]) for trade in trades)
                value["time_source"] = "broker_detail"
                value["time_source_label"] = "券商明细"
            else:
                value["position_time"] = read_at
                value["time_source"] = "read_fallback"
                value["time_source_label"] = "读取时间兜底"
                previous_item = previous_by_ticker.get(value["ticker"])
                if previous_item and previous_item.get("time_source") == "user_modified":
                    value["position_time"] = previous_item.get("position_time")
                    value["time_source"] = "user_modified"
                    value["time_source_label"] = "用户修改"
            payload.append(value)
        token = secrets.token_urlsafe(32)
        readiness = (
            "partial"
            if details is not None and details["status"] == "unavailable"
            else "preview"
        )
        result = {"preview_token": token, "items": payload, "previous_count": len(previous),
                  "account_mode": mode, "account_label": _ACCOUNT_LABELS[mode], "provider": name,
                  "label": _provider_label(provider), "read_at": read_at,
                  "expires_in_seconds": _PREVIEW_TTL, "readiness": readiness, "session": "ready",
                  "surface": "electron" if foreground else "web", "platform": sys.platform}
        if details is not None:
            result["details"] = details
        history = store.get("holdings", "snapshots", []) or []
        latest = history[-1] if history else None
        result["changed"] = not holdings_snapshot_matches(latest, payload, "broker_" + mode)
        _cancelled(cancelled)
        with _PREVIEW_LOCK:
            now = time.monotonic()
            for key in list(_PREVIEWS):
                if _PREVIEWS[key]["expires"] <= now:
                    del _PREVIEWS[key]
            if len(_PREVIEWS) >= 32:
                del _PREVIEWS[next(iter(_PREVIEWS))]
            _PREVIEWS[token] = {"result": result, "previous": previous,
                                "root": str(store.base_dir.resolve()), "expires": now + _PREVIEW_TTL}
        return result
    finally:
        _READ_LOCK.release()


def commit_holdings(token: str, time_overrides: dict[str, str] | None = None) -> dict:
    """在同一存储事务内校验预览基线并保存；token 成功后仅可使用一次。"""
    with _READ_LOCK:
        with _PREVIEW_LOCK:
            preview = _PREVIEWS.get(token)
            if preview is None or preview["expires"] <= time.monotonic():
                raise PreviewConflict("预览已过期或已使用，请重新读取。")
            result = copy.deepcopy(preview["result"])
            store = JsonStore()
            if (result["account_mode"] != current_account_mode()
                    or result["provider"] != settings.holdings_provider
                    or preview["root"] != str(store.base_dir.resolve())):
                raise PreviewConflict("账户、数据源或数据目录已变化，请重新读取。")
            if time_overrides:
                for item in result["items"]:
                    replacement = time_overrides.get(item["ticker"])
                    if replacement is not None and item.get("time_source") != "broker_detail":
                        item["position_time"] = replacement
                        item["time_source"] = "user_modified"
                        item["time_source_label"] = "用户修改"
            previous_by_ticker = {item.get("ticker"): item for item in preview["previous"] if isinstance(item, dict)}
            for item in result["items"]:
                previous_item = previous_by_ticker.get(item["ticker"])
                if (item.get("time_source") == "read_fallback" and previous_item
                        and previous_item.get("time_source") == "user_modified"):
                    item["position_time"] = previous_item.get("position_time")
                    item["time_source"] = "user_modified"
                    item["time_source_label"] = "用户修改"
            with store.transaction():
                if (store.get("holdings", "default", []) or []) != preview["previous"]:
                    raise PreviewConflict("本地持仓已变化，请重新读取并确认替换范围。")
                history = store.get("holdings", "snapshots", []) or []
                previous_snapshot_id = history[-1].get("snapshot_id") if history else None
                snapshot = record_holdings_snapshot(store, result["items"], "broker_" + result["account_mode"])
            del _PREVIEWS[token]
            return {**result, "saved": len(result["items"]), "snapshot_id": snapshot["snapshot_id"] if snapshot else None,
                    "changed": bool(snapshot and snapshot["snapshot_id"] != previous_snapshot_id)}


def native_action(action: str, account_mode: str, client_path: str = "", preview_token: str = "",
                  time_overrides: dict[str, str] | None = None, operation_id: str = "") -> dict:
    """仅认证宿主可调用；启动路径经过固定应用名校验。"""
    import subprocess
    import os
    env = {key: value for key, value in os.environ.items()
           if not any(marker in key.upper() for marker in ("KEY", "SECRET", "TOKEN", "PASSWORD"))}
    if action == "cancel_read":
        if not operation_id:
            raise ProviderUnavailable("读取任务标识无效，请重试。", "invalid_operation")
        with _NATIVE_READS_LOCK:
            event = _NATIVE_READS.get(operation_id)
            if event is None:
                event = threading.Event()
                _NATIVE_READS[operation_id] = event
                while len(_NATIVE_READS) > 64:
                    del _NATIVE_READS[next(iter(_NATIVE_READS))]
            event.set()
        return {"canceled": True}
    if account_mode != current_account_mode():
        raise ProviderUnavailable("账户选择已变化，请重试。", "account_changed")
    if action == "read":
        if settings.holdings_provider not in _CLIENT_AUTOMATION_PROVIDERS:
            raise ProviderUnavailable("此数据源无需同花顺原生操作。", "unsupported_action")
        if not operation_id:
            raise ProviderUnavailable("读取任务标识无效，请重试。", "invalid_operation")
        event = threading.Event()
        with _NATIVE_READS_LOCK:
            if operation_id in _NATIVE_READS:
                pending = _NATIVE_READS[operation_id]
                if pending.is_set():
                    del _NATIVE_READS[operation_id]
                    raise ProviderUnavailable("已取消读取，当前持仓保持不变。", "read_cancelled")
                raise ProviderUnavailable("读取任务标识重复，请重试。", "invalid_operation")
            _NATIVE_READS[operation_id] = event
        try:
            return preview_holdings(foreground=True, expected_account=account_mode,
                                    cancelled=event.is_set)
        finally:
            with _NATIVE_READS_LOCK:
                if _NATIVE_READS.get(operation_id) is event:
                    del _NATIVE_READS[operation_id]
    if action == "read_trades":
        # 走原生通道而不是普通 /trades/sync，是因为 Windows 的另存为会抢焦点并可能弹
        # 风控验证码——那是需要用户本次同意的前台动作，不能由网页请求触发。
        # 函数内 import：trades_source 反向依赖本模块的 _READ_LOCK 等，模块级会成环。
        from .trades_source import preview_trades

        if settings.holdings_provider.strip().lower() not in _TRADES_PROVIDERS:
            raise ProviderUnavailable("当前数据源不支持读取成交明细。", "unsupported_action")
        return preview_trades(foreground=True, expected_account=account_mode)
    if action == "commit":
        if not preview_token:
            raise PreviewConflict("预览已过期，请重新读取。")
        return commit_holdings(preview_token, time_overrides)
    if action == "select_client" and sys.platform == "win32":
        path = Path(client_path).resolve(strict=True)
        if path.name.lower() != "xiadan.exe" or not path.is_file():
            raise ProviderUnavailable("请选择同花顺 xiadan.exe。", "invalid_client")
        import dotenv
        env_path = settings.user_config_dir / "backend.env"
        env_path.parent.mkdir(parents=True, exist_ok=True)
        key = "EASYTRADER_SIM_CLIENT_PATH" if account_mode == "simulated" else "EASYTRADER_CLIENT_PATH"
        dotenv.set_key(str(env_path), key, str(path), encoding="utf-8")
        setattr(settings, key.lower(), str(path))
        return {"readiness": "ready"}
    if action == "launch":
        if sys.platform == "darwin":
            from .holdings_providers.mac_ths import app_bundles
            bundles = app_bundles()
            if not bundles:
                raise ProviderUnavailable("请先安装同花顺。", "client_missing")
            subprocess.run(["/usr/bin/open", bundles[0]], check=True, timeout=10, env=env)
            return {"readiness": "ready"}
        if sys.platform == "win32":
            from .holdings_providers.easytrader import EasyTraderProvider
            path = Path(EasyTraderProvider()._client_path()).resolve(strict=True)
            if path.name.lower() != "xiadan.exe" or not path.is_file():
                raise ProviderUnavailable("请选择同花顺 xiadan.exe。", "invalid_client")
            subprocess.Popen([str(path)], cwd=str(path.parent), env=env)
            return {"readiness": "ready"}
    raise ProviderUnavailable("此平台不支持该动作。", "unsupported_action")
