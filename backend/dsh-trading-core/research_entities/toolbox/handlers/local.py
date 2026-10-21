# -*- coding: utf-8 -*-
"""本地实体库与用户集合工具：不触网也能工作。"""

from __future__ import annotations

from typing import Any

from ...models import EntityInstance
from ..contracts import ToolCall
from ..helpers import (
    empty,
    entity_code,
    first_entity,
    lookup_entity_by_code,
    lookup_entity_by_name,
    needs_authorization,
    ok,
    param_code,
    param_name,
    unavailable,
)


def _entity_payload(entity: EntityInstance) -> dict[str, Any]:
    return entity.model_dump(mode="json")


def _resolve_entity(call: ToolCall, *type_codes: str) -> EntityInstance | None:
    entity = first_entity(call, *type_codes)
    if entity is not None:
        return entity
    code = param_code(call)
    by_code = lookup_entity_by_code(call, code, *type_codes)
    if by_code is not None:
        return by_code
    return lookup_entity_by_name(call, param_name(call), *type_codes)


def security_lookup(call: ToolCall):
    entity = _resolve_entity(call, "ENTITY_01_01", "ENTITY_01_02", "ENTITY_01_04")
    if entity is None:
        code = param_code(call)
        name = param_name(call)
        return empty(
            call,
            reason=f"实体库中没有匹配的证券：{code or name or '未提供代码/名称'}",
            source="research_entities.repository",
        )
    return ok(
        call,
        data={
            "entity": _entity_payload(entity),
            "matched_by": "entity_repository",
            "verification": (
                "imported_unverified" if entity.status == "imported_unverified" else entity.status
            ),
        },
        source="research_entities.repository",
    )


def _industry_members(call: ToolCall, entity: EntityInstance, limit: int) -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    for company in call.ctx.entities_of_type("ENTITY_02_01", limit=6000):
        if any(
            relation.relation_type == "belongs_to_industry"
            and relation.target_entity_id == entity.entity_id
            for relation in company.relations
        ):
            members.append(
                {
                    "entity_id": company.entity_id,
                    "code": entity_code(company),
                    "name": company.canonical_name,
                    "market_cap": company.attributes.get("market_cap"),
                }
            )
            if len(members) >= limit:
                break
    return members


def industry_lookup(call: ToolCall):
    entity = _resolve_entity(call, "ENTITY_03_01")
    if entity is None:
        return empty(
            call,
            reason=f"实体库中没有匹配的行业：{param_name(call) or param_code(call) or '未提供名称'}",
            source="research_entities.repository",
        )
    data: dict[str, Any] = {
        "entity": _entity_payload(entity),
        "aliases": entity.aliases,
        "taxonomy": entity.attributes.get("taxonomy"),
    }
    if call.params.get("include_members"):
        limit = int(call.params.get("member_limit") or 200)
        data["members"] = _industry_members(call, entity, limit)
        data["member_count"] = len(data["members"])
        data["member_source"] = "本地 A 股名称表的行业字段（未核验）"
    return ok(call, data=data, source="research_entities.repository")


def theme_lookup(call: ToolCall):
    entity = _resolve_entity(call, "ENTITY_03_02", "ENTITY_04_01", "ENTITY_04_02")
    if entity is None:
        return empty(
            call,
            reason=(
                "实体库中没有匹配的主题："
                f"{param_name(call) or param_code(call) or '未提供名称'}；"
                "可先导入词典或改用标准主题名。"
            ),
            source="research_entities.gazetteers",
        )
    related = [
        {
            "target_entity_id": relation.target_entity_id,
            "relation_type": relation.relation_type,
            "source": relation.source,
        }
        for relation in entity.relations
    ]
    return ok(
        call,
        data={
            "entity": _entity_payload(entity),
            "aliases": entity.aliases,
            "related": related,
            "constituents_available": False,
        },
        source="research_entities.gazetteers",
        warnings=["本地主题词典只提供标准名与别名，不含成分股。"],
    )


def benchmark_lookup(call: ToolCall):
    from adapter.benchmark import candidate_benchmarks

    entity = first_entity(call)
    code = entity_code(entity) or param_code(call)
    if not code or len(code) != 6:
        return empty(call, reason="缺少数值证券代码，无法映射基准。", source="adapter.benchmark")
    candidates = candidate_benchmarks(code)
    from ..mappings import INDEX_DEFS

    by_sina = {item[1]: item for item in INDEX_DEFS.values()}
    records = []
    for benchmark_code, benchmark_name in candidates:
        normalized = benchmark_code.replace(".", "")
        entry = by_sina.get(normalized)
        records.append(
            {
                "benchmark_code": benchmark_code,
                "benchmark_name": benchmark_name,
                "csindex_code": entry[0] if entry else None,
                "sina_symbol": entry[1] if entry else normalized,
            }
        )
    return ok(call, records=records, source="adapter.benchmark")


