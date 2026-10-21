# -*- coding: utf-8 -*-
"""交易所上市公司名录适配器测试：离线假 akshare。"""

from __future__ import annotations

import unittest

import pandas as pd

from research_entities.adapters.sources.exchange_profile import ExchangeProfileSource
from research_entities.errors import SourceUnavailable
from research_entities.factory import build_sources


class FakeAkshare:
    def __init__(self, **responses) -> None:
        self.responses = responses

    def __getattr__(self, name):
        response = self.responses.get(name)
        if response is None:
            raise AttributeError(name)
        if isinstance(response, Exception):
            def fail(**_kwargs):
                raise response

            return fail
        return lambda **_kwargs: response


SH_FRAME = pd.DataFrame(
    [
        {
            "证券代码": "600000",
            "证券简称": "浦发银行",
            "公司全称": "上海浦东发展银行股份有限公司",
            "上市日期": pd.Timestamp("1999-11-10"),
        },
        {
            "证券代码": "688001",
            "证券简称": "华兴源创",
            "公司全称": "苏州华兴源创科技股份有限公司",
            "上市日期": pd.Timestamp("2019-07-22"),
        },
    ]
)
SZ_FRAME = pd.DataFrame(
    [
        {
            "A股代码": "000001",
            "A股简称": "平安银行",
            "A股上市日期": "1991-04-03",
        }
    ]
)
BJ_FRAME = pd.DataFrame([{"证券代码": "920000", "证券简称": "安徽凤凰"}])


def full_source() -> ExchangeProfileSource:
    return ExchangeProfileSource(
        akshare_module=FakeAkshare(
            stock_info_sh_name_code=SH_FRAME,
            stock_info_sz_name_code=SZ_FRAME,
            stock_info_bj_name_code=BJ_FRAME,
        )
    )


class ExchangeProfileSourceTest(unittest.TestCase):
    def test_records_are_company_entities_with_legal_name_aliases(self):
        batch = full_source().fetch_entities()
        self.assertEqual(batch.source_id, "exchange_profile")
        by_code = {record.external_code: record for record in batch.records}
        self.assertEqual(set(by_code), {"600000", "688001", "000001", "920000"})
        pufa = by_code["600000"]
        self.assertEqual(pufa.entity_type_code, "ENTITY_02_01")
        self.assertEqual(pufa.name, "浦发银行")
        self.assertEqual(pufa.attributes["legal_name"], "上海浦东发展银行股份有限公司")
        self.assertIn("上海浦东发展银行股份有限公司", pufa.aliases)
        self.assertEqual(pufa.identifiers["company_code"], "600000")
        self.assertEqual(pufa.identifiers["exchange"], "SH")
        self.assertEqual(pufa.attributes["listing_date"], "1999-11-10")

    def test_shenzhen_without_legal_name_does_not_invent_one(self):
        record = next(
            item for item in full_source().fetch_entities().records
            if item.external_code == "000001"
        )
        self.assertNotIn("legal_name", record.attributes)
        self.assertEqual(record.aliases, [])
        self.assertEqual(record.attributes["listing_board"], "sz_a")

    def test_partial_failure_is_a_warning(self):
        module = FakeAkshare(
            stock_info_sh_name_code=SH_FRAME,
            stock_info_sz_name_code=RuntimeError("深交所接口超时"),
            stock_info_bj_name_code=BJ_FRAME,
        )
        batch = ExchangeProfileSource(akshare_module=module).fetch_entities()
        self.assertTrue(batch.records)
        self.assertTrue(any("深交所接口超时" in item for item in batch.warnings))

    def test_all_failures_raise(self):
        module = FakeAkshare(
            stock_info_sh_name_code=RuntimeError("a"),
            stock_info_sz_name_code=RuntimeError("b"),
            stock_info_bj_name_code=RuntimeError("c"),
        )
        with self.assertRaises(SourceUnavailable):
            ExchangeProfileSource(akshare_module=module).fetch_entities()

    def test_missing_function_is_reported(self):
        module = FakeAkshare(
            stock_info_sh_name_code=SH_FRAME,
            stock_info_sz_name_code=SZ_FRAME,
        )
        batch = ExchangeProfileSource(akshare_module=module).fetch_entities()
        self.assertTrue(any("不提供 stock_info_bj_name_code" in item for item in batch.warnings))

    def test_invalid_rows_are_skipped(self):
        frame = pd.DataFrame(
            [
                {"证券代码": "600000", "证券简称": "浦发银行"},
                {"证券代码": "ABCDEF", "证券简称": "坏数据"},
                {"证券代码": "600001", "证券简称": ""},
            ]
        )
        module = FakeAkshare(
            stock_info_sh_name_code=frame,
            stock_info_sz_name_code=SZ_FRAME,
            stock_info_bj_name_code=BJ_FRAME,
        )
        codes = {
            item.external_code
            for item in ExchangeProfileSource(akshare_module=module).fetch_entities().records
        }
        self.assertIn("600000", codes)
        self.assertNotIn("ABCDEF", codes)
        self.assertNotIn("600001", codes)

    def test_version_changes_with_legal_name(self):
        first = full_source().fetch_entities().source_version
        changed = SH_FRAME.copy()
        changed.loc[0, "公司全称"] = "上海浦东发展银行股份有限公司（更名）"
        module = FakeAkshare(
            stock_info_sh_name_code=changed,
            stock_info_sz_name_code=SZ_FRAME,
            stock_info_bj_name_code=BJ_FRAME,
        )
        second = ExchangeProfileSource(akshare_module=module).fetch_entities().source_version
        self.assertNotEqual(first, second)


class FactoryGatingTest(unittest.TestCase):
    def test_akshare_sources_prepare_proxy_environment(self):
        import os
        from unittest import mock

        from research_entities.toolbox import context as tool_context

        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(
            tool_context, "_NO_PROXY_INSTALLED", False
        ):
            os.environ.pop("NO_PROXY", None)
            os.environ.pop("no_proxy", None)
            build_sources(include_akshare=True)
            self.assertIn("*", os.environ.get("NO_PROXY", "").split(","))

    def test_exchange_profile_is_only_included_with_akshare(self):
        with_akshare = build_sources(include_akshare=True)
        without = build_sources(include_akshare=False)
        self.assertIn("exchange_profile", [item.source_id for item in with_akshare])
        self.assertNotIn("exchange_profile", [item.source_id for item in without])


if __name__ == "__main__":
    unittest.main()
