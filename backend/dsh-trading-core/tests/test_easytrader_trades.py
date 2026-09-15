# -*- coding: utf-8 -*-
"""Windows 路径的成交读取：前台闸门、前置检查文案、导出表 → TradeItem。

界面测试全都在闸门这一层：真机上「点错按钮」的代价是确认掉某个对话框，所以这里
反复断言的是「没到该动手的时候绝不动手」——_connect 不被调用、前台不被抢。
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from adapter.config import settings
from adapter.holdings_providers import _ths_export
from adapter.holdings_providers import easytrader as easytrader_module
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.holdings_providers.broker_profiles import resolve_profile
from adapter.holdings_providers.broker_profiles import DEFAULT_TRADES_MENU_PATH
from adapter.holdings_providers.easytrader import EasyTraderProvider

# 2026-09-15 平安同花顺版「历史成交」真实导出的一行（含 Excel 公式包裹与紧凑日期）。
HEADER = [
    "成交日期", "成交时间", "证券代码", "证券名称", "操作", "成交数量", "成交均价",
    "成交金额", "合同编号", "成交编号", "发生金额", "备注", "交易市场", "股东帐户",
    "委托价格", "委托数量", "撤销数量", "",
]
ROW = [
    "20260626", "11:12:51", '="159607"', "中概互联网ETF嘉实", "买入", "1500", "0.6980",
    "1047.000", '="0112854471"', "0101000060832139", "0.000", "", "深圳Ａ股",
    '="0306172272"', "0.6980", "1500", "0", "",
]


def provider(account_mode="real"):
    """按平安档案构造 provider，并把客户端前置条件都桩成「就绪」。"""
    with patch.object(settings, "easytrader_broker", "pingan"):
        instance = EasyTraderProvider(account_mode=account_mode)
    instance._imported = True
    instance.profile = resolve_profile("pingan")
    instance._client_path = lambda: "C:/平安证券/同花顺版/xiadan.exe"
    instance._client_running = lambda: True
    return instance


class ForegroundGateTests(unittest.TestCase):
    """被动调用一律拒绝：另存为会抢焦点并可能弹风控验证码。"""

    def test_passive_call_is_refused_before_connecting(self):
        instance = provider()
        with patch.object(instance, "_connect") as connect:
            with self.assertRaises(ProviderUnavailable) as caught:
                instance.read_trades()
        self.assertEqual(caught.exception.code, "navigation_required")
        connect.assert_not_called()

    def test_unsupported_platform_is_refused_before_connecting(self):
        instance = provider()
        with patch.object(easytrader_module.sys, "platform", "darwin"), \
                patch.object(instance, "_connect") as connect:
            with self.assertRaises(ProviderUnavailable) as caught:
                instance.read_trades(foreground=True)
        self.assertEqual(caught.exception.code, "unsupported_platform")
        connect.assert_not_called()


class RequiredClientTests(unittest.TestCase):
    """前置检查的文案是用户唯一能照着做的指引——每条都要指到具体动作。"""

    def test_missing_client_path_points_at_detect(self):
        instance = provider()
        instance._client_path = lambda: ""
        with self.assertRaises(ProviderUnavailable) as caught:
            instance._require_client()
        self.assertIn("EASYTRADER_CLIENT_PATH", str(caught.exception))
        self.assertIn("detect", str(caught.exception))

    def test_client_not_running_names_the_broker(self):
        instance = provider()
        instance._client_running = lambda: False
        with self.assertRaises(ProviderUnavailable) as caught:
            instance._require_client()
        self.assertIn("未运行", str(caught.exception))
        self.assertIn(instance.profile.label, str(caught.exception))

    def test_missing_dependency_points_at_pip_install(self):
        instance = provider()
        instance._imported = False
        with self.assertRaises(ProviderUnavailable) as caught:
            instance._require_client()
        self.assertIn("pip install", str(caught.exception))

    def test_unresolved_profile_reports_the_resolution_error(self):
        instance = provider()
        instance.profile = None
        instance._profile_error = "未知 EASYTRADER_BROKER: nope"
        with self.assertRaises(ProviderUnavailable) as caught:
            instance._require_client()
        self.assertIn("未知 EASYTRADER_BROKER", str(caught.exception))

    def test_ready_client_returns_its_path(self):
        self.assertEqual(provider()._require_client(),
                         "C:/平安证券/同花顺版/xiadan.exe")


class ReadTradesTests(unittest.TestCase):
    def test_exported_table_is_mapped_with_the_provider_identity(self):
        instance = provider()
        with patch.object(instance, "_connect", return_value=object()), \
                patch.object(instance, "_read_trade_table", return_value=(HEADER, [ROW])):
            items = instance.read_trades(foreground=True)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].ticker, "159607")
        self.assertEqual(items[0].side, "buy")
        self.assertEqual(items[0].traded_at, "2026-06-26T11:12:51")
        # 来源与账户口径由 provider 填，不由映射层猜
        self.assertEqual(items[0].source, "easytrader")
        self.assertEqual(items[0].account_mode, "real")

    def test_simulated_account_is_carried_through(self):
        instance = provider(account_mode="simulated")
        with patch.object(instance, "_connect", return_value=object()), \
                patch.object(instance, "_read_trade_table", return_value=(HEADER, [ROW])):
            items = instance.read_trades(foreground=True)
        self.assertEqual(items[0].account_mode, "simulated")

    def test_provider_unavailable_codes_are_not_wrapped(self):
        """read_failed 会把 navigation_required 压成一条无用的通用错误，不能包装。"""
        instance = provider()
        with patch.object(instance, "_connect", return_value=object()), \
                patch.object(instance, "_read_trade_table",
                             side_effect=ProviderUnavailable("切页失败", "navigation_required")):
            with self.assertRaises(ProviderUnavailable) as caught:
                instance.read_trades(foreground=True)
        self.assertEqual(caught.exception.code, "navigation_required")

    def test_unexpected_failures_become_a_readable_error(self):
        instance = provider()
        with patch.object(instance, "_connect", return_value=object()), \
                patch.object(instance, "_read_trade_table", side_effect=RuntimeError("控件没了")):
            with self.assertRaises(ProviderUnavailable) as caught:
                instance.read_trades(foreground=True)
        self.assertEqual(caught.exception.code, "read_failed")
        self.assertIn("控件没了", str(caught.exception))


class ReadTradeTableTests(unittest.TestCase):
    """取数流程本身：切到成交页 → 另存为 → 读回，临时目录用完即删。"""

    def test_navigates_to_the_trades_menu_and_removes_the_temp_dir(self):
        seen = {}

        class Trader:
            class config:
                COMMON_GRID_CONTROL_ID = 1047

            class main:
                @staticmethod
                def child_window(**kwargs):
                    seen["child_window"] = kwargs
                    return "grid"

            def _switch_left_menus(self, path):
                seen["menu"] = path

        def fake_export(grid, out_path, *, pid):
            seen["grid"] = grid
            seen["pid"] = pid
            seen["out_path"] = out_path
            out_path.write_bytes("成交日期\t证券代码\n20260626\t159607\n".encode("gbk"))
            return out_path

        instance = provider()
        with patch.object(easytrader_module, "_export_grid", fake_export), \
                patch.object(_ths_export, "_process_id", lambda: 4242):
            header, rows = instance._read_trade_table(Trader())

        self.assertEqual(seen["menu"], list(DEFAULT_TRADES_MENU_PATH))
        self.assertEqual(seen["grid"], "grid")
        self.assertEqual(seen["pid"], 4242)
        self.assertEqual(seen["child_window"]["class_name"], "CVirtualGridCtrl")
        self.assertEqual(seen["child_window"]["control_id"], 1047)
        self.assertEqual(header, ["成交日期", "证券代码"])
        self.assertEqual(rows, [["20260626", "159607"]])
        # 临时目录必须已删除：easytrader 自己是写进 %TEMP% 且从不清理的
        self.assertFalse(Path(seen["out_path"]).parent.exists())


class KernelGateTests(unittest.TestCase):
    """专用客户端内核没有同花顺那套「查询 → 历史成交」左树，必须在动手前挡掉。

    这六家（银河/华泰/五矿/海通/国金/广发）在档案表里仍是 easytrader 数据源，
    只按数据源名放行的话，它们会一路走到 _switch_left_menus 上炸成一条
    看不懂的 read_failed。
    """

    def client_provider(self):
        with patch.object(settings, "easytrader_broker", "huatai_client"):
            instance = EasyTraderProvider(account_mode="real")
        instance._imported = True
        instance.profile = resolve_profile("huatai_client")
        instance._client_path = lambda: "C:/华泰/xiadan.exe"
        instance._client_running = lambda: True
        return instance

    def test_client_kernel_has_no_trades_menu_path(self):
        self.assertIsNone(self.client_provider().trades_menu_path)

    def test_client_kernel_is_refused_before_connecting(self):
        instance = self.client_provider()
        with patch.object(instance, "_connect") as connect:
            with self.assertRaises(ProviderUnavailable) as caught:
                instance.read_trades(foreground=True)
        self.assertEqual(caught.exception.code, "unsupported_action")
        connect.assert_not_called()

    def test_the_refusal_names_the_broker(self):
        with self.assertRaises(ProviderUnavailable) as caught:
            self.client_provider().read_trades(foreground=True)
        self.assertIn("华泰证券（专用客户端）", str(caught.exception))

    def test_ths_kernel_still_passes_the_gate(self):
        """闸门只能挡专用客户端，不能把 67 家同花顺贴牌券商一起挡了。"""
        self.assertEqual(provider().trades_menu_path, DEFAULT_TRADES_MENU_PATH)

    def test_missing_profile_has_no_menu_path(self):
        """档案没解析出来时连的是哪家都不知道，谈不上按哪套菜单导航。"""
        instance = provider()
        instance.profile = None
        self.assertIsNone(instance.trades_menu_path)


class HoldingsReadRegressionTests(unittest.TestCase):
    """_read_with_navigation 的前置检查搬进 _require_client 后不能改变行为。"""

    def test_connection_failure_names_the_broker_without_crashing(self):
        instance = provider()
        with patch.object(instance, "_require_client", return_value="path"), \
                patch.object(instance, "_connect", side_effect=RuntimeError("boom")):
            with self.assertRaises(ProviderUnavailable) as caught:
                instance._read_with_navigation()
        self.assertIn("boom", str(caught.exception))
        self.assertIn(instance.profile.label, str(caught.exception))

    def test_require_client_still_blocks_a_passive_holdings_read(self):
        """持仓读取也要过同一组前置检查——两条路径共用，不能只保住成交那条。"""
        instance = provider()
        instance._client_running = lambda: False
        with self.assertRaises(ProviderUnavailable) as caught:
            instance._read_with_navigation()
        self.assertIn("未运行", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
