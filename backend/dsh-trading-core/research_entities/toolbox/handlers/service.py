# -*- coding: utf-8 -*-
"""兄弟服务工具：industry-chain（产业链）与 market-watch（监控写入）。

服务未启动时返回 unavailable，绝不伪造服务结果。
"""

from __future__ import annotations

from typing import Any

from ...models import EntityInstance
from ..context import ToolUnavailable
from ..contracts import ToolCall
from ..helpers import (
    empty,
    entity_code,
    entity_name,
    first_entity,
    needs_authorization,
    ok,
    param_code,
    param_name,
    unavailable,
)


def _local_chain_records(call: ToolCall, entity: EntityInstance | None) -> list[dict[str, Any]]:
    if entity is None:
        return []
    records: list[dict[str, Any]] = []
    for relation in entity.relations:
        records.append(
            {
                "subject_entity_id": entity.entity_id,
                "target_entity_id": relation.target_entity_id,
                "relation_type": relation.relation_type,
                "source": relation.source,
            }
        )
    return records


def _search_companies(call: ToolCall, keyword: str) -> tuple[list[dict], str | None]:
    try:
        payload = call.ctx.http_get(
            f"{call.ctx.industry_chain_url}/companies",
            {"keyword": keyword, "limit": 5},
        )
    except ToolUnavailable as exc:
        return [], f"按名称解析公司代码失败：{exc}"
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [item for item in items if isinstance(item, dict)], None


def _resolve_code_by_name(
    call: ToolCall, name: str | None
) -> tuple[str | None, list[str]]:
    """行业/主题实体没有证券代码时，用产业链服务按名称找代表公司。

    这只是"代表公司"映射，不等于主题成分股；调用方必须披露该限制。
    """

    if not name:
        return None, []
    items, warning = _search_companies(call, name)
    if warning:
        return None, [warning]
    if not items:
        return None, [f"产业链服务没有与「{name}」匹配的公司。"]
    exact = next(
        (
            item
            for item in items
            if str(item.get("name") or "").strip() == name.strip()
        ),
        None,
    )
    chosen = exact or items[0]
    code = str(chosen.get("code") or "").strip()
    if not code:
        return None, [f"产业链服务返回了「{name}」的匹配项，但没有可用证券代码。"]
    return code, [
        f"实体没有绑定证券代码，按名称检索到代表公司 {chosen.get('name') or code}"
        f"（{code}）；结果只代表该公司，不代表整个行业或主题。"
    ]


def industry_chain_lookup(call: ToolCall):
    entity = first_entity(call, "ENTITY_03_03", "ENTITY_03_02", "ENTITY_02_01", "ENTITY_02_02")
    code = entity_code(entity) or param_code(call)
    name = entity_name(entity) or param_name(call)
    local = _local_chain_records(call, entity)
    warnings: list[str] = []

    if not code:
        code, resolve_warnings = _resolve_code_by_name(call, name)
        warnings.extend(resolve_warnings)

    external: Any = None
    service_source = "industry-chain:/graph/chain"
    if code:
        try:
            external = call.ctx.http_get(
                f"{call.ctx.industry_chain_url}/graph/chain/{code}",
                {
                    "depth_up": int(call.params.get("depth_up") or 2),
                    "depth_down": int(call.params.get("depth_down") or 2),
                    "top_up": int(call.params.get("top_up") or 3),
                    "top_down": int(call.params.get("top_down") or 2),
                },
            )
        except ToolUnavailable as exc:
            warnings.append(f"产业链展开不可用：{exc}")
            # 非图谱核心公司没有 /graph/chain，但 /graph/entity 会聚合
            # 该公司在图中的供应商/客户关系，作为降级来源。
            try:
                external = call.ctx.http_get(
                    f"{call.ctx.industry_chain_url}/graph/entity/{code}"
                )
                service_source = "industry-chain:/graph/entity"
                warnings.append("该公司不是图谱核心节点，返回聚合关系档案而非分层链路。")
            except ToolUnavailable as entity_exc:
                warnings.append(f"产业链实体档案也不可用：{entity_exc}")

    if external is None and local:
        return ok(
            call,
            records=local,
            data={"entity_id": entity.entity_id if entity else None, "fallback": "local_relations"},
            source="research_entities.repository",
            warnings=warnings + ["产业链服务不可用，仅返回实体库中的直接关系，未展开多层链路。"],
        )
    if external is None and not local:
        if code:
            reason = "产业链服务不可用，且实体库没有可用的链路关系；无法回答产业链问题。"
        else:
            reason = (
                f"实体 {name or entity.entity_id if entity else name or '未知'} "
                "没有可映射的证券代码，按名称也没有找到代表公司；"
                "无法查询产业链图谱，请补充 code 参数。"
            )
        return unavailable(call, reason, source="industry-chain")

    node_count = None
    if isinstance(external, dict):
        for key in ("nodes", "layers", "items"):
            value = external.get(key)
            if isinstance(value, list):
                node_count = len(value)
                break
    return ok(
        call,
        data={
            "entity_id": entity.entity_id if entity else None,
            "code": code,
            "name": name,
            "node_count": node_count,
            "chain": external,
            "local_relations": local,
        },
        source=service_source,
        warnings=warnings,
    )


