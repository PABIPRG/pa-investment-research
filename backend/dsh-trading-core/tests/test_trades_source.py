# -*- coding: utf-8 -*-
"""成交明细「预览 → 显式提交」的不可绕过行为。

与持仓预览的测试同形，但断言的东西不同：持仓提交是**整体替换**（基线比对防的是
替换范围变了），成交提交是**去重合并**（基线比对防的是预览之后本地又并进了别的
成交）。所以这里最要紧的两条是「重复提交不产生第二份数据」与「基线变了必须拒绝」。
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from adapter import holdings_source
from adapter import trades_source as source
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.schemas import TradeItem
from adapter.store import JsonStore
from adapter.trades_store import load_entries


def trade(ticker="600519", side="buy", price=1500.0, quantity=100, at="2026-06-26T11:12:51",
          trade_id="T1", **extra):
    return TradeItem(
        ticker=ticker, name="贵州茅台", side=side, side_label="买入" if side == "buy" else "卖出",
        price=price, quantity=quantity, amount=price * quantity, traded_at=at,
        trade_id=trade_id, source="easytrader", account_mode="real", **extra,
    )


class TradesPreviewTestCase(unittest.TestCase):
    """共享夹具：临时 store + 替身数据源 + 一份两笔的成交。"""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = JsonStore(Path(self.directory.name))
        self.items = [trade(), trade(ticker="000001", side="sell", price=12.0, quantity=500,
                                     at="2026-06-27T09:35:00", trade_id="T2")]
        self.provider = SimpleNamespace(name="qmt", get_trades=lambda: list(self.items))
        for target, value in [("JsonStore", lambda: self.store),
                              ("get_provider", lambda: self.provider)]:
            patcher = patch.object(source, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for key, value in [("holdings_provider", "qmt"), ("holdings_account_mode", "real")]:
            patcher = patch.object(source.settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        source.reset_previews()
        self.addCleanup(source.reset_previews)


class PreviewCommitTests(TradesPreviewTestCase):
    def test_preview_never_writes_and_commit_consumes_token(self):
        preview = source.preview_trades()
        self.assertEqual(load_entries(self.store), [])
        self.assertEqual(preview["kind"], "import")
        self.assertEqual(len(preview["items"]), 2)

        result = source.commit_trades(preview["preview_token"])

        self.assertEqual(result["saved"], 2)
        self.assertEqual(len(load_entries(self.store)), 2)
        with self.assertRaises(source.PreviewConflict):
            source.commit_trades(preview["preview_token"])

    def test_reimporting_the_same_batch_adds_nothing(self):
        """客户端的历史成交会被反复读到；第二次导入必须是 no-op，不是第二份数据。"""
        first = source.preview_trades()
        source.commit_trades(first["preview_token"])

        second = source.preview_trades()
        result = source.commit_trades(second["preview_token"])

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["duplicates"], 2)
        self.assertEqual(len(load_entries(self.store)), 2)

    def test_partial_fills_are_not_collapsed_into_one(self):
        """同日同价同量的两次部分成交必须都留下——多集合语义，不是集合语义。"""
        fill = trade(at="2026-06-26T11:12:51", trade_id="")
        self.provider.get_trades = lambda: [fill, fill]
        preview = source.preview_trades()
        result = source.commit_trades(preview["preview_token"])
        self.assertEqual(result["added"], 2)
        self.assertEqual(len(load_entries(self.store)), 2)

    def test_unclassified_flows_are_counted_before_commit(self):
        """红股派息这类非买卖流水要如实计数：它计入笔数，但买卖比里没有它。"""
        self.provider.get_trades = lambda: [
            TradeItem(ticker="600879", side="unclassified", side_label="红股派息",
                      price=0.0, quantity=500, amount=10.5,
                      traded_at="2026-07-09T15:00:00", trade_id="T3",
                      source="easytrader", account_mode="real")
        ]
        preview = source.preview_trades()
        self.assertEqual(preview["unclassified"], 1)
        source.commit_trades(preview["preview_token"])
        self.assertEqual(load_entries(self.store)[0].side, "unclassified")


class ConflictTests(TradesPreviewTestCase):
    def test_entries_changing_after_preview_rejects_commit(self):
        """预览之后本地又并进了别的成交，合并结果会与用户刚看到的不一致。"""
        preview = source.preview_trades()
        self.store.mutate_document("trades", lambda document: {
            "entries": [trade(ticker="300750", trade_id="T9").model_dump()],
            "imports": [], "last_cleared": None,
        })
        with self.assertRaises(source.PreviewConflict):
            source.commit_trades(preview["preview_token"])
        # 预览未被消费，用户可以重读后再试——但基线还是旧的，所以仍然冲突
        with self.assertRaises(source.PreviewConflict):
            source.commit_trades(preview["preview_token"])

    def test_account_and_provider_changes_reject_commit(self):
        preview = source.preview_trades()
        with patch.object(source.settings, "holdings_account_mode", "simulated"):
            with self.assertRaises(source.PreviewConflict):
                source.commit_trades(preview["preview_token"])

        preview = source.preview_trades()
        with patch.object(source.settings, "holdings_provider", "easytrader"):
            with self.assertRaises(source.PreviewConflict):
                source.commit_trades(preview["preview_token"])

    def test_expired_preview_cannot_commit(self):
        preview = source.preview_trades()
        with patch.object(source.time, "monotonic", return_value=10 ** 20):
            with self.assertRaises(source.PreviewConflict):
                source.commit_trades(preview["preview_token"])

    def test_unknown_token_cannot_commit(self):
        with self.assertRaises(source.PreviewConflict):
            source.commit_trades("not-a-real-token")


class RefusalTests(TradesPreviewTestCase):
    def test_empty_result_is_refused_instead_of_recorded(self):
        """读回 0 条更可能是「页没停对」，静默成功会让用户以为已经导进来了。"""
        self.provider.get_trades = lambda: []
        with self.assertRaises(source.EmptyTradesError):
            source.preview_trades()

    def test_partial_read_propagates_its_code(self):
        self.provider.get_trades = lambda: (_ for _ in ()).throw(
            ProviderUnavailable("部分成交的成交价格无法识别", "partial_read")
        )
        with self.assertRaises(ProviderUnavailable) as ctx:
            source.preview_trades()
        self.assertEqual(ctx.exception.code, "partial_read")

    def test_platform_mismatch_is_refused_before_reading(self):
        with patch.object(source, "platform_gate", lambda name: "仅支持 Windows。"):
            with self.assertRaises(ProviderUnavailable) as ctx:
                source.preview_trades()
        self.assertEqual(ctx.exception.code, "unsupported_platform")


class SharedReadLockTests(TradesPreviewTestCase):
    """持仓读取与成交读取必须互斥。

    两条路径驱动的是同一个同花顺窗口（`_switch_left_menus`、`SetForegroundWindow`、
    `app.top_window()` 全是全局状态）。若各自持一把锁，并发的结果是互相读到对方的表
    ——错数据，不是缺数据。所以这里既断言两处引用的是同一个对象，也断言拿不到锁时
    直接拒绝而不是排队。
    """

    def test_both_sources_share_one_lock_object(self):
        self.assertIs(source._READ_LOCK, holdings_source._READ_LOCK)

    def test_trades_preview_is_refused_while_another_read_holds_the_lock(self):
        acquired = holdings_source._READ_LOCK.acquire(blocking=False)
        self.assertTrue(acquired, "锁应未被占用")
        try:
            with self.assertRaises(ProviderUnavailable) as ctx:
                source.preview_trades()
            self.assertEqual(ctx.exception.code, "busy")
        finally:
            holdings_source._READ_LOCK.release()


class ClearTests(TradesPreviewTestCase):
    def _seed(self):
        preview = source.preview_trades()
        source.commit_trades(preview["preview_token"])

    def test_clear_previews_the_scope_then_commits_once(self):
        self._seed()
        preview = source.preview_clear()
        self.assertEqual(preview["kind"], "clear")
        self.assertEqual(preview["will_remove"], 2)
        self.assertIsNotNone(preview["last_import_at"])
        self.assertEqual(len(load_entries(self.store)), 2)

        result = source.commit_trades(preview["preview_token"])

        self.assertTrue(result["cleared"])
        self.assertEqual(result["removed"], 2)
        self.assertEqual(load_entries(self.store), [])
        with self.assertRaises(source.PreviewConflict):
            source.commit_trades(preview["preview_token"])

    def test_clear_keeps_the_audit_trail(self):
        """清空之后 imports 是唯一还能解释「这批数据从哪来」的东西。"""
        self._seed()
        preview = source.preview_clear()
        source.commit_trades(preview["preview_token"])
        document = self.store.all("trades")
        self.assertEqual(len(document["imports"]), 1)
        self.assertEqual(document["last_cleared"]["removed"], 2)

    def test_clear_refuses_when_there_is_nothing_to_clear(self):
        with self.assertRaises(source.EmptyTradesError):
            source.preview_clear()

    def test_clear_rejects_a_stale_baseline(self):
        self._seed()
        preview = source.preview_clear()
        self.store.mutate_document("trades", lambda document: {
            **document, "entries": [],
        })
        with self.assertRaises(source.PreviewConflict):
            source.commit_trades(preview["preview_token"])


class ReadPathTests(TradesPreviewTestCase):
    """客户端自动化数据源必须带 foreground 转发，普通数据源走 get_trades。"""

    def test_client_automation_provider_is_called_with_read_trades(self):
        calls = []
        items = list(self.items)

        class Provider:
            name = "easytrader"

            def read_trades(self, *, foreground=False):
                calls.append(foreground)
                return list(items)

        with patch.object(source, "get_provider", lambda: Provider()), \
                patch.object(source.settings, "holdings_provider", "easytrader"):
            preview = source.preview_trades(foreground=True)

        self.assertEqual(calls, [True])
        self.assertEqual(len(preview["items"]), 2)
        self.assertEqual(preview["surface"], "electron")

    def test_plain_provider_goes_through_get_trades(self):
        preview = source.preview_trades()
        self.assertEqual(preview["surface"], "web")
        self.assertEqual(len(preview["items"]), 2)


if __name__ == "__main__":
    unittest.main()
