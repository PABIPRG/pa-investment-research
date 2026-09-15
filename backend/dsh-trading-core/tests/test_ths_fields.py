# -*- coding: utf-8 -*-
"""同花顺表格字段映射（Windows 与 macOS 共用）的单元测试。

这里只覆盖共享的纯函数：表签名判定、买卖方向归一、数字解析与价格量化。
「这些函数接到券商读取路径上之后会怎样」由 test_mac_ths / test_holdings_preview 覆盖。
"""

import unittest

from adapter.holdings_providers import _ths_fields as fields


class ClassifyTableTests(unittest.TestCase):
    """成交表与持仓表必须被区分开。

    旧判据是「表头含『代码』」，而成交表同样含「证券代码」——它会把成交表送进
    rows_to_items，缺列后报出「请进入持仓页」这种与事实相反的提示。
    """

    def test_holdings_header_matches_across_broker_variants(self):
        """券商版本差异体现在成本列名上，判定必须靠 locate_columns 的候选表。"""
        for header in (
            ["证券代码", "股票余额", "成本价"],
            ["证券代码", "股票余额", "参考成本价"],
            ["证券代码", "证券余额", "成本均价"],
        ):
            with self.subTest(header=header):
                self.assertEqual(fields.classify_table(header), "holdings")

    def test_trades_header_is_recognized_as_trades(self):
        for header in (
            ["证券代码", "买卖标志", "成交价格", "成交数量", "成交日期", "成交时间"],
            ["证券代码", "委托方向", "成交均价", "成交金额", "委托日期", "成交数量"],
        ):
            with self.subTest(header=header):
                self.assertEqual(fields.classify_table(header), "trades")

    def test_pingan_history_trades_header_is_recognized(self):
        """平安同花顺版「历史成交」导出表的真实表头（2026-09-15 真机实测，逐列照抄）。

        方向列在这里叫「操作」而不是「买卖标志」。它曾不在候选表里，导致真实成交表
        判定为 None——表现是读回来只能报「表头认不出来」，而全部单元测试都是绿的，
        因为此前的用例都按开发者想象中的列名写。
        """
        header = [
            "成交日期", "成交时间", "证券代码", "证券名称", "操作", "成交数量", "成交均价",
            "成交金额", "合同编号", "成交编号", "发生金额", "备注", "交易市场", "股东帐户",
            "委托价格", "委托数量", "撤销数量", "",
        ]
        self.assertEqual(fields.classify_table(header), "trades")
        columns = fields.locate_columns(header)
        self.assertEqual(columns["side"], 4)
        # 价格必须取「成交均价」，不能被同表里的「委托价格」抢走：两者都在候选表里，
        # 顺序决定了取到的是成交口径还是委托口径。
        self.assertEqual(columns["price"], 6)
        self.assertEqual(columns["quantity"], 5)
        self.assertEqual(columns["amount"], 7)

    def test_short_side_name_matches_exactly_not_by_substring(self):
        """「操作」按整名匹配：子串语义会先命中委托表的「操作日期」，把日期当方向。

        这正是候选表里用 = 前缀的唯一理由，所以单独锁一条。
        """
        entrust = ["证券代码", "操作日期", "委托价格", "委托数量", "成交数量", "成交金额"]
        self.assertNotIn("side", fields.locate_columns(entrust))
        self.assertIsNone(fields.classify_table(entrust))

    def test_extract_reads_exact_candidates_from_column_dicts(self):
        """easytrader 的 grid 返回「列名 → 值」字典，精确候选要能整键取到值。"""
        row = {"证券代码": "600879", "操作": "买入", "操作日期": "20260713"}
        self.assertEqual(fields.extract(row, "side"), "买入")
        self.assertEqual(fields.extract(row, "ticker"), "600879")

    def test_entrust_table_is_not_mistaken_for_trades(self):
        """委托表有方向/价格/日期，但没有「成交数量」，不能被当成成交表。

        两者读错会把「已委托」记成「已成交」，是实质性的账目错误。
        """
        header = ["证券代码", "委托方向", "委托价格", "委托数量", "委托日期", "委托时间"]
        self.assertIsNone(fields.classify_table(header))

    def test_unknown_header_is_not_classified(self):
        self.assertIsNone(fields.classify_table(["名称", "市值"]))

    def test_holdings_signature_is_the_field_subset_rows_to_items_asserts(self):
        """签名字段必须与持仓读取实际要求的列一致，否则判定与读取会分叉。"""
        self.assertEqual(fields.required_fields("holdings"),
                         ("ticker", "quantity", "cost_price"))


