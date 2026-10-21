# -*- coding: utf-8 -*-
"""研究证据与 Scope 预挂载执行测试。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.adapters.storage_sqlite import SqliteEntityRepository
from research_entities.models import (
    PreloadTool,
    ResearchScope,
    ScopeEntity,
)
from research_entities.tool_preloader import ToolPreloader
from research_entities.toolbox.context import ToolContext, ToolUnavailable
from research_entities.toolbox.executor import ToolExecutor

from tests.research_entities_fixtures import seed_stocks

NOW = lambda: datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
STOCK_ID = "SEC:CN:A:600519"
COMPANY_ID = "CO:CN:A:600519"


class OfflineAkshare:
    """默认工具回退会执行行情类工具；单测必须离线，避免真实抓取污染缓存。"""

    def __getattr__(self, name):
        def call(**kwargs):
            raise ToolUnavailable("离线测试")

        return call


class OfflineSession:
    trust_env = True

    def get(self, url, params=None, timeout=None):
        raise ConnectionError("离线测试")

    def post(self, url, json=None, timeout=None):
        raise ConnectionError("离线测试")


def build_executor(repository=None, *, persist_evidence=True):
    repository = repository or InMemoryEntityRepository()
    if not repository.get(STOCK_ID):
        seed_stocks(repository)
    context = ToolContext(
        repository,
        akshare_module=OfflineAkshare(),
        http_session=OfflineSession(),
        timeout=1,
        service_timeout=0.1,
        now=NOW,
    )
    return ToolExecutor(context, audit=False, persist_evidence=persist_evidence), repository


class EvidencePersistenceTest(unittest.TestCase):
    def test_execution_persists_evidence_by_request_id(self):
        executor, repository = build_executor()
        result = executor.execute_tool(
            "security_lookup",
            entity_ids=[STOCK_ID],
            request_id="REQ_EVIDENCE_1",
        )
        self.assertEqual(result.status, "ok")

        items = repository.list_evidence("REQ_EVIDENCE_1")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].tool_id, "security_lookup")
        self.assertEqual(items[0].status, "ok")
        self.assertEqual(items[0].record_count, result.record_count)
        self.assertIn("entity", items[0].data)

    def test_bundle_summarizes_and_reports_gaps(self):
        executor, _ = build_executor()
        executor.execute_tool(
            "security_lookup",
            entity_ids=[STOCK_ID],
            request_id="REQ_BUNDLE",
        )
        executor.execute_tool(
            "security_lookup",
            params={"code": "999999"},
            request_id="REQ_BUNDLE",
        )
        bundle = executor.evidence_bundle("REQ_BUNDLE")
        self.assertEqual(bundle.request_id, "REQ_BUNDLE")
        self.assertEqual(len(bundle.items), 2)
        self.assertEqual(bundle.summary.get("ok"), 1)
        self.assertEqual(bundle.summary.get("empty"), 1)
        self.assertEqual(len(bundle.gaps), 1)
        self.assertEqual(bundle.gaps[0]["status"], "empty")
        self.assertEqual(bundle.gaps[0]["tool_id"], "security_lookup")
        self.assertTrue(bundle.gaps[0]["reason"])

    def test_no_request_id_means_no_evidence(self):
        executor, repository = build_executor()
        executor.execute_tool("security_lookup", entity_ids=[STOCK_ID])
        self.assertEqual(repository.list_evidence(""), [])
        self.assertEqual(repository._evidence, {})

    def test_persist_evidence_can_be_disabled(self):
        executor, repository = build_executor(persist_evidence=False)
        executor.execute_tool(
            "security_lookup",
            entity_ids=[STOCK_ID],
            request_id="REQ_NO_EVIDENCE",
        )
        self.assertEqual(repository.list_evidence("REQ_NO_EVIDENCE"), [])

    def test_unknown_tool_is_persisted_as_error_gap(self):
        executor, _ = build_executor()
        executor.execute_tool("no_such_tool", request_id="REQ_UNKNOWN")
        bundle = executor.evidence_bundle("REQ_UNKNOWN")
        self.assertEqual(bundle.summary, {"error": 1})
        self.assertEqual(bundle.gaps[0]["tool_id"], "no_such_tool")
        self.assertIn("未注册", bundle.gaps[0]["reason"])


class ScopeExecutionTest(unittest.TestCase):
    def test_preloaded_tools_drive_execution(self):
        executor, _ = build_executor()
        scope = ResearchScope(
            request_id="REQ_SCOPE_PRELOAD",
            raw_query="测试预挂载执行",
            preload_tool_ids=["security_lookup", "theme_constituents_lookup"],
            preload_tools=[
                PreloadTool(
                    tool_id="security_lookup",
                    entity_ids=[STOCK_ID],
                    status="configured",
                ),
                PreloadTool(
                    tool_id="theme_constituents_lookup",
                    status="unconfigured",
                ),
            ],
        )
        results = executor.execute_for_scope(scope)
        # Scope 没有实体条目，只应执行预挂载里已配置的工具。
        self.assertEqual([item.tool_id for item in results], ["security_lookup"])
        self.assertEqual(results[0].status, "ok")
        self.assertEqual(results[0].entity_ids, [STOCK_ID])
        self.assertEqual(len(executor.evidence_bundle("REQ_SCOPE_PRELOAD").items), 1)

    def test_scope_without_preload_falls_back_to_entity_defaults(self):
        executor, _ = build_executor()
        scope = ResearchScope(
            request_id="REQ_SCOPE_FALLBACK",
            raw_query="测试回退执行",
            entity_list=[
                ScopeEntity(
                    mention_id="M1",
                    entity_id=STOCK_ID,
                    entity_type_code="ENTITY_01_01",
                    raw_text="贵州茅台",
                    resolution_status="resolved",
                )
            ],
        )
        results = executor.execute_for_scope(scope)
        self.assertIn("security_lookup", [item.tool_id for item in results])
        self.assertEqual(
            len(executor.evidence_bundle("REQ_SCOPE_FALLBACK").items), len(results)
        )

    def test_preloader_scopes_entity_ids_by_type(self):
        tools, _ = ToolPreloader().preload(
            entity_types=["ENTITY_01_01", "ENTITY_02_01"],
            intent_codes=[],
            entity_ids=[STOCK_ID, COMPANY_ID],
            entity_ids_by_type={
                "ENTITY_01_01": [STOCK_ID],
                "ENTITY_02_01": [COMPANY_ID],
            },
        )
        by_id = {item.tool_id: item for item in tools}
        self.assertEqual(by_id["security_lookup"].entity_ids, [STOCK_ID])
        self.assertEqual(by_id["company_profile"].entity_ids, [COMPANY_ID])


class SqliteEvidenceTest(unittest.TestCase):
    def test_evidence_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = SqliteEntityRepository(Path(folder) / "entities.db")
            seed_stocks(repository)
            executor = ToolExecutor(
                ToolContext(repository, now=NOW), audit=False
            )
            executor.execute_tool(
                "security_lookup",
                entity_ids=[STOCK_ID],
                request_id="REQ_SQLITE",
            )
            items = repository.list_evidence("REQ_SQLITE")
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0].tool_id, "security_lookup")
            self.assertEqual(items[0].status, "ok")
            self.assertIn("entity", items[0].data)
            repository.close()

    def test_upgrade_from_existing_001_database(self):
        migrations = Path(__file__).resolve().parent.parent / "research_entities" / "migrations"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "legacy.db"
            connection = sqlite3.connect(path)
            connection.executescript(
                (migrations / "001_init.sql").read_text(encoding="utf-8")
            )
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                ("001_init", datetime.now(timezone.utc).isoformat()),
            )
            connection.commit()
            connection.close()

            repository = SqliteEntityRepository(path)
            seed_stocks(repository)
            executor = ToolExecutor(
                ToolContext(repository, now=NOW), audit=False
            )
            executor.execute_tool(
                "security_lookup",
                entity_ids=[STOCK_ID],
                request_id="REQ_UPGRADE",
            )
            self.assertEqual(len(repository.list_evidence("REQ_UPGRADE")), 1)

            connection = sqlite3.connect(path)
            versions = {
                row[0]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations"
                ).fetchall()
            }
            connection.close()
            repository.close()
            self.assertIn("002_evidence", versions)


if __name__ == "__main__":
    unittest.main()
