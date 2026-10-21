# -*- coding: utf-8 -*-
"""工具执行层离线测试：用假 akshare / 假 HTTP 会话验证解析与降级。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

import pandas as pd

from research_entities.models import EntityInstance
from research_entities.toolbox.context import ToolContext
from research_entities.toolbox.executor import ToolExecutor

from tests.research_entities_fixtures import InMemoryEntityRepository, seed_stocks

NOW = lambda: datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)


class FakeAkshare:
    """按函数名返回固定 DataFrame，并记录调用。"""

    def __init__(self, responses: dict):
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            response = self.responses.get(name)
            if response is None:
                raise RuntimeError(f"fake akshare 没有配置 {name}")
            return response(**kwargs) if callable(response) else response

        return call


class FakeSession:
    trust_env = True

    def get(self, url, params=None, timeout=None):
        raise ConnectionError(f"服务不可达：{url}")

    def post(self, url, json=None, timeout=None):
        raise ConnectionError(f"服务不可达：{url}")


class _FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class RecordingSession(FakeSession):
    def __init__(self):
        self.posts: list[tuple[str, dict]] = []

    def post(self, url, json=None, timeout=None):
        self.posts.append((url, dict(json or {})))
        return _FakeResponse({"ok": True, "id": "test-rule"})


class ToolBoxTest(unittest.TestCase):
    def build(self, responses: dict, session=None):
        repository = InMemoryEntityRepository()
        seed_stocks(repository)
        fake = FakeAkshare(responses)
        context = ToolContext(
            repository,
            akshare_module=fake,
            http_session=session or FakeSession(),
            timeout=5,
            service_timeout=0.1,
            now=NOW,
        )
        return ToolExecutor(context, audit=False), fake, repository

    def test_quote_history_normalizes_series(self):
        frame = pd.DataFrame(
            [
                {"date": "2026-10-16", "close": 100.0, "volume": 10},
                {"date": "2026-10-19", "close": 110.0, "volume": 20},
            ]
        )
        executor, fake, _ = self.build({"stock_zh_a_daily": frame})
        result = executor.execute_tool(
            "quote_history", entity_ids=["SEC:CN:A:600519"], params={}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["count"], 2)
        self.assertEqual(result.data["summary"]["latest"], 110.0)
        self.assertEqual(result.data["summary"]["change_pct"], 10.0)
        self.assertIn("stock_zh_a_daily", [call[0] for call in fake.calls])

    def test_margin_uses_sse_target_code_column(self):
        frame = pd.DataFrame(
            [
                {"信用交易日期": "20261019", "标的证券代码": "600519", "融资余额": 1},
                {"信用交易日期": "20261019", "标的证券代码": "000001", "融资余额": 2},
            ]
        )
        executor, _fake, _ = self.build({"stock_margin_detail_sse": frame})
        result = executor.execute_tool(
            "margin_balance_lookup", entity_ids=["SEC:CN:A:600519"], params={"days": 3}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.source, "akshare.stock_margin_detail_sse")
        self.assertEqual(result.data["records"][0]["标的证券代码"], "600519")

    def test_announcement_prefers_cninfo(self):
        frame = pd.DataFrame(
            [
                {"公告标题": "测试公告", "公告时间": "2026-10-19", "公告链接": "http://x"}
            ]
        )
        executor, fake, _ = self.build(
            {"stock_zh_a_disclosure_report_cninfo": frame}
        )
        result = executor.execute_tool(
            "announcement_search", entity_ids=["CO:CN:A:600519"], params={}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.source, "akshare.stock_zh_a_disclosure_report_cninfo")
        self.assertIn(
            "stock_zh_a_disclosure_report_cninfo", [name for name, _ in fake.calls]
        )

    def test_slug_entity_is_not_used_as_security_code(self):
        executor, fake, repository = self.build({})
        repository.upsert_entities(
            [
                EntityInstance(
                    entity_id="TREND:AI_COMPUTE_DEMAND",
                    entity_type_code="ENTITY_04_01",
                    canonical_name="AI算力需求",
                    identifiers={},
                    attributes={},
                    source="fixture",
                    status="imported_unverified",
                )
            ],
            source_version="fixture-v1",
        )
        result = executor.execute_tool(
            "event_timeline_lookup", entity_ids=["TREND:AI_COMPUTE_DEMAND"], params={}
        )
        self.assertEqual(result.status, "empty")
        called = [name for name, _ in fake.calls]
        self.assertNotIn("stock_news_em", called)

    def test_stale_index_history_falls_back_to_csindex(self):
        old = pd.DataFrame(
            [{"date": "2019-01-30", "close": 4000.0}],
        )
        # 数据源约定按日期升序返回，记录层再翻转为最新在前。
        recent = pd.DataFrame(
            [
                {"日期": "2025-10-20", "收盘": 4000.0},
                {"日期": "2026-10-19", "收盘": 4100.0},
            ]
        )
        executor, _fake, _ = self.build(
            {
                "stock_zh_index_daily": old,
                "stock_zh_index_hist_csindex": recent,
            }
        )
        result = executor.execute_tool(
            "index_performance_lookup", params={"code": "000300"}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.source, "akshare.stock_zh_index_hist_csindex")
        self.assertEqual(result.data["summary"]["latest_date"], "2026-10-19")

    def test_executor_enforces_authorization_and_unknown_tool(self):
        executor, _fake, _ = self.build({})
        blocked = executor.execute_tool("event_monitor_setup", params={})
        self.assertEqual(blocked.status, "needs_authorization")
        missing = executor.execute_tool("no_such_tool", params={})
        self.assertEqual(missing.status, "error")

    def test_event_monitor_posts_market_watch_alert_schema(self):
        session = RecordingSession()
        executor, _fake, _ = self.build({}, session=session)
        result = executor.execute_tool(
            "event_monitor_setup",
            params={
                "code": "600519",
                "field": "pct_change",
                "operator": ">=",
                "value": 5,
            },
            authorized=True,
        )
        self.assertEqual(result.status, "ok")
        url, payload = session.posts[0]
        self.assertTrue(url.endswith("/alerts"))
        self.assertEqual(payload["ticker"], "600519")
        self.assertEqual(
            payload["conditions"],
            [{"field": "pct_change", "operator": ">=", "value": 5.0}],
        )
        self.assertNotIn("condition", payload)

    def test_event_monitor_rejects_invalid_condition_without_writing(self):
        session = RecordingSession()
        executor, _fake, _ = self.build({}, session=session)
        result = executor.execute_tool(
            "event_monitor_setup",
            params={"code": "600519", "field": "not_a_field", "value": 1},
            authorized=True,
        )
        self.assertEqual(result.status, "empty")
        self.assertEqual(session.posts, [])

    def test_industry_entity_resolves_representative_company_by_name(self):
        class Session:
            trust_env = True

            def __init__(self):
                self.calls = []

            def get(self, url, params=None, timeout=None):
                self.calls.append((url, dict(params or {})))
                if url.endswith("/companies"):
                    return _FakeResponse(
                        {
                            "items": [
                                {"code": "600519", "name": "贵州茅台", "industry": "白酒"}
                            ]
                        }
                    )
                if "/graph/chain/600519" in url:
                    return _FakeResponse({"nodes": [{"id": "600519"}], "layers": []})
                raise ConnectionError(url)

            def post(self, url, json=None, timeout=None):
                raise ConnectionError(url)

        session = Session()
        executor, _fake, repository = self.build({}, session=session)
        repository.upsert_entities(
            [
                EntityInstance(
                    entity_id="IND:CN:BAIJIU",
                    entity_type_code="ENTITY_03_01",
                    canonical_name="白酒",
                    source="fixture",
                    status="imported_unverified",
                )
            ],
            source_version="fixture-industry",
        )
        result = executor.execute_tool(
            "industry_chain_lookup", entity_ids=["IND:CN:BAIJIU"]
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["code"], "600519")
        self.assertTrue(
            any("代表公司" in warning for warning in result.warnings)
        )
        self.assertTrue(
            any(
                url.endswith("/companies") and params.get("keyword") == "白酒"
                for url, params in session.calls
            )
        )

    def test_industry_entity_without_company_match_is_unavailable(self):
        class EmptySearchSession:
            trust_env = True

            def get(self, url, params=None, timeout=None):
                if url.endswith("/companies"):
                    return _FakeResponse({"items": []})
                raise ConnectionError(url)

            def post(self, url, json=None, timeout=None):
                raise ConnectionError(url)

        executor, _fake, repository = self.build({}, session=EmptySearchSession())
        repository.upsert_entities(
            [
                EntityInstance(
                    entity_id="THEME:NO_MATCH",
                    entity_type_code="ENTITY_04_01",
                    canonical_name="不存在的主题",
                    source="fixture",
                    status="imported_unverified",
                )
            ],
            source_version="fixture-theme",
        )
        result = executor.execute_tool(
            "industry_chain_lookup", entity_ids=["THEME:NO_MATCH"]
        )
        self.assertEqual(result.status, "unavailable")
        self.assertIn("按名称也没有找到代表公司", result.error)


if __name__ == "__main__":
    unittest.main()