_ALERT_FIELDS = ("price", "pct_change", "volume_ratio", "amount", "turnover")
_ALERT_OPERATORS = (">", ">=", "<", "<=")


def event_monitor_setup(call: ToolCall):
    if not call.request.authorized:
        return needs_authorization(
            call, "设置事件监控会在盯盘服务写入规则，需要用户明确授权后才能执行。"
        )
    code = param_code(call) or entity_code(first_entity(call, "ENTITY_01_01"))
    if not code:
        return empty(call, reason="缺少要监控的证券代码。", source="market-watch:/alerts")

    field = str(call.params.get("field") or "").strip()
    operator = str(call.params.get("operator") or "").strip()
    raw_value = call.params.get("value")
    # 兼容旧参数：condition 可以写成 "pct_change>=5" 或直接写字段名。
    condition = str(call.params.get("condition") or "").strip()
    if condition and (not field or not operator):
        for candidate in _ALERT_OPERATORS:
            if candidate in condition:
                left, right = condition.split(candidate, 1)
                field = field or left.strip()
                operator = operator or candidate
                if raw_value in (None, "") and right.strip():
                    raw_value = right.strip()
                break
        else:
            field = field or condition
    field = field or "pct_change"
    operator = operator or ">="
    if field not in _ALERT_FIELDS or operator not in _ALERT_OPERATORS:
        return empty(
            call,
            reason=(
                f"不支持的监控条件：{field}{operator}；"
                f"field 只能是 {_ALERT_FIELDS}，operator 只能是 {_ALERT_OPERATORS}。"
            ),
            source="market-watch:/alerts",
        )
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return empty(
            call,
            reason="缺少可解析的监控阈值 value。",
            source="market-watch:/alerts",
        )

    payload = {
        "name": str(call.params.get("name") or f"{code} 研究监控"),
        "ticker": code,
        "enabled": True,
        "time_frame": str(call.params.get("time_frame") or "trading"),
        "combine": str(call.params.get("combine") or "or"),
        "conditions": [
            {"field": field, "operator": operator, "value": value}
        ],
        "cooldown_min": int(call.params.get("cooldown_min") or 0),
        "daily_cap": int(call.params.get("daily_cap") or 0),
    }
    try:
        created = call.ctx.http_post(f"{call.ctx.market_watch_url}/alerts", payload)
    except ToolUnavailable as exc:
        return unavailable(
            call,
            f"盯盘服务不可用，未写入任何监控规则：{exc}",
            source="market-watch:/alerts",
        )
    return ok(
        call,
        data={"created": created, "request": payload},
        source="market-watch:/alerts",
    )


def company_service_lookup(call: ToolCall):
    """产业链服务的公司节点查询（company_profile 的服务端补充）。"""

    code = param_code(call) or entity_code(first_entity(call, "ENTITY_02_01"))
    warnings: list[str] = []
    if not code:
        name = param_name(call) or entity_name(first_entity(call, "ENTITY_02_01"))
        code, warnings = _resolve_code_by_name(call, name)
    if not code:
        detail = "；".join(warnings) if warnings else "缺少公司代码"
        return empty(
            call,
            reason=f"{detail}；无法查询产业链服务的公司档案。",
            source="industry-chain:/companies",
        )
    try:
        payload = call.ctx.http_get(f"{call.ctx.industry_chain_url}/companies/{code}")
        source = "industry-chain:/companies"
    except ToolUnavailable as exc:
        # /companies 只覆盖图谱核心公司；非核心 A 股回退到聚合档案。
        try:
            payload = call.ctx.http_get(f"{call.ctx.industry_chain_url}/graph/entity/{code}")
            source = "industry-chain:/graph/entity"
        except ToolUnavailable:
            return unavailable(call, str(exc), source="industry-chain:/companies")
    return ok(
        call,
        data={"profile": payload, "code": code},
        source=source,
        warnings=warnings,
    )


def company_search_service(call: ToolCall):
    keyword = param_name(call)
    if not keyword:
        return empty(call, reason="缺少检索关键词。", source="industry-chain:/companies")
    try:
        payload = call.ctx.http_get(
            f"{call.ctx.industry_chain_url}/companies",
            {"keyword": keyword, "limit": int(call.params.get("limit") or 20)},
        )
    except ToolUnavailable as exc:
        return unavailable(call, str(exc), source="industry-chain:/companies")
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return ok(call, records=items, data={"keyword": keyword}, source="industry-chain:/companies")
