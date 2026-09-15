# -*- coding: utf-8 -*-
"""成交明细去重与合并的契约。

这里的每一条都对应一个会静默损坏数据的现实场景：重复导入、拆单、跨日流水号、
客户端改数。基准事实来自平安同花顺版客户端：可查约 93 天历史成交，成交编号是
当日流水号，成交时间可能只到分钟。
"""

import unittest

from adapter.schemas import TradeItem
from adapter.trade_dedup import merge_trades, trade_key


def trade(**overrides) -> TradeItem:
    """造一笔成交，只写关心的字段。"""
    fields = dict(
        ticker="600372",
        side="buy",
        price=16.2117,
        quantity=100,
        amount=1621.17,
        traded_at="2026-09-01T14:32:05",
        trade_id="000123",
        account_mode="real",
    )
    fields.update(overrides)
    return TradeItem(**fields)


class TradeKeyTests(unittest.TestCase):
    def test_trade_id_key_includes_the_date(self):
        """成交编号是当日流水号，跨日的同一编号是两笔不同的成交。

        键里不带日期，第二天导入就会把真实成交当重复静默丢弃。
        """
        first = trade(traded_at="2026-09-01T14:32:05", trade_id="000123")
        second = trade(traded_at="2026-09-02T09:31:00", trade_id="000123")
        self.assertNotEqual(trade_key(first), trade_key(second))

    def test_key_separates_accounts(self):
        self.assertNotEqual(
            trade_key(trade(account_mode="real")),
            trade_key(trade(account_mode="simulated")),
        )

    def test_key_falls_back_to_fields_without_a_trade_id(self):
        bare = trade(trade_id="")
        self.assertEqual(trade_key(bare), trade_key(trade(trade_id="")))

    def test_field_key_separates_buy_from_sell(self):
        """同价同量的买卖对冲是真实存在的，键里不带方向就会互相吞掉。"""
        self.assertNotEqual(
            trade_key(trade(trade_id="", side="buy")),
            trade_key(trade(trade_id="", side="sell")),
        )

    def test_key_ignores_float_representation_noise(self):
        """同一笔成交经 pandas 与经字符串清洗后的浮点表示不同，键必须一致。"""
        self.assertEqual(
            trade_key(trade(price=16.2117)),
            trade_key(trade(price=16.211700000000001)),
        )

    def test_key_ignores_the_stock_name(self):
        """股票改名/戴帽摘帽是常态，名称不该影响「是不是同一笔」。"""
        self.assertEqual(
            trade_key(trade(name="航天电子")),
            trade_key(trade(name="*ST航电")),
        )


