# -*- coding: utf-8 -*-
import unittest

from research_entities.registry.entity_types import (
    DYNAMIC_COLLECTION_DEFINITIONS,
    ENTITY_TYPE_REGISTRY,
    PARENT_CATEGORIES,
    validate_entity_type_registry,
)
from research_entities.registry.intents import INTENT_REGISTRY, classify_intents
from research_entities.registry.tools import TOOL_REGISTRY, validate_tool_registry


class EntityTypeRegistryTest(unittest.TestCase):
    def test_six_parent_categories_and_twenty_child_types(self):
        self.assertEqual(len(PARENT_CATEGORIES), 6)
        self.assertEqual(len(ENTITY_TYPE_REGISTRY), 20)
        self.assertEqual(validate_entity_type_registry(), [])

    def test_every_child_belongs_to_declared_parent(self):
        for code, definition in ENTITY_TYPE_REGISTRY.items():
            self.assertIn(definition.parent_code, PARENT_CATEGORIES, code)

    def test_dynamic_collections_are_not_entity_types(self):
        self.assertEqual(
            set(DYNAMIC_COLLECTION_DEFINITIONS),
            {"USER_PORTFOLIO", "USER_WATCHLIST", "DYNAMIC_COMPARABLES", "TASK_GENERATED_SET"},
        )
        for name in DYNAMIC_COLLECTION_DEFINITIONS:
            self.assertFalse(name.startswith("ENTITY_"))

    def test_registry_rejects_dynamic_static_entry(self):
        broken = ENTITY_TYPE_REGISTRY["ENTITY_01_01"].model_copy(
            update={"is_dynamic": True}
        )
        problems = validate_entity_type_registry([broken])
        self.assertTrue(any("is_dynamic" in item for item in problems))


class ToolRegistryTest(unittest.TestCase):
    def test_registry_is_consistent(self):
        self.assertEqual(validate_tool_registry(), [])

    def test_availability_matches_implementation_reality(self):
        configured = {
            tool_id
            for tool_id, item in TOOL_REGISTRY.items()
            if item.availability == "configured"
        }
        self.assertIn("quote_history", configured)
        self.assertIn("portfolio_lookup", configured)
        for tool_id in configured:
            self.assertTrue(TOOL_REGISTRY[tool_id].implementation, tool_id)
        for tool_id, item in TOOL_REGISTRY.items():
            if item.availability == "unconfigured":
                self.assertIsNone(item.implementation, tool_id)
            if item.availability == "external_service":
                # 兄弟服务的实现位置是事实描述，不代表本服务可直接执行。
                self.assertTrue(item.implementation, tool_id)

    def test_unbuilt_tools_are_not_marked_configured(self):
        # 已接入真实数据源的境外/基金/债券工具应为 configured。
        for tool_id in ("index_constituents_lookup", "fund_holdings_lookup", "bond_terms_lookup"):
            self.assertEqual(TOOL_REGISTRY[tool_id].availability, "configured")
        # 同花顺概念成分页与 gov.cn 政策文件库已接通。
        for tool_id in ("theme_constituents_lookup", "official_document_search"):
            self.assertEqual(TOOL_REGISTRY[tool_id].availability, "configured")
        # 仍无公开供需平衡表的工具必须保持 unconfigured，不能假装可用。
        self.assertEqual(
            TOOL_REGISTRY["supply_demand_lookup"].availability, "unconfigured"
        )
        for tool_id in (
            "shareholder_count_lookup",
            "dividend_history_lookup",
            "restricted_release_lookup",
            "institution_survey_lookup",
        ):
            self.assertEqual(TOOL_REGISTRY[tool_id].availability, "configured")


class IntentRegistryTest(unittest.TestCase):
    def test_stock_analysis_intent(self):
        intents = classify_intents("分析一下贵州茅台最近一年的走势")
        self.assertIn("STOCK_ANALYSIS", [item.intent_code for item in intents])

    def test_portfolio_intent(self):
        intents = classify_intents("帮我看看我的持仓风险")
        codes = [item.intent_code for item in intents]
        self.assertIn("PORTFOLIO_RISK_ANALYSIS", codes)
        self.assertIn("PORTFOLIO_ANALYSIS", codes)

    def test_unknown_query_falls_back_to_general_research(self):
        intents = classify_intents("随便聊聊")
        self.assertEqual([item.intent_code for item in intents], ["GENERAL_RESEARCH"])

    def test_specialised_intents_are_classified(self):
        cases = {
            "分析贵州茅台的子公司和参股公司": "COMPANY_RELATION_ANALYSIS",
            "贵州茅台的实际控制人是谁": "COMPANY_GOVERNANCE_ANALYSIS",
            "贵州茅台资金流向": "CAPITAL_FLOW_ANALYSIS",
            "相对基准的超额收益": "BENCHMARK_ANALYSIS",
        }
        for query, expected in cases.items():
            codes = [item.intent_code for item in classify_intents(query)]
            self.assertIn(expected, codes, query)

    def test_all_registered_intents_have_tools(self):
        for code, definition in INTENT_REGISTRY.items():
            for tool_id in [*definition.required_tools, *definition.optional_tools]:
                self.assertIn(tool_id, TOOL_REGISTRY, f"{code} -> {tool_id}")


if __name__ == "__main__":
    unittest.main()
