# -*- coding: utf-8 -*-
"""真实/模拟操盘账户在 Windows provider 中的隔离契约。"""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from adapter.config import settings
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.holdings_providers.easytrader import EasyTraderProvider
from adapter.holdings_providers.qmt import QMTProvider


class _Window:
    def __init__(self, handle: int, title: str):
        self.handle = handle
        self._title = title

    def window_text(self):
        return self._title


class _App:
    def __init__(self, windows):
        self._windows = windows
        self.selected_handle = None

    def windows(self, **_kwargs):
        return self._windows

    def window(self, handle):
        self.selected_handle = handle
        return _Window(handle, "selected")


class EasyTraderAccountModeTests(unittest.TestCase):
    def _trader(self, *windows):
        app = _App(list(windows))
        return SimpleNamespace(_app=app, _main=_Window(99, "默认窗口")), app

    def test_simulated_mode_only_selects_a_simulation_window(self):
        trader, app = self._trader(
            _Window(1, "网上股票交易系统5.0"),
            _Window(2, "同花顺网上交易系统 - 同花顺模拟炒股 0"),
        )

        matched = EasyTraderProvider._fix_main_window(trader, "simulated")

        self.assertTrue(matched)
        self.assertEqual(app.selected_handle, 2)

    def test_real_mode_does_not_select_a_simulation_window(self):
        trader, app = self._trader(
            _Window(1, "同花顺网上交易系统 - 同花顺模拟炒股 0"),
            _Window(2, "网上股票交易系统5.0"),
        )

        matched = EasyTraderProvider._fix_main_window(trader, "real")

        self.assertTrue(matched)
        self.assertEqual(app.selected_handle, 2)

    def test_simulated_mode_never_falls_back_to_an_unknown_window(self):
        trader, app = self._trader(_Window(1, "网上股票交易系统5.0"))

        matched = EasyTraderProvider._fix_main_window(trader, "simulated")

        self.assertFalse(matched)
        self.assertIsNone(app.selected_handle)

    def test_simulation_can_use_a_separate_client_path(self):
        with patch.object(settings, "easytrader_client_path", "C:/ths/xiadan.exe"), patch.object(
            settings, "easytrader_sim_client_path", "C:/ths-sim/xiadan.exe", create=True
        ):
            provider = EasyTraderProvider(account_mode="simulated")
            client_path = provider._client_path()

        self.assertEqual(client_path, "C:/ths-sim/xiadan.exe")


class QMTAccountModeTests(unittest.TestCase):
    def test_simulated_mode_uses_the_dedicated_qmt_account(self):
        with patch.object(settings, "qmt_account_id", "real-id"), patch.object(
            settings, "qmt_sim_account_id", "sim-id", create=True
        ):
            provider = QMTProvider(account_mode="simulated")
            account_id = provider._account_id()

        self.assertEqual(account_id, "sim-id")

    def test_simulated_mode_refuses_to_relabel_the_real_qmt_account(self):
        with patch.object(settings, "qmt_account_id", "real-id"), patch.object(
            settings, "qmt_sim_account_id", "", create=True
        ):
            provider = QMTProvider(account_mode="simulated")
            provider._imported = True
            with self.assertRaises(ProviderUnavailable) as caught:
                provider.get_holdings()

        self.assertIn("QMT_SIM_ACCOUNT_ID", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
