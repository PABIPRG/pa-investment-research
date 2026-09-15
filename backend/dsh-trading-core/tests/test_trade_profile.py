# -*- coding: utf-8 -*-
"""本地行为指标：频率 / 集中度 / 覆盖度。

这三类被选中是因为它们的输入就是成交表本身——不需要成本基础、不需要手续费、
不需要行情。测试的重点因此也在「哪些东西被算进去了」：集中度必须排除逆回购与基金
（否则占比整体失真），覆盖度必须区分「那天没成交」与「那段没被任何一次读取覆盖过」。
"""

import unittest

from adapter.schemas import TradeItem
from adapter.trade_profile import build_profile, is_stock


def trade(ticker="600519", side="buy", price=10.0, quantity=100, at="2026-06-26T10:00:00",
          name="贵州茅台"):
    return TradeItem(
        ticker=ticker, name=name, side=side, side_label=side, price=price,
        quantity=quantity, amount=price * quantity, traded_at=at, trade_id="",
        source="easytrader", account_mode="real",
    )


def imported(*ranges):
    return [{"range_start": first, "range_end": last} for first, last in ranges]


class IsStockTests(unittest.TestCase):
    def test_a_share_stock_segments_are_recognized(self):
        for ticker in ("600519", "000001", "002594", "300750", "688981", "430047", "830799"):
            with self.subTest(ticker=ticker):
                self.assertTrue(is_stock(ticker))

    def test_non_stock_instruments_are_excluded(self):
        """这些代码都是 ^\\d{6}$，靠位数拦不住，必须按代码段白名单排除。"""
        cases = {
            "204001": "国债逆回购",
            "131900": "深市逆回购",
            "510300": "ETF",
            "159915": "深市 ETF",
            "110043": "沪市可转债",
            "128036": "深市可转债",
            "900901": "沪市 B 股",
            "200011": "深市 B 股",
        }
        for ticker, label in cases.items():
            with self.subTest(ticker=ticker, label=label):
                self.assertFalse(is_stock(ticker))

    def test_malformed_codes_are_not_stocks(self):
        for ticker in ("", "60051", "6005199", "60051A"):
            with self.subTest(ticker=ticker):
                self.assertFalse(is_stock(ticker))


class FrequencyTests(unittest.TestCase):
    def test_counts_and_ratio(self):
        entries = [
            trade(side="buy"), trade(side="buy", at="2026-06-26T14:00:00"),
            trade(side="sell", at="2026-06-27T09:40:00"),
        ]
        frequency = build_profile(entries, [])["frequency"]
        self.assertEqual(frequency["trades"], 3)
        self.assertEqual(frequency["buy_count"], 2)
        self.assertEqual(frequency["sell_count"], 1)
        self.assertEqual(frequency["active_days"], 2)
        self.assertEqual(frequency["buy_sell_ratio"], 2.0)
        self.assertEqual(frequency["trades_per_active_day"], 1.5)

    def test_no_sells_yields_none_not_zero(self):
        """没有卖出与「买卖完全均衡」是两回事，0 会被读成后者。"""
        frequency = build_profile([trade(side="buy")], [])["frequency"]
        self.assertIsNone(frequency["buy_sell_ratio"])

    def test_unclassified_flows_count_but_stay_out_of_the_ratio(self):
        entries = [
            TradeItem(ticker="600879", side="unclassified", side_label="红股派息", price=0.0,
                      quantity=500, amount=10.5, traded_at="2026-07-09T15:00:00",
                      source="easytrader", account_mode="real"),
            trade(side="buy", ticker="600879"),
        ]
        frequency = build_profile(entries, [])["frequency"]
        self.assertEqual(frequency["trades"], 2)
        self.assertEqual(frequency["unclassified_count"], 1)
        self.assertEqual(frequency["buy_count"], 1)
        self.assertEqual(frequency["sell_count"], 0)


