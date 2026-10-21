# -*- coding: utf-8 -*-
"""实体类型注册表：6 个一级类别、20 个二级类型。

编码一经发布不得随意变更；新增类型只能追加，不得复用旧编码。
动态集合是来源与集合管理机制，不是新的静态类型，单独定义在本文件末尾。
"""

from __future__ import annotations

from typing import Iterable

from ..models import EntityTypeDef

# 一级类别：编码 -> 名称
PARENT_CATEGORIES: dict[str, str] = {
    "ENTITY_01": "证券标的",
    "ENTITY_02": "公司主体",
    "ENTITY_03": "行业与产业",
    "ENTITY_04": "主题与催化",
    "ENTITY_05": "资金与市场风格",
    "ENTITY_06": "宏观与大宗商品",
}


def _type(
    code: str,
    parent: str,
    name: str,
    description: str,
    priority: str,
    keys: list[str],
    tools: list[str],
) -> EntityTypeDef:
    return EntityTypeDef(
        type_code=code,
        parent_code=parent,
        type_name=name,
        description=description,
        priority=priority,  # type: ignore[arg-type]
        is_dynamic=False,
        normalization_keys=keys,
        default_tool_ids=tools,
    )


_ENTITY_TYPES: list[EntityTypeDef] = [
    # ── ENTITY_01 证券标的 ──────────────────────────────────────────
    _type(
        "ENTITY_01_01", "ENTITY_01", "A股股票",
        "在中国境内证券交易所上市交易的 A 股股票。",
        "P0",
        ["security_code", "exchange", "security_name"],
        ["security_lookup", "quote_history", "financials_lookup", "announcement_search"],
    ),
    _type(
        "ENTITY_01_02", "ENTITY_01", "ETF／指数基金",
        "场内 ETF、指数基金等基金份额。",
        "P0",
        ["fund_code", "fund_name", "tracked_index"],
        ["fund_lookup", "fund_holdings_lookup", "fund_performance_lookup"],
    ),
    _type(
        "ENTITY_01_03", "ENTITY_01", "宽基指数／行业指数",
        "由指数编制机构发布的宽基或行业指数。",
        "P0",
        ["index_code", "index_name", "compiler"],
        ["index_lookup", "index_constituents_lookup", "index_performance_lookup"],
    ),
    _type(
        "ENTITY_01_04", "ENTITY_01", "可转债",
        "上市公司发行的可转换公司债券。",
        "P0",
        ["bond_code", "bond_name", "issuer_entity_id"],
        ["convertible_bond_lookup", "bond_terms_lookup"],
    ),
    # ── ENTITY_02 公司主体 ──────────────────────────────────────────
    _type(
        "ENTITY_02_01", "ENTITY_02", "上市公司",
        "具有独立法人身份的上市公司主体；与证券标的分开建模。",
        "P0",
        ["company_code", "legal_name", "security_ids"],
        ["company_profile", "financials_lookup", "announcement_search"],
    ),
    _type(
        "ENTITY_02_02", "ENTITY_02", "子公司／关联公司",
        "上市公司旗下子公司、参股企业或其他关联公司。",
        "P0",
        ["company_code", "parent_company_id", "holding_ratio"],
        ["company_relationship_lookup", "company_profile"],
    ),
    _type(
        "ENTITY_02_03", "ENTITY_02", "实际控制人／核心管理人员",
        "上市公司的实际控制人、董事长、总经理等核心人员。",
        "P0",
        ["person_code", "company_id", "role", "tenure"],
        ["company_governance_lookup", "company_relationship_lookup"],
    ),
    # ── ENTITY_03 行业与产业 ────────────────────────────────────────
    _type(
        "ENTITY_03_01", "ENTITY_03", "标准行业",
        "按标准行业分类体系划分的行业。",
        "P0",
        ["industry_code", "industry_name", "taxonomy"],
        ["industry_lookup", "industry_performance_lookup"],
    ),
    _type(
        "ENTITY_03_02", "ENTITY_03", "细分赛道／主题产业",
        "跨行业边界的技术或产业主题，如固态电池、人形机器人。",
        "P0",
        ["theme_code", "theme_name", "aliases", "boundary"],
        ["theme_lookup", "theme_constituents_lookup", "industry_chain_lookup"],
    ),
    _type(
        "ENTITY_03_03", "ENTITY_03", "产业链环节",
        "产业链中的上游、中游、下游环节或具体零部件。",
        "P0",
        ["chain_code", "segment_name", "upstream_downstream"],
        ["industry_chain_lookup", "company_relationship_lookup"],
    ),
    # ── ENTITY_04 主题与催化 ────────────────────────────────────────
    _type(
        "ENTITY_04_01", "ENTITY_04", "产业趋势主题",
        "跨越单一事件的产业趋势判断，如 AI 算力需求增长。",
        "P0",
        ["trend_code", "definition", "effective_period"],
        ["theme_lookup", "event_timeline_lookup", "announcement_search"],
    ),
    _type(
        "ENTITY_04_02", "ENTITY_04", "政策主题",
        "由政府部门发布或拟定的政策方向。",
        "P0",
        ["policy_theme_code", "issuer", "scope"],
        ["policy_search", "official_document_search"],
    ),
    _type(
        "ENTITY_04_03", "ENTITY_04", "公司事件",
        "与具体公司相关的事件，如业绩预告、并购、回购。",
        "P0",
        ["event_code", "company_id", "event_time"],
        ["announcement_search", "event_timeline_lookup"],
    ),
    _type(
        "ENTITY_04_04", "ENTITY_04", "宏观／监管事件",
        "具体发生的宏观或监管事件，如某次降息、监管新规。",
        "P0",
        ["event_code", "event_category", "event_time"],
        ["macro_event_search", "official_document_search"],
    ),
    # ── ENTITY_05 资金与市场风格 ────────────────────────────────────
    _type(
        "ENTITY_05_01", "ENTITY_05", "资金流向实体",
        "北向资金、融资余额、龙虎榜等资金观察对象。",
        "P1",
        ["flow_type", "statistic_scope", "time_range"],
        ["capital_flow_lookup", "margin_balance_lookup", "dragon_tiger_lookup"],
    ),
    _type(
        "ENTITY_05_02", "ENTITY_05", "市场风格",
        "高股息、小微盘、价值、成长等市场风格。",
        "P1",
        ["style_code", "rules", "scope"],
        ["style_performance_lookup", "style_constituents_lookup"],
    ),
    _type(
        "ENTITY_05_03", "ENTITY_05", "可比基准实体",
        "用于比较的基准指数或同业组合。",
        "P1",
        ["benchmark_code", "comparison_scope", "time_range"],
        ["benchmark_lookup", "benchmark_performance_lookup"],
    ),
    # ── ENTITY_06 宏观与大宗商品 ────────────────────────────────────
    _type(
        "ENTITY_06_01", "ENTITY_06", "宏观因子",
        "CPI、PMI、DR007、汇率等连续变化的宏观变量。",
        "P1",
        ["indicator_code", "issuer", "frequency", "unit"],
        ["macro_series_lookup", "macro_event_search"],
    ),
    _type(
        "ENTITY_06_02", "ENTITY_06", "大宗商品／产品品类",
        "碳酸锂、生猪、铜、原油等商品或产品价格品类。",
        "P1",
        ["commodity_code", "specification", "market", "quote_basis"],
        ["commodity_price_lookup", "supply_demand_lookup", "inventory_lookup"],
    ),
    _type(
        "ENTITY_06_03", "ENTITY_06", "区域主题",
        "海南自贸港、长三角、大湾区等区域主题。",
        "P1",
        ["region_code", "spatial_scope", "policies"],
        ["regional_policy_search", "theme_lookup"],
    ),
]