def peer_group_builder(call: ToolCall):
    entity = first_entity(call, "ENTITY_02_01", "ENTITY_01_01")
    code = entity_code(entity) or param_code(call)
    if not code:
        return empty(call, reason="缺少公司/证券代码，无法构建可比组。", source="research_entities.repository")

    industry_id = None
    if entity is not None:
        for relation in entity.relations:
            if relation.relation_type == "belongs_to_industry":
                industry_id = relation.target_entity_id
                break
    if industry_id is None:
        security = lookup_entity_by_code(call, code)
        for relation in (security.relations if security else []):
            if relation.relation_type == "belongs_to_industry":
                industry_id = relation.target_entity_id
                break
        if industry_id is None and security is not None:
            industry_name = security.attributes.get("industry")
            industry_id = f"IND:CN:{industry_name}" if industry_name else None
    if industry_id is None:
        return empty(call, reason=f"{code} 没有行业归属，无法构建可比组。", source="research_entities.repository")

    limit = int(call.params.get("limit") or 20)
    peers: list[dict[str, Any]] = []
    for company in call.ctx.entities_of_type("ENTITY_02_01", limit=6000):
        if entity_code(company) == code:
            continue
        if any(
            relation.relation_type == "belongs_to_industry"
            and relation.target_entity_id == industry_id
            for relation in company.relations
        ):
            peers.append(
                {
                    "entity_id": company.entity_id,
                    "code": entity_code(company),
                    "name": company.canonical_name,
                    "market_cap": company.attributes.get("market_cap"),
                }
            )

    peers.sort(
        key=lambda item: float(item["market_cap"]) if item.get("market_cap") not in (None, "") else -1,
        reverse=True,
    )
    return ok(
        call,
        records=peers[:limit],
        data={"industry_entity_id": industry_id, "total_peers": len(peers)},
        source="research_entities.repository",
        warnings=["可比组按本地行业字段与市值排序，未做业务相似度核验。"],
    )


# ── 用户集合 ────────────────────────────────────────────────────────


def _collection_result(call: ToolCall, collection_type: str, label: str):
    collection = call.ctx.collection(collection_type)
    if collection is None:
        return unavailable(
            call,
            f"未配置{label}数据源，无法读取用户{label}。",
            source="adapter.store:local",
        )
    if collection.authorization_status != "authorized":
        return needs_authorization(
            call,
            f"{label}未授权或不可读（状态：{collection.authorization_status}），需用户明确授权后才能读取。",
        )
    records = []
    for entity_id in collection.member_entity_ids:
        entity = call.ctx.get_entity(entity_id)
        records.append(
            {
                "entity_id": entity_id,
                "code": entity_code(entity) or entity_id.rsplit(":", 1)[-1],
                "name": entity.canonical_name if entity else None,
            }
        )
    return ok(
        call,
        records=records,
        data={
            "collection_id": collection.collection_id,
            "collection_type": collection.collection_type,
            "authorization_status": collection.authorization_status,
            "source": collection.source,
        },
        source="adapter.store:local",
    )


def portfolio_lookup(call: ToolCall):
    result = _collection_result(call, "USER_PORTFOLIO", "持仓")
    if result.status in ("ok", "empty"):
        result.data.setdefault("members", result.data.get("records", []))
    return result


def watchlist_lookup(call: ToolCall):
    return _collection_result(call, "USER_WATCHLIST", "自选")


def _holdings_rows(ctx: Any) -> list[dict[str, Any]]:
    provider = ctx.collection_provider
    store = getattr(provider, "store", None)
    if store is None:
        return []
    try:
        rows = store.get("holdings", "default", [])
    except Exception:  # noqa: BLE001 - 本地文件损坏时按无明细处理
        return []
    return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []


def portfolio_risk_analysis(call: ToolCall):
    collection = call.ctx.collection("USER_PORTFOLIO")
    if collection is None:
        return unavailable(
            call, "未配置持仓数据源，无法做持仓风险分析。", source="adapter.store:local"
        )
    if collection.authorization_status != "authorized":
        return needs_authorization(
            call,
            f"持仓未授权或不可读（状态：{collection.authorization_status}），需用户明确授权。",
        )

    rows = _holdings_rows(call.ctx)
    positions: list[dict[str, Any]] = []
    total_cost = 0.0
    for row in rows:
        code = str(row.get("ticker", "")).strip()
        if len(code) != 6:
            continue
        shares = _number(row.get("shares") or row.get("quantity"))
        cost = _number(row.get("cost") or row.get("cost_price") or row.get("avg_cost"))
        value = shares * cost if shares is not None and cost is not None else None
        if value is not None:
            total_cost += value
        entity = lookup_entity_by_code(call, code)
        positions.append(
            {
                "entity_id": entity.entity_id if entity else None,
                "code": code,
                "name": entity.canonical_name if entity else row.get("name"),
                "shares": shares,
                "cost": cost,
                "cost_value": round(value, 2) if value is not None else None,
            }
        )

    warnings = []
    for item in positions:
        if item["cost_value"] is not None and total_cost > 0:
            item["cost_weight"] = round(item["cost_value"] / total_cost * 100, 4)
        else:
            item["cost_weight"] = None
    if not any(item["cost_value"] is not None for item in positions):
        warnings.append("持仓文件缺少股数/成本，无法计算权重，只返回成员清单。")
    else:
        warnings.append("权重按成本价市值计算，不是实时市值；未接入实时行情时不得当作当前仓位比例。")

    positions.sort(key=lambda item: item.get("cost_weight") or -1, reverse=True)
    top_weight = positions[0].get("cost_weight") if positions else None
    return ok(
        call,
        records=positions,
        data={
            "total_cost_value": round(total_cost, 2) if total_cost else None,
            "top_position_cost_weight": top_weight,
            "concentration_note": "单一标的高权重意味着集中度风险；需结合实时市值复核。",
            "resource": "/risk/portfolio",
        },
        source="adapter.store:local",
        warnings=warnings,
    )


def _number(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None
