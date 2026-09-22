"""持仓操作公开许可、固定字段与失败关闭。"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from adapter.public_observatory import public_activities, public_activity_detail, register_public_observatory_routes
from adapter.store import JsonStore
from adapter import holdings_operation_index as index


class PublicHoldingsOperationsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonStore(Path(self.tmp.name))
        self.directory = self.store.base_dir / "_holdings_operation_history"
        self.directory.mkdir()
        self.identity = "11111111-1111-4111-8111-111111111111"
        self.environment = patch.dict(os.environ, {
            "DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS": "[]",
            "DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE": "2026-09-21T00:00:00+08:00",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def archive(self, **overrides):
        record = {
            "schemaVersion": 1, "transactionId": self.identity, "kind": "import",
            "terminalState": "committed", "confirmation": "host_committed",
            "startedAt": "2026-09-21T09:00:00+08:00",
            "committedAt": "2026-09-21T09:01:00+08:00", "rolledBackAt": None,
            "observedAt": "2026-09-21T09:02:00+08:00",
            "before": {"holdings": {"default": [{"ticker": "600519", "quantity": 100, "cost_price": 10, "note": "SECRET-NOTE"}]}, "trades": {"account_id": "SECRET-ACCOUNT"}},
            "after": {"holdings": {"default": [{"ticker": "600519", "quantity": 150, "cost_price": 11}]}, "trades": {}},
            **overrides,
        }
        (self.directory / f"{self.identity}.json").write_text(json.dumps(record))
        # 夹具直接改归档，必须显式走私有重建；GET 不再扫描或修复归档。
        index.rebuild(self.store)
        return record

    def test_independent_operations_approval_exposes_only_safe_adjustment_details(self):
        self.archive()
        page = public_activities(self.store, "2026-09-21")
        self.assertEqual(len(page["items"]), 1)
        row = page["items"][0]
        self.assertEqual(set(row), {"public_id", "category", "status", "occurred_at", "title", "summary"})
        self.assertEqual(row["category"], "operation")
        self.assertEqual(row["occurred_at"], "2026-09-21T09:02:00+08:00")
        self.assertIn("不代表买卖成交", row["summary"])
        detail = public_activity_detail(self.store, row["public_id"])
        self.assertEqual(detail["holdings_changes"], [{"ticker": "600519", "before_quantity": "100", "after_quantity": "150", "before_cost_price": "10", "after_cost_price": "11"}])
        self.assertIsNone(detail["related_snapshot_id"])
        for secret in ("SECRET", self.identity, "transactionId", "before\"", "account_id"):
            self.assertNotIn(secret, json.dumps(detail))

    def test_default_off_and_revocation_apply_to_list_and_detail(self):
        self.archive()
        identity = public_activities(self.store, "2026-09-21")["items"][0]["public_id"]
        os.environ.pop("DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE")
        self.assertEqual(public_activities(self.store, "2026-09-21")["items"], [])
        with self.assertRaises(LookupError):
            public_activity_detail(self.store, identity)

    def test_only_new_started_operations_and_proven_host_commits_are_published(self):
        for override in ({"confirmation": "backend_only"}, {"startedAt": None}, {"startedAt": "2026-09-20T23:59:59+08:00"}):
            with self.subTest(override=override):
                self.archive(**override)
                self.assertEqual(public_activities(self.store, "2026-09-21")["items"], [])

    def test_reset_and_rollback_do_not_claim_sale_or_fund_outflow(self):
        record = self.archive(kind="reset", after={"holdings": {}, "trades": {}})
        item = public_activities(self.store, "2026-09-21")["items"][0]
        self.assertIn("重置", item["title"])
        self.assertEqual(public_activity_detail(self.store, item["public_id"])["holdings_changes"][0]["after_quantity"], "0")
        self.archive(kind="reset", terminalState="rolled_back", confirmation="rolled_back", after=record["before"], rolledBackAt="2026-09-21T09:01:30+08:00")
        item = public_activities(self.store, "2026-09-21", status="failed")["items"][0]
        self.assertIn("已回滚", item["title"])
        self.assertEqual(public_activity_detail(self.store, item["public_id"])["holdings_changes"], [])

    def test_utc_archive_time_is_normalized_before_cutoff_and_ordering(self):
        self.archive(observedAt="2026-09-21T16:02:00Z")
        self.assertEqual(public_activities(self.store, "2026-09-21")["items"], [])
        self.assertEqual(public_activities(self.store, "2026-09-22")["items"][0]["occurred_at"], "2026-09-22T00:02:00+08:00")

    def test_bad_archive_is_redacted_and_get_never_rewrites_files(self):
        app = FastAPI()
        register_public_observatory_routes(app, store_factory=lambda: self.store)
        with TestClient(app) as client:
            for override in ({"transactionId": "SECRET-PATH"}, {"observedAt": "invalid SECRET"}, {"after": {"holdings": {"default": [{"ticker": "600519", "quantity": "NaN", "cost_price": 10}]}}}):
                self.archive(**override)
                before = {path.name: path.read_bytes() for path in self.directory.iterdir()}
                response = client.get("/public/performance/v1/activities?as_of=2026-09-21")
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("SECRET", response.text)
                self.assertEqual(before, {path.name: path.read_bytes() for path in self.directory.iterdir()})

    def test_invalid_numbers_duplicate_tickers_and_unknown_holdings_never_become_zero(self):
        for value in (True, -1, 0, "Infinity", "1e99999", "1e-99999"):
            self.archive(after={"holdings": {"default": [{"ticker": "600519", "quantity": value, "cost_price": 10}]}})
            with self.assertRaises(RuntimeError):
                public_activities(self.store, "2026-09-21")
        row = {"ticker": "600519", "quantity": 100, "cost_price": 10}
        self.archive(after={"holdings": {"default": [row, row]}})
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        self.archive(after={"holdings": {}})
        identity = public_activities(self.store, "2026-09-21")["items"][0]["public_id"]
        self.assertIsNone(public_activity_detail(self.store, identity)["holdings_changes"])

    def test_invalid_policy_busy_transfer_symlink_and_limits_fail_closed(self):
        self.archive()
        for policy in ("bad", "2026-09-21T00:00:00"):
            with patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE": policy}):
                with self.assertRaises(RuntimeError):
                    public_activities(self.store, "2026-09-21")
        with patch.object(index, "MAX_SOURCE_BYTES", 8):
            with self.assertRaises(RuntimeError):
                index.rebuild(self.store)
        self.store.reserve_transfer(self.identity)
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        self.store.release_transfer(self.identity)
        original = self.directory / f"{self.identity}.json"
        linked = self.directory / "22222222-2222-4222-8222-222222222222.json"
        linked.symlink_to(original)
        with self.assertRaises(RuntimeError):
            index.rebuild(self.store)

    def test_normal_changes_are_published_without_private_trade_payloads(self):
        with patch("adapter.holdings_mutation_history._now", return_value="2026-09-20T10:00:00+08:00"):
            self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 1, "cost_price": 10}])
        with patch("adapter.holdings_mutation_history._now", return_value="2026-09-21T10:00:00+08:00"):
            self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 3, "cost_price": 10.333333333333334}])
            self.store.set("trades", "entries", [{"ticker": "600519", "secret": "SECRET-PATH", "account_id": "SECRET-ID"}] * 2)
        page = public_activities(self.store, "2026-09-21")
        self.assertEqual(len(page["items"]), 2)
        rows = [public_activity_detail(self.store, row["public_id"]) for row in page["items"]]
        self.assertNotIn("SECRET", json.dumps(rows))
        adjustment = next(row for row in rows if "持仓数据更新" in row["title"])
        self.assertEqual(adjustment["holdings_changes"][0]["after_quantity"], "3")
        self.assertEqual(adjustment["holdings_changes"][0]["after_cost_price"], "10.333333333333334")
        trades = next(row for row in rows if "成交记录更新" in row["title"])
        self.assertIn("新增 2 条", trades["summary"])
        self.assertIn("不表示此刻执行", trades["summary"])
        self.assertNotIn("holdings_changes", trades)

    def test_pending_journal_blocks_publication_without_recovering_or_writing(self):
        from adapter import holdings_mutation_history as audit
        with patch.object(audit, "complete", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                self.store.set("holdings", "default", [])
        before = {str(path): path.read_bytes() for path in self.store.base_dir.rglob("*") if path.is_file()}
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.store.base_dir.rglob("*") if path.is_file()})

    def test_normal_write_order_retains_subsecond_record_times(self):
        with patch("adapter.holdings_mutation_history._now", return_value="2026-09-21T09:00:00.100000+08:00"):
            self.store.set("holdings", "default", [])
        with patch("adapter.holdings_mutation_history._now", return_value="2026-09-21T09:00:00.200000+08:00"):
            self.store.set("trades", "entries", [])
        times = [row["occurred_at"] for row in public_activities(self.store, "2026-09-21")["items"]]
        self.assertEqual(times, ["2026-09-21T09:00:00.200000+08:00", "2026-09-21T09:00:00.100000+08:00"])


if __name__ == "__main__":
    unittest.main()
