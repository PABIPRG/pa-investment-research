# -*- coding: utf-8 -*-
"""akshare 主数据源离线测试：四类证券、部分失败与全量失败。"""

from __future__ import annotations

import unittest
from datetime import date

import pandas as pd

from research_entities.adapters.sources import records_to_entities
from research_entities.adapters.sources.akshare import AkshareSecuritySource
from research_entities.errors import SourceUnavailable
from research_entities.factory import build_sources


class FakeAkshare:
    def __init__(self, *, fail: tuple[str, ...] = ()) -> None:
        self.fail = set(fail)

    def _guard(self, kind: str) -> None:
        if kind in self.fail:
            raise ConnectionError(f"{kind} 接口不可达")

    def stock_info_a_code_name(self):
        self._guard("stock")
        return pd.DataFrame(
            [
                {"code": "600519", "name": "贵州茅台"},
                {"code": "000001", "name": "平安银行"},
                {"code": "bad", "name": "坏记录"},
            ]
        )

    def fund_name_em(self):
        self._guard("fund")
        return pd.DataFrame(
            [
                {"基金代码": "000001", "基金简称": "华夏成长混合", "基金类型": "混合型-灵活"},
                {"基金代码": "510300", "基金简称": "沪深300ETF", "基金类型": "指数型-股票"},
            ]
        )

    def index_stock_info(self):
        self._guard("index")
        return pd.DataFrame(
            [
                {"index_code": "000001", "display_name": "上证指数", "publish_date": "1991-07-15"},
                {"index_code": "000300", "display_name": "沪深300", "publish_date": date(2005, 4, 8)},
            ]
        )

    def bond_zh_cov(self):
        self._guard("bond")
        return pd.DataFrame(
            [
                {
                    "债券代码": "127119",
                    "债券简称": "中鼎转03",
                    "正股代码": "000887",
                    "正股简称": "中鼎股份",
                    "信用评级": "AA+",
                    "上市时间": pd.NaT,
                }
            ]
        )


class AkshareSecuritySourceTest(unittest.TestCase):
    def test_all_four_security_types_are_imported(self):
        batch = AkshareSecuritySource(akshare_module=FakeAkshare()).fetch_entities()
        self.assertEqual(batch.warnings, [])
        by_type: dict[str, list] = {}
        for record in batch.records:
            by_type.setdefault(record.entity_type_code, []).append(record)
        self.assertEqual([r.external_code for r in by_type["ENTITY_01_01"]], ["600519", "000001"])
        self.assertEqual([r.external_code for r in by_type["ENTITY_01_02"]], ["000001", "510300"])
        self.assertEqual([r.external_code for r in by_type["ENTITY_01_03"]], ["000001", "000300"])
        self.assertEqual([r.external_code for r in by_type["ENTITY_01_04"]], ["127119"])
        bond = by_type["ENTITY_01_04"][0]
        self.assertEqual(bond.attributes["underlying_code"], "000887")
        self.assertEqual(bond.attributes["credit_rating"], "AA+")
        self.assertNotIn("listing_date", bond.attributes)

    def test_same_code_across_types_gets_distinct_entity_ids(self):
        batch = AkshareSecuritySource(akshare_module=FakeAkshare()).fetch_entities()
        entities = records_to_entities(batch, source_label="akshare")
        ids = {entity.entity_id for entity in entities if entity.canonical_name in ("平安银行", "华夏成长混合", "上证指数")}
        self.assertEqual(ids, {"SEC:CN:A:000001", "FUND:000001", "INDEX:000001"})

    def test_single_kind_failure_degrades_with_warning(self):
        batch = AkshareSecuritySource(
            akshare_module=FakeAkshare(fail=("bond",))
        ).fetch_entities()
        self.assertTrue(any("bond" in item for item in batch.warnings))
        self.assertFalse(
            any(record.entity_type_code == "ENTITY_01_04" for record in batch.records)
        )
        self.assertTrue(any(record.entity_type_code == "ENTITY_01_01" for record in batch.records))

    def test_all_kinds_failing_raises_source_unavailable(self):
        source = AkshareSecuritySource(
            akshare_module=FakeAkshare(fail=("stock", "fund", "index", "bond"))
        )
        with self.assertRaises(SourceUnavailable):
            source.fetch_entities()

    def test_include_limits_fetched_kinds(self):
        batch = AkshareSecuritySource(
            include=("fund",), akshare_module=FakeAkshare()
        ).fetch_entities()
        self.assertEqual(
            {record.entity_type_code for record in batch.records}, {"ENTITY_01_02"}
        )

    def test_factory_only_adds_akshare_when_enabled(self):
        without = build_sources(include_universe=False, include_akshare=False)
        with_akshare = build_sources(include_universe=False, include_akshare=True)
        self.assertEqual([item.source_id for item in without], ["gazetteer_json"])
        self.assertEqual(
            [item.source_id for item in with_akshare],
            ["gazetteer_json", "akshare_security", "exchange_profile"],
        )


if __name__ == "__main__":
    unittest.main()
