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

    def test_zero_and_dashed_rows_are_skipped(self):
        """已清仓的行数量为 0 或 '--'，不能写进持仓。"""
        header = ["证券代码", "股票余额", "成本价"]
        rows = [
            ["600879", "0", "23.5024"],  # 已清仓
            ["159607", "--", "1.0115"],  # 非持仓行
            ["600372", "400", "16.2117"],
        ]

        items = rows_to_items(header, rows)

        self.assertEqual([item.ticker for item in items], ["600372"])

    def test_rows_shorter_than_the_header_are_tolerated(self):
        items = rows_to_items(["证券代码", "股票余额", "成本价"], [["600372", "400"]])

        self.assertEqual(items, [])

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
    """provider 各分支；用注入的 platform/runner 在 Windows 上跑通。"""

    def _provider(self, runner, platform="darwin", app_name="同花顺", account_mode="real"):
        return MacThsProvider(
            platform=platform,
            runner=runner,
            app_name=app_name,
            account_mode=account_mode,
        )

    def _on_mac(self):
        return patch.multiple(mac_ths, osascript_available=lambda: True, app_running=lambda name: True)

    def test_non_darwin_is_unavailable_and_says_so(self):
        provider = self._provider(lambda script: (0, "", ""), platform="win32")

        self.assertFalse(provider.is_available())
        with self.assertRaises(ProviderUnavailable) as ctx:
            provider.get_holdings()
        self.assertIn("win32", str(ctx.exception))

    def test_missing_osascript_is_unavailable(self):
        provider = self._provider(lambda script: (0, "", ""))
        with patch.multiple(mac_ths, osascript_available=lambda: False, app_running=lambda name: True):
            self.assertFalse(provider.is_available())
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()
        self.assertIn("osascript", str(ctx.exception))

    def test_client_not_running_is_unavailable(self):
        provider = self._provider(lambda script: (0, "", ""))
        with patch.multiple(mac_ths, osascript_available=lambda: True, app_running=lambda name: False):
            self.assertFalse(provider.is_available())
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()
        self.assertIn("未运行", str(ctx.exception))

    def test_successful_run_returns_items(self):
        script_seen = []

        def runner(script):
            script_seen.append(script)
            return 0, _ok(HOLDINGS_HEADER, "600879\t航天电子\t900\t900\t23.5024\t24.10"), ""

        provider = self._provider(runner)
        with self._on_mac():
            self.assertTrue(provider.is_available())
            items = provider.get_holdings()

        self.assertEqual([item.ticker for item in items], ["600879"])
        self.assertEqual(items[0].quantity, 900.0)
        # 运行器收到的是脚本正文，不是 shell 命令
        self.assertEqual(script_seen, [apple_script("同花顺")])

    def test_simulated_run_passes_the_simulation_script(self):
        script_seen = []

        provider = self._provider(
            lambda script: (script_seen.append(script) or 0, _ok(HOLDINGS_HEADER), ""),
            account_mode="simulated",
        )
        with self._on_mac():
            provider.get_holdings()

        self.assertEqual(script_seen, [apple_script("同花顺", "simulated")])

    def test_err_status_becomes_a_provider_unavailable(self):
        provider = self._provider(lambda script: (0, "ERR\t未在交易窗口找到持仓表格。", ""))
        with self._on_mac():
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()

        self.assertIn("未在交易窗口找到持仓表格", str(ctx.exception))

    def test_permission_failure_maps_to_the_actionable_hint(self):
        """TCC 拒绝时 osascript 退出码非 0、stderr 带 -1743/-25211，
        必须换成中文可执行指引，而不是把英文原文丢给用户。"""
        for marker, settings_section in (
            ("execution error: Not authorized to send Apple events. (-1743)", "自动化"),
            ("System Events got an error: not allowed assistive access. (-25211)", "辅助功能"),
        ):
            provider = self._provider(lambda script, m=marker: (1, "", m))
            with self._on_mac():
                with self.assertRaises(ProviderUnavailable) as ctx:
                    provider.get_holdings()

            message = str(ctx.exception)
            self.assertIn("隐私与安全性", message)
            self.assertIn(settings_section, message)
            self.assertNotIn("-1743", message)
            self.assertNotIn("-25211", message)

    def test_caught_automation_failure_maps_to_the_automation_permission_hint(self):
        """脚本内捕获的 TCC 错误仍以退出码 0 返回，不能漏过权限分类。"""
        provider = self._provider(lambda script: (
            0,
            "ERR\t无法切换到「交易 → A股 → 股票 → 持仓」："
            "未获得授权将Apple事件发送给System Events。 (-1743)",
            "",
        ))
        with self._on_mac():
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()

        message = str(ctx.exception)
        self.assertIn("自动化", message)
        self.assertIn("System Events", message)
        self.assertIn("可能已打开或切换了部分页面", message)
        self.assertNotIn("无法切换到", message)
        self.assertNotIn("-1743", message)

    def test_caught_accessibility_failure_maps_to_the_accessibility_permission_hint(self):
        provider = self._provider(lambda script: (
            0,
            "ERR\tSystem Events got an error: not allowed assistive access. (-25211)",
            "",
        ))
        with self._on_mac():
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()

        message = str(ctx.exception)
        self.assertIn("辅助功能", message)
        self.assertIn("可能已打开或切换了部分页面", message)
        self.assertNotIn("-25211", message)

    def test_generic_failure_surfaces_the_stderr(self):
        provider = self._provider(lambda script: (1, "", "execution error: 同花顺 isn't running. (-600)"))
        with self._on_mac():
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()

        self.assertIn("-600", str(ctx.exception))

    def test_timeout_becomes_a_provider_unavailable(self):
        def runner(script):
            raise subprocess.TimeoutExpired(cmd="osascript", timeout=60)

        provider = self._provider(runner)
        with self._on_mac():
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()

        self.assertIn("超时", str(ctx.exception))

    def test_runner_failure_becomes_a_provider_unavailable(self):
        def runner(script):
            raise OSError("no such file")

        provider = self._provider(runner)
        with self._on_mac():
            with self.assertRaises(ProviderUnavailable) as ctx:
                provider.get_holdings()

        self.assertIn("无法执行 AppleScript", str(ctx.exception))

    def test_provider_name_is_mac_ths(self):
        self.assertEqual(MacThsProvider.name, "mac_ths")


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
        ), patch.multiple(mac_ths, osascript_available=lambda: True, app_running=lambda name: False):
            snapshot = holdings_source.provider_snapshot()

        self.assertEqual(snapshot["provider"], "mac_ths")
        self.assertFalse(snapshot["available"])
        self.assertIn("未运行", snapshot["reason"] or "")

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
        ), patch.multiple(mac_ths, osascript_available=lambda: True, app_running=lambda name: False):
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