class ConcentrationTests(unittest.TestCase):
    def test_shares_hhi_and_top_share(self):
        entries = [
            trade(ticker="600519", price=100.0, quantity=10),   # 1000
            trade(ticker="000001", price=10.0, quantity=10),    # 100
            trade(ticker="300750", price=10.0, quantity=10),    # 100
        ]
        concentration = build_profile(entries, [])["concentration"]
        self.assertEqual(concentration["amount_total"], 1200.0)
        self.assertEqual(concentration["tickers"], 3)
        # 单票占比合计为 1；HHI 是占比平方和，越集中越接近 1
        self.assertAlmostEqual(sum(row["share"] for row in concentration["items"]), 1.0, places=3)
        # 0.8333² + 2 × 0.0833² = 0.7083
        self.assertAlmostEqual(concentration["hhi"], 0.7083, places=3)
        self.assertEqual(concentration["items"][0]["ticker"], "600519")
        self.assertAlmostEqual(concentration["top_share"], 0.8333, places=3)

    def test_non_stocks_are_excluded_and_counted(self):
        """逆回购会天天做、金额又大，混进集中度会让占比整体失真。"""
        entries = [
            trade(ticker="600519", price=100.0, quantity=10),
            trade(ticker="204001", price=1000.0, quantity=100),
        ]
        concentration = build_profile(entries, [])["concentration"]
        self.assertEqual(concentration["tickers"], 1)
        self.assertEqual(concentration["amount_total"], 1000.0)
        self.assertEqual(concentration["excluded_non_stock_trades"], 1)
        self.assertEqual(concentration["top_share"], 1.0)

    def test_name_comes_from_the_latest_row(self):
        """同一票改名时，界面该显示最新简称。"""
        entries = [
            trade(ticker="000001", name="平安银行", at="2026-06-26T10:00:00"),
            trade(ticker="000001", name="平安银行(新)", at="2026-06-27T10:00:00"),
        ]
        items = build_profile(entries, [])["concentration"]["items"]
        self.assertEqual(items[0]["name"], "平安银行(新)")

    def test_all_non_stock_yields_no_share_instead_of_zero(self):
        concentration = build_profile([trade(ticker="204001")], [])["concentration"]
        self.assertEqual(concentration["tickers"], 0)
        self.assertIsNone(concentration["top_share"])
        self.assertEqual(concentration["hhi"], 0.0)


class CoverageTests(unittest.TestCase):
    def test_span_and_active_days(self):
        entries = [
            trade(at="2026-06-26T10:00:00"),
            trade(at="2026-06-26T14:00:00"),
            trade(at="2026-07-13T10:00:00"),
        ]
        coverage = build_profile(entries, imported(("2026-06-26", "2026-07-13")))["coverage"]
        self.assertEqual(coverage["start"], "2026-06-26")
        self.assertEqual(coverage["end"], "2026-07-13")
        self.assertEqual(coverage["span_days"], 18)
        self.assertEqual(coverage["active_days"], 2)
        self.assertEqual(coverage["status"], "complete")
        self.assertEqual(coverage["uncovered"], [])

    def test_a_gap_between_two_imports_is_reported_as_uncovered(self):
        """这是覆盖度唯一能给出的真信号：一段区间没有任何一次读取覆盖过。

        区间里某天没有成交完全可能是那天没交易；但没被任何一次读取覆盖过，就是
        真的缺数据——只有记下每次读取的区间才能区分这两者。
        """
        entries = [
            trade(at="2026-06-20T10:00:00"),
            trade(at="2026-08-10T10:00:00"),
        ]
        coverage = build_profile(
            entries, imported(("2026-06-01", "2026-06-30"), ("2026-08-01", "2026-08-31"))
        )["coverage"]
        self.assertEqual(coverage["status"], "partial")
        self.assertEqual(coverage["uncovered"], [{"start": "2026-07-01", "end": "2026-07-31"}])
        self.assertEqual(len(coverage["read_ranges"]), 2)

    def test_overlapping_imports_are_merged_before_looking_for_gaps(self):
        entries = [trade(at="2026-06-20T10:00:00"), trade(at="2026-08-10T10:00:00")]
        coverage = build_profile(entries, imported(
            ("2026-06-01", "2026-07-10"), ("2026-07-01", "2026-08-31"),
        ))["coverage"]
        self.assertEqual(coverage["status"], "complete")
        self.assertEqual(coverage["read_ranges"], [{"start": "2026-06-01", "end": "2026-08-31"}])

    def test_records_without_a_range_are_treated_as_unknown(self):
        """旧记录没有 range_* 键；宁可说「不知道」，也不能当成「已覆盖」。"""
        coverage = build_profile([trade(at="2026-06-26T10:00:00")], [{"fetched": 1}])["coverage"]
        self.assertEqual(coverage["status"], "unknown")
        self.assertIsNotNone(coverage["note"])

    def test_leading_gap_before_the_first_import(self):
        entries = [trade(at="2026-06-20T10:00:00")]
        coverage = build_profile(
            entries, imported(("2026-06-25", "2026-06-30"))
        )["coverage"]
        self.assertEqual(coverage["status"], "partial")
        self.assertEqual(coverage["uncovered"], [{"start": "2026-06-20", "end": "2026-06-24"}])


class EmptyProfileTests(unittest.TestCase):
    def test_empty_entries_yield_a_zeroed_profile_not_an_error(self):
        """没有导入过成交是正常状态，不是故障。"""
        profile = build_profile([], [])
        self.assertEqual(profile["frequency"]["trades"], 0)
        self.assertEqual(profile["concentration"]["items"], [])
        self.assertEqual(profile["coverage"]["status"], "empty")
        self.assertTrue(profile["caveats"])

    def test_caveats_name_the_things_that_are_not_computed(self):
        """不标注「没算费用」就是造数——这条是给界面直接展示的。"""
        profile = build_profile([trade()], [])
        joined = "".join(profile["caveats"])
        self.assertIn("佣金", joined)
        self.assertIn("已实现盈亏", joined)


if __name__ == "__main__":
    unittest.main()
