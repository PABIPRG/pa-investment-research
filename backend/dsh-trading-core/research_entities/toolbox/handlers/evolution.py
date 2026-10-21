# -*- coding: utf-8 -*-
"""策略自进化工具：策略池状态、影子归因与待确认预案（只读）。

能力由 trading-core 的 ``/evolution/*`` 提供；服务未启动时返回 unavailable，
绝不伪造策略结论。应用预案属于写动作，工具层不提供——升级/降级/淘汰/变异
必须由用户确认，或由已授权的闭环调度执行。
"""

from __future__ import annotations

from typing import Any

from ..context import ToolUnavailable
from ..contracts import ToolCall
from ..helpers import ok, unavailable

SOURCE = "trading-core:/evolution"


def _strategy_id(call: ToolCall) -> str | None:
    for key in ("strategy_id", "sid", "id"):
        value = call.params.get(key)
        if value not in (None, ""):
            return str(value).strip()
    for entity_id in call.request.entity_ids:
        if entity_id.startswith("strategy:") and entity_id != "strategy_pool":
            candidate = entity_id.split(":", 1)[1].strip()
            if candidate:
                return candidate
    return None


def _get(call: ToolCall, path: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = call.ctx.http_get(f"{call.ctx.evolution_url}{path}", params)
    except ToolUnavailable as exc:
        raise ToolUnavailable(f"策略自进化服务不可用：{exc}") from exc
    if not isinstance(payload, dict):
        raise ToolUnavailable("策略自进化服务返回了非对象结果")
    return payload


def strategy_pool_lookup(call: ToolCall):
    """策略池阶段与影子数据是否就绪。"""

    strategy_id = _strategy_id(call)
    try:
        payload = _get(
            call,
            "/evolution/status",
            {"strategy_id": strategy_id, "include_history": "false"},
        )
    except ToolUnavailable as exc:
        return unavailable(call, str(exc), source=SOURCE)

    records = [
        dict(item)
        for item in payload.get("per_strategy") or []
        if isinstance(item, dict)
    ]
    data = {
        "as_of": payload.get("as_of"),
        "ready": payload.get("ready"),
        "days_of_data": payload.get("days_of_data"),
        "min_days": payload.get("min_days"),
        "counts": payload.get("counts") or {},
        "note": payload.get("note"),
        "last_applied_at": payload.get("last_applied_at"),
        "recent_run_at": payload.get("recent_run_at"),
        "next_scheduled_run_at": payload.get("next_scheduled_run_at"),
        "strategy_id": strategy_id,
    }
    warnings = [payload["note"]] if payload.get("note") else []
    return ok(call, records=records, data=data, source=SOURCE, warnings=warnings)


def strategy_attribution_lookup(call: ToolCall):
    """影子组合整体归因与每策略贡献；数据不足时如实说明。"""

    strategy_id = _strategy_id(call)
    try:
        payload = _get(
            call, "/evolution/attribution", {"strategy_id": strategy_id}
        )
    except ToolUnavailable as exc:
        return unavailable(call, str(exc), source=SOURCE)

    records = [
        dict(item)
        for item in payload.get("strategies") or []
        if isinstance(item, dict)
    ]
    data = {
        "as_of": payload.get("as_of"),
        "days_of_data": payload.get("days_of_data"),
        "min_days": payload.get("min_days"),
        "data_note": payload.get("data_note"),
        "overall": payload.get("overall"),
        "strategy_id": strategy_id,
    }
    warnings = [payload["data_note"]] if payload.get("data_note") else []
    return ok(call, records=records, data=data, source=SOURCE, warnings=warnings)


def strategy_evolution_preview(call: ToolCall):
    """当前待确认的进化预案（只读，不含应用入口）。"""

    strategy_id = _strategy_id(call)
    try:
        payload = _get(call, "/evolution/preview", {"strategy_id": strategy_id})
    except ToolUnavailable as exc:
        return unavailable(call, str(exc), source=SOURCE)

    actions = [
        dict(item) for item in payload.get("actions") or [] if isinstance(item, dict)
    ]
    data = {
        "preview_status": payload.get("preview_status") or "none",
        "valid": payload.get("valid"),
        "strategy_id": strategy_id,
        "expires_at": payload.get("expires_at"),
        "note": "只读预案；应用升级/降级/淘汰/变异必须由用户确认。",
    }
    if actions:
        return ok(call, records=actions, data=data, source=SOURCE)
    return ok(call, records=[], data={**data, "reason": "当前没有待确认的进化预案"}, source=SOURCE)
