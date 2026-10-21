# -*- coding: utf-8 -*-
"""新增外部数据源离线测试：同花顺成分页、gov.cn 政策库与公司行动数据。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

import pandas as pd

from research_entities.toolbox.context import ToolContext
from research_entities.toolbox.executor import ToolExecutor
from research_entities.toolbox.handlers.fund_index import (
    _infer_index_sina_code,
    _parse_ths_constituents,
)

from tests.research_entities_fixtures import InMemoryEntityRepository, seed_stocks

NOW = lambda: datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)

CONCEPT_HTML = """<html><body>
<table class="m-table m-pager-table">
  <thead><tr>
    <th>序号</th><th>代码</th><th>名称</th><th>现价</th><th>涨跌幅(%)</th>
    <th>涨跌</th><th>换手(%)</th><th>量比(%)</th><th>振幅(%)</th>
    <th>成交额</th><th>流通股</th><th>流通市值</th><th>市盈率</th>
  </tr></thead>
  <tbody>
    <tr><td>1</td><td>688004</td><td>示例科技</td><td>37.19</td><td>20.01</td>
        <td>6.20</td><td>12.83</td><td>0.77</td><td>21.65</td>
        <td>3.53亿</td><td>0.80亿</td><td>29.78亿</td><td>--</td></tr>
    <tr><td>2</td><td>300466</td><td>样本股份</td><td>8.64</td><td>20.00</td>
        <td>1.44</td><td>7.84</td><td>7.10</td><td>21.39</td>
        <td>2.96亿</td><td>4.61亿</td><td>39.79亿</td><td>186.25</td></tr>
  </tbody>
</table>
<span class="page_info">1/3</span>
</body></html>"""

CONCEPT_PAGE_2 = """<html><body>
<table class="m-table m-pager-table">
  <thead><tr><th>序号</th><th>代码</th><th>名称</th><th>现价</th><th>涨跌幅(%)</th></tr></thead>
  <tbody>
    <tr><td>3</td><td>000001</td><td>页面二</td><td>10.00</td><td>1.00</td></tr>
  </tbody>
