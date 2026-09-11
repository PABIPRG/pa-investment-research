# -*- coding: utf-8 -*-
"""macOS 持仓数据源（同花顺 Mac 版 + AppleScript）测试。

注意：AppleScript 正文本身只能在 macOS 上执行，本机（Windows）无法做语法校验。
这里覆盖的是「脚本产出 → 持仓」的解析与错误分支，以及平台门禁；
AppleScript 的实际控件路径仍需在装有同花顺 Mac 版的机器上人工验证。
"""

import asyncio
import subprocess
import unittest
from unittest.mock import patch

from adapter import holdings_source
from adapter.holdings_providers import mac_ths
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.holdings_providers.mac_ths import (
    DEFAULT_APP_NAME,
    MacThsProvider,
    MacThsScriptError,
    _to_float,
    apple_script,
    default_runner,
    parse_output,
    rows_to_items,
)


def _ok(*lines: str) -> str:
    """拼一段 osascript 的 OK 输出（首行表头，其余数据行）。"""
    return "OK\t" + "\n".join(lines)


HOLDINGS_HEADER = "证券代码\t证券名称\t股票余额\t可用余额\t参考成本价\t市价"


class AppleScriptSourceTests(unittest.TestCase):
    def test_script_is_bare_applescript_without_shell_wrapper(self):
        """脚本正文直接交给 osascript -e，不能再套一层 osascript -e '...'。

        上游 Go 版把整条 shell 命令当成 -e 的参数传进去，脚本永远语法错误；
        这里用断言把它钉住，避免以后「顺手加个 shell 包装」。
        """
        script = apple_script("同花顺")

        self.assertNotIn("osascript", script)
        self.assertTrue(script.startswith("on joinList"))
        self.assertIn("on run", script)

    def test_app_name_is_interpolated_everywhere(self):
        script = apple_script("某某证券")

        self.assertNotIn("__APP__", script)
        # 只出现一次字面量，其余位置复用 appName 变量
        self.assertEqual(script.count('"某某证券"'), 1)
        self.assertIn('set appName to "某某证券"', script)

    def test_default_app_name_is_the_ths_mac_bundle(self):
        self.assertEqual(DEFAULT_APP_NAME, "同花顺")

    def test_real_account_uses_the_a_share_tab(self):
        script = apple_script("同花顺", "real")

        self.assertIn('set accountTab to "A股"', script)
        self.assertIn('click button accountTab of window 1', script)

    def test_simulated_account_uses_the_simulation_tab(self):
        script = apple_script("同花顺", "simulated")

        self.assertIn('set accountTab to "模拟"', script)
        self.assertIn('交易 → 模拟 → 股票 → 持仓', script)


class ParseOutputTests(unittest.TestCase):
    def test_ok_output_yields_header_and_rows(self):
        raw = _ok(HOLDINGS_HEADER, "600879\t航天电子\t900\t900\t23.5024\t24.10")

        header, rows = parse_output(raw)

        self.assertEqual(header[0], "证券代码")
        self.assertEqual(rows, [["600879", "航天电子", "900", "900", "23.5024", "24.10"]])

    def test_thousand_separators_survive_the_transport(self):
        """上游用 AppleScript list + 逗号拼接，'1,000' 会被拆成两列；
        改成 TAB/换行分隔后必须原样带回来。"""
        raw = _ok(HOLDINGS_HEADER, "000001\t平安银行\t11,000\t11,000\t12.3456\t13.00")

        _, rows = parse_output(raw)

        self.assertEqual(len(rows[0]), 6)
        self.assertEqual(_to_float(rows[0][2]), 11000.0)

    def test_err_output_raises_with_the_client_reason(self):
        raw = "ERR\t同花顺 Mac 版未运行：请先启动同花顺并登录券商交易账号，窗口保持打开。"

        with self.assertRaises(MacThsScriptError) as ctx:
            parse_output(raw)

        self.assertIn("未运行", str(ctx.exception))

    def test_empty_output_raises(self):
        with self.assertRaises(MacThsScriptError) as ctx:
            parse_output("   \n")

        self.assertIn("没有返回任何内容", str(ctx.exception))

    def test_unknown_status_raises(self):
        with self.assertRaises(MacThsScriptError) as ctx:
            parse_output("WAT\twhatever")

        self.assertIn("无法识别", str(ctx.exception))

    def test_header_only_output_yields_no_rows(self):
        """表头在但没有数据行 = 空仓；此时不该报错，由上层判定「拒绝覆盖」。"""
        header, rows = parse_output(_ok(HOLDINGS_HEADER))

        self.assertEqual(header[0], "证券代码")
        self.assertEqual(rows, [])

    def test_blank_lines_are_dropped(self):
        raw = "OK\t" + HOLDINGS_HEADER + "\n\n600879\t航天电子\t900\t900\t23.5024\t24.10\n\n"

        _, rows = parse_output(raw)

        self.assertEqual(len(rows), 1)

    def test_err_without_a_body_still_raises(self):
        with self.assertRaises(MacThsScriptError):
            parse_output("ERR")