class MergeTradesTests(unittest.TestCase):
    def test_reimporting_the_same_window_adds_nothing(self):
        first = merge_trades([], [trade()])
        self.assertEqual(len(first.added), 1)

        second = merge_trades(first.added, [trade()])
        self.assertEqual(second.added, [])
        self.assertEqual(second.duplicates, 1)
        self.assertEqual(second.conflicts, [])

    def test_reimport_is_idempotent_across_many_rounds(self):
        stored = merge_trades([], [trade()]).added
        for _ in range(3):
            outcome = merge_trades(stored, [trade()])
            self.assertEqual(outcome.added, [])
            stored = stored + outcome.added
        self.assertEqual(len(stored), 1)

    def test_identical_partial_fills_are_not_swallowed(self):
        """一笔委托拆成多笔成交时字段可能完全相同，集合去重会丢掉第二笔。

        这里模拟分钟级时间戳下的拆单：同票、同向、同价、同量、同分钟。
        """
        fills = [trade(trade_id="", traded_at="2026-09-01T14:32"),
                 trade(trade_id="", traded_at="2026-09-01T14:32")]

        outcome = merge_trades([], fills)

        self.assertEqual(len(outcome.added), 2)
        self.assertEqual([item.occurred for item in outcome.added], [1, 2])

    def test_a_second_identical_fill_arriving_later_is_added(self):
        """先读到 1 笔、后读到 2 笔（同键）时，新增的 1 笔不能被当成重复。"""
        stored = merge_trades([], [trade(trade_id="", traded_at="2026-09-01T14:32")]).added

        outcome = merge_trades(stored, [
            trade(trade_id="", traded_at="2026-09-01T14:32"),
            trade(trade_id="", traded_at="2026-09-01T14:32"),
        ])

        self.assertEqual(len(outcome.added), 1)
        self.assertEqual(outcome.duplicates, 1)
        self.assertEqual(outcome.added[0].occurred, 2)

    def test_same_trade_number_on_another_day_is_a_new_trade(self):
        stored = merge_trades([], [trade(traded_at="2026-09-01T14:32:05")]).added

        outcome = merge_trades(stored, [trade(traded_at="2026-09-02T09:31:00")])

        self.assertEqual(len(outcome.added), 1)

    def test_same_key_with_different_content_is_reported_not_swallowed(self):
        """键相同但金额/价格不同，意味着客户端改了数据或上次读错了。

        既不能静默并进 skipped，也不能覆盖历史——两边都报出来。
        """
        stored = merge_trades([], [trade(price=16.2117, amount=1621.17)]).added

        outcome = merge_trades(stored, [trade(price=16.3000, amount=1630.00)])

        self.assertEqual(outcome.added, [])
        self.assertEqual(outcome.duplicates, 0)
        self.assertEqual(len(outcome.conflicts), 1)
        conflict = outcome.conflicts[0]
        self.assertEqual(conflict.existing.price, 16.2117)
        self.assertEqual(conflict.incoming.price, 16.3)
        self.assertIn("price", conflict.changed_fields)
        self.assertIn("amount", conflict.changed_fields)

    def test_conflict_does_not_consume_the_stored_entry(self):
        """报过冲突之后，原来那笔仍应能被重读识别为重复，而不是每轮都报冲突。"""
        stored = merge_trades([], [trade(price=16.2117)]).added

        merge_trades(stored, [trade(price=16.3000)])
        outcome = merge_trades(stored, [trade(price=16.2117)])

        self.assertEqual(outcome.conflicts, [])
        self.assertEqual(outcome.duplicates, 1)

    def test_a_stock_rename_is_not_a_conflict(self):
        stored = merge_trades([], [trade(name="航天电子")]).added

        outcome = merge_trades(stored, [trade(name="*ST航电")])

        self.assertEqual(outcome.conflicts, [])
        self.assertEqual(outcome.duplicates, 1)

    def test_multiplicity_survives_a_second_import(self):
        """已存 2 笔同键成交时，重读同样的 2 笔应全部识别为重复。"""
        stored = merge_trades([], [
            trade(trade_id="", traded_at="2026-09-01T14:32"),
            trade(trade_id="", traded_at="2026-09-01T14:32"),
        ]).added

        outcome = merge_trades(stored, [
            trade(trade_id="", traded_at="2026-09-01T14:32"),
            trade(trade_id="", traded_at="2026-09-01T14:32"),
        ])

        self.assertEqual(outcome.added, [])
        self.assertEqual(outcome.duplicates, 2)

    def test_incoming_occurred_is_reassigned(self):
        """occurred 是存储层的槽位序号，不是客户端字段，不采信传入值。"""
        outcome = merge_trades([], [trade(occurred=99)])
        self.assertEqual(outcome.added[0].occurred, 1)

    def test_unclassified_rows_are_counted_separately(self):
        """送股/红利入账归不了买卖，要单独报出而不是计入成交笔数。"""
        outcome = merge_trades([], [
            trade(trade_id="1"),
            trade(trade_id="2", side="unclassified", side_label="送股"),
        ])

        self.assertEqual(len(outcome.added), 2)
        self.assertEqual(outcome.unclassified, 1)

    def test_occurred_continues_from_the_stored_maximum(self):
        stored = merge_trades([], [
            trade(trade_id="", traded_at="2026-09-01T14:32", quantity=100),
        ]).added
        stored[0] = stored[0].model_copy(update={"occurred": 7})

        outcome = merge_trades(stored, [
            trade(trade_id="", traded_at="2026-09-01T14:32", quantity=100),
            trade(trade_id="", traded_at="2026-09-01T14:32", quantity=100),
        ])

        self.assertEqual([item.occurred for item in outcome.added], [8])


class TradeItemTests(unittest.TestCase):
    """TradeItem 契约。去重键取 traded_at[:10] 当日期，所以这里的归一是耦合点。"""

    def test_space_separator_is_normalized_to_t(self):
        self.assertEqual(trade(traded_at="2026-09-01 14:32:05").traded_at,
                         "2026-09-01T14:32:05")

    def test_minute_precision_is_preserved_not_padded(self):
        """客户端只给到分钟就保留分钟——补成 :00 等于凭空造出秒级精度。"""
        self.assertEqual(trade(traded_at="2026-09-01T14:32").traded_at,
                         "2026-09-01T14:32")

    def test_date_only_is_rejected(self):
        """没有时间的成交无法排序也无法参与日内分析，必须报错而不是猜。"""
        for raw in ("2026-09-01", "20260901", "14:32:05", ""):
            with self.subTest(raw=raw):
                with self.assertRaises(Exception) as ctx:
                    trade(traded_at=raw)
                self.assertIn("成交时间无法识别", str(ctx.exception))

    def test_impossible_dates_are_rejected(self):
        for raw in ("2026-13-01T09:30:00", "2026-09-32T09:30:00"):
            with self.subTest(raw=raw):
                with self.assertRaises(Exception):
                    trade(traded_at=raw)

    def test_side_accepts_unclassified_without_rejecting_the_row(self):
        """非买卖流水不能让整批入库失败——那会表现成「读到了但一条都存不进」。"""
        item = trade(side="unclassified", side_label="送股")
        self.assertEqual(item.side_label, "送股")

    def test_ticker_must_be_six_digits(self):
        for raw in ("600372", "000001"):
            with self.subTest(raw=raw):
                self.assertEqual(trade(ticker=raw).ticker, raw)
        for raw in ("6003721", "60037", "sh600372", ""):
            with self.subTest(raw=raw):
                with self.assertRaises(Exception):
                    trade(ticker=raw)

    def test_occurred_defaults_to_the_first_slot(self):
        self.assertEqual(trade().occurred, 1)


if __name__ == "__main__":
    unittest.main()
