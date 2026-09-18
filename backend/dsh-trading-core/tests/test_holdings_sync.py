# -*- coding: utf-8 -*-
"""持仓数据源「检测 + 同步」接口测试（产品 UI 用）。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException


os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from adapter import app as adapter_app
from adapter import holdings_source
from adapter.holdings_providers import easytrader as easytrader_module
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.holdings_providers.broker_profiles import DiscoveredClient, resolve_profile
from adapter.holdings_source import EmptyHoldingsError
from adapter.schemas import HoldingItem
from adapter.store import JsonStore


class FakeProvider:
    """最小 provider 替身：固定 is_available / get_holdings 行为。"""

    name = "easytrader"

    def __init__(self, items=None, available=True, error=None):
        self.profile = resolve_profile("pingan")
        self._items = items or []
        self._available = available
        self._error = error

    def is_available(self):
        return self._available

    def get_holdings(self):
        if self._error is not None:
            raise ProviderUnavailable(self._error)
        return list(self._items)


def _endpoint(app, path):
    return next(route.endpoint for route in app.routes if route.path == path)


class ProviderSnapshotTests(unittest.TestCase):
    def test_manual_source_is_available_without_a_reason(self):
        with patch.object(holdings_source.settings, "holdings_provider", "manual"), \
                patch.object(holdings_source.settings, "holdings_account_mode", "real", create=True):
            snapshot = holdings_source.provider_snapshot()

        self.assertEqual(snapshot["provider"], "manual")
        self.assertEqual(snapshot["label"], "手动输入")
        self.assertTrue(snapshot["available"])
        self.assertIsNone(snapshot["reason"])
        self.assertEqual(snapshot["account_mode"], "real")
        self.assertEqual(snapshot["supported_account_modes"], ["real"])

    def test_unknown_provider_reports_a_reason_instead_of_raising(self):
        with patch.object(holdings_source.settings, "holdings_provider", "nope"):
            snapshot = holdings_source.provider_snapshot()

        self.assertFalse(snapshot["available"])
        self.assertEqual(snapshot["blocking_reason"], "provider_unavailable")

    def test_snapshot_never_calls_holdings_reader(self):
        provider = FakeProvider(available=False, error="must not read")
        with patch.object(holdings_source.settings, "holdings_provider", "qmt"), \
             patch.object(holdings_source, "get_provider", return_value=provider), \
             patch.object(provider, "get_holdings") as reader:
            snapshot = holdings_source.provider_snapshot()
        self.assertEqual(snapshot["blocking_reason"], "provider_unavailable")
        reader.assert_not_called()


class CaptchaOcrAdvisoryTests(unittest.TestCase):
    """验证码 OCR 是「建议」不是「闸门」。

    真机踩过：Tesseract 装了但不在 PATH 里，读持仓撞上风控验证码才失败。修法是
    在用户点读取**之前**先提示，但绝不能顺手把功能禁掉——验证码不保证每次都弹，
    没装 OCR 的机器照样读得到不弹验证码的持仓。这组用例钉死这个边界。
    """

    def _snapshot(self, *, ocr: str, client_running: bool = True,
                  client_exists: bool = True, provider: str = "easytrader") -> dict:
        """按 easytrader 分支真正用到的属性桩住 provider，并指定 OCR 探测结果。"""
        path = str(Path(tempfile.gettempdir()) / "dsh-ocr-test.exe") if client_exists else ""
        stub = SimpleNamespace(
            profile=resolve_profile("pingan"),
            _client_path=lambda: path,
            _client_running=lambda: client_running,
            _imported=True,
        )
        if client_exists:
            Path(path).write_text("", encoding="utf-8")
            self.addCleanup(lambda: Path(path).unlink(missing_ok=True))

        def probe() -> str:
            if isinstance(ocr, Exception):
                raise ocr
            return ocr

        patchers = [
            patch.object(holdings_source.settings, "holdings_provider", provider),
            patch.object(holdings_source.settings, "holdings_account_mode", "real"),
            patch.object(holdings_source, "platform_gate", lambda name: None),
            patch.object(holdings_source._ocr, "tesseract_status", probe),
            patch.object(easytrader_module, "EasyTraderProvider", lambda *a, **k: stub),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        return holdings_source.provider_snapshot("electron")

    def test_missing_ocr_is_advisory_not_blocking(self):
        """核心非回归：缺 OCR 时读取入口必须照常上报。"""
        snapshot = self._snapshot(ocr="missing")

        self.assertTrue(snapshot["available"])
        self.assertIsNone(snapshot["blocking_reason"])
        self.assertIn("read", snapshot["available_actions"])
        self.assertEqual(snapshot["captcha_ocr"], "missing")
        self.assertIn("Tesseract", snapshot["captcha_ocr_hint"])

    def test_missing_ocr_survives_client_not_running(self):
        """探测必须排在三个 blocked() 之前，否则客户端没开时这条提示会消失。"""
        snapshot = self._snapshot(ocr="missing", client_running=False)

        self.assertEqual(snapshot["blocking_reason"], "client_not_running")
        self.assertEqual(snapshot["captcha_ocr"], "missing")

    def test_missing_ocr_survives_unlocated_client(self):
        """同上，覆盖另一个提前返回。"""
        snapshot = self._snapshot(ocr="missing", client_exists=False)

        self.assertEqual(snapshot["blocking_reason"], "client_location_required")
        self.assertEqual(snapshot["captcha_ocr"], "missing")

    def test_available_ocr_leaves_hint_empty(self):
        snapshot = self._snapshot(ocr="available")

        self.assertEqual(snapshot["captcha_ocr"], "available")
        self.assertIsNone(snapshot["captcha_ocr_hint"])

    def test_probe_failure_does_not_break_the_snapshot(self):
        """探测抛错也要出快照——本模块约定「只报告不抛错」。"""
        snapshot = self._snapshot(ocr=RuntimeError("探测炸了"))

        self.assertEqual(snapshot["captcha_ocr"], "unknown")
        self.assertTrue(snapshot["available"])

    def test_non_ocr_provider_reports_not_applicable(self):
        """只有 easytrader 用 OCR；其他数据源不该看到这个字段有值。"""
        snapshot = self._snapshot(ocr="missing", provider="manual")

        self.assertEqual(snapshot["captcha_ocr"], "not_applicable")
        self.assertIsNone(snapshot["captcha_ocr_hint"])


class SyncHoldingsTests(unittest.TestCase):
    def _items(self):
        return [
            HoldingItem(ticker="600519", quantity=100, cost_price=1500),
            HoldingItem(ticker="000858", quantity=200, cost_price=135),
        ]

    def test_sync_replaces_the_collection_and_records_an_api_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            provider = FakeProvider(items=self._items())

            with patch.object(holdings_source, "get_provider", return_value=provider), \
                    patch.object(holdings_source, "JsonStore", return_value=store), \
                    patch.object(holdings_source.settings, "holdings_account_mode", "simulated", create=True):
                result = holdings_source.sync_holdings()

            self.assertEqual(result["saved"], 2)
            self.assertEqual(result["provider"], "easytrader")
            self.assertEqual(result["account_mode"], "simulated")
            self.assertEqual(result["account_label"], "模拟操盘")
            self.assertEqual([item["ticker"] for item in result["items"]], ["600519", "000858"])
            self.assertRegex(result["snapshot_id"], r"^[0-9a-f]{32}$")

            saved = store.get("holdings", "default")
            self.assertEqual(len(saved), 2)
            self.assertEqual(store.get("holdings", "snapshots")[0]["source"], "broker_simulated")

    def test_empty_result_is_refused_and_leaves_the_store_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set(
                "holdings",
                "default",
                [{"ticker": "600519", "quantity": 100, "cost_price": 1500}],
            )
            provider = FakeProvider(items=[])

            with patch.object(holdings_source, "get_provider", return_value=provider), \
                    patch.object(holdings_source, "JsonStore", return_value=store):
                with self.assertRaises(EmptyHoldingsError):
                    holdings_source.sync_holdings()

            self.assertEqual(
                store.get("holdings", "default"),
                [{"ticker": "600519", "quantity": 100, "cost_price": 1500}],
            )
            self.assertIsNone(store.get("holdings", "snapshots"))

    def test_unavailable_source_propagates_provider_unavailable(self):
        provider = FakeProvider(available=False, error="券商客户端未运行。")

        with patch.object(holdings_source, "get_provider", return_value=provider):
            with self.assertRaises(ProviderUnavailable):
                holdings_source.sync_holdings()


class SyncRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = adapter_app.create_app()
        self.endpoint = _endpoint(self.app, "/holdings/sync")

    def test_provider_unavailable_returns_stable_code(self):
        with patch.object(adapter_app, "preview_holdings", side_effect=ProviderUnavailable("先登录", "login_required")):
            result = asyncio.run(self.endpoint())
        self.assertEqual(result["blocking_reason"], "login_required")

    def test_empty_preview_is_blocked(self):
        with patch.object(adapter_app, "preview_holdings", side_effect=EmptyHoldingsError("空结果")):
            result = asyncio.run(self.endpoint())
        self.assertEqual(result["blocking_reason"], "empty_result")

    def test_electron_owned_backend_rejects_generic_sync_without_host_token(self):
        with patch.dict(os.environ, {
            "DSH_HOLDINGS_NATIVE_REQUIRED": "1",
            "DSH_HOLDINGS_NATIVE_TOKEN": "private",
        }):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(self.endpoint(None, ""))
        self.assertEqual(caught.exception.status_code, 403)

    def test_native_route_requires_private_host_token(self):
        from adapter.schemas import HoldingsNativeRequest
        endpoint = _endpoint(self.app, "/holdings/native")
        with patch.dict(os.environ, {"DSH_HOLDINGS_NATIVE_TOKEN": "private"}):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(endpoint(HoldingsNativeRequest(action="read", account_mode="real"), "wrong"))
        self.assertEqual(caught.exception.status_code, 403)


class DetectClientsTests(unittest.TestCase):
    def setUp(self):
        holdings_source.reset_cache()
        self.addCleanup(holdings_source.reset_cache)
        # 替换被测模块的 sys 引用，避免修改进程级 sys.platform 后让
        # asyncio 在 macOS 测试进程中误加载 windows_events。
        platform = patch.object(holdings_source, "sys", SimpleNamespace(platform="win32"))
        platform.start()
        self.addCleanup(platform.stop)

    def _client(self):
        return DiscoveredClient(
            profile=resolve_profile("pingan"),
            exe_path=Path("C:/平安证券/同花顺版/xiadan.exe"),
            main_dir=Path("C:/平安证券/同花顺版"),
            running=True,
            matched=True,
        )

    def test_detection_projects_discovered_clients(self):
        with patch.object(holdings_source, "discover_clients", return_value=[self._client()]) as scanner:
            payload = asyncio.run(holdings_source.detect_clients(force=True))

        self.assertFalse(payload["cached"])
        self.assertEqual(len(payload["clients"]), 1)
        client = payload["clients"][0]
        self.assertEqual(client["broker_id"], "pingan")
        self.assertEqual(client["kernel"], "ths")
        self.assertTrue(client["running"])
        self.assertEqual(client["main_dir"], str(Path("C:/平安证券/同花顺版")))
        scanner.assert_called_once()

    def test_second_call_within_the_ttl_skips_the_scan(self):
        with patch.object(holdings_source, "discover_clients", return_value=[self._client()]) as scanner:
            first = asyncio.run(holdings_source.detect_clients())
            second = asyncio.run(holdings_source.detect_clients())

        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["clients"], first["clients"])
        scanner.assert_called_once()

    def test_force_bypasses_the_cache(self):
        with patch.object(holdings_source, "discover_clients", return_value=[self._client()]) as scanner:
            asyncio.run(holdings_source.detect_clients())
            forced = asyncio.run(holdings_source.detect_clients(force=True))

        self.assertFalse(forced["cached"])
        self.assertEqual(scanner.call_count, 2)

    def test_detect_route_forwards_force(self):
        endpoint = _endpoint(adapter_app.create_app(), "/holdings/source/detect")

        with patch.object(adapter_app, "detect_clients", return_value={"clients": [], "cached": False, "age_seconds": 0.0}) as forwarded:
            asyncio.run(endpoint(None))

        forwarded.assert_awaited_once_with(force=False)


if __name__ == "__main__":
    unittest.main()