</table>
<span class="page_info">2/2</span>
</body></html>"""


class FakeAkshare:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            response = self.responses.get(name)
            if response is None:
                raise RuntimeError(f"fake akshare 没有配置 {name}")
            return response(**kwargs) if callable(response) else response

        return call


class _TextResponse:
    status_code = 200

    def __init__(self, text: str, encoding: str = "utf-8"):
        self.content = text.encode(encoding)
        self.text = text


class _JsonResponse:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class RoutedSession:
    trust_env = True

    def __init__(self, routes):
        self.routes = routes
        self.requests: list[tuple[str, dict]] = []

    def get(self, url, params=None, timeout=None, headers=None):
        self.requests.append((url, dict(params or {})))
        for fragment, value in self.routes.items():
            if fragment in url:
                return value
        raise ConnectionError(f"未配置的 URL：{url}")

    def post(self, url, json=None, timeout=None):
        raise ConnectionError(f"服务不可达：{url}")


class NewSourceTest(unittest.TestCase):
    def build(self, responses, session):
        repository = InMemoryEntityRepository()
        seed_stocks(repository)
        fake = FakeAkshare(responses)
        context = ToolContext(
            repository,
            akshare_module=fake,
            http_session=session,
            timeout=5,
            service_timeout=0.2,
            now=NOW,
        )
        return ToolExecutor(context, audit=False), fake

    def test_infer_index_sina_code_uses_index_ranges(self):
        self.assertEqual(_infer_index_sina_code("000001"), "sh000001")
        self.assertEqual(_infer_index_sina_code("399001"), "sz399001")
        self.assertEqual(_infer_index_sina_code("899050"), "bj899050")
        # 股票代码区间不能被误当成指数。
        self.assertIsNone(_infer_index_sina_code("600519"))
        self.assertIsNone(_infer_index_sina_code("300750"))

    def test_parse_ths_constituents_page(self):
        records, total_pages = _parse_ths_constituents(CONCEPT_HTML)
        self.assertEqual(total_pages, 3)
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["股票代码"], "688004")
        self.assertEqual(records[0]["股票简称"], "示例科技")
        self.assertEqual(records[0]["涨跌幅"], 20.01)
        self.assertIsNone(records[0]["市盈率"])

    def test_theme_constituents_fetches_pages(self):
        names = pd.DataFrame(
            [{"name": "人工智能", "code": "302035"}, {"name": "机器人", "code": "301558"}]
        )
        session = RoutedSession(
            {
                "q.10jqka.com.cn/gn/detail/code/302035/page/2/": _TextResponse(
                    CONCEPT_PAGE_2, "gbk"
                ),
                "q.10jqka.com.cn/gn/detail/code/302035/": _TextResponse(
                    CONCEPT_HTML, "gbk"
                ),
            }
        )
        executor, _fake = self.build(
            {"stock_board_concept_name_ths": names}, session
        )
        result = executor.execute_tool(
            "theme_constituents_lookup",
            params={"keyword": "人工智能", "pages": 2},
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["matched_board"], "人工智能")
        self.assertEqual(result.data["board_code"], "302035")
        self.assertEqual(result.data["count"], 3)
        self.assertEqual(
            [row["股票代码"] for row in result.data["records"]],
            ["688004", "300466", "000001"],
        )
        self.assertTrue(any("不是完整成分股" in item for item in result.warnings))

    def test_official_document_search_maps_gov_payload(self):
        payload = {
            "code": 200,
            "searchVO": {
                "totalCount": 2,
                "listVO": [
                    {
                        "title": "关于<em>人工智能</em>的指导意见",
                        "puborg": "国务院",
                        "pubtimeStr": "2025.08.26",
                        "pcode": "国发〔2025〕11号",
                        "childtype": "科技、教育/科技",
                        "url": "https://www.gov.cn/zhengce/zhengceku/202508/content_1.htm",
                        "summary": "支持<em>人工智能</em>产业发展。",
                    },
                    {
                        "title": "另一份文件",
                        "puborg": "国务院办公厅",
                        "ptime": 1755766800000,
                        "url": "https://www.gov.cn/zhengce/zhengceku/202508/content_2.htm",
                    },
                ],
            },
        }
        session = RoutedSession({"sousuo.www.gov.cn": _JsonResponse(payload)})
        executor, _fake = self.build({}, session)
        result = executor.execute_tool(
            "official_document_search", params={"keyword": "人工智能", "limit": 5}
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["total"], 2)
        first = result.data["records"][0]
        self.assertEqual(first["标题"], "关于人工智能的指导意见")
        self.assertEqual(first["发布日期"], "2025-08-26")
        self.assertEqual(first["文号"], "国发〔2025〕11号")
        self.assertEqual(result.data["records"][1]["发布日期"], "2025-08-21")

    def test_shareholder_count_sorted_latest_first(self):
        frame = pd.DataFrame(
            [
                {"股东户数统计截止日": "2026-06-30", "股东户数-本次": 100},
                {"股东户数统计截止日": "2026-09-30", "股东户数-本次": 120},
            ]
        )
        executor, _fake = self.build(
            {"stock_zh_a_gdhs_detail_em": frame}, RoutedSession({})
        )
        result = executor.execute_tool(
            "shareholder_count_lookup", entity_ids=["SEC:CN:A:600519"]
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["latest_holders"], 120)
        self.assertEqual(
            result.data["records"][0]["股东户数统计截止日"], "2026-09-30"
        )

    def test_dividend_history_returns_latest_period(self):
        frame = pd.DataFrame(
            [
                {"报告期": "2025-12-31", "现金分红-现金分红比例": 10.0},
                {"报告期": "2026-06-30", "现金分红-现金分红比例": 8.0},
            ]
        )
        executor, _fake = self.build(
            {"stock_fhps_detail_em": frame}, RoutedSession({})
        )
        result = executor.execute_tool(
            "dividend_history_lookup", entity_ids=["SEC:CN:A:600519"]
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["latest_period"], "2026-06-30")

    def test_restricted_release_filters_code(self):
        frame = pd.DataFrame(
            [
                {"股票代码": "600519", "解禁时间": "2026-11-01", "解禁数量": 100},
                {"股票代码": "000001", "解禁时间": "2026-11-02", "解禁数量": 200},
            ]
        )
        executor, _fake = self.build(
            {"stock_restricted_release_detail_em": frame}, RoutedSession({})
        )
        result = executor.execute_tool(
            "restricted_release_lookup", entity_ids=["SEC:CN:A:600519"]
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["count"], 1)
        self.assertEqual(result.data["records"][0]["股票代码"], "600519")

    def test_institution_survey_filters_code(self):
        frame = pd.DataFrame(
            [
                {"代码": "600519", "接待日期": "2026-10-19", "接待机构数量": 7},
                {"代码": "000001", "接待日期": "2026-10-19", "接待机构数量": 2},
                {"代码": "600519", "接待日期": "2026-09-01", "接待机构数量": 3},
            ]
        )
        executor, fake = self.build({"stock_jgdy_tj_em": frame}, RoutedSession({}))
        result = executor.execute_tool(
            "institution_survey_lookup", entity_ids=["SEC:CN:A:600519"]
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.data["count"], 2)
        self.assertEqual(result.data["records"][0]["接待日期"], "2026-10-19")
        jgdy_calls = [kwargs for name, kwargs in fake.calls if name == "stock_jgdy_tj_em"]
        self.assertEqual(jgdy_calls[0]["date"], "20260920")


if __name__ == "__main__":
    unittest.main()
