# -*- coding: utf-8 -*-
"""盯盘数据导出、增量合并与重置契约。"""

import tempfile
import unittest
from pathlib import Path

from market_watch.data_transfer import (
    TransferRevisionConflict,
    commit_import,
    export_snapshot,
    finalize_import,
    prepare_import,
    prepare_reset,
    preview_import,
    register_data_transfer_routes,
    rollback_import,
)
from market_watch.store import JsonStore, JsonStoreTransferBusyError


class DataTransferTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_export_includes_watchlist_and_alerts_but_excludes_runtime_caches(self):
        self.store.set("watchlist", "default", [{"code": "600519", "name": "贵州茅台"}])
        self.store.set("alerts", "default", [{"id": "a1", "name": "价格预警", "ticker": "600519"}])
        self.store.set("events", "latest", [{"item_id": "cache-only"}])
        self.store.set("news", "latest", "cache-only")
        self.store.set("state", "triggers", ["cache-only"])

        snapshot = export_snapshot(self.store, ["watchlist"])

        self.assertEqual(snapshot["schemaVersion"], 1)
        self.assertEqual(snapshot["backend"], "market-watch")
        self.assertEqual(
            snapshot["categories"]["watchlist"]["collections"],
            {
                "watchlist": {"default": [{"code": "600519", "name": "贵州茅台"}]},
                "alerts": {"default": [{"id": "a1", "name": "价格预警", "ticker": "600519"}]},
            },
        )
        self.assertNotIn("cache-only", str(snapshot))

    def test_preview_and_default_import_merge_codes_and_deduplicate_same_alert(self):
        local_watch = {"code": "600519", "name": "贵州茅台", "added_at": "local"}
        local_alert = {
            "id": "local-id",
            "name": "跌幅预警",
            "ticker": "600519",
            "time_frame": "trading",
            "combine": "or",
            "conditions": [{"field": "pct_change", "operator": "<=", "value": -5}],
        }
        self.store.set("watchlist", "default", [local_watch])
        self.store.set("alerts", "default", [local_alert])
        snapshot = {
            "schemaVersion": 1,
            "backend": "market-watch",
            "categories": {"watchlist": {"collections": {
                "watchlist": {"default": [
                    {"code": "600519", "name": "茅台", "added_at": "imported"},
                    {"code": "000001", "name": "平安银行", "added_at": "imported"},
                ]},
                "alerts": {"default": [
                    {**local_alert, "id": "another-id", "created_at": "imported"},
                    {"id": "a2", "name": "价格预警", "ticker": "000001", "conditions": [
                        {"field": "price", "operator": ">=", "value": 20}
                    ]},
                ]},
            }}},
        }

        preview = preview_import(self.store, snapshot)
        prepare_import(self.store, "11111111-1111-4111-8111-111111111111", snapshot, preview["currentRevision"])
        result = commit_import(self.store, "11111111-1111-4111-8111-111111111111")
        finalize_import(self.store, "11111111-1111-4111-8111-111111111111")

        self.assertEqual(preview["categories"]["watchlist"]["added"], 2)
        self.assertEqual(preview["categories"]["watchlist"]["conflicts"], 0)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.store.get("watchlist", "default"), [
            local_watch,
            {"code": "000001", "name": "平安银行", "added_at": "imported"},
        ])
        alerts = self.store.get("alerts", "default")
        self.assertEqual(len(alerts), 2)
        self.assertEqual(alerts[0], local_alert)
        self.assertEqual(alerts[1]["id"], "a2")

    def test_apply_rejects_stale_preview_and_reset_clears_only_portable_state(self):
        snapshot = export_snapshot(self.store, ["watchlist"])
        preview = preview_import(self.store, snapshot)
        self.store.set("watchlist", "default", [{"code": "600519"}])

        with self.assertRaises(TransferRevisionConflict):
            prepare_import(
                self.store,
                "22222222-2222-4222-8222-222222222222",
                snapshot,
                preview["currentRevision"],
            )

        current = preview_import(self.store, snapshot)["currentRevision"]
        self.store.set("events", "latest", [{"item_id": "cache-remains"}])
        prepare_reset(
            self.store,
            "33333333-3333-4333-8333-333333333333",
            ["watchlist"],
            current,
        )
        commit_import(self.store, "33333333-3333-4333-8333-333333333333")
        finalize_import(self.store, "33333333-3333-4333-8333-333333333333")
        self.assertEqual(self.store.all("watchlist"), {})
        self.assertEqual(self.store.all("alerts"), {})
        self.assertEqual(self.store.get("events", "latest"), [{"item_id": "cache-remains"}])

    def test_persistent_transaction_blocks_other_writes_and_rolls_back(self):
        self.store.set("watchlist", "default", [{"code": "600519"}])
        snapshot = {
            "schemaVersion": 1,
            "backend": "market-watch",
            "categories": {"watchlist": {"collections": {
                "watchlist": {"default": [{"code": "000001"}]},
                "alerts": {},
            }}},
        }
        preview = preview_import(self.store, snapshot)
        transaction_id = "44444444-4444-4444-8444-444444444444"

        prepare_import(self.store, transaction_id, snapshot, preview["currentRevision"])
        with self.assertRaises(JsonStoreTransferBusyError):
            JsonStore(Path(self.temporary.name)).set("watchlist", "other", [])
        commit_import(self.store, transaction_id)
        rollback_import(self.store, transaction_id)

        self.assertEqual(self.store.get("watchlist", "default"), [{"code": "600519"}])
        finalize_import(self.store, transaction_id)

    def test_http_routes_require_host_token_and_expose_transaction_contract(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        register_data_transfer_routes(app, lambda: self.store, token="transfer-secret")
        client = TestClient(app)

        unauthorized = client.get(
            "/data-transfer/export",
            params={"categories": "watchlist"},
            headers={"Origin": "https://malicious.example"},
        )
        self.assertEqual(unauthorized.status_code, 401)
        headers = {"Authorization": "Bearer transfer-secret"}
        exported = client.get("/data-transfer/export", params={"categories": "watchlist"}, headers=headers)
        self.assertEqual(exported.status_code, 200)
        snapshot = exported.json()
        preview = client.post("/data-transfer/preview", json={"snapshot": snapshot}, headers=headers)
        self.assertEqual(preview.status_code, 200)
        prepared = client.post("/data-transfer/prepare", json={
            "transaction_id": "55555555-5555-4555-8555-555555555555",
            "snapshot": snapshot,
            "expected_revision": preview.json()["currentRevision"],
        }, headers=headers)
        self.assertEqual(prepared.status_code, 200)
        applied = client.post("/data-transfer/commit", json={
            "transaction_id": "55555555-5555-4555-8555-555555555555",
        }, headers=headers)
        self.assertEqual(applied.status_code, 200)
        self.assertEqual(applied.json()["status"], "applied")
        finalized = client.post("/data-transfer/finalize", json={
            "transaction_id": "55555555-5555-4555-8555-555555555555",
        }, headers=headers)
        self.assertEqual(finalized.status_code, 200)


if __name__ == "__main__":
    unittest.main()