class RowsToItemsTests(unittest.TestCase):
    def test_maps_columns_by_header_name_not_by_position(self):
        """列序由客户端决定，映射必须按表头名走。"""
        header = ["证券名称", "参考成本价", "证券代码", "股票余额"]
        rows = [["航天电子", "23.5024", "600879", "900"]]

        items = rows_to_items(header, rows)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].ticker, "600879")
        self.assertEqual(items[0].quantity, 900.0)
        self.assertEqual(items[0].cost_price, 23.5024)

    def test_reference_cost_column_matches_the_plain_candidate(self):
        """『参考成本价』含子串『成本价』，靠候选名顺序命中，不需要额外登记。"""
        items = rows_to_items(["证券代码", "股票余额", "参考成本价"], [["600372", "400", "16.2117"]])

        self.assertEqual(items[0].cost_price, 16.2117)

    def test_ticker_with_exchange_suffix_is_normalized(self):
        items = rows_to_items(["证券代码", "股票余额", "成本价"], [["000001.SZ", "100", "12.5"]])

        self.assertEqual(items[0].ticker, "000001")

    def test_zero_rows_are_skipped(self):
        """已清仓的行数量为 0，不能写进持仓。"""
        header = ["证券代码", "股票余额", "成本价"]
        rows = [
            ["600879", "0", "23.5024"],  # 已清仓
            ["600372", "400", "16.2117"],
        ]

        items = rows_to_items(header, rows)

        self.assertEqual([item.ticker for item in items], ["600372"])

    def test_partial_rows_refuse_replacement(self):
        with self.assertRaises(ProviderUnavailable) as caught:
            rows_to_items(["证券代码", "股票余额", "成本价"], [["600372", "400"]])
        self.assertEqual(caught.exception.code, "partial_read")

    def test_unrecognized_header_reports_the_actual_header(self):
        with self.assertRaises(MacThsScriptError) as ctx:
            rows_to_items(["名称", "市值"], [["航天电子", "1000"]])

        message = str(ctx.exception)
        self.assertIn("未找到代码列", message)
        self.assertIn("名称 | 市值", message)


class ToFloatTests(unittest.TestCase):
    def test_tolerates_thousand_separators_currency_and_dashes(self):
        self.assertEqual(_to_float("11,000"), 11000.0)
        self.assertEqual(_to_float("¥3,700.00"), 3700.0)
        self.assertEqual(_to_float("￥1.05"), 1.05)
        self.assertEqual(_to_float(" 23.5024 "), 23.5024)

    def test_blank_placeholders_become_zero(self):
        for raw in (None, "", "--", "-", "—"):
            self.assertEqual(_to_float(raw), 0.0)

    def test_garbage_still_raises(self):
        with self.assertRaises(ValueError):
            _to_float("暂无")


