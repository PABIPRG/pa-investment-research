# -*- coding: utf-8 -*-
"""成交明细的「读取预览 → 显式提交」服务层（产品 UI 用）。

镜像 holdings_source 的 preview/commit 契约，但有一处语义差别必须记住：

  持仓是**状态快照**，提交 = 整体替换；成交是**事件流**，提交 = 去重合并。
  所以这里的 previous 基线与冲突检测防的不是「替换范围变了」，而是「预览之后
  本地又并进了别的成交」——那种情况下把这批再合进去会得到与用户刚才看到的
  预览不一致的结果，必须让他重读。

三处刻意与 holdings_source 共享而不是各写一份：

  * `_READ_LOCK`：持仓读取与成交读取驱动的是同一个同花顺窗口
    （`_switch_left_menus`、`SetForegroundWindow`、`app.top_window()` 全是全局状态）。
    各自持一把锁就能并发，结果是互相读到对方的表——错数据，不是缺数据。
  * `platform_gate`：平台不匹配时的中文指引只该有一份。
  * `PreviewConflict`：两类预览的冲突语义相同（已过期/已使用/事实已变），
    上层的错误映射（`preview_conflict`）也共用一条分支。

清除动作走同一套 token：entries 是 append-only 且无上限，必须有一条退出通道，
但它同时也是「改变本地数据的动作」，要能撤销或可追溯——所以先预览影响范围、
再显式提交，而不是一个 DELETE 直接删。
"""

from __future__ import annotations

import secrets
import sys
import threading
import time
from datetime import datetime, timezone

from .config import settings
from .holdings_providers import get_provider
from .holdings_providers.base import ProviderUnavailable, current_account_mode
from .holdings_source import (
    _ACCOUNT_LABELS,
    _CLIENT_AUTOMATION_PROVIDERS,
    _READ_LOCK,
    PreviewConflict,
    _provider_label,
    platform_gate,
)
from .schemas import TradeItem
from .store import JsonStore
from .trades_store import apply_import, clear_entries, load_entries

_PREVIEWS: dict[str, dict] = {}
_PREVIEW_LOCK = threading.Lock()
_PREVIEW_TTL = 300


class EmptyTradesError(Exception):
    """数据源可用但读回 0 条成交——不写入任何记录。

    与 EmptyHoldingsError 的后果不同：清空持仓会毁掉现有数据，而合并空批次只是
    什么都不做。但两者都必须拒绝：读回 0 条更可能是「页没停对 / 日期范围没查到」
    而不是「这段时间真的没交易」，静默成功会让用户以为已经导进来了。
    """


def _current_provider_name() -> str:
    """当前数据源码。统一 strip+lower——provider_snapshot 与 get_provider 都按小写比对，
    这里若用原始值，配置里多一个空格就会让名单判断与重新校验前后不一致。"""
    return settings.holdings_provider.strip().lower()


def _expire_locked() -> None:
    """清掉过期预览；_PREVIEW_LOCK 必须已持有。"""
    now = time.monotonic()
    for key in list(_PREVIEWS):
        if _PREVIEWS[key]["expires"] <= now:
            del _PREVIEWS[key]


def _remember_locked(token: str, entry: dict) -> None:
    """登记一个预览；_PREVIEW_LOCK 必须已持有。"""
    now = time.monotonic()
    _expire_locked()
    if len(_PREVIEWS) >= 32:
        # 预览只用于「刚刚读到的那一批」，没有理由留更多；超限时丢最早的一条。
        del _PREVIEWS[next(iter(_PREVIEWS))]
    _PREVIEWS[token] = {**entry, "expires": now + _PREVIEW_TTL}


def preview_trades(*, foreground: bool = False, expected_account: str | None = None) -> dict:
    """读取成交明细并返回预览，不落盘。

    foreground 仅由经宿主认证的原生入口传入（见 holdings_source.native_action）。
    """
    if not _READ_LOCK.acquire(blocking=False):
        raise ProviderUnavailable("另一次券商读取正在进行，请稍后重试。", "busy")
    try:
        mode = current_account_mode()
        name = _current_provider_name()
        if expected_account is not None and expected_account != mode:
            raise ProviderUnavailable("账户选择已变化，请重新读取。", "account_changed")
        gate = platform_gate(name)
        if gate:
            raise ProviderUnavailable(gate, "unsupported_platform")
        provider = get_provider()
        store = JsonStore()
        previous = [trade.model_dump() for trade in load_entries(store)]
        if name in _CLIENT_AUTOMATION_PROVIDERS:
            items = provider.read_trades(foreground=foreground)
        else:
            items = provider.get_trades()
        if not items:
            raise EmptyTradesError(
                "没有读到成交明细。请确认券商客户端已登录、已进入「历史成交」页、"
                "并在客户端里查到了所选日期范围内的数据，然后重试。"
            )
        if mode != current_account_mode() or name != _current_provider_name():
            raise ProviderUnavailable("读取期间账户或数据源发生变化，请重试。", "account_changed")
        payload = [item.model_dump() for item in items]
        token = secrets.token_urlsafe(32)
        result = {
            "preview_token": token,
            "kind": "import",
            "items": payload,
            "previous_count": len(previous),
            "unclassified": sum(1 for item in items if item.side == "unclassified"),
            "account_mode": mode,
            "account_label": _ACCOUNT_LABELS[mode],
            "provider": name,
            "label": _provider_label(provider),
            "read_at": datetime.now(timezone.utc).isoformat(),
            "expires_in_seconds": _PREVIEW_TTL,
            "readiness": "preview",
            "session": "ready",
            "surface": "electron" if foreground else "web",
            "platform": sys.platform,
        }
        with _PREVIEW_LOCK:
            _remember_locked(token, {
                "result": result, "previous": previous, "kind": "import",
                "root": str(store.base_dir.resolve()),
            })
        return result
    finally:
        _READ_LOCK.release()


