# -*- coding: utf-8 -*-
"""工具预挂载测试：只推荐，不执行。"""

from __future__ import annotations

import unittest

from research_entities.registry.tools import TOOL_REGISTRY
from research_entities.tool_preloader import ToolPreloader

from tests.research_entities_fixtures import build_service, collection


class ToolPreloaderTest(unittest.TestCase):
    def setUp(self):
        self.preloader = ToolPreloader()

    def preload(self, **kwargs):
        defaults = dict(
            entity_types=[],
            intent_codes=[],
            entity_ids=[],
            dynamic_collection_types=[],
            collection=None,
        )
        defaults.update(kwargs)
        return self.preloader.preload(**defaults)

    def test_stock_analysis_preloads_required_tools(self):
        tools, _ = self.preload(
            entity_types=["ENTITY_01_01"],
            intent_codes=["STOCK_ANALYSIS"],
            entity_ids=["SEC:CN:A:600519"],
        )
        by_id = {item.tool_id: item for item in tools}
        self.assertIn("quote_history", by_id)
        self.assertIn("financials_lookup", by_id)
        self.assertTrue(by_id["quote_history"].required)
        self.assertFalse(by_id["security_lookup"].required)
        self.assertEqual(by_id["quote_history"].entity_ids, ["SEC:CN:A:600519"])
        for item in tools:
            self.assertEqual(item.execution_mode, "preload_only")
            self.assertEqual(item.status, TOOL_REGISTRY[item.tool_id].availability)

    def test_configured_tools_are_not_flagged(self):
        tools, warnings = self.preload(
            entity_types=["ENTITY_02_01"], intent_codes=["STOCK_ANALYSIS"]
        )
        by_id = {item.tool_id: item for item in tools}
        self.assertEqual(by_id["company_profile"].status, "configured")
        self.assertEqual(by_id["announcement_search"].status, "configured")
        self.assertFalse(any("company_profile" in item for item in warnings))
        self.assertFalse(any("announcement_search" in item for item in warnings))

    def test_unconfigured_services_are_disclosed(self):
        tools, warnings = self.preload(entity_types=["ENTITY_06_02"])
        by_id = {item.tool_id: item for item in tools}
        self.assertEqual(by_id["supply_demand_lookup"].status, "unconfigured")
        self.assertTrue(any("supply_demand_lookup" in item for item in warnings))

    def test_theme_entity_does_not_preload_stock_tools(self):
        theme_id = "THEME:固态电池"
        tools, warnings = self.preload(
            entity_types=["ENTITY_03_02"],
            intent_codes=["STOCK_ANALYSIS"],
            entity_ids=[theme_id],
            entity_ids_by_type={"ENTITY_03_02": [theme_id]},
        )
        by_id = {item.tool_id: item for item in tools}
        self.assertNotIn("quote_history", by_id)
        self.assertNotIn("financials_lookup", by_id)
        self.assertTrue(any("不兼容" in item for item in warnings))

    def test_mixed_scope_only_binds_compatible_entities(self):
        stock_id = "SEC:CN:A:600519"
        theme_id = "THEME:固态电池"
        tools, _ = self.preload(
            entity_types=["ENTITY_01_01", "ENTITY_03_02"],
            intent_codes=["STOCK_ANALYSIS"],
            entity_ids=[stock_id, theme_id],
            entity_ids_by_type={
                "ENTITY_01_01": [stock_id],
                "ENTITY_03_02": [theme_id],
            },
        )
        quote = next(item for item in tools if item.tool_id == "quote_history")
        self.assertEqual(quote.entity_ids, [stock_id])

    def test_stock_intent_preloads_company_action_tools(self):
        stock_id = "SEC:CN:A:600519"
        tools, _ = self.preload(
            entity_types=["ENTITY_01_01"],
            intent_codes=["STOCK_ANALYSIS"],
            entity_ids=[stock_id],
            entity_ids_by_type={"ENTITY_01_01": [stock_id]},
        )
        by_id = {item.tool_id: item for item in tools}
        for tool_id in ("dividend_history_lookup", "shareholder_count_lookup"):
            self.assertIn(tool_id, by_id)
            self.assertFalse(by_id[tool_id].required)
            self.assertEqual(by_id[tool_id].entity_ids, [stock_id])

    def test_event_intent_preloads_release_and_survey_tools(self):
        stock_id = "SEC:CN:A:600519"
        tools, _ = self.preload(
            entity_types=["ENTITY_01_01"],
            intent_codes=["EVENT_ANALYSIS"],
            entity_ids=[stock_id],
            entity_ids_by_type={"ENTITY_01_01": [stock_id]},
        )
        by_id = {item.tool_id: item for item in tools}
        for tool_id in (
            "restricted_release_lookup",
            "institution_survey_lookup",
            "dividend_history_lookup",
        ):
            self.assertIn(tool_id, by_id)
            self.assertEqual(by_id[tool_id].entity_ids, [stock_id])

    def test_event_intent_keeps_timeline_for_company_entity(self):
        company_id = "CO:CN:A:600519"
        tools, _ = self.preload(
            entity_types=["ENTITY_02_01"],
            intent_codes=["EVENT_ANALYSIS"],
            entity_ids=[company_id],
            entity_ids_by_type={"ENTITY_02_01": [company_id]},
        )
        timeline = next(item for item in tools if item.tool_id == "event_timeline_lookup")
        self.assertTrue(timeline.required)
        self.assertEqual(timeline.entity_ids, [company_id])

    def test_keyword_only_intent_keeps_tools_without_entities(self):
        tools, _ = self.preload(intent_codes=["POLICY_CATALYST_SEARCH"])
        by_id = {item.tool_id: item for item in tools}
        self.assertIn("policy_search", by_id)
        self.assertEqual(by_id["policy_search"].entity_ids, [])

    def test_tools_are_deduplicated_with_merged_reason(self):
        tools, _ = self.preload(
            entity_types=["ENTITY_01_01"], intent_codes=["STOCK_ANALYSIS"]
        )
        quote = [item for item in tools if item.tool_id == "quote_history"]
        self.assertEqual(len(quote), 1)
        self.assertIn("；", quote[0].reason)

    def test_portfolio_tools_require_authorization(self):
        tools, warnings = self.preload(
            entity_types=[], intent_codes=["PORTFOLIO_ANALYSIS"],
            dynamic_collection_types=["USER_PORTFOLIO"],
        )
        portfolio = next(item for item in tools if item.tool_id == "portfolio_lookup")
        self.assertTrue(portfolio.requires_authorization)
        self.assertTrue(any("授权" in item for item in warnings))

    def test_authorized_collection_removes_authorization_warning(self):
        authorized = collection("USER_PORTFOLIO", ["600519"])
        _, warnings = self.preload(
            intent_codes=["PORTFOLIO_ANALYSIS"],
            dynamic_collection_types=["USER_PORTFOLIO"],
            collection=authorized,
        )
        self.assertFalse(any("需要用户授权" in item for item in warnings))

    def test_unknown_type_and_collection_are_reported(self):
        tools, warnings = self.preload(
            entity_types=["ENTITY_99_99"], dynamic_collection_types=["UNKNOWN_SET"]
        )
        self.assertEqual(tools, [])
        self.assertTrue(any("未知实体类型" in item for item in warnings))
        self.assertTrue(any("未知动态集合" in item for item in warnings))

    def test_required_tools_are_ordered_first(self):
        tools, _ = self.preload(intent_codes=["STOCK_ANALYSIS"])
        flags = [item.required for item in tools]
        self.assertEqual(flags, sorted(flags, reverse=True))


class ScopeToolIntegrationTest(unittest.TestCase):
    def test_scope_tool_ids_match_details_and_are_unique(self):
        service = build_service()
        scope = service.resolve_scope("分析贵州茅台")
        self.assertEqual(
            scope.preload_tool_ids, [item.tool_id for item in scope.preload_tools]
        )
        self.assertEqual(len(scope.preload_tool_ids), len(set(scope.preload_tool_ids)))
        self.assertIn("quote_history", scope.preload_tool_ids)


if __name__ == "__main__":
    unittest.main()
