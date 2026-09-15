# -*- coding: utf-8 -*-
"""成交明细 HTTP 契约。

三条路由的错误形态必须与持仓那三条一致（readiness/blocking_reason/reason），否则
前端得为成交再写一套错误分支。所以这里逐个断言的是**错误映射**，不是读取逻辑
（那由 test_trades_source / test_trade_profile 覆盖）。
"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from adapter import app as adapter_app
from adapter import trades_source
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.schemas import TradeItem, TradesClearRequest, TradesSyncRequest
from adapter.store import JsonStore
from adapter.trades_source import EmptyTradesError, PreviewConflict


def endpoint(app, path):
    """按路径取路由函数；重复注册时取最后一个（后注册的覆盖前者）。"""
    matches = [route.endpoint for route in app.routes if getattr(route, "path", "") == path]
    assert matches, f"未注册路由 {path}"
    return matches[-1]


def trade(ticker="600519"):
    return TradeItem(
        ticker=ticker, name="贵州茅台", side="buy", side_label="买入", price=1500.0,
        quantity=100, amount=150000.0, traded_at="2026-06-26T11:12:51", trade_id="T1",
        source="easytrader", account_mode="real",
    )


class SyncRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = adapter_app.create_app()
        self.endpoint = endpoint(self.app, "/trades/sync")
        trades_source.reset_previews()
        self.addCleanup(trades_source.reset_previews)

    def test_preview_is_the_default_action(self):
        with patch.object(adapter_app, "preview_trades",
                          return_value={"preview_token": "t", "kind": "import"}) as preview:
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["preview_token"], "t")
        preview.assert_called_once_with()

    def test_commit_requires_the_token(self):
        with patch.object(adapter_app, "commit_trades", return_value={"saved": 0}) as commit:
            asyncio.run(self.endpoint(TradesSyncRequest(action="commit", preview_token="abc")))
        commit.assert_called_once_with("abc")

    def test_provider_unavailable_returns_a_stable_code(self):
        with patch.object(adapter_app, "preview_trades",
                          side_effect=ProviderUnavailable("先登录", "client_not_running")):
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["blocking_reason"], "client_not_running")
        self.assertEqual(result["readiness"], "blocked")

    def test_partial_read_is_reported_as_partial_not_blocked(self):
        """部分失败与完全失败对用户是两个不同的动作：前者重读，后者先修客户端。"""
        with patch.object(adapter_app, "preview_trades",
                          side_effect=ProviderUnavailable("脏数据", "partial_read")):
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["readiness"], "partial")
        self.assertEqual(result["blocking_reason"], "partial_read")

    def test_automation_required_is_surfaced(self):
        with patch.object(adapter_app, "preview_trades",
                          side_effect=ProviderUnavailable("需要验证码", "automation_required")):
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["automation"], "required")

    def test_empty_result_and_conflict_have_their_own_codes(self):
        with patch.object(adapter_app, "preview_trades", side_effect=EmptyTradesError("空结果")):
            self.assertEqual(asyncio.run(self.endpoint(None))["blocking_reason"], "empty_result")
        with patch.object(adapter_app, "commit_trades", side_effect=PreviewConflict("过期了")):
            result = asyncio.run(self.endpoint(TradesSyncRequest(action="commit", preview_token="x")))
        self.assertEqual(result["blocking_reason"], "preview_conflict")

    def test_unexpected_failure_is_not_leaked_as_a_traceback(self):
        with patch.object(adapter_app, "preview_trades", side_effect=RuntimeError("内部细节")):
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["readiness"], "failed")
        self.assertNotIn("内部细节", result["reason"])


class ClearRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = adapter_app.create_app()
        self.endpoint = endpoint(self.app, "/trades/clear")

    def test_preview_reports_the_scope_and_commit_consumes_the_token(self):
        with patch.object(adapter_app, "preview_clear",
                          return_value={"kind": "clear", "will_remove": 3}) as preview:
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["will_remove"], 3)
        preview.assert_called_once_with()

        with patch.object(adapter_app, "commit_trades",
                          return_value={"cleared": True, "removed": 3}) as commit:
            result = asyncio.run(self.endpoint(
                TradesClearRequest(action="commit", preview_token="tok")))
        self.assertTrue(result["cleared"])
        commit.assert_called_once_with("tok")

    def test_nothing_to_clear_is_reported_as_empty(self):
        with patch.object(adapter_app, "preview_clear", side_effect=EmptyTradesError("没有明细")):
            result = asyncio.run(self.endpoint(None))
        self.assertEqual(result["blocking_reason"], "empty_result")


class TradesGetRouteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = JsonStore(Path(self.directory.name))
        self.endpoint = endpoint(adapter_app.create_app(), "/trades")

    def test_returns_entries_imports_and_profile(self):
        self.store.mutate_document("trades", lambda document: {
            "entries": [trade().model_dump()],
            "imports": [{"fetched": 1, "added": 1, "range_start": "2026-06-26",
                         "range_end": "2026-06-26"}],
            "last_cleared": None,
        })
        with patch.object(adapter_app, "JsonStore", lambda *a, **k: self.store):
            result = asyncio.run(self.endpoint())

        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(len(result["imports"]), 1)
        self.assertEqual(result["profile"]["frequency"]["trades"], 1)
        self.assertEqual(result["profile"]["coverage"]["status"], "complete")
        self.assertIsNone(result["last_cleared"])

    def test_empty_store_yields_a_renderable_profile(self):
        """没导入过成交是正常状态：界面要能直接渲染零值，而不是撞到一个空响应。"""
        with patch.object(adapter_app, "JsonStore", lambda *a, **k: self.store):
            result = asyncio.run(self.endpoint())

        self.assertEqual(result["entries"], [])
        self.assertEqual(result["profile"]["frequency"]["trades"], 0)
        self.assertEqual(result["profile"]["coverage"]["status"], "empty")


class NativeActionTests(unittest.TestCase):
    """成交读取只能从认证宿主进来：Windows 上它会抢前台并可能弹验证码。"""

    def test_read_trades_action_reaches_the_preview(self):
        from adapter import holdings_source

        with patch.object(holdings_source.settings, "holdings_provider", "easytrader"), \
                patch.object(holdings_source.settings, "holdings_account_mode", "real"), \
                patch.object(trades_source, "preview_trades",
                             return_value={"preview_token": "t"}) as preview:
            result = holdings_source.native_action("read_trades", "real")

        self.assertEqual(result["preview_token"], "t")
        self.assertEqual(preview.call_args.kwargs,
                         {"foreground": True, "expected_account": "real"})

    def test_unsupported_provider_refuses_the_action(self):
        from adapter import holdings_source

        with patch.object(holdings_source.settings, "holdings_provider", "manual"), \
                patch.object(holdings_source.settings, "holdings_account_mode", "real"):
            with self.assertRaises(ProviderUnavailable) as caught:
                holdings_source.native_action("read_trades", "real")
        self.assertEqual(caught.exception.code, "unsupported_action")

    def test_account_change_blocks_before_reading(self):
        from adapter import holdings_source

        with patch.object(holdings_source.settings, "holdings_account_mode", "real"):
            with self.assertRaises(ProviderUnavailable) as caught:
                holdings_source.native_action("read_trades", "simulated")
        self.assertEqual(caught.exception.code, "account_changed")


if __name__ == "__main__":
    unittest.main()
