# -*- coding: utf-8 -*-
"""研究实体 HTTP API 离线测试。"""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from research_entities.api import create_app
from research_entities.toolbox.context import ToolContext, ToolUnavailable

STOCK_ID = "SEC:CN:A:600519"


class OfflineAkshare:
    """任何行情调用都视为数据源不可用，测试不触网。"""

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


def build_client(llm_call=None):
    from tests.research_entities_fixtures import InMemoryEntityRepository
    from tests.research_entities_fixtures import build_service

    repository = InMemoryEntityRepository()
    build_service(repository=repository)
    context = ToolContext(
        repository,
        akshare_module=OfflineAkshare(),
        http_session=OfflineSession(),
        timeout=1,
        service_timeout=0.1,
    )
    app = create_app(
        repository=repository,
        tool_context=context,
        llm_call=llm_call,
    )
    return TestClient(app), repository


def valid_llm_payload() -> dict:
    return {
        "summary": "离线报告摘要。",
        "sections": [
            {
                "title": "测试章节",
                "claims": [
                    {
                        "text": "这是基于证据的分析。",
                        "kind": "analysis",
                        "evidence_refs": ["E1"],
                    }
                ],
            }
        ],
    }


class ResearchApiTest(unittest.TestCase):
    def setUp(self):
        self.client, self.repository = build_client()
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def test_health(self):
        for path in ("/health", "/research/health"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "ok")

    def test_sources_endpoint_reports_freshness_and_disables_scheduler(self):
        response = self.client.get("/research/sources")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        # 内存仓储不启用后台刷新，避免测试环境被动联网。
        self.assertFalse(payload["refresh_enabled"])
        by_id = {item["source_id"]: item for item in payload["sources"]}
        self.assertIn("gazetteer_json", by_id)
        self.assertIn("akshare_security", by_id)
        self.assertEqual(by_id["gazetteer_json"]["state"], "fresh")
        self.assertEqual(by_id["akshare_security"]["state"], "never_imported")
        self.assertIn("akshare_security", payload["stale_sources"])

    def test_tool_catalog(self):
        response = self.client.get("/research/tools")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total"], 48)
        self.assertEqual(sum(payload["by_availability"].values()), 48)
        by_id = {item["tool_id"]: item for item in payload["tools"]}
        self.assertTrue(by_id["quote_history"]["executable"])
        # 策略自进化：依赖 trading-core 在线，不可执行时如实标注为外部服务。
        self.assertEqual(
            by_id["strategy_pool_lookup"]["availability"], "external_service"
        )
        self.assertFalse(by_id["strategy_pool_lookup"]["executable"])
        self.assertIn("ENTITY_01_01", by_id["quote_history"]["used_by"])
        self.assertTrue(by_id["portfolio_lookup"]["requires_authorization"])
        self.assertTrue(by_id["theme_constituents_lookup"]["executable"])
        self.assertEqual(
            by_id["theme_constituents_lookup"]["availability"], "configured"
        )
        self.assertFalse(by_id["supply_demand_lookup"]["executable"])
        self.assertFalse(by_id["event_monitor_setup"]["executable"])

    def test_tool_detail_and_unknown_tool(self):
        detail = self.client.get("/research/tools/quote_history")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["tool_id"], "quote_history")
        self.assertIn("ENTITY_01_01", detail.json()["used_by"])
        self.assertEqual(
            self.client.get("/research/tools/no_such_tool").status_code, 404
        )

    def test_entity_type_catalog(self):
        response = self.client.get("/research/entities/types")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total"], 20)
        codes = [item["type_code"] for item in payload["types"]]
        self.assertEqual(len(codes), 20)
        self.assertEqual(len(set(codes)), 20)
        stock = next(
            item for item in payload["types"] if item["type_code"] == "ENTITY_01_01"
        )
        self.assertEqual(stock["parent_name"], "证券标的")
        self.assertIn("quote_history", stock["default_tool_ids"])
        collections = {
            item["collection_type"]: item for item in payload["dynamic_collections"]
        }
        self.assertTrue(collections["USER_PORTFOLIO"]["requires_authorization"])
        self.assertIn("portfolio_lookup", collections["USER_PORTFOLIO"]["default_tool_ids"])

    def test_list_entities_by_type(self):
        response = self.client.get(
            "/research/entities", params={"type_code": "ENTITY_01_01", "limit": 2}
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["type_code"], "ENTITY_01_01")
        self.assertEqual(payload["total"], 2)
        self.assertTrue(payload["next_cursor"])
        self.assertEqual(
            {item["entity_type_code"] for item in payload["items"]},
            {"ENTITY_01_01"},
        )
        self.assertTrue(all(item["entity_id"] for item in payload["items"]))

        next_page = self.client.get(
            "/research/entities",
            params={
                "type_code": "ENTITY_01_01",
                "limit": 2,
                "cursor": payload["next_cursor"],
            },
        ).json()
        self.assertEqual(next_page["total"], 2)
        self.assertTrue(next_page["next_cursor"])
        self.assertFalse(
            {item["entity_id"] for item in payload["items"]}
            & {item["entity_id"] for item in next_page["items"]}
        )

        last_page = self.client.get(
            "/research/entities",
            params={
                "type_code": "ENTITY_01_01",
                "limit": 2,
                "cursor": next_page["next_cursor"],
            },
        ).json()
        self.assertEqual(last_page["total"], 1)
        self.assertIsNone(last_page["next_cursor"])

    def test_list_entities_rejects_unknown_type(self):
        response = self.client.get(
            "/research/entities", params={"type_code": "ENTITY_99_99"}
        )
        self.assertEqual(response.status_code, 400)

    def test_search_entities_by_name(self):
        response = self.client.get(
            "/research/entities/search",
            params={"q": "贵州茅台", "type_code": "ENTITY_01_01"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["entity_id"], STOCK_ID)
        self.assertIn("exact_name_match", payload["items"][0]["match_reason"])

    def test_scope_endpoint_resolves_entity(self):
        response = self.client.post(
            "/research/scope", json={"query": "贵州茅台现在怎么样"}
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "scope_ready")
        self.assertIn(
            STOCK_ID,
            [item["entity_id"] for item in payload["entity_list"]],
        )

    def test_tool_run_and_evidence_visibility(self):
        response = self.client.post(
            "/research/tools/run",
            json={
                "tool_id": "security_lookup",
                "entity_ids": [STOCK_ID],
                "request_id": "REQ_API_TOOL",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

        hidden = self.client.get("/research/evidence/REQ_API_TOOL").json()
        self.assertEqual(len(hidden["items"]), 1)
        self.assertEqual(hidden["items"][0]["data"], {})

        full = self.client.get(
            "/research/evidence/REQ_API_TOOL", params={"include_data": True}
        ).json()
        self.assertIn("entity", full["items"][0]["data"])

    def test_research_run_orchestrates_scope_tools_and_evidence(self):
        response = self.client.post(
            "/research/run", json={"query": "贵州茅台现在怎么样"}
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["scope"]["status"], "scope_ready")
        self.assertGreater(payload["summary"]["total"], 0)
        self.assertEqual(payload["evidence"]["items"], payload["summary"]["total"])
        self.assertEqual(len(payload["results"]), payload["summary"]["total"])
        self.assertNotIn("data", payload["results"][0])

        request_id = payload["request_id"]
        evidence = self.client.get(f"/research/evidence/{request_id}").json()
        self.assertEqual(len(evidence["items"]), payload["summary"]["total"])
        for item in evidence["items"]:
            self.assertIn(
                item["status"],
                {"ok", "empty", "unavailable", "error", "needs_authorization"},
            )

    def test_report_build_list_and_latest_markdown(self):
        run = self.client.post("/research/run", json={"query": "贵州茅台现在怎么样"})
        request_id = run.json()["request_id"]

        built = self.client.post(
            "/research/reports",
            json={"request_id": request_id, "mode": "deterministic"},
        )
        self.assertEqual(built.status_code, 200)
        report = built.json()
        self.assertEqual(report["mode"], "deterministic")
        self.assertTrue(report["citations"])

        listed = self.client.get(f"/research/reports/{request_id}").json()
        self.assertEqual(len(listed["reports"]), 1)
        self.assertEqual(listed["reports"][0]["report_id"], report["report_id"])

        latest = self.client.get(
            f"/research/reports/{request_id}/latest",
            params={"format": "markdown"},
        )
        self.assertEqual(latest.status_code, 200)
        self.assertIn("# 研究报告", latest.text)

        by_id = self.client.get(
            f"/research/reports/by-id/{report['report_id']}"
        )
        self.assertEqual(by_id.status_code, 200)
        self.assertEqual(by_id.json()["report_id"], report["report_id"])

    def test_report_for_missing_request_returns_404(self):
        response = self.client.post(
            "/research/reports", json={"request_id": "REQ_MISSING"}
        )
        self.assertEqual(response.status_code, 404)

    def test_llm_report_endpoint(self):
        client, _ = build_client(llm_call=lambda system, user: valid_llm_payload())
        with client:
            run = client.post("/research/run", json={"query": "贵州茅台现在怎么样"})
            request_id = run.json()["request_id"]
            response = client.post(
                "/research/reports",
                json={"request_id": request_id, "mode": "llm"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["mode"], "llm_assisted")
            claims = [
                claim
                for section in response.json()["sections"]
                for claim in section["claims"]
            ]
            self.assertEqual(claims[0]["evidence_refs"], ["E1"])


if __name__ == "__main__":
    unittest.main()
