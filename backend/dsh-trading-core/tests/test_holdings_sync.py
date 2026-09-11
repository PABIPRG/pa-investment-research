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
        self.assertIn("未知 HOLDINGS_PROVIDER", snapshot["reason"])

    def test_unavailable_source_surfaces_the_provider_message(self):
        message = "券商客户端未运行：请先启动并登录 平安证券（同花顺版）。"
        provider = FakeProvider(available=False, error=message)

        with patch.object(holdings_source.settings, "holdings_provider", "easytrader"), \
                patch.object(holdings_source.sys, "platform", "win32"), \
                patch.object(holdings_source, "get_provider", return_value=provider):
            snapshot = holdings_source.provider_snapshot()

        self.assertEqual(snapshot["provider"], "easytrader")
        self.assertEqual(snapshot["label"], provider.profile.label)
        self.assertFalse(snapshot["available"])
        self.assertEqual(snapshot["reason"], message)


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

    def test_provider_unavailable_maps_to_503_with_the_provider_message(self):
        def raise_unavailable():
            raise ProviderUnavailable("券商客户端未运行：请先启动并登录。")

        with patch.object(adapter_app, "sync_holdings", side_effect=raise_unavailable):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(self.endpoint())

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, "券商客户端未运行：请先启动并登录。")

    def test_empty_result_maps_to_409(self):
        with patch.object(adapter_app, "sync_holdings", side_effect=EmptyHoldingsError("未读回任何持仓。")):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(self.endpoint())

        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("未读回任何持仓", caught.exception.detail)


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
