# -*- coding: utf-8 -*-
"""成交明细能力的上报契约。

前端靠 provider_snapshot 的 available_actions 决定是否给出「同步成交明细」入口。
这份能力名单一旦与实现脱节，用户点进去的动作必然失败——所以这里既验证基类的
拒绝行为，也核对名单与「是否真的覆写 read_trades」一致。
"""

import inspect
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from adapter import holdings_source
from adapter.holdings_providers import (
    EasyTraderProvider,
    HoldingsProvider,
    JoinQuantProvider,
    MacThsProvider,
    ManualProvider,
    QMTProvider,
)
from adapter.holdings_providers import easytrader as easytrader_module
from adapter.holdings_providers import mac_ths as mac_ths_module
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.holdings_providers.broker_profiles import resolve_profile

_ALL_PROVIDERS = {
    "manual": ManualProvider,
    "joinquant": JoinQuantProvider,
    "qmt": QMTProvider,
    "easytrader": EasyTraderProvider,
    "mac_ths": MacThsProvider,
}


class TradesCapabilityListTests(unittest.TestCase):
    def test_capability_list_matches_the_actual_overrides(self):
        """名单里必须正好是那些真的覆写了 read_trades 的数据源。

        这是 _TRADES_PROVIDERS 唯一的防错手段：它是手写名单，会与实现脱节。
        步骤 4/5 给 easytrader/mac_ths 实现 read_trades 时，实现与名单要在同一个
        提交里改完；将来若有数据源也支持成交，同样如此。
        """
        declared = holdings_source._TRADES_PROVIDERS
        actual = {
            name for name, cls in _ALL_PROVIDERS.items()
            if cls.read_trades is not HoldingsProvider.read_trades
        }
        self.assertEqual(declared, actual)

    def test_capability_list_names_only_known_providers(self):
        self.assertTrue(holdings_source._TRADES_PROVIDERS <= set(_ALL_PROVIDERS))


