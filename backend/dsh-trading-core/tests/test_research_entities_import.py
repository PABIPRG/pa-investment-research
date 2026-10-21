# -*- coding: utf-8 -*-
"""数据源导入测试：只读本地文件，不访问网络。"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from research_entities.adapters.sources import records_to_entities
from research_entities.adapters.sources.gazetteer_json import GazetteerJsonSource
from research_entities.adapters.sources.universe_json import UniverseJsonSource
from research_entities.adapters.storage_sqlite import SqliteEntityRepository
from research_entities.cli import main as cli_main
from research_entities.errors import InvalidSourceBatch, SourceUnavailable
from research_entities.models import SourceEntityRecord

from tests.research_entities_fixtures import build_service, sample_batch

UNIVERSE = [
    {"code": "600519", "name": "贵州茅台", "industry": "食品饮料", "market_cap": 1, "board": "主板"},
    {"code": "000858", "name": "五粮液", "industry": "食品饮料", "market_cap": 2, "board": "主板"},
    {"code": "000858", "name": "五粮液重复", "industry": "食品饮料"},
    {"code": "600520", "name": "贵州茅台", "industry": "食品饮料"},
    {"code": "300750", "name": "宁德时代", "industry": "-"},
    {"code": "12", "name": ""},
]


class UniverseSourceTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.mkdtemp(prefix="universe_")
        self.path = Path(self.tempdir) / "universe.json"
        self.path.write_text(json.dumps(UNIVERSE, ensure_ascii=False), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def test_batch_emits_security_company_and_industry_records(self):
        source = UniverseJsonSource(self.path)
        self.assertTrue(source.health().available)
        batch = source.fetch_entities()
        self.assertEqual(batch.source_id, "universe_json")
        self.assertEqual(len(batch.source_version), 16)
        # 4 个唯一代码 ×（证券 + 公司）+ 1 个行业。
        self.assertEqual(len(batch.records), 9)
        types = [record.entity_type_code for record in batch.records]
        self.assertEqual(types.count("ENTITY_01_01"), 4)
        self.assertEqual(types.count("ENTITY_02_01"), 4)
        self.assertEqual(types.count("ENTITY_03_01"), 1)
        self.assertFalse(source.capabilities().authoritative)

    def test_duplicate_code_name_and_invalid_rows_are_warned(self):
        batch = UniverseJsonSource(self.path).fetch_entities()
        text = "\n".join(batch.warnings)
        self.assertIn("重复代码", text)
        self.assertIn("证券简称重复", text)
        self.assertIn("跳过非法证券记录", text)

    def test_missing_file_raises_source_unavailable(self):
        source = UniverseJsonSource(Path(self.tempdir) / "missing.json")
        self.assertFalse(source.health().available)
        with self.assertRaises(SourceUnavailable):
            source.fetch_entities()


class GazetteerSourceTest(unittest.TestCase):
    def test_gazetteer_keeps_explicit_entity_ids(self):
        batch = GazetteerJsonSource().fetch_entities()
        self.assertTrue(batch.records)
        self.assertTrue(all(record.entity_id for record in batch.records))
        ids = {record.entity_id for record in batch.records}
        self.assertIn("THEME:HBM", ids)
        self.assertIn("FUND:CSI300ETF:510300", ids)
        self.assertIn("FUND:CSI300ETF:159919", ids)


class ConversionTest(unittest.TestCase):
    def test_security_record_without_id_derives_identifier_based_id(self):
        entities = records_to_entities(
            sample_batch(
                [
                    SourceEntityRecord(
                        external_code="600519",
                        name="贵州茅台",
                        entity_type_code="ENTITY_01_01",
                        identifiers={"security_code": "600519"},
                    )
                ]
            ),
            source_label="test:v1",
        )
        self.assertEqual(entities[0].entity_id, "SEC:CN:A:600519")
        self.assertEqual(entities[0].status, "imported_unverified")

    def test_non_security_record_without_id_is_rejected(self):
        with self.assertRaises(InvalidSourceBatch):
            records_to_entities(
                sample_batch(
                    [SourceEntityRecord(name="某主题", entity_type_code="ENTITY_03_02")]
                ),
                source_label="test:v1",
            )


class ServiceImportTest(unittest.TestCase):
    def test_import_is_queryable(self):
        service = build_service(stocks=[])
        result = service.import_source(GazetteerJsonSource())
        self.assertGreater(result.imported, 0)
        self.assertEqual(result.warnings, [])
        scope = service.resolve_scope("HBM 景气度如何")
        self.assertEqual(scope.entity_list[0].entity_id, "THEME:HBM")
        self.assertEqual(scope.entity_list[0].resolution_status, "resolved")

    def test_universe_import_does_not_erase_gazetteer_aliases(self):
        tempdir = tempfile.mkdtemp(prefix="merge_sources_")
        try:
            path = Path(tempdir) / "universe.json"
            path.write_text(
                json.dumps(
                    [{"code": "600519", "name": "贵州茅台", "industry": "白酒Ⅱ"}],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            service = build_service(stocks=[])
            service.import_source(GazetteerJsonSource())
            service.import_source(UniverseJsonSource(path))
            matches = service.repository.find_by_name("白酒")
            self.assertIn("IND:CN:白酒Ⅱ", [item.entity_id for item in matches])
            scope = service.resolve_scope("白酒行业最近表现如何")
            self.assertEqual(scope.status, "scope_ready")
            self.assertEqual(scope.entity_list[0].entity_id, "IND:CN:白酒Ⅱ")
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)

    def test_sqlite_backend_survives_reopen(self):
        tempdir = tempfile.mkdtemp(prefix="research_entities_import_")
        path = Path(tempdir) / "entities.sqlite3"
        try:
            first = build_service(stocks=[], repository=SqliteEntityRepository(path))
            first.import_source(GazetteerJsonSource())
            expected = first.repository.get("THEME:HBM")
            self.assertIsNotNone(expected)
            first.repository._local.connection.close()

            second = build_service(stocks=[], repository=SqliteEntityRepository(path))
            self.assertIsNotNone(second.repository.get("THEME:HBM"))
            scope = second.resolve_scope("HBM 景气度如何")
            self.assertEqual(scope.entity_list[0].entity_id, "THEME:HBM")
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)


class CliTest(unittest.TestCase):
    def test_registry_check_returns_zero(self):
        self.assertEqual(cli_main(["registry-check"]), 0)


if __name__ == "__main__":
    unittest.main()
