# -*- coding: utf-8 -*-
"""逻辑工具注册表。

``availability`` 的语义必须严格区分，不能把"计划开发"写成"已配置"：

- ``configured``：trading-core 进程内有可执行的处理器（本地库或已接通的公开数据源），
  具体实现见 ``research_entities.toolbox.registry``。
- ``external_service``：能力依赖兄弟服务的在线状态，服务未启动时工具会返回
  ``unavailable``，不会伪造结果。
- ``unconfigured``：当前工程没有可靠数据源；即使保留了处理器，也只返回明确原因。

本模块只描述能力，不执行任何外部调用。
"""

from __future__ import annotations

from ..models import ToolDefinition


def _tool(
    tool_id: str,
    name: str,
    category: str,
    availability: str,
    implementation: str | None,
    description: str,
    requires_authorization: bool = False,
    supported_entity_types: list[str] | None = None,
) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=name,
        category=category,
        availability=availability,  # type: ignore[arg-type]
        implementation=implementation,
        requires_authorization=requires_authorization,
        description=description,
        supported_entity_types=supported_entity_types or [],
    )


_TOOLS: list[ToolDefinition] = [
    # ── 本地实体库 / 用户事实 ───────────────────────────────────────
    _tool(
        "security_lookup", "证券名称/代码查询", "证券", "configured",
        "toolbox.local.security_lookup + research_entities.repository",
        "本地实体库精确查询证券；返回实体状态，未核验数据会显式标注。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_01_02", "ENTITY_01_04"],
    ),
    _tool(
        "industry_lookup", "行业查询", "行业", "configured",
        "toolbox.local.industry_lookup + research_entities.repository",
        "标准行业名称、别名与归属；可选返回本地名称表中的成员公司。",
        supported_entity_types=["ENTITY_03_01"],
    ),
    _tool(
        "theme_lookup", "主题/赛道查询", "主题", "configured",
        "toolbox.local.theme_lookup + research_entities.resources/gazetteers.json",
        "本地主题词典，提供标准名、别名与本地关系；不含成分股。",
        supported_entity_types=["ENTITY_03_02", "ENTITY_04_01", "ENTITY_04_02"],
    ),
    _tool(
        "benchmark_lookup", "基准映射", "基准", "configured",
        "toolbox.local.benchmark_lookup + adapter.benchmark",
        "按证券板块给出主基准、兜底基准及指数代码。",
        supported_entity_types=["ENTITY_05_03", "ENTITY_01_03", "ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "benchmark_performance_lookup", "基准表现", "基准", "configured",
        "toolbox.handlers.fund_index.benchmark_performance_lookup",
        "基准指数历史行情与区间表现，数据来自新浪/中证指数。",
        supported_entity_types=["ENTITY_05_03", "ENTITY_01_03", "ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "peer_group_builder", "可比公司构建", "基准", "configured",
        "toolbox.local.peer_group_builder + research_entities.repository",
        "按本地行业归属与市值构建可比组，未做业务相似度核验。",
        supported_entity_types=["ENTITY_05_03", "ENTITY_02_01", "ENTITY_01_01"],
    ),
    _tool(
        "portfolio_lookup", "用户持仓查询", "用户事实", "configured",
        "toolbox.local.portfolio_lookup + adapter.store(holdings)",
        "读取用户持仓；执行前必须确认授权状态。",
        requires_authorization=True,
    ),
    _tool(
        "portfolio_risk_analysis", "持仓风险分析", "用户事实", "configured",
        "toolbox.local.portfolio_risk_analysis + adapter.store(holdings)",
        "持仓集中度与成本权重；执行前必须确认授权状态。",
        requires_authorization=True,
    ),
    _tool(
        "watchlist_lookup", "用户自选查询", "用户事实", "configured",
        "toolbox.local.watchlist_lookup + adapter.store(watchlist)",
        "读取用户自选；执行前必须确认授权状态。",
        requires_authorization=True,
    ),
    # ── 策略自进化（只读；写动作必须走预案确认）────────────────────
    _tool(
        "strategy_pool_lookup", "策略池状态查询", "策略", "external_service",
        "toolbox.handlers.evolution.strategy_pool_lookup → trading-core /evolution/status",
        "策略池阶段、影子数据天数与每策略判定；服务未启动时返回 unavailable。",
    ),
    _tool(
        "strategy_attribution_lookup", "策略影子归因", "策略", "external_service",
        "toolbox.handlers.evolution.strategy_attribution_lookup → trading-core /evolution/attribution",
        "影子组合整体收益/回撤与每策略贡献；数据不足时显式说明，不做外推。",
    ),
    _tool(
        "strategy_evolution_preview", "策略进化预案查询", "策略", "external_service",
        "toolbox.handlers.evolution.strategy_evolution_preview → trading-core /evolution/preview",
        "只读当前待确认的升级/降级/淘汰/变异预案；应用预案必须由用户确认。",
    ),
    # ── 行情 / 财务 / 公司 / 事件 ───────────────────────────────────
    _tool(
        "quote_history", "历史行情", "行情", "configured",
        "toolbox.handlers.equity.quote_history + akshare.stock_zh_a_daily",
        "A 股前复权日线行情；新浪不可用时回退东方财富。",
        supported_entity_types=["ENTITY_01_01"],
    ),
    _tool(
        "financials_lookup", "财务数据", "财务", "configured",
        "toolbox.handlers.equity.financials_lookup + akshare.stock_financial_abstract",
        "A 股财务摘要指标，按报告期返回最近若干期。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "announcement_search", "公告检索", "披露", "configured",
        "toolbox.handlers.equity.announcement_search + akshare.stock_notice_report",
        "按公司代码/名称在最近 N 天公告列表中检索；不抓取公告正文。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01", "ENTITY_04_03"],
    ),
    _tool(
        "company_profile", "公司资料", "公司", "configured",
        "toolbox.handlers.equity.company_profile + akshare.stock_profile_cninfo",
        "巨潮公司档案：法定名称、行业、法人代表、经营范围与简介。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01", "ENTITY_02_02"],
    ),
    _tool(
        "company_relationship_lookup", "公司关系查询", "公司", "configured",
        "toolbox.handlers.equity.company_relationship_lookup + industry-chain :8200",
        "本地实体关系为基础，产业链服务在线时补充上下游与关联关系。",
        supported_entity_types=["ENTITY_02_01", "ENTITY_02_02", "ENTITY_02_03", "ENTITY_03_03"],
    ),
    _tool(
        "company_governance_lookup", "公司治理", "公司", "configured",
        "toolbox.handlers.equity.company_governance_lookup + akshare.stock_profile_cninfo",
        "法人代表、注册资本、成立/上市日期与机构简介；不含完整董监高名单。",
        supported_entity_types=["ENTITY_02_03", "ENTITY_02_01"],
    ),
    _tool(
        "shareholder_count_lookup", "股东户数", "公司", "configured",
        "toolbox.handlers.equity.shareholder_count_lookup + akshare.stock_zh_a_gdhs_detail_em",
        "历史股东户数与环比变化，用于观察筹码集中度；户数受股本变动影响。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "dividend_history_lookup", "分红送配", "公司", "configured",
        "toolbox.handlers.equity.dividend_history_lookup + akshare.stock_fhps_detail_em",
        "按报告期披露的分红送配历史（送转、现金分红、除权除息日）。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "restricted_release_lookup", "限售解禁", "公司", "configured",
        "toolbox.handlers.equity.restricted_release_lookup + akshare.stock_restricted_release_detail_em",
        "查询个股在给定窗口内的限售解禁记录；计划可能随公告调整。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "institution_survey_lookup", "机构调研", "公司", "configured",
        "toolbox.handlers.equity.institution_survey_lookup + akshare.stock_jgdy_tj_em",
        "近 N 天机构调研记录（接待日期、机构数量、接待方式与人员）。",
        supported_entity_types=["ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "industry_chain_lookup", "产业链查询", "产业", "configured",
        "toolbox.handlers.service.industry_chain_lookup + industry-chain :8200",
        "产业链多层链路；服务不可用时回退实体库直接关系并明确告警。",
        supported_entity_types=["ENTITY_03_02", "ENTITY_03_03", "ENTITY_02_01", "ENTITY_02_02"],
    ),
    _tool(
        "event_timeline_lookup", "事件时间线", "事件", "configured",
        "toolbox.handlers.equity.event_timeline_lookup + market-watch / akshare",
        "优先盯盘服务事件流，服务不可用时回退个股新闻。",
        supported_entity_types=[
            "ENTITY_04_01", "ENTITY_04_03", "ENTITY_04_04",
            "ENTITY_01_01", "ENTITY_02_01",
        ],
    ),
    _tool(
        "event_monitor_setup", "事件监控设置", "事件", "external_service",
        "toolbox.handlers.service.event_monitor_setup → market-watch :8100 POST /alerts",
        "写入监控规则必须由用户明确授权；服务未启动时不写入。",
        requires_authorization=True,
        supported_entity_types=["ENTITY_04_03", "ENTITY_04_04"],
    ),
    # ── 资金 / 风格 ─────────────────────────────────────────────────
    _tool(
        "capital_flow_lookup", "资金流向", "资金", "configured",
        "toolbox.handlers.equity.capital_flow_lookup + akshare.stock_fund_flow_individual",
        "同花顺即时资金流快照（流入/流出/净额）。",
        supported_entity_types=["ENTITY_05_01", "ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "margin_balance_lookup", "融资余额", "资金", "configured",
        "toolbox.handlers.equity.margin_balance_lookup + akshare.stock_margin_detail_*",
        "沪深两融明细，按最近交易日回溯查询。",
        supported_entity_types=["ENTITY_05_01", "ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "dragon_tiger_lookup", "龙虎榜", "资金", "configured",
        "toolbox.handlers.equity.dragon_tiger_lookup + akshare.stock_lhb_detail_em",
        "近期龙虎榜上榜记录与买卖额。",
        supported_entity_types=["ENTITY_05_01", "ENTITY_01_01", "ENTITY_02_01"],
    ),
    _tool(
        "style_performance_lookup", "风格表现", "风格", "configured",
        "toolbox.handlers.fund_index.style_performance_lookup + 代理指数",
        "用有明确口径的指数代理风格表现，并披露代理关系。",
        supported_entity_types=["ENTITY_05_02"],
    ),
    _tool(
        "style_constituents_lookup", "风格成分", "风格", "configured",
        "toolbox.handlers.fund_index.style_constituents_lookup + 代理指数成分",
        "返回风格代理指数的成分股，并披露代理关系。",
        supported_entity_types=["ENTITY_05_02"],
    ),
    # ── 基金 / 指数 ─────────────────────────────────────────────────
    _tool(
        "fund_lookup", "基金查询", "基金", "configured",
        "toolbox.handlers.fund_index.fund_lookup + akshare.fund_name_em",
        "全市场基金名录检索（代码/简称）。",
        supported_entity_types=["ENTITY_01_02"],
    ),
    _tool(
        "fund_holdings_lookup", "基金持仓", "基金", "configured",
        "toolbox.handlers.fund_index.fund_holdings_lookup + akshare.fund_portfolio_hold_em",
        "基金季度持仓；当年为空时回退上一年。",
        supported_entity_types=["ENTITY_01_02"],
    ),
    _tool(
        "fund_performance_lookup", "基金表现", "基金", "configured",
        "toolbox.handlers.fund_index.fund_performance_lookup + akshare",
        "ETF 用新浪历史价格，其他基金用单位净值走势。",
        supported_entity_types=["ENTITY_01_02"],
    ),
    _tool(
        "index_lookup", "指数查询", "指数", "configured",
        "toolbox.handlers.fund_index.index_lookup + akshare.stock_zh_index_spot_sina",
        "指数实时快照与实体信息。",
        supported_entity_types=["ENTITY_01_03", "ENTITY_05_03"],
    ),
    _tool(
        "index_constituents_lookup", "指数成分", "指数", "configured",
        "toolbox.handlers.fund_index.index_constituents_lookup + akshare.index_stock_cons*",
        "指数成分股，新浪失败时回退中证指数。",
        supported_entity_types=["ENTITY_01_03"],
    ),
    _tool(
        "index_performance_lookup", "指数表现", "指数", "configured",
        "toolbox.handlers.fund_index.index_performance_lookup + akshare",
        "指数历史行情与区间表现。",
        supported_entity_types=["ENTITY_01_03"],
    ),
    _tool(
        "industry_performance_lookup", "行业表现", "行业", "configured",
        "toolbox.handlers.fund_index.industry_performance_lookup + 同花顺板块",
        "同花顺行业/概念板块行情；分类口径与本地行业不同，需复核。",
        supported_entity_types=["ENTITY_03_01"],
    ),
    _tool(
        "theme_constituents_lookup", "主题成分", "主题", "configured",
        "toolbox.handlers.fund_index.theme_constituents_lookup + 同花顺概念板块详情页",
        "按主题名称匹配同花顺概念板块，抓取涨幅排序的前若干页成分股；不是完整成分列表。",
        supported_entity_types=["ENTITY_03_02"],
    ),
    # ── 可转债 ──────────────────────────────────────────────────────
    _tool(
        "convertible_bond_lookup", "可转债查询", "债券", "configured",
        "toolbox.handlers.bond.convertible_bond_lookup + akshare.bond_zh_cov",
        "可转债主数据检索（代码/简称）。",
        supported_entity_types=["ENTITY_01_04"],
    ),
    _tool(
        "bond_terms_lookup", "转债条款", "债券", "configured",
        "toolbox.handlers.bond.bond_terms_lookup + akshare.bond_zh_cov_info",
        "可转债基本条款与发行信息。",
        supported_entity_types=["ENTITY_01_04"],
    ),
    # ── 宏观 / 大宗 / 政策 ──────────────────────────────────────────
    _tool(
        "macro_series_lookup", "宏观序列", "宏观", "configured",
        "toolbox.handlers.macro.macro_series_lookup + akshare.macro_china_*",
        "CPI/PPI/PMI/GDP/M2/社融/LPR/SHIBOR 等宏观序列。",
        supported_entity_types=["ENTITY_06_01"],
    ),
    _tool(
        "macro_event_search", "宏观事件检索", "宏观", "configured",
        "toolbox.handlers.macro.macro_event_search + 新闻检索",
        "基于新闻关键词检索宏观事件，不是结构化事件库。",
        supported_entity_types=["ENTITY_04_04", "ENTITY_06_01"],
    ),
    _tool(
        "commodity_price_lookup", "商品价格", "大宗", "configured",
        "toolbox.handlers.macro.commodity_price_lookup + akshare.futures_main_sina",
        "商品主力连续合约价格序列。",
        supported_entity_types=["ENTITY_06_02"],
    ),
    _tool(
        "inventory_lookup", "库存数据", "大宗", "configured",
        "toolbox.handlers.macro.inventory_lookup + akshare.futures_inventory_em",
        "期货品种库存序列。",
        supported_entity_types=["ENTITY_06_02"],
    ),
    _tool(
        "supply_demand_lookup", "供需数据", "大宗", "unconfigured", None,
        "已核查库存、价格与新闻接口，均无可复现的供需平衡表；不得用库存/价格冒充供需。",
        supported_entity_types=["ENTITY_06_02"],
    ),
    _tool(
        "policy_search", "政策检索", "政策", "configured",
        "toolbox.handlers.macro.policy_search + 新闻联播/财联社",
        "基于新闻关键词检索政策报道，不等同于官方文件库。",
        supported_entity_types=["ENTITY_04_02"],
    ),
    _tool(
        "official_document_search", "官方文件检索", "政策", "configured",
        "toolbox.handlers.macro.official_document_search + gov.cn 政策文件库",
        "中国政府网政策文件库检索（国务院/部门文件），返回标题、文号、发布机构与原文链接。",
        supported_entity_types=["ENTITY_04_02", "ENTITY_04_04"],
    ),
    _tool(
        "regional_policy_search", "区域政策检索", "区域", "configured",
        "toolbox.handlers.macro.regional_policy_search + 新闻检索",
        "基于新闻关键词检索区域政策报道。",
        supported_entity_types=["ENTITY_06_03"],
    ),
]


TOOL_REGISTRY: dict[str, ToolDefinition] = {item.tool_id: item for item in _TOOLS}


def get_tool(tool_id: str) -> ToolDefinition:
    try:
        return TOOL_REGISTRY[tool_id]
    except KeyError as exc:
        raise KeyError(f"未注册的逻辑工具: {tool_id}") from exc


def tool_exists(tool_id: str) -> bool:
    return tool_id in TOOL_REGISTRY


def validate_tool_registry() -> list[str]:
    problems: list[str] = []
    seen: set[str] = set()
    for item in _TOOLS:
        if item.tool_id in seen:
            problems.append(f"重复工具 ID: {item.tool_id}")
        seen.add(item.tool_id)
        if item.availability == "configured" and not item.implementation:
            problems.append(f"{item.tool_id} 标记为已配置但未声明实现")
        if item.availability == "unconfigured" and item.implementation:
            problems.append(f"{item.tool_id} 标记为未配置却声明了实现")
    return problems
