# -*- coding: utf-8 -*-
"""成交明细行 → TradeItem 的单元测试。

表头与数据行取自 2026-09-15 平安同花顺版「历史成交」的真实导出（`="..."` 的公式
包裹、紧凑日期 `20260626`、非买卖流水「红股派息」都在里面），不做理想化改写——
这套映射的第一版就是照着想象中的列名写的，结果真机上一条都读不出来。
"""

import unittest

from adapter.holdings_providers import _ths_trades as trades
from adapter.holdings_providers.base import ProviderUnavailable

# 真实导出表头（逐列照抄，含 Excel 公式列与表尾空列）
HEADER = [
    "成交日期", "成交时间", "证券代码", "证券名称", "操作", "成交数量", "成交均价",
    "成交金额", "合同编号", "成交编号", "发生金额", "备注", "交易市场", "股东帐户",
    "委托价格", "委托数量", "撤销数量", "",
]

# 真实数据行：买入 / 红股派息（价格与金额都不寻常）/ 卖出
ROWS = [
    ["20260626", "11:12:51", '="159607"', "中概互联网ETF嘉实", "买入", "1500", "0.6980",
     "1047.000", '="0112854471"', "0101000060832139", "0.000", "", "深圳Ａ股",
     '="0306172272"', "0.6980", "1500", "0", ""],
    ["20260709", "15:00:00", '="600879"', "航天电子", "红股派息", "500", "0.0000",
     "10.500", '=""', "2607090112805316", "0.000", "", "上海Ａ股",
     '="A182823006"', "0.0000", "0", "0", ""],
    ["20260713", "14:49:48", '="600879"', "航天电子", "卖出", "100", "21.5100",
     "2151.000", '="0163592410"', "79726064", "0.000", "", "上海Ａ股",
     '="A182823006"', "21.5100", "100", "0", ""],
]


def build(rows=ROWS, header=HEADER, *, source="easytrader", account_mode="real"):
    return trades.rows_to_trades(header, rows, source=source, account_mode=account_mode)


class RowsToTradesTests(unittest.TestCase):
    def test_real_export_rows_map_to_trades(self):
        items = build()
        self.assertEqual(len(items), 3)
        first = items[0]
        # 代码被 Excel 公式包裹，靠 normalize_ticker 抽数字才是对的
        self.assertEqual(first.ticker, "159607")
        self.assertEqual(first.name, "中概互联网ETF嘉实")
        self.assertEqual(first.side, "buy")
        self.assertEqual(first.side_label, "买入")
        self.assertEqual(first.price, 0.698)
        self.assertEqual(first.quantity, 1500)
        self.assertEqual(first.amount, 1047.0)
        # 日期是紧凑的 20260626，必须拼成 ISO8601 的 T 分隔形式
        self.assertEqual(first.traded_at, "2026-06-26T11:12:51")
        self.assertEqual(first.trade_id, "0101000060832139")
        self.assertEqual(first.source, "easytrader")
        self.assertEqual(first.account_mode, "real")

    def test_non_buy_sell_flows_are_kept_as_unclassified(self):
        """红股派息不是买卖，但它是真实发生过的一笔流水，不能被丢掉。

        丢掉会让「成交笔数」少算；猜一个方向会污染买卖比。所以留 unclassified
        并把客户端原文放进 side_label，由界面照实显示。
        """
        dividend = build()[1]
        self.assertEqual(dividend.side, "unclassified")
        self.assertEqual(dividend.side_label, "红股派息")
        # 送股类流水没有成交价，0 是合法值（schema 用 ge=0 就是为了这批流水）
        self.assertEqual(dividend.price, 0.0)
        self.assertEqual(dividend.quantity, 500)
        self.assertEqual(dividend.amount, 10.5)

    def test_prices_are_not_taken_from_the_entrust_columns(self):
        """真实表里同时有「成交均价」和「委托价格」，必须取成交口径。"""
        for item, price in zip(build(), (0.698, 0.0, 21.51)):
            with self.subTest(ticker=item.ticker):
                self.assertEqual(item.price, price)

    def test_empty_trailing_rows_are_skipped_silently(self):
        """表尾空行是客户端的常态，跳过而不是判 partial_read。"""
        items = build(rows=[["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]])
        self.assertEqual(items, [])

    def test_blank_quantity_is_zero_not_an_error(self):
        """数值列的空占位是「没有值」，按 0 处理——与脏数据是两回事。"""
        items = build(rows=[ROWS[0][:5] + ["", "0.6980", "1047.000"] + ROWS[0][8:]])
        self.assertEqual(items[0].quantity, 0.0)

    def test_unparseable_number_rejects_the_batch(self):
        """脏数据不能压成 0：那会把一笔真实成交悄悄记成 0 股。

        成交明细是 append-only 的，写错一笔之后没有「下次同步覆盖」能纠正。
        """
        rows = [ROWS[0][:6] + ["暂无"] + ROWS[0][7:]]
        with self.assertRaises(ProviderUnavailable) as ctx:
            build(rows=rows)
        self.assertEqual(ctx.exception.code, "partial_read")

    def test_missing_date_or_time_rejects_the_batch(self):
        """不补造精度：缺时间就报错，而不是替它写 T00:00:00。"""
        for column in (0, 1):
            with self.subTest(column=column):
                rows = [ROWS[0][:column] + [""] + ROWS[0][column + 1:]]
                with self.assertRaises(ProviderUnavailable) as ctx:
                    build(rows=rows)
                self.assertEqual(ctx.exception.code, "partial_read")

    def test_minute_precision_is_preserved(self):
        """客户端只给到分钟就保留分钟，不会写成 :00。"""
        rows = [ROWS[0][:1] + ["11:12"] + ROWS[0][2:]]
        self.assertEqual(build(rows=rows)[0].traded_at, "2026-06-26T11:12")

    def test_holdings_table_is_refused_as_navigation_required(self):
        """读错页要提示切页，而不是报「列名认不出来」这种开发者才看得懂的话。"""
        with self.assertRaises(ProviderUnavailable) as ctx:
            build(header=["证券代码", "股票余额", "参考成本价"], rows=[])
        self.assertEqual(ctx.exception.code, "navigation_required")

    def test_unknown_header_reports_the_missing_columns(self):
        with self.assertRaises(ProviderUnavailable) as ctx:
            build(header=["日期", "金额"], rows=[])
        self.assertEqual(ctx.exception.code, "read_failed")
        self.assertIn("成交日期", str(ctx.exception))


class BuildTradedAtTests(unittest.TestCase):
    def test_accepts_compact_and_dashed_dates(self):
        for raw in ("20260626", "2026-06-26", "2026/06/26"):
            with self.subTest(raw=raw):
                self.assertEqual(trades.build_traded_at(raw, "11:12:51"), "2026-06-26T11:12:51")

    def test_rejects_impossible_values(self):
        for date, time in (("", "11:12:51"), ("20260626", ""), ("2026", "11:12:51"),
                           ("20260626", "25:00:00"), ("20260626", "11:70")):
            with self.subTest(date=date, time=time):
                self.assertIsNone(trades.build_traded_at(date, time))


class CleanTextTests(unittest.TestCase):
    def test_strips_excel_formula_wrapper(self):
        self.assertEqual(trades.clean_text('="0112854471"'), "0112854471")
        self.assertEqual(trades.clean_text("航天电子"), "航天电子")
        # 空公式（客户端表示没有值）剥完是空串，不是字面量 =""
        self.assertEqual(trades.clean_text('=""'), "")
        self.assertEqual(trades.clean_text(None), "")


if __name__ == "__main__":
    unittest.main()
