# -*- coding: utf-8 -*-
"""仓储端口契约测试：内存与 SQLite 适配器必须表现一致。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.adapters.storage_sqlite import SqliteEntityRepository
from research_entities.audit import make_event
from research_entities.models import (
    EntityCollection,
    EntityInstance,
    EntityMention,
    EntityRelation,
    ResearchScope,
    SourceImport,
)
from research_entities.registry.entity_types import ENTITY_TYPE_REGISTRY


def _entity(code: str = "600519", name: str = "贵州茅台") -> EntityInstance:
    return EntityInstance(
        entity_id=f"SEC:CN:A:{code}",
        entity_type_code="ENTITY_01_01",
        canonical_name=name,
        aliases=["茅台"],
        identifiers={"security_code": code, "exchange": "SH"},
        attributes={"industry": "食品饮料"},
        relations=[
            EntityRelation(target_entity_id=f"CO:CN:{code}", relation_type="issuer_company")
        ],
        source="contract_test",
        status="imported_unverified",
    )


class RepositoryContractMixin:
    repository = None  # type: ignore[assignment]

    def test_upsert_and_get(self):
        self.repository.upsert_entities([_entity()], source_version="v1")
        entity = self.repository.get("SEC:CN:A:600519")
        self.assertIsNotNone(entity)
        self.assertEqual(entity.canonical_name, "贵州茅台")
        self.assertEqual(entity.identifiers["security_code"], "600519")
        self.assertEqual(len(self.repository.get_many(["SEC:CN:A:600519"])), 1)
        self.assertIsNone(self.repository.get("SEC:CN:A:999999"))

    def test_find_by_identifier_and_name_and_alias(self):
        self.repository.upsert_entities([_entity()], source_version="v1")
        by_code = self.repository.find_by_identifier("security_code", "600519")
        self.assertEqual([item.entity_id for item in by_code], ["SEC:CN:A:600519"])

        by_name = self.repository.find_by_name("贵州茅台")
        self.assertEqual([item.entity_id for item in by_name], ["SEC:CN:A:600519"])

        by_alias = self.repository.find_by_name("茅台")
        self.assertEqual([item.entity_id for item in by_alias], ["SEC:CN:A:600519"])

        self.assertEqual(self.repository.find_by_name("不存在的名字"), [])

    def test_index_terms_include_name_and_alias(self):
        self.repository.upsert_entities([_entity()], source_version="v1")
        texts = {term.text for term in self.repository.index_terms()}
        self.assertIn("贵州茅台", texts)
        self.assertIn("茅台", texts)

    def test_index_version_changes_on_write(self):
        before = self.repository.index_version()
        self.repository.upsert_entities([_entity()], source_version="v1")
        after = self.repository.index_version()
        self.assertNotEqual(before, after)

    def test_list_by_type_and_relations(self):
        self.repository.upsert_entities([_entity()], source_version="v1")
        items, cursor = self.repository.list_by_type("ENTITY_01_01")
        self.assertEqual(len(items), 1)
        self.assertIsNone(cursor)
        relations = self.repository.relations_from("SEC:CN:A:600519")
        self.assertEqual(relations[0].relation_type, "issuer_company")
        self.assertEqual(
            self.repository.relations_from("SEC:CN:A:600519", relation_type="other"), []
        )

    def test_collection_roundtrip(self):
        collection = EntityCollection(
            collection_id="USER_PORTFOLIO",
            collection_type="USER_PORTFOLIO",
            source="test",
            as_of=datetime(2026, 1, 2, tzinfo=timezone.utc),
            member_entity_ids=["SEC:CN:A:600519"],
            filter_definition={"kind": "test"},
            authorization_status="authorized",
        )
        self.repository.replace_collection(collection)
        stored = self.repository.get_collection("USER_PORTFOLIO")
        self.assertEqual(stored.member_entity_ids, ["SEC:CN:A:600519"])
        self.assertEqual(stored.authorization_status, "authorized")
        self.assertIsNone(self.repository.get_collection("USER_WATCHLIST"))

    def test_scope_audit_mention_roundtrip(self):
        scope = ResearchScope(
            request_id="REQ_TEST",
            raw_query="分析贵州茅台",
            status="pending_entity_resolution",
        )
        self.repository.save_scope(scope)
        self.assertEqual(self.repository.get_scope("REQ_TEST").raw_query, "分析贵州茅台")

        event = make_event(request_id="REQ_TEST", stage="extract", payload={"n": 1})
        self.repository.append_audit(event)
        events = self.repository.list_audit("REQ_TEST")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].stage, "extract")

        mention = EntityMention(
            mention_id="MENTION_001",
            raw_text="贵州茅台",
            start_offset=0,
            end_offset=4,
            candidate_entity_ids=["SEC:CN:A:600519"],
            resolution_status="pending",
        )
        self.repository.save_mention(mention)

    def test_type_registry_persists(self):
        self.repository.upsert_types(ENTITY_TYPE_REGISTRY.values())
        stored = self.repository.list_types()
        self.assertEqual(len(stored), 20)
        self.assertEqual({item.type_code for item in stored}, set(ENTITY_TYPE_REGISTRY))

    def test_transaction_rollback(self):
        with self.assertRaises(RuntimeError):
            with self.repository.transaction():
                self.repository.upsert_entities([_entity()], source_version="v1")
                raise RuntimeError("rollback")
        self.assertIsNone(self.repository.get("SEC:CN:A:600519"))

    def test_source_imports_are_recorded_and_newest_first(self):
        base = datetime(2026, 10, 20, tzinfo=timezone.utc)
        self.repository.record_source_import(
            SourceImport(
                import_id="I1",
                source_id="universe_json",
                source_version="v1",
                imported_count=10,
                status="success",
                imported_at=base,
            )
        )
        self.repository.record_source_import(
            SourceImport(
                import_id="I2",
                source_id="akshare_security",
                imported_count=0,
                status="failed",
                warnings=["网络不可用"],
                imported_at=base.replace(hour=1),
            )
        )
        items = self.repository.list_source_imports()
        self.assertEqual([item.import_id for item in items], ["I2", "I1"])
        self.assertEqual(items[0].status, "failed")
        self.assertEqual(items[0].warnings, ["网络不可用"])
        self.assertEqual(len(self.repository.list_source_imports(limit=1)), 1)

    def test_upsert_is_idempotent(self):
        self.repository.upsert_entities([_entity()], source_version="v1")
        self.repository.upsert_entities([_entity()], source_version="v2")
        entity = self.repository.get("SEC:CN:A:600519")
        self.assertEqual(entity.source, "contract_test")
        self.assertEqual(len(self.repository.find_by_name("贵州茅台")), 1)

    def test_upsert_merges_aliases_and_attributes_across_sources(self):
        self.repository.upsert_entities([_entity()], source_version="v1")
        later = EntityInstance(
            entity_id="SEC:CN:A:600519",
            entity_type_code="ENTITY_01_01",
            canonical_name="贵州茅台股份有限公司",
            identifiers={"security_code": "600519"},
            attributes={"board": "主板"},
            source="other_source",
        )
        self.repository.upsert_entities([later], source_version="v2")
        merged = self.repository.get("SEC:CN:A:600519")
        self.assertEqual(merged.canonical_name, "贵州茅台股份有限公司")
        self.assertIn("茅台", merged.aliases)
        self.assertIn("贵州茅台", merged.aliases)  # 旧标准名保留为曾用名
        self.assertEqual(merged.attributes["industry"], "食品饮料")
        self.assertEqual(merged.attributes["board"], "主板")
        self.assertIn("茅台", {term.text for term in self.repository.index_terms()})


class InMemoryRepositoryContractTest(RepositoryContractMixin, unittest.TestCase):
    def setUp(self):
        self.repository = InMemoryEntityRepository()


class SqliteRepositoryContractTest(RepositoryContractMixin, unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.mkdtemp(prefix="research_entities_")
        self.repository = SqliteEntityRepository(Path(self.tempdir) / "entities.sqlite3")

    def tearDown(self):
        shutil.rmtree(self.tempdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
