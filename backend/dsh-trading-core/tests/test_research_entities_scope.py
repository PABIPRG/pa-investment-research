# -*- coding: utf-8 -*-
"""Scope 端到端测试：抽取 → 检索 → 消歧 → Scope → 工具预挂载。"""

from __future__ import annotations

import unittest

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.errors import StorageUnavailable
from research_entities.models import ResearchScope, ScopeEntity

from tests.research_entities_fixtures import (
    FakeCollectionProvider,
    build_service,
    collection,
)


class ScopeResolutionTest(unittest.TestCase):
    def setUp(self):
        self.service = build_service()
        self.repository = self.service.repository

    def test_single_stock_scope_is_ready(self):
        scope = self.service.resolve_scope("分析一下贵州茅台最近一年的走势")
        self.assertEqual(scope.status, "scope_ready")
        self.assertEqual(len(scope.entity_list), 1)
        entity = scope.entity_list[0]
        self.assertEqual(entity.resolution_status, "resolved")
        self.assertEqual(entity.raw_text, "贵州茅台")
        # 个股分析以证券为主实体，公司实体仍在候选中。
        self.assertEqual(entity.entity_id, "SEC:CN:A:600519")
        self.assertEqual(entity.entity_type_code, "ENTITY_01_01")
        self.assertEqual(entity.canonical_name, "贵州茅台")
        self.assertEqual(scope.constraints.time_range, "近一年")
        self.assertIn("quote_history", scope.preload_tool_ids)

    def test_company_context_keeps_company_type_consistent(self):
        scope = self.service.resolve_scope("贵州茅台公司经营情况如何")
        self.assertEqual(scope.status, "scope_ready")
        entity = scope.entity_list[0]
        self.assertEqual(entity.entity_id, "CO:CN:A:600519")
        self.assertEqual(entity.entity_type_code, "ENTITY_02_01")

    def test_code_mention_resolves_to_security(self):
        scope = self.service.resolve_scope("看看 600519 最近的行情")
        self.assertEqual(scope.status, "scope_ready")
        self.assertEqual(scope.entity_list[0].entity_id, "SEC:CN:A:600519")

    def test_industry_alias_is_in_scope(self):
        scope = self.service.resolve_scope("白酒行业最近表现如何")
        self.assertEqual(scope.status, "scope_ready")
        types = {item.entity_type_code for item in scope.entity_list}
        self.assertIn("ENTITY_03_01", types)

    def test_ambiguous_etf_requires_clarification(self):
        scope = self.service.resolve_scope("沪深300ETF 和贵州茅台哪个好")
        self.assertEqual(scope.status, "pending_clarification")
        etf = next(item for item in scope.entity_list if item.raw_text == "沪深300ETF")
        self.assertEqual(etf.resolution_status, "ambiguous")
        self.assertIsNone(etf.entity_id)
        self.assertTrue(scope.clarification_questions)

    def test_unknown_code_is_not_fabricated(self):
        scope = self.service.resolve_scope("分析 688256 的走势")
        self.assertEqual(scope.status, "pending_clarification")
        entity = scope.entity_list[0]
        self.assertEqual(entity.resolution_status, "unresolved")
        self.assertIsNone(entity.entity_id)
        self.assertIsNone(entity.canonical_name)
        self.assertTrue(any("688256" in item for item in scope.clarification_questions))

    def test_partial_resolution_blocks_ready(self):
        scope = self.service.resolve_scope("对比 600519 和 688256")
        self.assertEqual(scope.status, "pending_clarification")
        statuses = {item.raw_text: item.resolution_status for item in scope.entity_list}
        self.assertEqual(statuses["600519"], "resolved")
        self.assertEqual(statuses["688256"], "unresolved")

    def test_time_range_and_market_scope(self):
        scope = self.service.resolve_scope("贵州茅台近三个月走势")
        self.assertEqual(scope.constraints.time_range, "近三个月")
        self.assertEqual(scope.constraints.market_scope, "A股")

    def test_scope_is_persisted_with_audit(self):
        scope = self.service.resolve_scope("分析贵州茅台", request_id="REQ_PERSIST")
        stored = self.repository.get_scope("REQ_PERSIST")
        self.assertIsNotNone(stored)
        self.assertEqual(stored.raw_query, "分析贵州茅台")
        events = self.repository.list_audit("REQ_PERSIST")
        self.assertEqual([event.stage for event in events], ["scope"])

    def test_unverified_source_is_disclosed(self):
        import json
        import shutil
        import tempfile
        from pathlib import Path

        from research_entities.adapters.sources.universe_json import UniverseJsonSource

        tempdir = tempfile.mkdtemp(prefix="scope_universe_")
        try:
            path = Path(tempdir) / "universe.json"
            path.write_text(
                json.dumps(
                    [{"code": "600519", "name": "贵州茅台", "industry": "食品饮料"}],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            service = build_service(stocks=[])
            service.import_source(UniverseJsonSource(path))
            scope = service.resolve_scope("分析600519")
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)
        self.assertEqual(scope.status, "scope_ready")
        self.assertTrue(any("未核验" in warning for warning in scope.warnings))


class DynamicCollectionScopeTest(unittest.TestCase):
    def test_holdings_without_provider_never_fabricates_members(self):
        service = build_service()
        scope = service.resolve_scope("分析我的持仓风险")
        self.assertNotEqual(scope.status, "scope_ready")
        self.assertTrue(scope.clarification_questions)
        self.assertFalse(scope.entity_list)
        self.assertTrue(any("持仓" in item for item in scope.clarification_questions))

    def test_authorized_holdings_only_constrain_scope(self):
        provider = FakeCollectionProvider(
            {"USER_PORTFOLIO": collection("USER_PORTFOLIO", ["600519", "300750"])}
        )
        service = build_service(collection_provider=provider)
        scope = service.resolve_scope("分析我的持仓风险")
        self.assertEqual(scope.status, "scope_ready")
        self.assertIn("数据范围：用户持仓", scope.constraints.other_constraints)
        self.assertFalse(any("未授权" in item for item in scope.warnings))
        # 集合成员不是被伪造的静态实体。
        self.assertFalse(scope.entity_list)

    def test_unauthorized_collection_stays_pending(self):
        provider = FakeCollectionProvider(
            {"USER_PORTFOLIO": collection("USER_PORTFOLIO", [], authorization="unauthorized")}
        )
        service = build_service(collection_provider=provider)
        scope = service.resolve_scope("分析我的持仓")
        self.assertEqual(scope.status, "pending_clarification")
        self.assertTrue(any("未授权" in item for item in scope.warnings))


class ScopeFailureTest(unittest.TestCase):
    def test_storage_failure_yields_failed_scope(self):
        class BrokenRepository(InMemoryEntityRepository):
            def index_version(self) -> str:
                raise StorageUnavailable("db down")

        service = build_service(repository=BrokenRepository())
        scope = service.resolve_scope("分析贵州茅台", persist=False)
        self.assertEqual(scope.status, "failed")
        self.assertTrue(any("实体库不可用" in item for item in scope.warnings))


class ScopeModelInvariantTest(unittest.TestCase):
    def test_ready_scope_rejects_unresolved_entity(self):
        with self.assertRaises(ValueError):
            ResearchScope(
                request_id="REQ_X",
                raw_query="x",
                status="scope_ready",
                entity_list=[
                    ScopeEntity(
                        mention_id="MENTION_001",
                        raw_text="x",
                        resolution_status="unresolved",
                    )
                ],
            )

    def test_ready_scope_rejects_clarification_questions(self):
        with self.assertRaises(ValueError):
            ResearchScope(
                request_id="REQ_X",
                raw_query="x",
                status="scope_ready",
                clarification_questions=["请确认"],
            )


if __name__ == "__main__":
    unittest.main()