class NormalizeSideTests(unittest.TestCase):
    def test_buy_and_sell_sides(self):
        for raw in ("买入", "买", "证券买入", "申购", "中签", "转入"):
            with self.subTest(raw=raw):
                self.assertEqual(fields.normalize_side(raw), "buy")
        for raw in ("卖出", "卖", "证券卖出", "赎回", "转出"):
            with self.subTest(raw=raw):
                self.assertEqual(fields.normalize_side(raw), "sell")

    def test_unclassifiable_returns_none_instead_of_guessing(self):
        """送股/红利入账这类非交易流水归不了买卖，必须报 None 让调用方单独计数。

        若在这里猜一个方向，或让上层因此拒绝整批，都会污染交易行为分析。
        """
        for raw in ("送股", "红利入账", "配股", "新股入账", "其他", "", "   ", None):
            with self.subTest(raw=raw):
                self.assertIsNone(fields.normalize_side(raw))


class ParseNumberTests(unittest.TestCase):
    def test_tolerates_presentation_noise(self):
        for raw, expected in (("11,000", 11000.0), ("¥3,700.00", 3700.0),
                              ("￥1.05", 1.05), (" 23.5024 ", 23.5024), ("0", 0.0),
                              ("-5", -5.0)):
            with self.subTest(raw=raw):
                self.assertEqual(fields.parse_number(raw), expected)

    def test_blank_and_garbage_both_return_none(self):
        for raw in (None, "", "   ", "--", "-", "—", "¥", ",", "暂无", "abc", "nan", "inf"):
            with self.subTest(raw=raw):
                self.assertIsNone(fields.parse_number(raw))

    def test_zero_is_not_conflated_with_missing(self):
        """0.0 与 None 必须可区分：前者是合法零值，后者要判 partial_read。"""
        self.assertEqual(fields.parse_number("0"), 0.0)
        self.assertIsNone(fields.parse_number("--"))
        self.assertFalse(fields.is_blank("0"))
        self.assertTrue(fields.is_blank("--"))

    def test_is_blank_shares_the_cleaning_with_parse_number(self):
        """只剩货币符号/逗号的展示值算「没有值」，与 parse_number 的边界一致。"""
        for raw in (None, "", "¥", "￥", ",", " , ", "—"):
            with self.subTest(raw=raw):
                self.assertTrue(fields.is_blank(raw))
        for raw in ("0", "¥0", "1,000"):
            with self.subTest(raw=raw):
                self.assertFalse(fields.is_blank(raw))


class QuantizePriceTests(unittest.TestCase):
    def test_stabilizes_float_representations_of_the_same_price(self):
        """同一笔成交经 pandas 与经字符串清洗后的浮点表示不同，量化后必须相同。

        Xls 路径的价格来自 pandas，macOS 路径来自字符串清洗；不量化就会让重复导入
        的同一笔成交被当成新增。
        """
        self.assertEqual(fields.quantize_price("16.2117"),
                         fields.quantize_price("16.211700000000001"))
        self.assertEqual(fields.quantize_price(16.2117 + 1e-12), 16.212)

    def test_missing_price_stays_missing(self):
        self.assertIsNone(fields.quantize_price("--"))
        self.assertIsNone(fields.quantize_price(None))


class LabelTests(unittest.TestCase):
    def test_known_fields_get_chinese_names(self):
        self.assertEqual(fields.label("cost_price"), "成本价")
        self.assertEqual(fields.label("ticker"), "证券代码")

    def test_every_signature_field_has_a_label(self):
        """签名里的字段都要有中文名，否则缺列提示会漏出内部键。"""
        for kind in fields.TABLE_SIGNATURES:
            for field in fields.required_fields(kind):
                with self.subTest(kind=kind, field=field):
                    self.assertNotEqual(fields.label(field), field)

    def test_unknown_field_falls_back_to_the_key(self):
        self.assertEqual(fields.label("not_a_field"), "not_a_field")


if __name__ == "__main__":
    unittest.main()
