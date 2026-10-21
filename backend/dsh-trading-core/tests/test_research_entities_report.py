# -*- coding: utf-8 -*-
"""报告层离线测试：确定性骨架、模型引用约束与持久化。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.adapters.storage_sqlite import SqliteEntityRepository
from research_entities.errors import ReportError
from research_entities.models import (
    EvidenceItem,
    ResearchScope,
    ScopeEntity,
)
from research_entities.reporting import (
    ReportService,
    build_deterministic_report,
    build_llm_report,
    render_markdown,
    validate_report,
)
from research_entities.toolbox.evidence import build_bundle

NOW = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
REQUEST_ID = "REQ_REPORT"


def evidence(
    evidence_id: str,
    tool_id: str,
    *,
    status: str = "ok",
    data: dict | None = None,
    record_count: int = 0,
    error: str | None = None,
    offset_minutes: int = 0,
    warnings: list[str] | None = None,
) -> EvidenceItem:
    return EvidenceItem(
        evidence_id=evidence_id,
        request_id=REQUEST_ID,
        tool_id=tool_id,
        status=status,
        entity_ids=["SEC:CN:A:600519"],
        source="fixture",
        fetched_at=NOW + timedelta(minutes=offset_minutes),
        record_count=record_count,
        data=data or {},
        error=error,
        warnings=list(warnings or []),
    )


def build_repository() -> InMemoryEntityRepository:
    repository = InMemoryEntityRepository()
    repository.save_evidence(
        evidence(
            "EV_QUOTE",
            "quote_history",
            record_count=2,
            data={
                "records": [
                    {"date": "2026-10-17", "open": 1500.5, "close": 1510.0},
                    {"date": "2026-10-18", "open": 1511.0, "close": 1520.5},
                ],
                "count": 2,
            },
        )
    )
    repository.save_evidence(
        evidence(
            "EV_SECURITY",
            "security_lookup",
            data={"entity": {"entity_id": "SEC:CN:A:600519", "canonical_name": "贵州茅台"}},
            offset_minutes=1,
        )
    )
    repository.save_evidence(
        evidence(
            "EV_CHAIN",
            "industry_chain_lookup",
            status="unavailable",
            error="产业链服务不可用",
            offset_minutes=2,
        )
    )
    repository.save_scope(
        ResearchScope(
            request_id=REQUEST_ID,
            raw_query="贵州茅台最近走势怎么样",
            status="scope_ready",
            entity_list=[
                ScopeEntity(
                    mention_id="M1",
                    entity_id="SEC:CN:A:600519",
                    entity_type_code="ENTITY_01_01",
                    raw_text="贵州茅台",
                    resolution_status="resolved",
                    canonical_name="贵州茅台",
                )
            ],
        )
    )
    return repository


def valid_llm_payload() -> dict:
    return {
        "summary": "行情数据显示收盘价上行，产业链数据缺失，判断需谨慎。",
        "sections": [
            {
                "title": "价格表现",
                "claims": [
                    {
                        "text": "2026-10-18 收盘价为 1520.5。",
                        "kind": "fact",
                        "evidence_refs": ["E1"],
                    },
                    {
                        "text": "短期偏强，但缺少产业链验证。",
                        "kind": "analysis",
                        "evidence_refs": ["E1", "E3"],
                    },
                ],
            }
        ],
    }


class DeterministicReportTest(unittest.TestCase):
    def test_report_contains_tables_citations_and_gaps(self):
        service = ReportService(build_repository())
        report = service.build(REQUEST_ID)

        self.assertEqual(report.mode, "deterministic")
        self.assertEqual(report.request_id, REQUEST_ID)
        self.assertEqual(
            [item.citation_id for item in report.citations], ["E1", "E2", "E3"]
        )
        self.assertEqual(len(report.gaps), 1)

        section_ids = [section.section_id for section in report.sections]
        self.assertIn("scope", section_ids)
        self.assertIn("evidence", section_ids)
        self.assertIn("gaps", section_ids)

        data_sections = [item for item in report.sections if item.section_id.startswith("data_")]
        self.assertTrue(data_sections)
        quote_tables = [
            table
            for section in data_sections
            for table in section.tables
            if table.evidence_id == "EV_QUOTE"
        ]
        self.assertEqual(len(quote_tables[0].rows), 2)
        self.assertEqual(quote_tables[0].columns, ["date", "open", "close"])
        self.assertIn("E1", quote_tables[0].title)

    def test_evidence_warnings_are_disclosed(self):
        repository = InMemoryEntityRepository()
        repository.save_evidence(
            evidence(
                "EV_STALE",
                "quote_history",
                data={"records": [{"date": "2026-09-30", "close": 100.0}]},
                record_count=1,
                warnings=["行情最新日期为 2026-09-30，落后最近交易日 2026-10-20 共 14 个交易日。"],
            )
        )
        report = ReportService(repository).build(REQUEST_ID)
        section = next(
            item for item in report.sections if item.section_id == "evidence"
        )
        self.assertTrue(
            any("落后最近交易日" in paragraph for paragraph in section.paragraphs),
            section.paragraphs,
        )
        self.assertTrue(
            any("E1" in paragraph for paragraph in section.paragraphs)
        )

    def test_report_is_persisted_and_latest_is_returned(self):
        service = ReportService(build_repository())
        report = service.build(REQUEST_ID)
        self.assertEqual(service.latest(REQUEST_ID).report_id, report.report_id)
        self.assertEqual(service.get(report.report_id).report_id, report.report_id)
        self.assertEqual(len(service.list(REQUEST_ID)), 1)

    def test_missing_evidence_raises(self):
        service = ReportService(InMemoryEntityRepository())
        with self.assertRaises(ReportError):
            service.build("REQ_NOTHING")

    def test_markdown_renders_citations_and_gaps(self):
        report = build_deterministic_report(
            build_bundle(
                REQUEST_ID,
                [build_repository().list_evidence(REQUEST_ID)[0]],
            )
        )
        text = render_markdown(report)
        self.assertIn("# 研究报告", text)
        self.assertIn("[E1]", text)
        self.assertIn("参考证据", text)


class LLMReportTest(unittest.TestCase):
    def test_valid_model_claims_are_kept(self):
        service = ReportService(
            build_repository(), llm_call=lambda system, user: valid_llm_payload()
        )
        report = service.build(REQUEST_ID, mode="llm")

        self.assertEqual(report.mode, "llm_assisted")
        claims = [claim for section in report.sections for claim in section.claims]
        self.assertEqual(len(claims), 2)
        self.assertEqual(claims[0].kind, "fact")
        self.assertEqual(claims[0].evidence_refs, ["E1"])
        self.assertEqual(claims[0].evidence_ids, ["EV_QUOTE"])
        self.assertEqual(claims[1].evidence_ids, ["EV_QUOTE", "EV_CHAIN"])

    def test_invalid_citations_and_gap_facts_are_dropped(self):
        payload = {
            "summary": "测试",
            "sections": [
                {
                    "title": "测试",
                    "claims": [
                        {"text": "引用不存在的脚注。", "kind": "analysis", "evidence_refs": ["E9"]},
                        {"text": "引用缺口证据当事实。", "kind": "fact", "evidence_refs": ["E3"]},
                        {"text": "没有引用的事实。", "kind": "fact", "evidence_refs": []},
                        {"text": "有效分析。", "kind": "analysis", "evidence_refs": ["E2"]},
                    ],
                }
            ],
        }
        service = ReportService(
            build_repository(), llm_call=lambda system, user: payload
        )
        report = service.build(REQUEST_ID, mode="llm")

        claims = [claim for section in report.sections for claim in section.claims]
        self.assertEqual([claim.text for claim in claims], ["有效分析。"])
        joined = "\n".join(report.warnings)
        self.assertIn("unknown_citation", joined)
        self.assertIn("fact_from_gap", joined)
        self.assertIn("fact_without_evidence", joined)

    def test_fabricated_number_drops_claim(self):
        payload = {
            "summary": "测试",
            "sections": [
                {
                    "title": "价格",
                    "claims": [
                        {
                            "text": "收盘价为 9999.9。",
                            "kind": "fact",
                            "evidence_refs": ["E1"],
                        }
                    ],
                }
            ],
        }
        service = ReportService(
            build_repository(), llm_call=lambda system, user: payload
        )
        report = service.build(REQUEST_ID, mode="llm")
        self.assertEqual(report.mode, "deterministic")
        self.assertIn("number_not_grounded", "\n".join(report.warnings))

    def test_fabricated_summary_number_falls_back(self):
        payload = valid_llm_payload()
        payload["summary"] = "目标价 9999 元，上涨空间 88%。"
        service = ReportService(
            build_repository(), llm_call=lambda system, user: payload
        )
        report = service.build(REQUEST_ID, mode="llm")
        self.assertEqual(report.mode, "llm_assisted")
        self.assertNotIn("9999", report.summary)
        self.assertIn("摘要中的数字未在任何证据中找到", "\n".join(report.warnings))

    def test_llm_failure_falls_back(self):
        def broken(system, user):
            raise RuntimeError("upstream 500")

        service = ReportService(build_repository(), llm_call=broken)
        report = service.build(REQUEST_ID, mode="llm")
        self.assertEqual(report.mode, "deterministic")
        self.assertIn("已降级", "\n".join(report.warnings))

    def test_validator_reports_gap_facts(self):
        bundle = build_bundle(REQUEST_ID, build_repository().list_evidence(REQUEST_ID))
        report = build_llm_report(
            bundle,
            llm_call=lambda system, user: {
                "summary": "x",
                "sections": [
                    {
                        "title": "t",
                        "claims": [
                            {
                                "text": "产业链服务不可用意味着公司没有产业链。",
                                "kind": "fact",
                                "evidence_refs": ["E3"],
                            }
                        ],
                    }
                ],
            },
        )
        issues = validate_report(report, bundle)
        # 有问题的判断已经丢弃，报告本身不应再包含该 claim。
        self.assertEqual(issues, [])
        self.assertIn("fact_from_gap", "\n".join(report.warnings))


class SqliteReportTest(unittest.TestCase):
    def test_report_roundtrip_and_legacy_upgrade(self):
        migrations = (
            Path(__file__).resolve().parent.parent
            / "research_entities"
            / "migrations"
        )
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "legacy.db"
            connection = sqlite3.connect(path)
            connection.executescript(
                (migrations / "001_init.sql").read_text(encoding="utf-8")
            )
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                ("001_init", NOW.isoformat()),
            )
            connection.commit()
            connection.close()

            repository = SqliteEntityRepository(path)
            for item in build_repository().list_evidence(REQUEST_ID):
                repository.save_evidence(item)
            report = ReportService(repository).build(REQUEST_ID)

            loaded = repository.get_report(report.report_id)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.request_id, REQUEST_ID)
            self.assertEqual(loaded.sections[0].section_id, "scope")
            self.assertEqual(len(repository.list_reports(REQUEST_ID)), 1)
            repository.close()

            connection = sqlite3.connect(path)
            versions = {
                row[0]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations"
                ).fetchall()
            }
            connection.close()
            self.assertIn("003_reports", versions)


if __name__ == "__main__":
    unittest.main()
