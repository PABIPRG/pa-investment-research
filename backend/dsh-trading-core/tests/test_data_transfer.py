# -*- coding: utf-8 -*-
"""投研数据导出、预览、增量合并与重置契约。"""

import tempfile
import unittest
import json
from pathlib import Path

from adapter.data_transfer import (
    TransferRevisionConflict,
    commit_import,
    export_snapshot,
    finalize_import,
    prepare_import,
    prepare_reset,
    preview_import,
    recover_incomplete_transactions,
    register_data_transfer_routes,
    rollback_import,
)
from adapter.store import JsonStore, JsonStoreTransferBusyError


class DataTransferTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_export_contains_only_selected_portable_collections(self):
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100}])
        self.store.set("preferences", "risk_profile", "balanced")
        self.store.set("evolution_previews", "current", {"secret": "transient"})

        snapshot = export_snapshot(self.store, ["holdings"])

        self.assertEqual(snapshot["schemaVersion"], 1)
        self.assertEqual(snapshot["backend"], "trading-core")
        self.assertEqual(set(snapshot["categories"]), {"holdings"})
        self.assertEqual(
            snapshot["categories"]["holdings"]["collections"],
            {"holdings": {"default": [{"ticker": "600519", "quantity": 100}]}},
        )
        self.assertNotIn("preferences", str(snapshot))
        self.assertNotIn("evolution_previews", str(snapshot))

    def test_preview_counts_new_and_conflicting_holdings_without_writing(self):
        local = {"ticker": "600519", "quantity": 100, "cost_price": 1500}
        incoming = {"ticker": "600519", "quantity": 120, "cost_price": 1490}
        self.store.set("holdings", "default", [local])
        snapshot = {
            "schemaVersion": 1,
            "backend": "trading-core",
            "categories": {
                "holdings": {
                    "collections": {"holdings": {"default": [
                        incoming,
                        {"ticker": "000001", "quantity": 50, "cost_price": 10},
                    ]}},
                },
            },
        }

        preview = preview_import(self.store, snapshot)

        self.assertEqual(preview["categories"]["holdings"]["added"], 1)
        self.assertEqual(preview["categories"]["holdings"]["conflicts"], 1)
        self.assertEqual(preview["categories"]["holdings"]["defaultRule"], "keep_local")
        self.assertEqual(self.store.get("holdings", "default"), [local])

    def test_default_import_keeps_local_holding_quantities_and_merges_watchlist(self):
        local = {"ticker": "600519", "quantity": 100, "cost_price": 1500}
        self.store.set("holdings", "default", [local])
        self.store.set("watchlist", "default", ["600519"])
        snapshot = {
            "schemaVersion": 1,
            "backend": "trading-core",
            "categories": {
                "holdings": {"collections": {"holdings": {"default": [
                    {"ticker": "600519", "quantity": 120, "cost_price": 1490},
                    {"ticker": "000001", "quantity": 50, "cost_price": 10},
                ]}}},
                "watchlist": {"collections": {"watchlist": {"default": ["600519", "000001"]}}},
            },
        }
        preview = preview_import(self.store, snapshot)

        prepare_import(self.store, "11111111-1111-4111-8111-111111111111", snapshot, preview["currentRevision"])
        result = commit_import(self.store, "11111111-1111-4111-8111-111111111111")
        finalize_import(self.store, "11111111-1111-4111-8111-111111111111")

        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.store.get("holdings", "default"), [
            local,
            {"ticker": "000001", "quantity": 50, "cost_price": 10},
        ])
        self.assertEqual(self.store.get("watchlist", "default"), ["600519", "000001"])

    def test_strategy_keep_both_remaps_strategy_and_shadow_references(self):
        self.store.set("strategies", "alpha", {"id": "alpha", "name": "本地策略"})
        snapshot = {
            "schemaVersion": 1,
            "backend": "trading-core",
            "categories": {
                "strategies": {"collections": {
                    "strategies": {"alpha": {"id": "alpha", "name": "导入策略"}},
                    "shadows": {"pos:alpha:600519": {"strategy_id": "alpha", "quantity": 10}},
                }},
            },
        }
        preview = preview_import(self.store, snapshot)

        prepare_import(self.store, "22222222-2222-4222-8222-222222222222", snapshot, preview["currentRevision"])
        apply_result = commit_import(self.store, "22222222-2222-4222-8222-222222222222")
        finalize_import(self.store, "22222222-2222-4222-8222-222222222222")

        self.assertEqual(apply_result["status"], "applied")

        self.assertEqual(self.store.get("strategies", "alpha")["name"], "本地策略")
        self.assertEqual(self.store.get("strategies", "alpha-imported"), {
            "id": "alpha-imported",
            "name": "导入策略",
        })
        self.assertEqual(
            self.store.get("shadows", "pos:alpha-imported:600519")["strategy_id"],
            "alpha-imported",
        )

    def test_apply_rejects_a_preview_after_current_data_changes(self):
        snapshot = export_snapshot(self.store, ["holdings"])
        preview = preview_import(self.store, snapshot)
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100, "cost_price": 1500}])

        with self.assertRaises(TransferRevisionConflict):
            prepare_import(
                self.store,
                "33333333-3333-4333-8333-333333333333",
                snapshot,
                preview["currentRevision"],
            )

    def test_reset_selected_categories_leaves_unselected_data_untouched(self):
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100, "cost_price": 1500}])
        self.store.set("strategies", "alpha", {"id": "alpha"})
        revision = preview_import(self.store, export_snapshot(self.store, ["holdings"]))["currentRevision"]

        prepare_reset(
            self.store,
            "44444444-4444-4444-8444-444444444444",
            ["holdings"],
            revision,
        )
        result = commit_import(self.store, "44444444-4444-4444-8444-444444444444")
        finalize_import(self.store, "44444444-4444-4444-8444-444444444444")

        self.assertEqual(result["status"], "reset")
        self.assertEqual(self.store.all("holdings"), {})
        self.assertEqual(self.store.get("strategies", "alpha"), {"id": "alpha"})

    def test_persistent_transaction_blocks_writes_and_can_restore_exact_before_image(self):
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100}])
        snapshot = {
            "schemaVersion": 1,
            "backend": "trading-core",
            "categories": {"holdings": {"collections": {"holdings": {"default": [
                {"ticker": "000001", "quantity": 50, "cost_price": 10}
            ]}}}},
        }
        preview = preview_import(self.store, snapshot)
        transaction_id = "55555555-5555-4555-8555-555555555555"

        prepare_import(self.store, transaction_id, snapshot, preview["currentRevision"])
        with self.assertRaises(JsonStoreTransferBusyError):
            JsonStore(Path(self.temporary.name)).set("holdings", "other", [])
        commit_import(self.store, transaction_id)
        rollback_import(self.store, transaction_id)

        self.assertEqual(self.store.get("holdings", "default"), [{"ticker": "600519", "quantity": 100}])
        finalize_import(self.store, transaction_id)
        self.assertIsNone(self.store.active_transfer_id())

    def test_restart_recovery_uses_the_durable_host_commit_decision(self):
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100}])
        snapshot = {
            "schemaVersion": 1,
            "backend": "trading-core",
            "categories": {"holdings": {"collections": {"holdings": {"default": [
                {"ticker": "000001", "quantity": 50, "cost_price": 10}
            ]}}}},
        }
        coordinator = Path(self.temporary.name) / "coordinator"
        coordinator.mkdir()

        rollback_id = "77777777-7777-4777-8777-777777777777"
        revision = preview_import(self.store, snapshot)["currentRevision"]
        prepare_import(self.store, rollback_id, snapshot, revision, {"holdings": "use_import"})
        commit_import(self.store, rollback_id)
        (coordinator / f"{rollback_id}.json").write_text(
            json.dumps({"phase": "committing"}), encoding="utf-8"
        )
        recover_incomplete_transactions(self.store, str(coordinator))
        self.assertEqual(self.store.get("holdings", "default"), [{"ticker": "600519", "quantity": 100}])

        commit_id = "88888888-8888-4888-8888-888888888888"
        revision = preview_import(self.store, snapshot)["currentRevision"]
        prepare_import(self.store, commit_id, snapshot, revision, {"holdings": "use_import"})
        commit_import(self.store, commit_id)
        (coordinator / f"{commit_id}.json").write_text(
            json.dumps({"phase": "committed"}), encoding="utf-8"
        )
        recover_incomplete_transactions(self.store, str(coordinator))
        self.assertEqual(self.store.get("holdings", "default"), [
            {"ticker": "600519", "quantity": 100},
            {"ticker": "000001", "quantity": 50, "cost_price": 10},
        ])

    def test_http_routes_require_host_token_and_map_stale_revision(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        register_data_transfer_routes(app, lambda: self.store, token="transfer-secret")
        client = TestClient(app)

        unauthorized = client.get(
            "/data-transfer/export",
            params={"categories": "holdings"},
            headers={"Origin": "https://malicious.example"},
        )
        self.assertEqual(unauthorized.status_code, 401)
        headers = {"Authorization": "Bearer transfer-secret"}
        exported = client.get("/data-transfer/export", params={"categories": "holdings"}, headers=headers)
        self.assertEqual(exported.status_code, 200)
        snapshot = exported.json()
        preview = client.post("/data-transfer/preview", json={"snapshot": snapshot}, headers=headers).json()
        self.store.set("holdings", "default", [{"ticker": "600519", "quantity": 100}])
        stale = client.post("/data-transfer/prepare", json={
            "transaction_id": "66666666-6666-4666-8666-666666666666",
            "snapshot": snapshot,
            "expected_revision": preview["currentRevision"],
        }, headers=headers)
        self.assertEqual(stale.status_code, 409)
        invalid = client.get("/data-transfer/export", params={"categories": "credentials"}, headers=headers)
        self.assertEqual(invalid.status_code, 422)


if __name__ == "__main__":
    unittest.main()