def preview_clear() -> dict:
    """预览「清空成交明细」的影响范围，不落盘。

    与读取预览共用 token 与冲突检测：清除会毁掉 append-only 的历史，在真正执行前
    必须让用户看到要删掉多少条、最后一次导入是什么时候。
    """
    if not _READ_LOCK.acquire(blocking=False):
        raise ProviderUnavailable("另一次券商读取正在进行，请稍后重试。", "busy")
    try:
        store = JsonStore()
        previous = [trade.model_dump() for trade in load_entries(store)]
        if not previous:
            raise EmptyTradesError("本地没有成交明细，无需清空。")
        document = store.all("trades")
        imports = document.get("imports") if isinstance(document.get("imports"), list) else []
        token = secrets.token_urlsafe(32)
        result = {
            "preview_token": token,
            "kind": "clear",
            "will_remove": len(previous),
            "last_import_at": imports[-1].get("read_at") if imports else None,
            "account_mode": current_account_mode(),
            "expires_in_seconds": _PREVIEW_TTL,
            "readiness": "preview",
            "surface": "web",
            "platform": sys.platform,
        }
        with _PREVIEW_LOCK:
            _remember_locked(token, {
                "result": result, "previous": previous, "kind": "clear",
                "root": str(store.base_dir.resolve()),
            })
        return result
    finally:
        _READ_LOCK.release()


def commit_trades(token: str) -> dict:
    """提交一个预览（导入或清空）；token 成功后仅可使用一次。"""
    with _READ_LOCK:
        with _PREVIEW_LOCK:
            preview = _PREVIEWS.get(token)
            if preview is None or preview["expires"] <= time.monotonic():
                raise PreviewConflict("预览已过期或已使用，请重新读取。")
            result = preview["result"]
            store = JsonStore()
            if (result["account_mode"] != current_account_mode()
                    or preview["root"] != str(store.base_dir.resolve())
                    or (preview["kind"] == "import"
                        and result["provider"] != _current_provider_name())):
                raise PreviewConflict("账户、数据源或数据目录已变化，请重新读取。")
            # 基线比对放在事务内：事务外比对完再进事务，两者之间仍有窗口，
            # 而这里的窗口会让「预览时看到的范围」与「实际合进去的范围」不一致。
            with store.transaction():
                if [t.model_dump() for t in load_entries(store)] != preview["previous"]:
                    raise PreviewConflict("本地成交明细已变化，请重新读取并确认导入范围。")
                payload = _apply_locked(store, preview)
            del _PREVIEWS[token]
            return {**result, **payload}


def _apply_locked(store: JsonStore, preview: dict) -> dict:
    """在事务内执行预览描述的动作（_READ_LOCK 与 _PREVIEW_LOCK 必须已持有）。"""
    result = preview["result"]
    if preview["kind"] == "clear":
        record = clear_entries(store)
        return {"cleared": True, "removed": record["removed"], "record": record}
    items = [TradeItem.model_validate(row) for row in result["items"]]
    applied = apply_import(
        store,
        incoming=items,
        source=result["provider"],
        account_mode=result["account_mode"],
        root=preview["root"],
        fetched=len(items),
    )
    return {
        "cleared": False,
        "saved": applied["added"],
        "added": applied["added"],
        "duplicates": applied["duplicates"],
        "unclassified": applied["unclassified"],
        # 键相同但内容不同：条目保留原样，把差异报出来供人工核对。
        "conflicts": applied["conflicts"],
        "record": applied["record"],
        "entries": applied["entries"],
    }


def reset_previews() -> None:
    """清空预览表（测试用）。"""
    with _PREVIEW_LOCK:
        _PREVIEWS.clear()