class MacThsProviderTests(unittest.TestCase):
    """权限、被动读取、按次导航、失败返回的契约。"""
    def setUp(self):
        from unittest.mock import Mock
        from types import SimpleNamespace
        self.previous = Mock()
        self.target = Mock()
        self.target.localizedName.return_value = '同花顺'
        workspace = Mock()
        workspace.frontmostApplication.return_value = self.previous
        workspace.runningApplications.return_value = [self.target]
        self.appkit = SimpleNamespace(NSWorkspace=SimpleNamespace(sharedWorkspace=lambda: workspace), NSApplicationActivateIgnoringOtherApps=1)
        self.patches = [
            patch.dict('sys.modules', {'AppKit': self.appkit}),
            patch.object(mac_ths, 'accessibility_status', return_value='granted'),
            patch.object(mac_ths, 'app_running', return_value=True),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_passive_read_does_not_activate_or_use_applescript(self):
        from unittest.mock import Mock
        runner = Mock()
        with patch.object(mac_ths, 'read_ax_table', return_value=[]) as read:
            MacThsProvider(platform='darwin', runner=runner).get_holdings()
            read.assert_called_once_with('simulated')
        runner.assert_not_called()
        self.target.activateWithOptions_.assert_not_called()

    def test_passive_failure_requires_navigation_without_activating(self):
        with patch.object(mac_ths, 'read_ax_table', side_effect=ProviderUnavailable('导航', 'navigation_required')):
            with self.assertRaises(ProviderUnavailable) as caught:
                MacThsProvider(platform='darwin').get_holdings()
        self.assertEqual(caught.exception.code, 'navigation_required')
        self.target.activateWithOptions_.assert_not_called()

    def test_foreground_uses_ax_first_and_restores_previous(self):
        with patch.object(mac_ths, 'read_ax_table', side_effect=[ProviderUnavailable('导航', 'navigation_required'), []]) as read:
            result = MacThsProvider(platform='darwin', account_mode='real').read_holdings(foreground=True)
        self.assertEqual(result, [])
        self.assertEqual(read.call_args.kwargs, {'navigate': True})
        self.previous.activateWithOptions_.assert_called_once()

    def test_only_actual_fallback_requests_automation_and_restores(self):
        for code, output, error in [(1, '', '-1743'), (0, 'ERR\t-1743', '')]:
            with self.subTest(code=code):
                with patch.object(mac_ths, 'read_ax_table', side_effect=ProviderUnavailable('导航', 'navigation_required')):
                    provider = MacThsProvider(platform='darwin', runner=lambda script: (code, output, error))
                    with self.assertRaises(ProviderUnavailable) as caught:
                        provider.read_holdings(foreground=True)
                self.assertEqual(caught.exception.code, 'automation_required')
        self.assertEqual(self.previous.activateWithOptions_.call_count, 2)

    def test_fallback_success_timeout_and_error_restore(self):
        cases = [
            (lambda script: (0, _ok(HOLDINGS_HEADER, '600879\t航天电子\t900\t900\t23.5024\t24.10'), ''), None),
            (lambda script: (1, '', '-25211'), 'accessibility_required'),
            (lambda script: (1, '', 'failure'), 'read_failed'),
        ]
        for runner, expected in cases:
            with patch.object(mac_ths, 'read_ax_table', side_effect=ProviderUnavailable('导航', 'navigation_required')):
                provider = MacThsProvider(platform='darwin', runner=runner)
                if expected:
                    with self.assertRaises(ProviderUnavailable) as caught:
                        provider.read_holdings(foreground=True)
                    self.assertEqual(caught.exception.code, expected)
                else:
                    self.assertEqual(len(provider.read_holdings(foreground=True)), 1)
        self.assertEqual(self.previous.activateWithOptions_.call_count, 3)

    def test_permission_and_platform_block_before_read(self):
        for status, code in [('not_granted', 'accessibility_required'), ('unknown', 'dependency_missing')]:
            with patch.object(mac_ths, 'accessibility_status', return_value=status), patch.object(mac_ths, 'read_ax_table') as read:
                with self.assertRaises(ProviderUnavailable) as caught:
                    MacThsProvider(platform='darwin').read_holdings(foreground=True)
                self.assertEqual(caught.exception.code, code)
                read.assert_not_called()
        with self.assertRaises(ProviderUnavailable) as caught:
            MacThsProvider(platform='win32').get_holdings()
        self.assertEqual(caught.exception.code, 'unsupported_platform')


class DefaultRunnerTests(unittest.TestCase):
    def test_passes_the_script_body_as_a_single_e_argument(self):
        seen = {}

        def fake_run(argv, **kwargs):
            seen["argv"] = argv
            return subprocess.CompletedProcess(argv, 0, "OK\t", "")

        with patch.object(mac_ths.subprocess, "run", fake_run):
            code, stdout, _ = default_runner("on run\nend run")

        self.assertEqual(code, 0)
        self.assertEqual(seen["argv"][:2], ["/usr/bin/osascript", "-e"])
        self.assertEqual(seen["argv"][2], "on run\nend run")
        self.assertEqual(len(seen["argv"]), 3)
        self.assertEqual(stdout, "OK\t")


class PlatformGateTests(unittest.TestCase):
    """平台门禁：必须在实例化 provider 之前拦下不匹配的组合。"""

    def _gate(self, platform, provider):
        with patch.object(holdings_source.sys, "platform", platform):
            return holdings_source.platform_gate(provider)

    def test_easytrader_passes_on_windows(self):
        self.assertIsNone(self._gate("win32", "easytrader"))

    def test_mac_ths_is_rejected_on_windows(self):
        reason = self._gate("win32", "mac_ths")

        self.assertIsNotNone(reason)
        self.assertIn("easytrader", reason)

    def test_easytrader_is_rejected_on_macos_with_a_pointer_to_mac_ths(self):
        reason = self._gate("darwin", "easytrader")

        self.assertIsNotNone(reason)
        self.assertIn("mac_ths", reason)

    def test_mac_ths_passes_on_macos(self):
        self.assertIsNone(self._gate("darwin", "mac_ths"))

    def test_manual_passes_on_every_platform(self):
        for platform in ("win32", "darwin", "linux"):
            self.assertIsNone(self._gate(platform, "manual"), platform)

    def test_other_platforms_are_rejected_for_client_sync(self):
        reason = self._gate("linux", "easytrader")

        self.assertIsNotNone(reason)
        self.assertIn("linux", reason)
        self.assertIn("导入持仓", reason)

    def test_gate_is_case_and_whitespace_insensitive(self):
        self.assertIsNotNone(self._gate("win32", "  MAC_THS "))
        self.assertIsNone(self._gate("darwin", " Mac_Ths "))


class SnapshotIntegrationTests(unittest.TestCase):
    """provider_snapshot 在 macOS + mac_ths 配置下不能抛错，只降级成 reason。"""

    def test_snapshot_on_macos_without_the_client_reports_a_reason(self):
        with patch.object(holdings_source.settings, "holdings_provider", "mac_ths"), patch.object(
            holdings_source.sys, "platform", "darwin"
        ), patch.multiple(mac_ths, app_bundles=lambda: ["/Applications/同花顺.app"], accessibility_status=lambda: "granted", app_running=lambda *args: False):
            snapshot = holdings_source.provider_snapshot()

        self.assertEqual(snapshot["provider"], "mac_ths")
        self.assertFalse(snapshot["available"])
        self.assertEqual(snapshot["blocking_reason"], "client_not_running")

    def test_snapshot_on_windows_names_the_platform_mismatch(self):
        with patch.object(holdings_source.settings, "holdings_provider", "mac_ths"), patch.object(
            holdings_source.sys, "platform", "win32"
        ):
            snapshot = holdings_source.provider_snapshot()

        self.assertFalse(snapshot["available"])
        self.assertIn("easytrader", snapshot["reason"] or "")

    def test_sync_on_macos_without_the_client_raises_provider_unavailable(self):
        with patch.object(holdings_source.settings, "holdings_provider", "mac_ths"), patch.object(
            holdings_source.sys, "platform", "darwin"
        ), patch.multiple(mac_ths, app_bundles=lambda: ["/Applications/同花顺.app"], accessibility_status=lambda: "granted", app_running=lambda *args: False):
            with self.assertRaises(ProviderUnavailable):
                holdings_source.sync_holdings()


class MacClientDetectionTests(unittest.TestCase):
    """/holdings/source/detect 在 macOS 上只认同花顺 Mac 版，且空态引导来自后端。"""

    def _mac_clients(self, bundles, running=True):
        with patch.object(mac_ths, "app_bundles", lambda name: bundles), patch.object(
            mac_ths, "app_running", lambda name: running
        ):
            return holdings_source._mac_clients()

    def test_absent_app_is_not_reported_as_a_discovered_client(self):
        """没装同花顺时不能列一行空路径的「客户端」，否则用户以为检测错了。"""
        self.assertEqual(self._mac_clients([]), [])

    def test_installed_app_is_reported_with_its_bundle_path(self):
        clients = self._mac_clients(["/Applications/同花顺.app"], running=False)

        self.assertEqual(len(clients), 1)
        self.assertEqual(clients[0]["broker_id"], "mac_ths")
        self.assertEqual(clients[0]["exe_path"], "/Applications/同花顺.app")
        self.assertEqual(clients[0]["running"], False)
        self.assertIn("同花顺", clients[0]["label"])

    def test_detect_on_macos_without_the_app_returns_the_mac_hint(self):
        with patch.object(holdings_source.sys, "platform", "darwin"), patch.object(
            mac_ths, "app_bundles", lambda name: []
        ):
            payload = asyncio.run(holdings_source.detect_clients())

        self.assertEqual(payload["clients"], [])
        self.assertIn("同花顺", payload["hint"])
        self.assertIn("辅助功能", payload["hint"])

    def test_detect_on_macos_with_the_app_found_has_no_hint(self):
        with patch.object(holdings_source.sys, "platform", "darwin"), patch.object(
            mac_ths, "app_bundles", lambda name: ["/Applications/同花顺.app"]
        ), patch.object(mac_ths, "app_running", lambda name: True):
            payload = asyncio.run(holdings_source.detect_clients())

        self.assertIsNone(payload["hint"])
        self.assertEqual(len(payload["clients"]), 1)
        # macOS 不做磁盘递归，永远是即时结果
        self.assertFalse(payload["cached"])


if __name__ == "__main__":
    unittest.main()
