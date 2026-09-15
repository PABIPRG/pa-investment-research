"""同步预览与提交的不可绕过行为。"""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from adapter import holdings_source as source
from adapter.schemas import HoldingItem, HoldingTrade
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.store import JsonStore


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = JsonStore(Path(self.directory.name))
        self.item = HoldingItem(ticker="600519", quantity=100, cost_price=1500)
        self.provider = SimpleNamespace(name="qmt", get_holdings=lambda: [self.item])
        for target, value in [("JsonStore", lambda: self.store), ("get_provider", lambda: self.provider)]:
            patcher = patch.object(source, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for key, value in [("holdings_provider", "qmt"), ("holdings_account_mode", "simulated")]:
            patcher = patch.object(source.settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_preview_never_writes_and_commit_consumes_token(self):
        preview = source.preview_holdings()
        self.assertEqual(self.store.get("holdings", "default", []), [])
        self.assertEqual(preview["items"][0]["time_source"], "read_fallback")
        self.assertEqual(preview["items"][0]["position_time"], preview["read_at"])
        result = source.commit_holdings(preview["preview_token"])
        self.assertEqual(result["saved"], 1)
        self.assertTrue(result["changed"])
        with self.assertRaises(source.PreviewConflict):
            source.commit_holdings(preview["preview_token"])

    def test_broker_trade_time_takes_precedence_over_read_fallback(self):
        self.item = HoldingItem(
            ticker="600519", quantity=100, cost_price=1500,
            trades=[HoldingTrade(executed_at="2026-09-15 09:31:02", side="buy", quantity=100, price=1500)],
        )
        self.provider.get_holdings = lambda: [self.item]

        preview = source.preview_holdings()

        self.assertEqual(preview["items"][0]["time_source"], "broker_detail")
        self.assertEqual(preview["items"][0]["position_time"], "2026-09-15 09:31:02")

    def test_repeated_fallback_read_is_unchanged_and_preserves_user_time(self):
        first = source.preview_holdings()
        committed = source.commit_holdings(first["preview_token"], {"600519": "2026-09-14T14:30"})
        self.assertTrue(committed["changed"])

        repeated = source.preview_holdings()
        self.assertFalse(repeated["changed"])
        self.assertEqual(repeated["items"][0]["time_source"], "user_modified")
        result = source.commit_holdings(repeated["preview_token"])

        self.assertFalse(result["changed"])
        self.assertEqual(result["items"][0]["time_source"], "user_modified")
        self.assertEqual(result["items"][0]["position_time"], "2026-09-14T14:30")
        self.assertEqual(len(self.store.get("holdings", "snapshots", [])), 1)

    def test_changed_holdings_and_account_reject_commit(self):
        preview = source.preview_holdings()
        self.store.set("holdings", "default", [{"ticker": "000001", "quantity": 1, "cost_price": 2}])
        with self.assertRaises(source.PreviewConflict):
            source.commit_holdings(preview["preview_token"])
        preview = source.preview_holdings()
        with patch.object(source.settings, "holdings_account_mode", "real"):
            with self.assertRaises(source.PreviewConflict):
                source.commit_holdings(preview["preview_token"])

    def test_expired_and_empty_results_cannot_commit(self):
        preview = source.preview_holdings()
        with patch.object(source.time, "monotonic", return_value=10**20):
            with self.assertRaises(source.PreviewConflict):
                source.commit_holdings(preview["preview_token"])
        self.provider.get_holdings = lambda: []
        with self.assertRaises(source.EmptyHoldingsError):
            source.preview_holdings()

    def test_native_read_can_be_cancelled_without_creating_a_preview(self):
        started = threading.Event()
        failures = []

        def read_holdings(*, foreground=False, cancelled=None):
            self.assertTrue(foreground)
            started.set()
            while not cancelled():
                time.sleep(0.001)
            raise ProviderUnavailable("已取消读取", "read_cancelled")

        self.provider.name = "mac_ths"
        self.provider.read_holdings = read_holdings

        def read():
            try:
                source.native_action("read", "simulated", operation_id="cancel-me")
            except Exception as exc:
                failures.append(exc)

        with patch.object(source.settings, "holdings_provider", "mac_ths"):
            worker = threading.Thread(target=read)
            worker.start()
            self.assertTrue(started.wait(1))
            self.assertEqual(source.native_action("cancel_read", "simulated", operation_id="cancel-me"), {"canceled": True})
            worker.join(1)

        self.assertFalse(worker.is_alive())
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].code, "read_cancelled")

    def test_cancel_arriving_before_native_read_prevents_the_read(self):
        self.provider.name = "mac_ths"
        self.provider.read_holdings = lambda **kwargs: self.fail("canceled read reached provider")
        with patch.object(source.settings, "holdings_provider", "mac_ths"):
            self.assertEqual(source.native_action("cancel_read", "simulated", operation_id="cancel-first"), {"canceled": True})
            with self.assertRaises(ProviderUnavailable) as caught:
                source.native_action("read", "simulated", operation_id="cancel-first")
        self.assertEqual(caught.exception.code, "read_cancelled")