class BaseProviderTradesTests(unittest.TestCase):
    """不支持成交的数据源必须明确拒绝，而不是返回空列表。

    空列表会被上游当成「这个账户没有成交」，把一次不支持的调用记成一次成功的空读取。
    """

    def test_unsupported_providers_refuse_explicitly(self):
        for name, cls in _ALL_PROVIDERS.items():
            if cls.read_trades is not HoldingsProvider.read_trades:
                continue
            with self.subTest(provider=name):
                with self.assertRaises(ProviderUnavailable) as ctx:
                    cls.read_trades(ManualProvider.__new__(cls))
                self.assertEqual(ctx.exception.code, "unsupported_action")

    def test_get_trades_delegates_to_read_trades(self):
        provider = ManualProvider.__new__(ManualProvider)

        with self.assertRaises(ProviderUnavailable) as ctx:
            provider.get_trades()

        self.assertEqual(ctx.exception.code, "unsupported_action")

    def test_signature_aligns_with_read_holdings(self):
        """foreground 必须是仅关键字参数：获准原生入口要能原样复用调用方式。"""
        signature = inspect.signature(HoldingsProvider.read_trades)
        self.assertEqual(list(signature.parameters), ["self", "foreground"])
        parameter = signature.parameters["foreground"]
        self.assertEqual(parameter.kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIs(parameter.default, False)


class SnapshotReportsTradesTests(unittest.TestCase):
    """能力上报的三个条件：在名单里、数据源确实就绪、且这个 surface 拿得到读取入口。

    surface 那一条只对 Windows 生效：成交取数走「Ctrl+S 另存为」，会抢焦点并可能弹
    风控验证码，只有经宿主认证的原生入口能触发；macOS 走 AX 被动遍历，网页版也能读。
    这里统一用 _snapshot(..., trades=True) 注入名单成员资格，把要验证的判定与
    「实现做到哪一步」解耦。
    """

    def test_trades_action_appears_for_a_ready_windows_provider(self):
        """桩掉 easytrader 分支真正用到的三个属性。

        这里验证的是「就绪 + 在能力名单里 + 有原生入口 → 上报动作」这条判定，
        不是 easytrader 自身的客户端探测逻辑（那由 test_holdings_* 覆盖）。
        platform_gate 一并桩掉，避免本用例依赖运行平台。
        """
        with tempfile.NamedTemporaryFile(suffix=".exe") as client:
            stub = SimpleNamespace(
                _client_path=lambda: client.name,
                _client_running=lambda: True,
                _imported=True,
            )
            state = self._snapshot(
                "easytrader", trades=True, surface="electron",
                extra=[patch.object(easytrader_module, "EasyTraderProvider",
                                    lambda *a, **k: stub)],
            )

        self.assertIn("read", state["available_actions"])
        self.assertIn("read_trades", state["available_actions"])

    def test_windows_web_surface_does_not_offer_trades(self):
        """网页版没有原生通道，Windows 上成交读取必然失败，不能给出入口。

        持仓不一样：被动读表格在网页版是能用的，所以 read 仍然上报。
        """
        with tempfile.NamedTemporaryFile(suffix=".exe") as client:
            stub = SimpleNamespace(
                _client_path=lambda: client.name,
                _client_running=lambda: True,
                _imported=True,
            )
            state = self._snapshot(
                "easytrader", trades=True, surface="web",
                extra=[patch.object(easytrader_module, "EasyTraderProvider",
                                    lambda *a, **k: stub)],
            )

        self.assertTrue(state["available"])
        self.assertIn("read", state["available_actions"])
        self.assertNotIn("read_trades", state["available_actions"])

    def test_mac_provider_offers_trades_on_the_web_surface(self):
        """macOS 走 AX 被动遍历，不需要原生入口。"""
        state = self._snapshot("mac_ths", trades=True, surface="web", extra=[
            patch.object(mac_ths_module, "app_bundles", lambda *a, **k: ["/Applications/同花顺.app"]),
            patch.object(mac_ths_module, "app_running", lambda *a, **k: True),
            patch.object(mac_ths_module, "accessibility_status", lambda: "granted"),
        ])

        self.assertIn("read", state["available_actions"])
        self.assertIn("read_trades", state["available_actions"])

    def test_client_kernel_broker_does_not_offer_trades(self):
        """专用客户端内核（银河/华泰等）没有同花顺那套「历史成交」左树。

        它们同样是 easytrader 数据源、同样在能力名单里，只按数据源名放行的话，
        用户点下去会在 _switch_left_menus 上炸成一条看不懂的 read_failed。
        """
        with tempfile.NamedTemporaryFile(suffix=".exe") as client:
            stub = SimpleNamespace(
                profile=resolve_profile("huatai_client"),
                _client_path=lambda: client.name,
                _client_running=lambda: True,
                _imported=True,
            )
            state = self._snapshot(
                "easytrader", trades=True, surface="electron",
                extra=[patch.object(easytrader_module, "EasyTraderProvider",
                                    lambda *a, **k: stub)],
            )

        self.assertTrue(state["available"])
        self.assertIn("read", state["available_actions"])
        self.assertNotIn("read_trades", state["available_actions"])

    def test_ths_kernel_broker_still_offers_trades(self):
        """闸门只能挡专用客户端，不能把 67 家同花顺贴牌券商一起挡了。"""
        with tempfile.NamedTemporaryFile(suffix=".exe") as client:
            stub = SimpleNamespace(
                profile=resolve_profile("pingan"),
                _client_path=lambda: client.name,
                _client_running=lambda: True,
                _imported=True,
            )
            state = self._snapshot(
                "easytrader", trades=True, surface="electron",
                extra=[patch.object(easytrader_module, "EasyTraderProvider",
                                    lambda *a, **k: stub)],
            )

        self.assertIn("read_trades", state["available_actions"])

    def test_every_registered_broker_declares_its_trades_support(self):
        """档案表里 THS 内核的必须给菜单路径，专用客户端的必须留空。

        这条防的是「新加一家券商时忘了填」——漏填会静默变成「这家不支持读成交」。
        """
        from adapter.holdings_providers import broker_profiles as bp

        wrong = [
            p.broker_id for p in bp.ALL_BROKERS
            if (p.trades_menu_path is None) != (p.kernel != "ths")
        ]
        self.assertEqual(wrong, [])

    def test_trades_action_is_absent_for_providers_outside_the_list(self):
        stub = SimpleNamespace(name="manual", is_available=lambda: True)
        state = self._snapshot("manual", trades=False, surface="electron", extra=[
            patch.object(holdings_source, "get_provider", lambda: stub),
        ])

        self.assertIn("read", state["available_actions"])
        self.assertNotIn("read_trades", state["available_actions"])

    def test_trades_action_is_absent_while_the_client_is_not_running(self):
        """客户端没起来时读成交同样读不了，不能提前给出一个必然失败的动作。"""
        stub = SimpleNamespace(
            _client_path=lambda: "C:/never/installed/xiadan.exe",
            _client_running=lambda: False,
            _imported=True,
        )
        state = self._snapshot("easytrader", trades=True, surface="electron", extra=[
            patch.object(easytrader_module, "EasyTraderProvider", lambda *a, **k: stub),
        ])

        self.assertFalse(state["available"])
        self.assertNotIn("read_trades", state["available_actions"])

    def _snapshot(self, provider: str, *, trades: bool, surface: str = "web",
                  extra: list) -> dict:
        enabled = holdings_source._TRADES_PROVIDERS | ({provider} if trades else set())
        patchers = [
            patch.object(holdings_source.settings, "holdings_provider", provider),
            patch.object(holdings_source.settings, "holdings_account_mode", "simulated"),
            patch.object(holdings_source, "_TRADES_PROVIDERS", enabled),
            patch.object(holdings_source, "platform_gate", lambda name: None),
            *extra,
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        return holdings_source.provider_snapshot(surface)


if __name__ == "__main__":
    unittest.main()
