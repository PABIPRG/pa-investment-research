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
import sys
import time

from .config import settings
from .holdings_providers import get_provider
from .holdings_providers.base import ProviderUnavailable, current_account_mode
from .holdings_providers.broker_profiles import discover_clients
from .portfolio_performance import record_holdings_snapshot
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
                "mac_ths 仅支持 macOS（同花顺 Mac 版 + AppleScript）。"
                "Windows 请改用 HOLDINGS_PROVIDER=easytrader。"
            )
        return None
    if sys.platform == "darwin":
        if name == "easytrader":
            return (
                "easytrader 依赖 pywinauto 操控 Win32 控件，仅支持 Windows。"
                "macOS 请改用 HOLDINGS_PROVIDER=mac_ths"
                "（同花顺 Mac 版 + AppleScript，需在系统设置中授予自动化与辅助功能权限）。"
            )
        return None
    return (
        f"当前平台 {sys.platform} 不支持券商客户端自动同步（仅支持 Windows / macOS）。"
        "请改用「导入持仓」手动维护。"
    )


def provider_snapshot() -> dict:
    """当前持仓数据源的配置快照（不扫盘、不抛错）。"""
    provider_name = settings.holdings_provider.strip().lower()
    snapshot: dict = {
        "provider": provider_name,
        "label": _PROVIDER_LABELS.get(provider_name, "未知数据源"),
        "available": False,
        "reason": None,
        "broker": getattr(settings, "easytrader_broker", "") or "",
        "client_type": getattr(settings, "easytrader_client_type", "") or "",
        "client_path": getattr(settings, "easytrader_client_path", "") or "",
        "account_mode": str(getattr(settings, "holdings_account_mode", "real") or "real"),
        "supported_account_modes": _ACCOUNT_MODE_SUPPORT.get(provider_name, ["real"]),
    }
    try:
        snapshot["account_mode"] = current_account_mode()
    except ProviderUnavailable as exc:
        snapshot["reason"] = str(exc)
        return snapshot
    gate = platform_gate(settings.holdings_provider)
    if gate is not None:
        snapshot["reason"] = gate
        return snapshot

    try:
        provider = get_provider()
    except Exception as exc:  # ValueError（未知 provider）或实例化期错误
        snapshot["reason"] = str(exc)
        return snapshot

    snapshot["label"] = _provider_label(provider)
    try:
        snapshot["available"] = bool(provider.is_available())
    except Exception as exc:
        snapshot["reason"] = str(exc)
        return snapshot

    if not snapshot["available"]:
        snapshot["reason"] = _unavailable_reason(provider)
    return snapshot


def _unavailable_reason(provider) -> str:
    """数据源不可用时，尽量给出可执行的中文原因（走 get_holdings 的前置校验）。"""
    try:
        provider.get_holdings()
    except ProviderUnavailable as exc:
        return str(exc)
    except Exception as exc:
        return str(exc)
    # is_available 为 False 但 get_holdings 没抛——理论上不会发生
    return "数据源当前不可用，请检查配置与客户端状态。"


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
    "未发现同花顺 Mac 版。macOS 上的持仓自动同步走 AppleScript 读同花顺 Mac 版"
    "（内置 80+ 券商账号登录），请先安装并登录同花顺，再在"
    "「系统设置 → 隐私与安全性」中授予本应用自动化与辅助功能权限。"
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
            "kernel": "apple_script",
            "trader_type": "mac_ths",
            "exe_path": bundles[0],
            "main_dir": "/Applications",
            "running": app_running(app_name),
            "matched": True,
            "note": "需在系统设置中授予自动化与辅助功能权限" if osascript_available() else "未找到 osascript",
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
