# -*- coding: utf-8 -*-
"""研究意图注册表与轻量规则分类器。

本版只服务 Scope 构建与工具映射，不承诺完整的生产级意图体系。
分类结果必须保留置信度，并与实体识别分开：识别到实体不代表意图成立。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import IntentItem


@dataclass(frozen=True)
class IntentDefinition:
    intent_code: str
    name: str
    description: str
    keywords: tuple[tuple[str, float], ...] = field(default_factory=tuple)
    preferred_entity_types: tuple[str, ...] = field(default_factory=tuple)
    required_tools: tuple[str, ...] = field(default_factory=tuple)
    optional_tools: tuple[str, ...] = field(default_factory=tuple)
    required_dimensions: tuple[str, ...] = field(default_factory=tuple)


INTENT_REGISTRY: dict[str, IntentDefinition] = {
    "STOCK_ANALYSIS": IntentDefinition(
        "STOCK_ANALYSIS", "个股分析",
        "分析单只股票或上市公司的投资价值、基本面与风险。",
        keywords=(("分析", 0.3), ("投资价值", 0.7), ("值不值得", 0.6), ("基本面", 0.5),
                  ("估值", 0.4), ("走势", 0.3), ("怎么样", 0.4)),
        preferred_entity_types=("ENTITY_01_01", "ENTITY_02_01"),
        required_tools=("quote_history", "financials_lookup"),
        optional_tools=(
            "company_profile",
            "announcement_search",
            "dividend_history_lookup",
            "shareholder_count_lookup",
        ),
        required_dimensions=("price", "fundamentals", "valuation"),
    ),
    "INDUSTRY_RELATION_ANALYSIS": IntentDefinition(
        "INDUSTRY_RELATION_ANALYSIS", "产业链关联分析",
        "分析公司与产业链、主题或环节之间的业务关系。",
        keywords=(("产业链", 0.8), ("关系", 0.5), ("相关", 0.3), ("布局", 0.5),
                  ("上下游", 0.7), ("环节", 0.5), ("映射", 0.4)),
        preferred_entity_types=("ENTITY_03_02", "ENTITY_03_03", "ENTITY_02_01"),
        required_tools=("company_profile", "industry_chain_lookup"),
        optional_tools=("announcement_search", "theme_lookup"),
        required_dimensions=("business_scope", "chain_position", "evidence"),
    ),
    "INDUSTRY_RESEARCH": IntentDefinition(
        "INDUSTRY_RESEARCH", "行业研究",
        "研究行业格局、景气度与代表公司。",
        keywords=(("行业", 0.7), ("板块", 0.5), ("赛道", 0.5), ("格局", 0.5),
                  ("景气", 0.6), ("产业链", 0.3)),
        preferred_entity_types=("ENTITY_03_01", "ENTITY_03_02"),
        required_tools=("industry_lookup",),
        optional_tools=("theme_lookup", "industry_chain_lookup", "industry_performance_lookup"),
        required_dimensions=("industry_scope", "representative_companies"),
    ),
    "COMPANY_COMPARISON": IntentDefinition(
        "COMPANY_COMPARISON", "公司比较",
        "对比两家或多家公司在产业链、财务、估值等维度的差异。",
        keywords=(("对比", 0.8), ("比较", 0.8), ("差异", 0.7), ("区别", 0.7),
                  ("二者", 0.6), ("哪个更好", 0.7), ("vs", 0.5)),
        preferred_entity_types=("ENTITY_02_01", "ENTITY_01_01"),
        required_tools=("financials_lookup", "quote_history"),
        optional_tools=("company_profile",),
        required_dimensions=("comparison_targets", "financials", "valuation"),
    ),
    "THEME_RESEARCH": IntentDefinition(
        "THEME_RESEARCH", "主题研究",
        "研究产业趋势主题的定义、边界与影响。",
        keywords=(("主题", 0.6), ("趋势", 0.6), ("产业趋势", 0.7), ("渗透率", 0.6),
                  ("产业化", 0.6)),
        preferred_entity_types=("ENTITY_03_02", "ENTITY_04_01"),
        required_tools=("theme_lookup",),
        optional_tools=("industry_chain_lookup", "event_timeline_lookup"),
        required_dimensions=("theme_definition", "drivers", "beneficiaries"),
    ),
    "POLICY_CATALYST_SEARCH": IntentDefinition(
        "POLICY_CATALYST_SEARCH", "政策催化",
        "识别与研究对象相关的政策催化、发布状态与证据等级。",
        keywords=(("政策", 0.8), ("催化", 0.7), ("补贴", 0.7), ("扶持", 0.6),
                  ("规划", 0.5), ("监管", 0.4)),
        preferred_entity_types=("ENTITY_04_02", "ENTITY_04_04", "ENTITY_03_02"),
        required_tools=("policy_search",),
        optional_tools=("official_document_search", "event_timeline_lookup"),
        required_dimensions=("policy_items", "issuer", "evidence_level"),
    ),
    "PORTFOLIO_ANALYSIS": IntentDefinition(
        "PORTFOLIO_ANALYSIS", "持仓分析",
        "分析用户持仓的构成、相关性与跟踪需求。",
        keywords=(("我的持仓", 0.9), ("我持仓", 0.9), ("持仓里", 0.8), ("持仓", 0.6),
                  ("仓位", 0.5)),
        preferred_entity_types=("ENTITY_01_01", "ENTITY_02_01"),
        required_tools=("portfolio_lookup",),
        optional_tools=("quote_history", "financials_lookup"),
        required_dimensions=("portfolio_members", "positions"),
    ),
    "PORTFOLIO_RISK_ANALYSIS": IntentDefinition(
        "PORTFOLIO_RISK_ANALYSIS", "持仓风险分析",
        "分析用户持仓的风险暴露、集中度与预警。",
        keywords=(("持仓风险", 1.0), ("组合风险", 0.9), ("仓位风险", 0.9),
                  ("风险敞口", 0.7), ("回撤", 0.5)),
        preferred_entity_types=("ENTITY_01_01", "ENTITY_05_02"),
        required_tools=("portfolio_lookup", "portfolio_risk_analysis"),
        optional_tools=("quote_history",),
        required_dimensions=("portfolio_members", "risk_metrics", "time_range"),
    ),
    "MACRO_SCENARIO_ANALYSIS": IntentDefinition(
        "MACRO_SCENARIO_ANALYSIS", "宏观情景分析",
        "分析假设性宏观情景对行业、风格或资产的影响。",
        keywords=(("如果", 0.7), ("假设", 0.7), ("未来", 0.5), ("降息", 0.6),
                  ("加息", 0.6), ("宏观", 0.5), ("情景", 0.7)),
        preferred_entity_types=("ENTITY_06_01", "ENTITY_04_04", "ENTITY_05_02"),
        required_tools=("macro_series_lookup",),
        optional_tools=("style_performance_lookup", "benchmark_lookup"),
        required_dimensions=("scenario_definition", "transmission_path"),
    ),
    "EVENT_ANALYSIS": IntentDefinition(
        "EVENT_ANALYSIS", "事件分析",
        "分析具体公司事件或宏观监管事件的影响。",
        keywords=(("事件", 0.7), ("公告", 0.6), ("业绩预告", 0.7), ("并购", 0.6),
                  ("回购", 0.6), ("减持", 0.6), ("重大合同", 0.6)),
        preferred_entity_types=("ENTITY_04_03", "ENTITY_04_04"),
        required_tools=("event_timeline_lookup",),
        optional_tools=(
            "announcement_search",
            "restricted_release_lookup",
            "institution_survey_lookup",
            "dividend_history_lookup",
        ),
        required_dimensions=("event_time", "affected_entities"),
    ),
    "DISCOVERY_SCREENING": IntentDefinition(
        "DISCOVERY_SCREENING", "标的筛选",
        "从主题或行业中筛选值得关注的公司。",
        keywords=(("有哪些", 0.7), ("哪些公司", 0.8), ("值得关注", 0.7),
                  ("筛选", 0.8), ("标的", 0.5), ("推荐", 0.4)),
        preferred_entity_types=("ENTITY_03_02", "ENTITY_03_01"),
        required_tools=("theme_constituents_lookup",),
        optional_tools=("industry_chain_lookup",),
        required_dimensions=("screening_scope", "criteria"),
    ),
    "QUOTE_CHECK": IntentDefinition(
        "QUOTE_CHECK", "行情查看",
        "查看当前或历史行情、价格位置。",
        keywords=(("股价", 0.8), ("行情", 0.8), ("现价", 0.7), ("涨跌", 0.6),
                  ("位置", 0.4), ("K线", 0.7)),
        preferred_entity_types=("ENTITY_01_01", "ENTITY_01_03"),
        required_tools=("quote_history",),
        optional_tools=("benchmark_lookup",),
        required_dimensions=("price", "time_range"),
    ),
    "COMPANY_RELATION_ANALYSIS": IntentDefinition(
        "COMPANY_RELATION_ANALYSIS", "公司关系分析",
        "分析公司的子公司、参股公司、控股关系与关联方。",
        keywords=(("子公司", 0.8), ("参股", 0.7), ("关联公司", 0.8), ("母公司", 0.7),
                  ("孙公司", 0.7), ("关联方", 0.6), ("控股", 0.5), ("持股", 0.4)),
        preferred_entity_types=("ENTITY_02_01", "ENTITY_02_02", "ENTITY_03_03"),
        required_tools=("company_relationship_lookup",),
        optional_tools=("company_profile",),
        required_dimensions=("related_parties", "ownership", "evidence"),
    ),
    "COMPANY_GOVERNANCE_ANALYSIS": IntentDefinition(
        "COMPANY_GOVERNANCE_ANALYSIS", "公司治理分析",
        "分析公司实际控制人、控股股东、管理层与治理结构。",
        keywords=(("实际控制人", 0.9), ("实控人", 0.9), ("控股股东", 0.8),
                  ("董监高", 0.8), ("公司治理", 0.8), ("董事长", 0.7),
                  ("高管", 0.5), ("管理层", 0.5)),
        preferred_entity_types=("ENTITY_02_01", "ENTITY_02_03"),
        required_tools=("company_governance_lookup",),
        optional_tools=("company_relationship_lookup",),
        required_dimensions=("controllers", "management", "ownership"),
    ),
    "CAPITAL_FLOW_ANALYSIS": IntentDefinition(
        "CAPITAL_FLOW_ANALYSIS", "资金流向分析",
        "分析个股或市场资金流向、主力资金、两融与龙虎榜。",
        keywords=(("资金流向", 0.9), ("主力资金", 0.8), ("北向资金", 0.8),
                  ("融资余额", 0.8), ("龙虎榜", 0.8), ("融券", 0.7), ("资金流", 0.7)),
        preferred_entity_types=("ENTITY_05_01", "ENTITY_01_01", "ENTITY_02_01"),
        required_tools=("capital_flow_lookup",),
        optional_tools=("margin_balance_lookup", "dragon_tiger_lookup"),
        required_dimensions=("net_inflow", "leverage", "time_range"),
    ),
    "BENCHMARK_ANALYSIS": IntentDefinition(
        "BENCHMARK_ANALYSIS", "基准与相对收益",
        "分析标的相对基准的表现、超额收益与跟踪指数。",
        keywords=(("相对收益", 0.8), ("超额收益", 0.8), ("基准", 0.7),
                  ("跑赢", 0.7), ("跟踪指数", 0.7)),
        preferred_entity_types=(
            "ENTITY_05_03", "ENTITY_01_03", "ENTITY_01_01", "ENTITY_02_01",
        ),
        required_tools=("benchmark_performance_lookup",),
        optional_tools=("benchmark_lookup",),
        required_dimensions=("benchmark", "relative_performance", "time_range"),
    ),
    "GENERAL_RESEARCH": IntentDefinition(
        "GENERAL_RESEARCH", "通用研究",
        "未命中特定意图时的兜底研究请求。",
        keywords=(("研究", 0.3), ("看看", 0.2), ("帮我", 0.1)),
        required_dimensions=("research_subject",),
    ),
}

# 组合规则：命中全部关键词组时额外加分 / 覆盖意图。
_COMBO_RULES: tuple[tuple[tuple[str, ...], str, float], ...] = (
    (("持仓", "风险"), "PORTFOLIO_RISK_ANALYSIS", 0.5),
    (("产业链", "关系"), "INDUSTRY_RELATION_ANALYSIS", 0.4),
    (("对比", "估值"), "COMPANY_COMPARISON", 0.3),
    (("政策", "催化"), "POLICY_CATALYST_SEARCH", 0.3),
)


def _contains(text: str, keyword: str) -> bool:
    return keyword.lower() in text.lower()


def classify_intents(query: str, *, max_intents: int = 3) -> list[IntentItem]:
    """基于关键词权重返回意图列表，按置信度降序。

    这是规则基线，不依赖 LLM；后续可在不改变输出的前提下替换为模型分类。
    """

    text = query or ""
    scores: dict[str, float] = {}
    for code, definition in INTENT_REGISTRY.items():
        score = 0.0
        for keyword, weight in definition.keywords:
            if _contains(text, keyword):
                score += weight
        if score > 0:
            scores[code] = score
    for keywords, code, bonus in _COMBO_RULES:
        if all(_contains(text, keyword) for keyword in keywords):
            scores[code] = scores.get(code, 0.0) + bonus

    # 归一化为 0–0.95 的置信度；多命中、强关键词得分更高。
    items: list[IntentItem] = []
    for code, raw in scores.items():
        confidence = min(0.95, 0.45 + 0.12 * raw)
        items.append(
            IntentItem(
                intent_code=code,
                description=INTENT_REGISTRY[code].description,
                confidence=round(confidence, 3),
            )
        )
    items.sort(key=lambda item: item.confidence, reverse=True)

    if not items:
        definition = INTENT_REGISTRY["GENERAL_RESEARCH"]
        items.append(
            IntentItem(
                intent_code=definition.intent_code,
                description=definition.description,
                confidence=0.35,
            )
        )
    return items[:max_intents]


def preferred_entity_types(intent_list: list[IntentItem]) -> list[str]:
    ordered: list[str] = []
    for item in intent_list:
        definition = INTENT_REGISTRY.get(item.intent_code)
        if definition is None:
            continue
        for code in definition.preferred_entity_types:
            if code not in ordered:
                ordered.append(code)
    return ordered
