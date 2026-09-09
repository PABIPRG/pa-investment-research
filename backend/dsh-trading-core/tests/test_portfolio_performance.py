# -*- coding: utf-8 -*-
"""组合持仓快照与收益表现合同测试。"""

import os
import asyncio
import tempfile
import threading
import time
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from unittest.mock import Mock, patch

import pandas as pd

os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from adapter.portfolio_performance import (
    ensure_legacy_seed,
    list_portfolio_snapshots,
    portfolio_performance,
    record_holdings_snapshot,
    set_history_start_override,
)
from adapter.store import JsonStore


class PortfolioSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = JsonStore(Path(self.temporary.name))
        self.positions = [
            {"ticker": "600519", "quantity": 100.0, "cost_price": 1500.0},
        ]
        self.changed_positions = [
            {"ticker": "000001", "quantity": 200.0, "cost_price": 10.0},
            {"ticker": "600519", "quantity": 100.0, "cost_price": 1500.0},
        ]
        timezone = ZoneInfo("Asia/Shanghai")
        self.at_0900 = datetime(2026, 9, 9, 9, 0, tzinfo=timezone)
        self.at_1000 = datetime(2026, 9, 9, 10, 0, tzinfo=timezone)
        self.at_1100 = datetime(2026, 9, 9, 11, 0, tzinfo=timezone)

    def test_record_updates_current_holdings_and_history_in_one_document(self):
        snapshot = record_holdings_snapshot(
            self.store, self.positions, "manual", self.at_0900
        )

        document = self.store.all("holdings")
        self.assertEqual(document["default"], self.positions)
        self.assertEqual(document["snapshots"], [snapshot])
        self.assertEqual(snapshot["source"], "manual")
        self.assertEqual(snapshot["effective_at"], "2026-09-09T09:00:00+08:00")
        self.assertRegex(snapshot["snapshot_id"], r"^[0-9a-f]{32}$")
        self.assertIsNone(snapshot["previous_snapshot_id"])

    def test_identical_save_is_idempotent_but_same_day_change_is_retained(self):
        first = record_holdings_snapshot(
            self.store, self.positions, "manual", self.at_0900
        )
        duplicate = record_holdings_snapshot(
            self.store, list(reversed(self.positions)), "api", self.at_1000
        )
        changed = record_holdings_snapshot(
            self.store, self.changed_positions, "bulk_import", self.at_1100
        )

        snapshots = list_portfolio_snapshots(self.store)
        self.assertEqual(duplicate, first)
        self.assertEqual(len(snapshots), 2)
        self.assertEqual(changed["previous_snapshot_id"], first["snapshot_id"])
        self.assertEqual(changed["source"], "bulk_import")
        self.assertEqual(self.store.get("holdings", "default"), self.changed_positions)

    def test_legacy_seed_uses_migration_time_and_is_created_only_once(self):
        self.store.set("holdings", "default", self.positions)

        seed = ensure_legacy_seed(self.store, self.at_0900)
        repeated = ensure_legacy_seed(self.store, self.at_1000)

        self.assertEqual(seed, repeated)
        self.assertEqual(seed["source"], "legacy_seed")
        self.assertEqual(seed["effective_at"], "2026-09-09T09:00:00+08:00")
        self.assertEqual(len(list_portfolio_snapshots(self.store)), 1)

    def test_empty_holdings_do_not_create_a_legacy_seed(self):
        self.store.set("holdings", "default", [])

        self.assertIsNone(ensure_legacy_seed(self.store, self.at_0900))
        self.assertEqual(list_portfolio_snapshots(self.store), [])

    def test_history_start_override_is_audited_without_rewriting_snapshots(self):
        first = record_holdings_snapshot(
            self.store, self.positions, "bulk_import", self.at_0900
        )
        before = list_portfolio_snapshots(self.store)

        result = set_history_start_override(
            self.store,
            date(2026, 8, 15),
            corrected_at=self.at_1000,
            today=date(2026, 9, 9),
        )

        self.assertEqual(list_portfolio_snapshots(self.store), before)
        self.assertEqual(result, {
            "effective_date": "2026-08-15",
            "original_effective_date": "2026-09-09",
            "source": "user_corrected",
            "corrected_at": "2026-09-09T10:00:00+08:00",
        })
        self.assertEqual(self.store.get("holdings", "history_start_override"), result)
        self.assertEqual(first["effective_at"], "2026-09-09T09:00:00+08:00")

    def test_history_start_override_rejects_future_and_out_of_order_dates(self):
        record_holdings_snapshot(
            self.store, self.positions, "manual", self.at_0900
        )
        record_holdings_snapshot(
            self.store, self.changed_positions, "manual", self.at_1100
        )

        with self.assertRaisesRegex(ValueError, "不能晚于下一次持仓变更"):
            set_history_start_override(
                self.store,
                date(2026, 9, 10),
                corrected_at=self.at_1000,
                today=date(2026, 9, 30),
            )
        with self.assertRaisesRegex(ValueError, "不能晚于今天"):
            set_history_start_override(
                self.store,
                date(2026, 10, 1),
                corrected_at=self.at_1000,
                today=date(2026, 9, 30),
            )


class PortfolioPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = JsonStore(Path(self.temporary.name))
        timezone = ZoneInfo("Asia/Shanghai")
        record_holdings_snapshot(
            self.store,
            [{"ticker": "600519", "quantity": 10, "cost_price": 100}],
            "manual",
            datetime(2026, 1, 2, 9, 0, tzinfo=timezone),
        )
        record_holdings_snapshot(
            self.store,
            [{"ticker": "600519", "quantity": 20, "cost_price": 100}],
            "manual",
            datetime(2026, 1, 3, 9, 0, tzinfo=timezone),
        )

    @staticmethod
    def price_loader(code: str, start: str, end: str):
        if code != "600519":
            return []
        return [
            {"date": "2026-01-02", "close": 100.0},
            {"date": "2026-01-03", "close": 110.0},
            {"date": "2026-01-06", "close": 121.0},
        ]

    def test_time_weighted_return_chain_links_around_a_deposit(self):
        result = portfolio_performance(
            self.store,
            date(2026, 1, 2),
            date(2026, 1, 6),
            self.price_loader,
        )

        self.assertAlmostEqual(result["returns"]["twr"]["value"], 0.21, places=6)
        self.assertAlmostEqual(result["summary"]["start_value"], 1000.0)
        self.assertAlmostEqual(result["summary"]["end_value"], 2420.0)
        self.assertAlmostEqual(result["summary"]["net_flow"], 1100.0)
        self.assertAlmostEqual(result["summary"]["profit_loss"], 320.0)
        self.assertAlmostEqual(result["summary"]["current_profit_loss"], 420.0)
        self.assertAlmostEqual(result["summary"]["cost_return"], 0.21)
        self.assertEqual(
            [point["profit_loss"] for point in result["series"]],
            [0.0, 100.0, 320.0],
        )

    def test_price_histories_for_multiple_tickers_are_loaded_concurrently(self):
        store = JsonStore(Path(self.temporary.name) / "concurrent")
        record_holdings_snapshot(
            store,
            [
                {"ticker": "000001", "quantity": 100, "cost_price": 10},
                {"ticker": "600519", "quantity": 10, "cost_price": 100},
            ],
            "manual",
            datetime(2026, 1, 2, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
        )
        barrier = threading.Barrier(2)

        def concurrent_loader(code: str, start: str, end: str):
            barrier.wait(timeout=1)
            return [{"date": "2026-01-02", "close": 10 if code == "000001" else 100}]

        result = portfolio_performance(
            store,
            date(2026, 1, 2),
            date(2026, 1, 2),
            concurrent_loader,
        )

        self.assertEqual(result["coverage_ratio"], 1.0)
        self.assertEqual(result["summary"]["end_value"], 2000.0)

    def test_user_corrected_history_start_is_used_and_explained(self):
        set_history_start_override(
            self.store,
            date(2025, 12, 31),
            corrected_at=datetime(2026, 1, 4, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            today=date(2026, 1, 6),
        )

        result = portfolio_performance(
            self.store,
            None,
            date(2026, 1, 6),
            self.price_loader,
        )

        self.assertEqual(result["available_since"], "2025-12-31")
        self.assertEqual(result["history_start_origin"], "user_corrected")
        self.assertEqual(result["history_start_original"], "2026-01-02")
        self.assertIn("人工校正", "".join(result["limitations"]))

    def test_xirr_is_an_estimate_with_explainable_cash_flows(self):
        result = portfolio_performance(
            self.store,
            date(2026, 1, 2),
            date(2026, 1, 6),
            self.price_loader,
        )

        self.assertEqual(result["returns"]["xirr"]["quality"], "estimated")
        self.assertIsNotNone(result["returns"]["xirr"]["value"])
        self.assertEqual(result["cash_flows"], [
            {"date": "2026-01-02", "amount": -1000.0, "kind": "opening_value"},
            {"date": "2026-01-03", "amount": -1100.0, "kind": "estimated_external_flow"},
            {"date": "2026-01-06", "amount": 2420.0, "kind": "ending_value"},
        ])

    def test_empty_history_returns_unavailable_without_fabricated_zeroes(self):
        empty = JsonStore(Path(self.temporary.name) / "empty")

        result = portfolio_performance(
            empty, None, date(2026, 1, 6), self.price_loader
        )

        self.assertEqual(result["quality"], "unavailable")
        self.assertIsNone(result["summary"]["end_value"])
        self.assertIsNone(result["returns"]["twr"]["value"])
        self.assertIsNone(result["returns"]["xirr"]["value"])
        self.assertEqual(result["series"], [])

    def test_missing_price_marks_partial_coverage_instead_of_using_zero(self):
        timezone = ZoneInfo("Asia/Shanghai")
        record_holdings_snapshot(
            self.store,
            [
                {"ticker": "000001", "quantity": 50, "cost_price": 10},
                {"ticker": "600519", "quantity": 20, "cost_price": 100},
            ],
            "manual",
            datetime(2026, 1, 4, 9, 0, tzinfo=timezone),
        )

        result = portfolio_performance(
            self.store,
            date(2026, 1, 2),
            date(2026, 1, 6),
            self.price_loader,
        )

        self.assertEqual(result["quality"], "partial")
        self.assertIn("000001", result["missing_tickers"])
        self.assertAlmostEqual(result["coverage_ratio"], 0.5)
        self.assertIsNone(result["summary"]["end_value"])
        self.assertNotEqual(result["summary"]["end_value"], 0)

    def test_range_ignores_tickers_sold_before_the_selected_start(self):
        store = JsonStore(Path(self.temporary.name) / "range-tickers")
        timezone = ZoneInfo("Asia/Shanghai")
        record_holdings_snapshot(
            store,
            [{"ticker": "000001", "quantity": 100, "cost_price": 10}],
            "manual",
            datetime(2025, 1, 2, 9, 0, tzinfo=timezone),
        )
        record_holdings_snapshot(
            store,
            [{"ticker": "600519", "quantity": 10, "cost_price": 100}],
            "manual",
            datetime(2026, 1, 2, 9, 0, tzinfo=timezone),
        )
        requested = []

        def range_loader(code: str, start: str, end: str):
            requested.append(code)
            if code == "000001":
                raise RuntimeError("已卖出的旧标的不应请求")
            return [
                {"date": "2026-01-02", "close": 100.0},
                {"date": "2026-01-06", "close": 110.0},
            ]

        result = portfolio_performance(
            store,
            date(2026, 1, 2),
            date(2026, 1, 6),
            range_loader,
        )

        self.assertEqual(requested, ["600519"])
        self.assertEqual(result["quality"], "estimated")
        self.assertEqual(result["coverage_ratio"], 1.0)
        self.assertEqual([item["ticker"] for item in result["contributions"]], ["600519"])

    def test_contributions_expose_prices_for_the_selected_end_date(self):
        result = portfolio_performance(
            self.store,
            date(2026, 1, 2),
            date(2026, 1, 6),
            self.price_loader,
        )

        contribution = result["contributions"][0]
        self.assertEqual(contribution["cost_price"], 100.0)
        self.assertEqual(contribution["end_price"], 121.0)
        self.assertEqual(contribution["price_return"], 0.21)

    def test_non_trading_start_uses_the_first_available_valuation_day(self):
        def prices_after_weekend(code: str, start: str, end: str):
            return [
                {"date": "2026-01-05", "close": 120.0},
                {"date": "2026-01-06", "close": 121.0},
            ]

        result = portfolio_performance(
            self.store,
            date(2026, 1, 4),
            date(2026, 1, 6),
            prices_after_weekend,
        )

        self.assertEqual(result["returns"]["twr"]["value"], 0.008333)
        self.assertAlmostEqual(result["summary"]["start_value"], 2400.0)
        self.assertEqual(result["series"][0]["value"], None)
        self.assertEqual(result["series"][1]["value"], 2400.0)

    def test_preopen_same_day_uses_previous_close_without_backdating_holdings(self):
        store = JsonStore(Path(self.temporary.name) / "preopen")
        timezone = ZoneInfo("Asia/Shanghai")
        record_holdings_snapshot(
            store,
            [{"ticker": "600519", "quantity": 10, "cost_price": 140}],
            "legacy_seed",
            datetime(2026, 9, 9, 9, 0, tzinfo=timezone),
        )

        def previous_close(code: str, start: str, end: str):
            self.assertLess(start, "2026-09-09")
            return [{"date": "2026-09-08", "close": 145.0}]

        result = portfolio_performance(
            store, None, date(2026, 9, 9), previous_close
        )

        self.assertEqual(result["available_since"], "2026-09-09")
        self.assertEqual(result["start_date"], "2026-09-09")
        self.assertEqual(result["summary"]["end_value"], 1450.0)
        self.assertIsNone(result["summary"]["profit_loss"])
        self.assertIsNone(result["returns"]["twr"]["value"])
        self.assertEqual(result["summary"]["current_profit_loss"], 50.0)
        self.assertIsNone(result["contributions"][0]["profit_loss"])
        self.assertEqual(result["contributions"][0]["current_profit_loss"], 50.0)
        self.assertEqual(result["as_of"], "2026-09-08")

    def test_http_route_validates_dates_and_projects_performance(self):
        from fastapi.testclient import TestClient
        from adapter import app as adapter_app

        with (
            patch("adapter.app.JsonStore", return_value=self.store),
            patch("adapter.app.load_portfolio_prices", side_effect=self.price_loader),
        ):
            client = TestClient(adapter_app.create_app())
            response = client.get(
                "/portfolio/performance",
                params={"start_date": "2026-01-02", "end_date": "2026-01-06"},
            )
            reversed_range = client.get(
                "/portfolio/performance",
                params={"start_date": "2026-01-06", "end_date": "2026-01-02"},
            )
            future = client.get(
                "/portfolio/performance", params={"end_date": "2999-01-01"}
            )
            snapshots_before = list_portfolio_snapshots(self.store)
            corrected = client.post(
                "/portfolio/history-start", json={"effective_date": "2026-01-01"}
            )
            rejected = client.post(
                "/portfolio/history-start", json={"effective_date": "2999-01-01"}
            )

        self.assertEqual(response.status_code, 200)
        self.assertAlmostEqual(response.json()["returns"]["twr"]["value"], 0.21)
        self.assertEqual(reversed_range.status_code, 422)
        self.assertEqual(future.status_code, 422)
        self.assertEqual(corrected.status_code, 200)
        self.assertEqual(corrected.json()["history_start_origin"], "user_corrected")
        self.assertEqual(list_portfolio_snapshots(self.store), snapshots_before)
        self.assertEqual(rejected.status_code, 422)

    def test_http_route_maps_price_source_failure_to_retryable_service_error(self):
        from fastapi.testclient import TestClient
        from adapter import app as adapter_app

        with (
            patch("adapter.app.JsonStore", return_value=self.store),
            patch(
                "adapter.app.load_portfolio_prices",
                side_effect=RuntimeError("feed unavailable"),
            ),
        ):
            response = TestClient(adapter_app.create_app()).get(
                "/portfolio/performance",
                params={"start_date": "2026-01-02", "end_date": "2026-01-06"},
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("历史行情暂不可用", response.json()["detail"])

    def test_http_route_reuses_wider_price_history_for_shorter_ranges(self):
        from fastapi.testclient import TestClient
        from adapter import app as adapter_app

        with (
            patch("adapter.app.JsonStore", return_value=self.store),
            patch(
                "adapter.app.load_portfolio_prices",
                side_effect=self.price_loader,
            ) as external_loader,
        ):
            client = TestClient(adapter_app.create_app())
            wider = client.get(
                "/portfolio/performance",
                params={"start_date": "2026-01-02", "end_date": "2026-01-06"},
            )
            shorter = client.get(
                "/portfolio/performance",
                params={"start_date": "2026-01-03", "end_date": "2026-01-06"},
            )

        self.assertEqual(wider.status_code, 200)
        self.assertEqual(shorter.status_code, 200)
        self.assertEqual(external_loader.call_count, 1)

    def test_slow_price_history_does_not_block_health_requests(self):
        import httpx
        from adapter import app as adapter_app

        def slow_loader(code: str, start: str, end: str):
            time.sleep(0.3)
            return self.price_loader(code, start, end)

        async def exercise():
            transport = httpx.ASGITransport(app=adapter_app.create_app())
            async with httpx.AsyncClient(
                transport=transport, base_url="http://testserver"
            ) as client:
                started = time.monotonic()
                performance = asyncio.create_task(client.get(
                    "/portfolio/performance",
                    params={"start_date": "2026-01-02", "end_date": "2026-01-06"},
                ))
                await asyncio.sleep(0.01)
                health = await client.get("/health")
                elapsed = time.monotonic() - started
                result = await performance
                return health, result, elapsed

        with (
            patch("adapter.app.JsonStore", return_value=self.store),
            patch("adapter.app.load_portfolio_prices", side_effect=slow_loader),
        ):
            health, result, elapsed = asyncio.run(exercise())

        self.assertEqual(health.status_code, 200)
        self.assertEqual(result.status_code, 200)
        self.assertLess(elapsed, 0.15)


class PortfolioPriceLoaderTests(unittest.TestCase):
    def test_unreachable_baostock_skips_the_blocking_client_and_uses_fallback(self):
        from adapter import app as adapter_app

        frame = pd.DataFrame({
            "日期": [date(2026, 9, 8)],
            "收盘": [11.73],
        })
        with (
            patch("adapter.app._baostock_reachable", return_value=False),
            patch("adapter.holdings_runner._bs_hist") as baostock,
            patch("akshare.stock_zh_a_hist", return_value=frame),
        ):
            rows = adapter_app.load_portfolio_prices(
                "000001", "2026-08-09", "2026-09-09"
            )

        baostock.assert_not_called()
        self.assertEqual(rows, [{"date": "2026-09-08", "close": 11.73}])

    def test_baostock_empty_etf_falls_back_to_forward_adjusted_etf_history(self):
        from adapter import app as adapter_app

        frame = pd.DataFrame({
            "日期": [date(2026, 9, 7), date(2026, 9, 8)],
            "收盘": [0.996, 0.982],
        })
        with (
            patch("adapter.app._baostock_reachable", return_value=True),
            patch("adapter.holdings_runner._bs_hist", return_value=[]),
            patch(
                "akshare.fund_etf_hist_em",
                side_effect=[ConnectionError("transient disconnect"), frame],
            ) as fallback,
        ):
            rows = adapter_app.load_portfolio_prices(
                "159022", "2026-08-09", "2026-09-09"
            )

        self.assertEqual(fallback.call_count, 2)
        fallback.assert_called_with(
            symbol="159022",
            period="daily",
            start_date="20260809",
            end_date="20260909",
            adjust="qfq",
        )
        self.assertEqual(rows, [
            {"date": "2026-09-07", "close": 0.996},
            {"date": "2026-09-08", "close": 0.982},
        ])

    def test_etf_history_uses_sina_after_eastmoney_retries_are_exhausted(self):
        from adapter import app as adapter_app

        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = [
            {"day": "2026-09-07", "close": "0.996"},
            {"day": "2026-09-08", "close": "0.982"},
        ]
        with (
            patch("adapter.app._baostock_reachable", return_value=True),
            patch("adapter.holdings_runner._bs_hist", return_value=[]),
            patch(
                "akshare.fund_etf_hist_em",
                side_effect=ConnectionError("eastmoney unavailable"),
            ) as eastmoney,
            patch("requests.get", return_value=response) as sina,
        ):
            rows = adapter_app.load_portfolio_prices(
                "159022", "2026-08-09", "2026-09-09"
            )

        self.assertEqual(eastmoney.call_count, 2)
        self.assertEqual(sina.call_count, 1)
        self.assertEqual(rows, [
            {"date": "2026-09-07", "close": 0.996},
            {"date": "2026-09-08", "close": 0.982},
        ])

    def test_baostock_failure_stock_falls_back_to_forward_adjusted_stock_history(self):
        from adapter import app as adapter_app

        frame = pd.DataFrame({
            "日期": [date(2026, 9, 7), date(2026, 9, 8)],
            "收盘": [11.61, 11.73],
        })
        with (
            patch("adapter.app._baostock_reachable", return_value=True),
            patch(
                "adapter.holdings_runner._bs_hist",
                side_effect=ConnectionError("baostock unavailable"),
            ),
            patch("akshare.stock_zh_a_hist", return_value=frame) as fallback,
        ):
            rows = adapter_app.load_portfolio_prices(
                "000001", "2026-08-09", "2026-09-09"
            )

        fallback.assert_called_once_with(
            symbol="000001",
            period="daily",
            start_date="20260809",
            end_date="20260909",
            adjust="qfq",
        )
        self.assertEqual(rows, [
            {"date": "2026-09-07", "close": 11.61},
            {"date": "2026-09-08", "close": 11.73},
        ])

if __name__ == "__main__":
    unittest.main()