class PermissionTests(unittest.TestCase):
    def test_denied_accessibility_does_not_read_or_navigate(self):
        from adapter.holdings_providers.mac_ths import MacThsProvider
        with patch('adapter.holdings_providers.mac_ths.accessibility_status', return_value='not_granted'), \
             patch('adapter.holdings_providers.mac_ths.read_ax_table') as reader:
            with self.assertRaises(Exception) as error:
                MacThsProvider(platform='darwin').read_holdings(foreground=True)
            self.assertEqual(error.exception.code, 'accessibility_required')
            reader.assert_not_called()

class ReadinessTests(unittest.TestCase):
    def test_missing_install_and_permission_have_distinct_states(self):
        from adapter.holdings_providers import mac_ths
        with patch.object(source.settings, 'holdings_provider', 'mac_ths'), patch.object(source.sys, 'platform', 'darwin'), \
             patch.object(mac_ths, 'app_running', return_value=False), patch.object(mac_ths, 'accessibility_status', return_value='not_granted'), \
             patch.object(mac_ths, 'app_bundles', return_value=[]):
            state = source.provider_snapshot()
            self.assertEqual(state['blocking_reason'], 'client_missing')
            self.assertIn('download', state['available_actions'])
            with patch.object(mac_ths, 'app_bundles', return_value=['/Applications/同花顺.app']):
                state = source.provider_snapshot()
                self.assertEqual(state['blocking_reason'], 'accessibility_required')
                self.assertEqual(state['automation'], 'not_requested')

    def test_windows_passive_read_does_not_call_navigation(self):
        from adapter.holdings_providers.easytrader import EasyTraderProvider
        provider = EasyTraderProvider(account_mode='simulated')
        with patch.object(provider, '_read_visible_table', return_value=[]) as passive, \
             patch.object(provider, '_read_with_navigation') as navigation:
            self.assertEqual(provider.get_holdings(), [])
            passive.assert_called_once()
            navigation.assert_not_called()

    def test_windows_passive_read_skips_a_visible_trades_table(self):
        """成交表同样含「证券代码」，只按「含代码」认表会把成交表读成持仓表。

        停在成交页时既不能给出错误的持仓，也不能报「请进入持仓页」——
        用户已经在交易窗口里，要说清读到的是成交表。
        """
        from adapter.holdings_providers.base import ProviderUnavailable
        from adapter.holdings_providers.easytrader import EasyTraderProvider

        class _TradesTable:
            @staticmethod
            def columns():
                return [{'text': name} for name in
                        ['证券代码', '买卖标志', '成交价格', '成交数量', '成交日期']]

            @staticmethod
            def item_count():
                return 1

            @staticmethod
            def get_item(row, column):
                raise AssertionError("成交表不应被逐行读取")

        class _Window:
            @staticmethod
            def window_text():
                return '模拟炒股 - 同花顺'

            @staticmethod
            def descendants(class_name=None):
                return [_TradesTable()]

        fake = SimpleNamespace(Desktop=lambda backend=None: SimpleNamespace(
            windows=lambda visible_only=True: [_Window()]))
        provider = EasyTraderProvider(account_mode='simulated')

        with patch.dict(sys.modules, {'pywinauto': fake}), patch(
            'adapter.holdings_providers.easytrader.sys.platform', 'win32'
        ):
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider._read_visible_table()

        self.assertEqual(ctx.exception.code, 'navigation_required')
        self.assertIn('成交明细表', str(ctx.exception))

    def test_missing_and_nonfinite_rows_are_not_partial_success(self):
        from adapter.holdings_providers.mac_ths import rows_to_items
        for row in [['600519', '--', '1'], ['600519', '100', 'inf']]:
            with self.assertRaises(Exception) as error:
                rows_to_items(['证券代码', '股票余额', '成本价'], [row])
            self.assertEqual(error.exception.code, 'partial_read')


class DefaultAccountTests(unittest.TestCase):
    def test_unconfigured_account_defaults_to_simulated(self):
        from adapter.config import Settings
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(Settings().holdings_account_mode, "simulated")
