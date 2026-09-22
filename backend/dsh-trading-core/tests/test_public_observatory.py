# -*- coding: utf-8 -*-
"""公开观察室账户快照与只读投影契约。"""

import tempfile
import json
import os
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.testclient import TestClient

from adapter.public_observatory import (
    AccountPositionSnapshot,
    AccountSnapshotInput,
    PublicSnapshotNotFound,
    list_account_snapshots,
    public_activities,
    public_activity_detail,
    public_calendar,
    public_equity,
    public_holdings,
    public_overview,
    register_public_observatory_routes,
    record_account_snapshot,
)
from adapter.portfolio_performance import record_holdings_snapshot
from adapter.store import JsonStore, JsonStoreReadLimitError, JsonStoreCorruptionError, JsonStoreTransferBusyError


SHANGHAI = ZoneInfo("Asia/Shanghai")


class PublicObservatorySnapshotTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS": "[]",
            "DSH_PUBLIC_OBSERVATORY_WRITE_TOKEN": "test-only-token",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonStore(Path(self.tmp.name))
        holdings = record_holdings_snapshot(
            self.store,
            [{"ticker": "600519", "quantity": 40, "cost_price": 1800}],
            "manual",
            datetime(2026, 9, 18, 14, 55, tzinfo=SHANGHAI),
        )
        self.holdings_snapshot_id = holdings["snapshot_id"]

    def approve(self, *snapshots):
        os.environ["DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS"] = json.dumps([
            item["snapshot_id"] for item in snapshots
        ])

    def input(self, **overrides):
        values = {
            "effective_at": datetime(2026, 9, 18, 15, 5, tzinfo=SHANGHAI),
            "source": "manual_calibration",
            "initial_capital": Decimal("100000.00"),
            "cash": Decimal("20000.00"),
            "market_value": Decimal("80000.00"),
            "total_equity": Decimal("100000.00"),
            "holdings_snapshot_id": self.holdings_snapshot_id,
            "positions": [
                AccountPositionSnapshot(
                    ticker="600519",
                    name="贵州茅台",
                    quantity=Decimal("40"),
                    cost_price=Decimal("1800.00"),
                    market_price=Decimal("2000.00"),
                    market_value=Decimal("80000.00"),
                    profit_loss=Decimal("8000.00"),
                    return_rate=Decimal("0.11111111"),
                )
            ],
            "price_as_of": datetime(2026, 9, 18, 15, 0, tzinfo=SHANGHAI),
            "stale_reason": None,
        }
        values.update(overrides)
        return AccountSnapshotInput(**values)

    def test_record_snapshot_is_atomic_and_projects_fixed_point_strings(self):
        saved = record_account_snapshot(self.store, self.input())

        self.assertEqual(saved["data_revision"], 1)
        self.assertEqual(saved["trade_date"], "2026-09-18")
        self.assertEqual(len(saved["snapshot_id"]), 32)
        self.assertEqual(len(list_account_snapshots(self.store)), 1)

        self.approve(saved)
        overview = public_overview(self.store, "2026-09-18")
        self.assertEqual(overview, {
            "availability": "available",
            "snapshot_id": saved["snapshot_id"],
            "data_revision": 1,
            "date": "2026-09-18",
            "currency": "CNY",
            "summary": {
                "initial_capital": "100000.00",
                "cash": "20000.00",
                "market_value": "80000.00",
                "total_equity": "100000.00",
                "cumulative_profit_loss": "0.00",
                "cumulative_return": "0.00000000",
            },
            "freshness": {
                "recorded_at": "2026-09-18T15:05:00+08:00",
                "price_as_of": "2026-09-18T15:00:00+08:00",
                "stale": False,
                "stale_reason": None,
            },
        })

    def test_invalid_equity_or_position_sum_does_not_write(self):
        with self.assertRaisesRegex(ValueError, "现金与持仓市值之和"):
            record_account_snapshot(
                self.store,
                self.input(total_equity=Decimal("99999.98")),
            )
        self.assertEqual(list_account_snapshots(self.store), [])

        with self.assertRaisesRegex(ValueError, "持仓明细市值之和"):
            record_account_snapshot(
                self.store,
                self.input(market_value=Decimal("79999.98"), total_equity=Decimal("99999.98")),
            )
        self.assertEqual(list_account_snapshots(self.store), [])

    def test_revision_increments_and_exact_date_never_falls_back(self):
        first = record_account_snapshot(self.store, self.input())
        second = record_account_snapshot(
            self.store,
            self.input(
                effective_at=datetime(2026, 9, 19, 15, 5, tzinfo=SHANGHAI),
                price_as_of=datetime(2026, 9, 19, 15, 0, tzinfo=SHANGHAI),
                cash=Decimal("21000.00"),
                market_value=Decimal("81000.00"),
                total_equity=Decimal("102000.00"),
                positions=[
                    AccountPositionSnapshot(
                        ticker="600519",
                        name="贵州茅台",
                        quantity=Decimal("40"),
                        cost_price=Decimal("1800.00"),
                        market_price=Decimal("2025.00"),
                        market_value=Decimal("81000.00"),
                        profit_loss=Decimal("9000.00"),
                        return_rate=Decimal("0.12500000"),
                    )
                ],
            ),
        )

        self.assertEqual(first["data_revision"], 1)
        self.assertEqual(second["data_revision"], 2)
        self.approve(first, second)
        with self.assertRaises(PublicSnapshotNotFound):
            public_overview(self.store, "2026-09-17")
        self.assertEqual(public_overview(self.store, "2026-09-18")["snapshot_id"], first["snapshot_id"])

    def test_initial_capital_is_fixed_across_the_account_series(self):
        record_account_snapshot(self.store, self.input())

        with self.assertRaisesRegex(ValueError, "初始资金必须与既有账户快照保持一致"):
            record_account_snapshot(
                self.store,
                self.input(
                    effective_at=datetime(2026, 9, 19, 15, 5, tzinfo=SHANGHAI),
                    price_as_of=datetime(2026, 9, 19, 15, 0, tzinfo=SHANGHAI),
                    initial_capital=Decimal("120000.00"),
                ),
            )

        self.assertEqual(len(list_account_snapshots(self.store)), 1)

    def test_public_holdings_uses_an_explicit_field_allowlist(self):
        saved = record_account_snapshot(self.store, self.input())
        self.approve(saved)
        projection = public_holdings(self.store, saved["snapshot_id"])

        self.assertEqual(set(projection), {"snapshot_id", "data_revision", "date", "currency", "items"})
        self.assertEqual(set(projection["items"][0]), {
            "ticker",
            "name",
            "quantity",
            "cost_price",
            "market_price",
            "market_value",
            "profit_loss",
            "return_rate",
        })
        self.assertEqual(projection["items"][0]["quantity"], "40")
        self.assertNotIn("source", projection["items"][0])
        self.assertNotIn("holdings_snapshot_id", projection)

    def test_calendar_and_equity_are_derived_only_from_account_snapshots(self):
        first = record_account_snapshot(self.store, self.input())
        second = record_account_snapshot(
            self.store,
            self.input(
                effective_at=datetime(2026, 9, 19, 15, 5, tzinfo=SHANGHAI),
                price_as_of=datetime(2026, 9, 19, 15, 0, tzinfo=SHANGHAI),
                cash=Decimal("21000.00"),
                market_value=Decimal("81000.00"),
                total_equity=Decimal("102000.00"),
                positions=[
                    AccountPositionSnapshot(
                        ticker="600519",
                        name="贵州茅台",
                        quantity=Decimal("40"),
                        cost_price=Decimal("1800.00"),
                        market_price=Decimal("2025.00"),
                        market_value=Decimal("81000.00"),
                        profit_loss=Decimal("9000.00"),
                        return_rate=Decimal("0.12500000"),
                    )
                ],
            ),
        )

        self.approve(first, second)
        calendar = public_calendar(self.store, "2026-09")
        equity = public_equity(self.store, "2026-09-18", "2026-09-19")

        self.assertEqual(calendar["month"], "2026-09")
        self.assertEqual(calendar["items"][0]["daily_profit_loss"], None)
        self.assertEqual(calendar["items"][1]["daily_profit_loss"], "2000.00")
        self.assertEqual(calendar["items"][1]["daily_return"], "0.02000000")
        self.assertEqual([point["snapshot_id"] for point in equity["points"]], [
            first["snapshot_id"], second["snapshot_id"],
        ])
        self.assertEqual(equity["points"][1]["cumulative_profit_loss"], "2000.00")
        self.assertEqual(equity["latest_revision"], 2)

    def test_activities_use_public_ids_cursors_and_approved_fields_only(self):
        saved = record_account_snapshot(self.store, self.input())
        previous = record_account_snapshot(self.store, self.input(
            effective_at=datetime(2026, 9, 17, 15, 5, tzinfo=SHANGHAI),
        ))
        self.approve(saved, previous)
        self.store.set("holdings", "manual_trades", [{
            "request_id": "private-request-id",
            "ticker": "600519",
            "side": "buy",
            "quantity": 40,
            "price": 1800,
            "fees": 5,
            "traded_at": "2026-09-18T10:00:00+08:00",
            "source": "manual",
            "request": {"secret": "never-public"},
        }])

        page = public_activities(self.store, "2026-09-18", limit=1)
        self.assertEqual(len(page["items"]), 1)
        self.assertIsNotNone(page["next_cursor"])
        self.assertEqual(set(page["items"][0]), {
            "public_id", "category", "status", "occurred_at", "title", "summary",
        })
        second_page = public_activities(
            self.store, "2026-09-18", cursor=page["next_cursor"], limit=10,
        )
        self.assertEqual(len(second_page["items"]), 1)
        self.assertNotEqual(page["items"][0]["public_id"], second_page["items"][0]["public_id"])

        snapshot_activity = next(
            item for item in [*page["items"], *second_page["items"]]
            if item["category"] == "system"
        )
        detail = public_activity_detail(self.store, snapshot_activity["public_id"])
        self.assertEqual(detail["related_snapshot_id"], saved["snapshot_id"])
        self.assertNotIn("holdings_snapshot_id", detail)
        self.assertNotIn("request_id", detail)
        self.assertEqual({item["category"] for item in [*page["items"], *second_page["items"]]}, {"system"})

    def test_publication_is_opt_in_on_every_projection_and_revocation_blocks_known_ids(self):
        saved = record_account_snapshot(self.store, self.input())
        private = record_account_snapshot(self.store, self.input(
            effective_at=datetime(2026, 9, 17, 15, 5, tzinfo=SHANGHAI),
        ))
        self.store.set("holdings", "manual_trades", [{
            "request_id": "private", "ticker": "600519", "side": "buy",
            "traded_at": "2026-09-18T10:00:00+08:00",
        }])
        self.assertEqual(public_overview(self.store, "2026-09-18")["availability"], "unavailable")
        self.assertEqual(public_activities(self.store, "2026-09-18")["items"], [])
        self.approve(saved)
        self.assertEqual(public_overview(self.store, "2026-09-18")["snapshot_id"], saved["snapshot_id"])
        with self.assertRaises(PublicSnapshotNotFound):
            public_overview(self.store, "2026-09-17")
        with self.assertRaises(PublicSnapshotNotFound):
            public_holdings(self.store, private["snapshot_id"])
        calendar = public_calendar(self.store, "2026-09")["items"]
        self.assertEqual(len(calendar), 1)
        self.assertIsNone(calendar[0]["daily_profit_loss"])
        self.assertEqual(len(public_equity(self.store, "2026-09-01", "2026-09-30")["points"]), 1)
        activity = public_activities(self.store, "2026-09-18")["items"]
        self.assertEqual(len(activity), 1)
        self.approve()
        with self.assertRaises(PublicSnapshotNotFound):
            public_activity_detail(self.store, activity[0]["public_id"])
        with self.assertRaises(PublicSnapshotNotFound):
            public_holdings(self.store, saved["snapshot_id"])

    def test_imported_policy_or_tampered_content_cannot_authorize_publication(self):
        saved = record_account_snapshot(self.store, self.input())
        self.store.set("holdings", "public_observatory", {"enabled": True, "approved_ids": [saved["snapshot_id"]]})
        self.assertEqual(public_overview(self.store, "2026-09-18")["availability"], "unavailable")
        self.approve(saved)
        saved["positions"][0]["name"] = "IMPORTED-PRIVATE-DATA"
        self.store.set("holdings", "account_snapshots", [saved])
        self.assertEqual(public_overview(self.store, "2026-09-18")["availability"], "unavailable")

    def test_publication_uses_canonical_dates_and_rejects_invalid_revisions(self):
        saved = record_account_snapshot(self.store, self.input())
        self.approve(saved)
        saved["trade_date"] = "2099-01-01"
        self.store.set("holdings", "account_snapshots", [
            {"snapshot_id": "not-approved", "data_revision": "broken"}, saved,
        ])
        self.assertEqual(public_overview(self.store, "2026-09-18")["date"], "2026-09-18")
        for revision in (True, "secret", -1, 2 ** 53):
            saved["data_revision"] = revision
            self.store.set("holdings", "account_snapshots", [saved])
            self.assertEqual(public_overview(self.store, "2026-09-18")["availability"], "unavailable")

    def test_daily_views_choose_the_latest_approved_snapshot_per_day(self):
        first = record_account_snapshot(self.store, self.input())
        last = record_account_snapshot(self.store, self.input(effective_at=datetime(2026, 9, 18, 16, 0, tzinfo=SHANGHAI)))
        self.approve(first, last)
        self.assertEqual(len(public_calendar(self.store, "2026-09")["items"]), 1)
        points = public_equity(self.store, "2026-09-18", "2026-09-18")["points"]
        self.assertEqual([point["snapshot_id"] for point in points], [last["snapshot_id"]])

    def test_large_valid_account_values_have_exact_bounded_return_formatting(self):
        holdings = record_holdings_snapshot(self.store, [], "manual", datetime(2026, 9, 18, 15, 0, tzinfo=SHANGHAI))
        saved = record_account_snapshot(self.store, self.input(
            holdings_snapshot_id=holdings["snapshot_id"], positions=[], market_value=Decimal(0),
            initial_capital=Decimal("0.01"), cash=Decimal("9999999999999999999999.99"),
            total_equity=Decimal("9999999999999999999999.99"),
        ))
        self.approve(saved)
        result = public_overview(self.store, "2026-09-18")
        self.assertEqual(result["summary"]["cumulative_return"], "999999999999999999999998.00000000")
        self.assertEqual(public_equity(self.store, "2026-09-18", "2026-09-18")["points"][0]["cumulative_return"], result["summary"]["cumulative_return"])

    def test_readonly_store_does_not_create_directories_and_bounds_disk_reads(self):
        empty = Path(self.tmp.name) / "must-not-be-created"
        store = JsonStore(empty, create=False)
        self.assertEqual(store.read_bounded_snapshot("holdings", max_bytes=100), {})
        self.assertFalse(empty.exists())
        with self.assertRaises(JsonStoreReadLimitError):
            self.store.read_bounded_snapshot("holdings", max_bytes=1)
        self.assertEqual(self.store.read_bounded_snapshot("holdings", max_bytes=8192), self.store.all("holdings"))
        self.store.reserve_transfer("test-import")
        with self.assertRaises(JsonStoreTransferBusyError):
            self.store.read_bounded_snapshot("holdings", max_bytes=8192)
        self.store.release_transfer("test-import")
        # 损坏内容只在本测试独立目录中构造。
        (Path(self.tmp.name) / "holdings.json").write_text("not-json", encoding="utf-8")
        with self.assertRaises(JsonStoreCorruptionError):
            self.store.read_bounded_snapshot("holdings", max_bytes=8192)

    def test_public_http_denies_duplicate_parameters_and_sanitizes_store_errors(self):
        saved = record_account_snapshot(self.store, self.input())
        self.approve(saved)
        app = FastAPI()
        register_public_observatory_routes(app, store_factory=lambda: self.store)
        client = TestClient(app)
        self.assertEqual(client.get("/public/performance/v1/overview?date=2026-09-18&date=2026-09-17").status_code, 422)
        with patch.object(self.store, "read_bounded_snapshot", side_effect=RuntimeError("SECRET /private/path")):
            response = client.get("/public/performance/v1/overview?date=2026-09-18")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("SECRET", response.text)

    def test_invalid_publication_configuration_fails_closed(self):
        saved = record_account_snapshot(self.store, self.input())
        for value in ("*", "not json", json.dumps([saved["snapshot_id"], "*"]), json.dumps([saved["snapshot_id"]] * 367)):
            os.environ["DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS"] = value
            self.assertEqual(public_overview(self.store, "2026-09-18")["availability"], "unavailable")

    def test_public_staleness_never_contains_internal_error_text(self):
        saved = record_account_snapshot(self.store, self.input(stale_reason="secret=DO_NOT_PUBLISH /private/error"))
        self.approve(saved)
        result = public_overview(self.store, "2026-09-18")
        self.assertTrue(result["freshness"]["stale"])
        self.assertEqual(result["freshness"]["stale_reason"], "行情数据可能已过期，请以记录时间为准。")
        self.assertNotIn("DO_NOT_PUBLISH", json.dumps(result))

    def test_equity_range_and_snapshot_positions_are_bounded(self):
        with self.assertRaises(ValueError):
            public_equity(self.store, "2020-01-01", "2026-09-20")
        with self.assertRaises(ValueError):
            self.input(positions=[self.input().positions[0]] * 1001)

    def test_calendar_status_is_independent_of_snapshots_and_handles_holidays(self):
        before = self.store.all("holdings")
        with patch("adapter.brief_engine.cached_trade_dates", return_value=(
            "2026-09-24", "2026-09-28",
        )), patch("adapter.brief_engine._sina_trade_dates") as fetch_dates:
            result = public_calendar(self.store, "2026-09")
        days = {item["date"]: item["trading_status"] for item in result["days"]}
        self.assertEqual(len(days), 30)
        self.assertEqual(days["2026-09-24"], "trading")
        self.assertEqual(days["2026-09-25"], "closed")
        self.assertEqual(days["2026-09-26"], "closed")
        self.assertEqual(days["2026-09-28"], "trading")
        self.assertEqual(days["2026-09-29"], "unknown")
        self.assertEqual(result["items"], [])
        self.assertEqual(self.store.all("holdings"), before)
        fetch_dates.assert_not_called()

    def test_calendar_without_source_never_invents_weekday_trading_status(self):
        with patch("adapter.brief_engine.cached_trade_dates", return_value=()):
            result = public_calendar(self.store, "2026-09")
        days = {item["date"]: item["trading_status"] for item in result["days"]}
        self.assertEqual(days["2026-09-18"], "unknown")
        self.assertEqual(days["2026-09-19"], "closed")
        self.assertEqual(days["2026-09-20"], "closed")

    def test_unconfigured_read_is_explicit_and_has_no_write_side_effect(self):
        before = self.store.all("holdings")
        result = public_overview(self.store, "2026-09-18")
        after = self.store.all("holdings")

        self.assertEqual(result, {
            "availability": "unavailable",
            "reason_code": "account-snapshot-unconfigured",
            "message": "尚未配置可公开的权威账户权益快照。",
        })
        self.assertEqual(after, before)

    def test_snapshot_must_reference_matching_holdings_state(self):
        with self.assertRaisesRegex(ValueError, "持仓快照不存在"):
            record_account_snapshot(
                self.store,
                self.input(holdings_snapshot_id="f" * 32),
            )
        with self.assertRaisesRegex(ValueError, "账户持仓与持仓快照不一致"):
            record_account_snapshot(
                self.store,
                self.input(
                    positions=[
                        AccountPositionSnapshot(
                            ticker="600519",
                            name="贵州茅台",
                            quantity=Decimal("50"),
                            cost_price=Decimal("1800.00"),
                            market_price=Decimal("1600.00"),
                            market_value=Decimal("80000.00"),
                            profit_loss=Decimal("-10000.00"),
                            return_rate=Decimal("-0.11111111"),
                        )
                    ],
                ),
            )

    def test_internal_http_routes_keep_writes_separate_from_public_reads(self):
        app = FastAPI()
        register_public_observatory_routes(app, store_factory=lambda: self.store)
        client = TestClient(app)
        payload = self.input().model_dump(mode="json")

        saved = client.post("/portfolio/account-snapshots", json=payload, headers={
            "X-Public-Observatory-Token": "test-only-token",
        })
        self.assertEqual(saved.status_code, 200)
        self.approve(saved.json())
        snapshot_id = saved.json()["snapshot_id"]

        overview = client.get("/public/performance/v1/overview", params={"date": "2026-09-18"})
        holdings = client.get("/public/performance/v1/holdings", params={"snapshot_id": snapshot_id})
        calendar = client.get("/public/performance/v1/calendar", params={"month": "2026-09"})
        equity = client.get("/public/performance/v1/equity", params={
            "from": "2026-09-18", "to": "2026-09-18",
        })
        activities = client.get("/public/performance/v1/activities", params={
            "as_of": "2026-09-18", "limit": 20,
        })
        missing = client.get("/public/performance/v1/overview", params={"date": "2026-09-17"})
        wrong_method = client.post("/public/performance/v1/overview", json={})

        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.json()["data_revision"], 1)
        self.assertEqual(holdings.status_code, 200)
        self.assertEqual(holdings.json()["items"][0]["ticker"], "600519")
        self.assertEqual(calendar.status_code, 200)
        self.assertEqual(equity.status_code, 200)
        self.assertEqual(activities.status_code, 200)
        public_id = activities.json()["items"][0]["public_id"]
        detail = client.get(f"/public/performance/v1/activities/{public_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json(), {
            "detail": {
                "code": "snapshot-not-found",
                "message": "指定日期没有账户权益快照。",
            }
        })
        self.assertEqual(wrong_method.status_code, 405)

    def test_snapshot_write_requires_a_dedicated_token_before_reading_body_or_store(self):
        app = FastAPI()
        register_public_observatory_routes(app, store_factory=lambda: self.fail("unauthorized store access"))
        client = TestClient(app)
        for token in (None, "wrong", ""):
            headers = {} if token is None else {"X-Public-Observatory-Token": token}
            response = client.post("/portfolio/account-snapshots", content="not even json", headers=headers)
            self.assertEqual(response.status_code, 403)
        os.environ.pop("DSH_PUBLIC_OBSERVATORY_WRITE_TOKEN")
        self.assertEqual(client.post("/portfolio/account-snapshots", json=self.input().model_dump(mode="json")).status_code, 403)

    def test_authenticated_write_body_is_size_limited(self):
        app = FastAPI()
        register_public_observatory_routes(app, store_factory=lambda: self.fail("oversize store access"))
        response = TestClient(app).post("/portfolio/account-snapshots", content=" " * (1024 * 1024), headers={
            "X-Public-Observatory-Token": "test-only-token",
        })
        self.assertEqual(response.status_code, 413)


if __name__ == "__main__":
    unittest.main()
