# -*- coding: utf-8 -*-
"""trades collection 的写入契约。

这里验证的是"反复同步同一批成交不会长出第二份数据"这类行为，而不是 dedup 算法本身
（那由 test_trade_dedup 覆盖）。
"""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from adapter.schemas import TradeItem
from adapter.store import JsonStore
from adapter.trades_store import (
    MAX_IMPORTS,
    apply_import,
    clear_entries,
    load_document,
    load_entries,
    load_imports,
)


def _trade(**overrides) -> TradeItem:
    payload = {
        "ticker": "600519",
        "side": "buy",
        "price": 1680.5,
        "quantity": 100.0,
        "amount": 168050.0,
        "traded_at": "2026-08-03T10:14:00",
        "account_mode": "simulated",
    }
    payload.update(overrides)
    return TradeItem.model_validate(payload)


class ApplyImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def _apply(self, incoming, *, fetched=None, root="r1"):
        return apply_import(
            self.store,
            incoming=incoming,
            source="easytrader",
            account_mode="simulated",
            root=root,
            fetched=len(incoming) if fetched is None else fetched,
        )

    def test_first_import_stores_entries_and_records_the_batch(self):
        result = self._apply([_trade(), _trade(ticker="000001", price=10.0, quantity=500.0,
                                               amount=5000.0)])

        self.assertEqual(result["added"], 2)
        self.assertEqual(result["duplicates"], 0)
        self.assertEqual(len(load_entries(self.store)), 2)
        record = load_imports(self.store)[0]
        self.assertEqual(record["source"], "easytrader")
        self.assertEqual(record["fetched"], 2)
        self.assertEqual(record["added"], 2)
        self.assertEqual(record["root"], "r1")

    def test_reimporting_the_same_batch_adds_nothing(self):
        """客户端每次都能查到全部成交，重复同步是常态而不是异常。"""
        batch = [_trade(), _trade(ticker="000001", price=10.0, quantity=500.0, amount=5000.0)]
        self._apply(batch)

        second = self._apply(batch)

        self.assertEqual(second["added"], 0)
        self.assertEqual(second["duplicates"], 2)
        self.assertEqual(len(load_entries(self.store)), 2)

    def test_identical_partial_fills_are_all_kept(self):
        """一笔委托拆成两笔、字段完全相同——不能被去重吞掉一笔。"""
        fill = _trade(quantity=100.0, amount=168050.0)

        result = self._apply([fill, fill])

        self.assertEqual(result["added"], 2)
        self.assertEqual(len(load_entries(self.store)), 2)
        self.assertEqual({entry.occurred for entry in load_entries(self.store)}, {1, 2})

    def test_conflict_keeps_the_stored_entry_and_is_reported(self):
        """同一成交编号配上不同的成交内容，说明客户端数据变了或上次读错了。

        没有 trade_id 时改价格会落到"字段键"回退上，键本身就变了，那是另一笔成交而不是
        冲突——所以这里必须带 trade_id 才构造得出冲突。
        """
        self._apply([_trade(trade_id="12345", quantity=100.0, amount=168050.0)])

        result = self._apply([_trade(trade_id="12345", quantity=300.0, amount=504150.0)])

        self.assertEqual(result["added"], 0)
        self.assertEqual(len(result["conflicts"]), 1)
        self.assertEqual(result["conflicts"][0]["changed_fields"], ["amount", "quantity"])
        stored = load_entries(self.store)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0].quantity, 100.0)

    def test_changed_price_without_trade_id_is_a_new_trade(self):
        """反向锁住上一条：没有编号时不能把改动过的成交当成冲突硬吞。"""
        self._apply([_trade()])

        result = self._apply([_trade(price=1700.0, amount=170000.0)])

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["conflicts"], [])
        self.assertEqual(len(load_entries(self.store)), 2)

    def test_entries_are_stored_in_a_stable_order(self):
        first = [_trade(traded_at="2026-08-05T09:30:00"), _trade(traded_at="2026-08-01T09:30:00")]
        self._apply(first)
        before = [entry.traded_at for entry in load_entries(self.store)]

        # 换一个到达顺序再同步一次，已存顺序不应因此改变（否则文件 diff 会无意义地抖动）。
        self._apply([_trade(traded_at="2026-08-03T09:30:00")])

        after = [entry.traded_at for entry in load_entries(self.store)]
        self.assertEqual(after, sorted(before + ["2026-08-03T09:30:00"]))

    def test_imports_are_capped(self):
        for index in range(MAX_IMPORTS + 5):
            self._apply([_trade(traded_at=f"2026-08-{(index % 28) + 1:02d}T09:30:00")])

        self.assertEqual(len(load_imports(self.store)), MAX_IMPORTS)


class ClearEntriesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_clear_removes_entries_and_keeps_a_traceable_record(self):
        apply_import(self.store, incoming=[_trade(), _trade(ticker="000001", price=10.0,
                                                            quantity=500.0, amount=5000.0)],
                     source="easytrader", account_mode="simulated", root="r1", fetched=2)

        record = clear_entries(self.store, cleared_at=datetime(2026, 9, 15, tzinfo=timezone.utc))

        self.assertEqual(record["removed"], 2)
        self.assertEqual(load_entries(self.store), [])
        # imports 保留：清空之后它是唯一还能解释"这批数据从哪来"的东西。
        self.assertEqual(len(load_imports(self.store)), 1)
        self.assertEqual(load_document(self.store)["last_cleared"]["removed"], 2)

    def test_clear_is_idempotent(self):
        clear_entries(self.store)
        record = clear_entries(self.store)

        self.assertEqual(record["removed"], 0)
        self.assertIsNone(record["last_import_at"])


class DocumentRobustnessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_corrupt_entry_is_dropped_without_hiding_the_rest(self):
        """单条坏数据只丢那一条：否则一次手改文件就能让整个成交明细变成不可读。"""
        self.store.set("trades", "entries", [
            {"ticker": "600519", "side": "buy", "price": 1.0, "quantity": 100.0,
             "amount": 100.0, "traded_at": "2026-08-03T10:14:00", "account_mode": "simulated"},
            {"ticker": "不是代码"},
            "完全不是对象",
        ])

        entries = load_entries(self.store)

        self.assertEqual([entry.ticker for entry in entries], ["600519"])

    def test_missing_collection_reads_as_empty(self):
        self.assertEqual(load_document(self.store)["entries"], [])
        self.assertEqual(load_document(self.store)["imports"], [])

    def test_reset_style_empty_document_is_readable(self):
        """prepare_reset 会把集合写成 {}，读取路径必须容忍。"""
        self.store.set("trades", "entries", [])
        self.assertEqual(load_entries(self.store), [])


if __name__ == "__main__":
    unittest.main()