ENTITY_TYPE_REGISTRY: dict[str, EntityTypeDef] = {
    item.type_code: item for item in _ENTITY_TYPES
}


# 动态集合：来源与集合管理机制，不占用静态二级编码。
DYNAMIC_COLLECTION_DEFINITIONS: dict[str, dict[str, object]] = {
    "USER_PORTFOLIO": {
        "collection_type": "USER_PORTFOLIO",
        "name": "用户持仓",
        "description": "用户当前持有的证券集合，来自经授权的账户或持仓数据。",
        "default_tool_ids": ["portfolio_lookup", "portfolio_risk_analysis"],
        "requires_authorization": True,
    },
    "USER_WATCHLIST": {
        "collection_type": "USER_WATCHLIST",
        "name": "用户自选",
        "description": "用户关注的证券或主题集合，来自经授权的自选数据。",
        "default_tool_ids": ["watchlist_lookup", "event_monitor_setup"],
        "requires_authorization": True,
    },
    "DYNAMIC_COMPARABLES": {
        "collection_type": "DYNAMIC_COMPARABLES",
        "name": "动态可比对象",
        "description": "按行业、业务、规模等规则生成的可比对象集合。",
        "default_tool_ids": ["peer_group_builder", "benchmark_lookup"],
        "requires_authorization": False,
    },
    "TASK_GENERATED_SET": {
        "collection_type": "TASK_GENERATED_SET",
        "name": "任务生成集合",
        "description": "当前研究过程中筛选得到的对象集合。",
        "default_tool_ids": [],
        "requires_authorization": False,
    },
}


def get_entity_type(type_code: str) -> EntityTypeDef:
    try:
        return ENTITY_TYPE_REGISTRY[type_code]
    except KeyError as exc:
        raise KeyError(f"未注册的实体类型: {type_code}") from exc


def validate_entity_type_registry(
    types: Iterable[EntityTypeDef] | None = None,
) -> list[str]:
    """返回注册表问题列表；空列表表示通过。"""

    items = list(types if types is not None else ENTITY_TYPE_REGISTRY.values())
    problems: list[str] = []
    seen: set[str] = set()
    parents = set(PARENT_CATEGORIES)
    for item in items:
        if item.type_code in seen:
            problems.append(f"重复实体类型编码: {item.type_code}")
        seen.add(item.type_code)
        if item.parent_code not in parents:
            problems.append(f"{item.type_code} 的父类型不存在: {item.parent_code}")
        if item.is_dynamic:
            problems.append(f"{item.type_code} 是静态注册表条目，不得标记 is_dynamic")
        if item.status not in ("active", "inactive", "deprecated"):
            problems.append(f"{item.type_code} 状态非法: {item.status}")
    missing = set(ENTITY_TYPE_REGISTRY) - seen
    for code in sorted(missing):
        problems.append(f"缺少实体类型: {code}")
    if len(seen) != 20:
        problems.append(f"二级实体类型数量应为 20，实际 {len(seen)}")
    return problems
