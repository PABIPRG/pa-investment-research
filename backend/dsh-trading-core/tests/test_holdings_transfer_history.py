"""持仓账户导入/重置留痕：不包含影子资金，不把回滚当成功。"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from adapter.data_transfer import (
    TransferValidationError, commit_import, export_snapshot, finalize_import,
    prepare_import, prepare_reset, preview_import, recover_incomplete_transactions,
    rollback_import,
)
from adapter.store import JsonStore


class HoldingsTransferHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = JsonStore(Path(self.temporary.name) / "data")
        self.history_dir = self.store.base_dir / "_holdings_operation_history"
        self.coordinator = Path(self.temporary.name) / "coordinator"
        self.coordinator.mkdir()
        environment = patch.dict("os.environ", {"DSH_DATA_TRANSFER_COORDINATOR_DIR": str(self.coordinator)})
        environment.start()
        self.addCleanup(environment.stop)
        self.transaction_id = "11111111-1111-4111-8111-111111111111"
        self.before = [{"ticker": "600519", "quantity": 100, "cost_price": 1500}]
        self.store.set("holdings", "default", self.before)

    def prepare(self, identity=None, *, reset=False):
        identity = identity or self.transaction_id
        snapshot = export_snapshot(self.store, ["holdings"])
        if not reset:
            snapshot["categories"]["holdings"]["collections"]["holdings"]["default"][0]["quantity"] = 150
        revision = preview_import(self.store, snapshot)["currentRevision"]
        if reset:
            prepare_reset(self.store, identity, ["holdings"], revision)
        else:
            prepare_import(self.store, identity, snapshot, revision, {"holdings": "use_import"})
        return identity

    def decide(self, identity=None, phase="committed"):
        identity = identity or self.transaction_id
        (self.coordinator / f"{identity}.json").write_text(json.dumps({
            "schemaVersion": 1, "transactionId": identity,
            "phase": phase, "targets": ["trading-core"],
        }), encoding="utf-8")

    def archived(self, identity=None):
        return json.loads((self.history_dir / f"{identity or self.transaction_id}.json").read_text())

    def transfer_archives(self):
        return [path for path in self.history_dir.glob("*.json")
                if json.loads(path.read_text())["kind"] in {"import", "reset"}]

    def test_success_preserves_exact_account_images_after_transaction_cleanup(self):
        self.store.set("shadows", "meta", {"private-strategy": {"initial_capital": 100000}})
        self.prepare()
        transaction = self.store.transfer_directory / f"{self.transaction_id}.json"
        started = json.loads(transaction.read_text()).get("startedAt")
        commit_import(self.store, self.transaction_id)
        self.assertEqual(self.transfer_archives(), [])
        self.decide()
        finalize_import(self.store, self.transaction_id)
        event = self.archived()
        self.assertEqual(event["before"]["holdings"]["default"], self.before)
        self.assertEqual(event["after"]["holdings"]["default"][0]["quantity"], 150)
        self.assertEqual(event["kind"], "import")
        self.assertEqual(event["terminalState"], "committed")
        self.assertEqual(event["confirmation"], "host_committed")
        self.assertIsNotNone(started)
        self.assertEqual(event["startedAt"], started)
        self.assertIsNotNone(event["committedAt"])
        self.assertIsNotNone(event["observedAt"])
        self.assertNotIn("private-strategy", json.dumps(event))
        self.assertEqual(set(event["before"]), {"holdings", "trades"})
        self.assertFalse(transaction.exists())

    def test_local_commit_followed_by_rollback_is_not_a_successful_change(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        rollback_import(self.store, self.transaction_id)
        finalize_import(self.store, self.transaction_id)
        event = self.archived()
        self.assertEqual(event["terminalState"], "rolled_back")
        self.assertEqual(event["confirmation"], "rolled_back")
        self.assertEqual(event["before"], event["after"])
        self.assertIsNotNone(event["rolledBackAt"])
        self.assertEqual(self.store.get("holdings", "default"), self.before)

    def test_reset_preserves_previous_history_and_does_not_export_it(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        finalize_import(self.store, self.transaction_id)
        original = (self.history_dir / f"{self.transaction_id}.json").read_bytes()
        identity = self.prepare("22222222-2222-4222-8222-222222222222", reset=True)
        commit_import(self.store, identity)
        self.decide(identity)
        finalize_import(self.store, identity)
        self.assertEqual(self.store.all("holdings"), {})
        self.assertEqual(self.archived(identity)["kind"], "reset")
        self.assertEqual(self.archived(identity)["after"]["holdings"], {})
        self.assertEqual((self.history_dir / f"{self.transaction_id}.json").read_bytes(), original)
        self.assertNotIn("_holdings_operation_history", json.dumps(export_snapshot(self.store, ["holdings"])))

    def test_finalization_requires_persisted_global_commit_when_coordinator_is_configured(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide(phase="committing")
        with self.assertRaises(TransferValidationError):
            finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.store.active_transfer_id(), self.transaction_id)
        self.assertEqual(self.transfer_archives(), [])

    def test_restart_finalizes_exactly_once_with_original_timestamps(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        recover_incomplete_transactions(self.store, str(self.coordinator))
        original = (self.history_dir / f"{self.transaction_id}.json").read_bytes()
        recover_incomplete_transactions(self.store, str(self.coordinator))
        finalize_import(self.store, self.transaction_id)
        self.assertEqual(len(self.transfer_archives()), 1)
        self.assertEqual((self.history_dir / f"{self.transaction_id}.json").read_bytes(), original)

    def test_audit_failure_keeps_recovery_material_and_active_reservation(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        with patch("adapter.data_transfer._sync_history_directory", side_effect=OSError("archive unavailable")):
            with self.assertRaises(OSError):
                finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.store.active_transfer_id(), self.transaction_id)
        self.assertTrue((self.store.transfer_directory / f"{self.transaction_id}.json").exists())
        finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.archived()["confirmation"], "host_committed")

    def test_archived_uuid_cannot_be_reused_for_a_different_operation(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        finalize_import(self.store, self.transaction_id)
        with self.assertRaises(TransferValidationError):
            self.prepare(reset=True)
        self.assertIsNone(self.store.active_transfer_id())

    def test_completed_archive_survives_a_later_import(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        finalize_import(self.store, self.transaction_id)
        original = (self.history_dir / f"{self.transaction_id}.json").read_bytes()
        identity = self.prepare("33333333-3333-4333-8333-333333333333")
        commit_import(self.store, identity)
        self.decide(identity)
        finalize_import(self.store, identity)
        self.assertEqual((self.history_dir / f"{self.transaction_id}.json").read_bytes(), original)
        self.assertEqual(len(self.transfer_archives()), 2)

    def test_legacy_sparse_import_keeps_unmodified_trades_in_actual_after_image(self):
        trades = {"entries": [{"ticker": "600519", "quantity": 100, "price": 1500,
                               "side": "buy", "amount": 150000, "account_mode": "simulated",
                               "traded_at": "2026-09-15T10:00:00+08:00"}], "imports": []}
        self.store.mutate_document("trades", lambda _: trades)
        snapshot = {"schemaVersion": 1, "backend": "trading-core", "categories": {
            "holdings": {"collections": {"holdings": {"default": self.before}}},
        }}
        revision = preview_import(self.store, snapshot)["currentRevision"]
        prepare_import(self.store, self.transaction_id, snapshot, revision)
        commit_import(self.store, self.transaction_id)
        self.decide()
        finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.store.all("trades"), trades)
        self.assertEqual(self.archived()["after"]["trades"], trades)

    def test_crash_after_archive_before_cleanup_replays_without_duplicate_history(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        with patch.object(self.store, "release_transfer", side_effect=OSError("crash")):
            with self.assertRaises(OSError):
                finalize_import(self.store, self.transaction_id)
        original = (self.history_dir / f"{self.transaction_id}.json").read_bytes()
        recover_incomplete_transactions(self.store, str(self.coordinator))
        self.assertEqual((self.history_dir / f"{self.transaction_id}.json").read_bytes(), original)
        self.assertEqual(len(self.transfer_archives()), 1)
        self.assertIsNone(self.store.active_transfer_id())

    def test_conflicting_archive_never_overwrites_history_or_discards_recovery(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        self.history_dir.mkdir(exist_ok=True)
        archive = self.history_dir / f"{self.transaction_id}.json"
        archive.write_text("existing-private-evidence")
        with self.assertRaises(TransferValidationError):
            finalize_import(self.store, self.transaction_id)
        self.assertEqual(archive.read_text(), "existing-private-evidence")
        self.assertEqual(self.store.active_transfer_id(), self.transaction_id)

    def test_index_failure_preserves_transfer_until_private_recovery(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        with patch("adapter.holdings_operation_index.append", side_effect=OSError("index unavailable")):
            with self.assertRaises(OSError):
                finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.store.active_transfer_id(), self.transaction_id)
        original = (self.history_dir / f"{self.transaction_id}.json").read_bytes()
        recover_incomplete_transactions(self.store, str(self.coordinator))
        self.assertIsNone(self.store.active_transfer_id())
        self.assertEqual(original, (self.history_dir / f"{self.transaction_id}.json").read_bytes())

    def test_coordinator_receipt_must_match_this_transaction_and_backend(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        for override in ({"transactionId": "other"}, {"targets": ["market-watch"]}, {"schemaVersion": 2}):
            with self.subTest(override=override):
                decision = {"schemaVersion": 1, "transactionId": self.transaction_id,
                            "phase": "committed", "targets": ["trading-core"], **override}
                (self.coordinator / f"{self.transaction_id}.json").write_text(json.dumps(decision))
                with self.assertRaises(TransferValidationError):
                    finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.transfer_archives(), [])

    def test_standalone_commit_is_not_claimed_as_host_confirmed(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        with patch.dict("os.environ", {"DSH_DATA_TRANSFER_COORDINATOR_DIR": ""}):
            finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.archived()["confirmation"], "backend_only")

    def test_legacy_transaction_keeps_unknown_times_null(self):
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        path = self.store.transfer_directory / f"{self.transaction_id}.json"
        transaction = json.loads(path.read_text())
        transaction.pop("startedAt")
        transaction.pop("committedAt")
        path.write_text(json.dumps(transaction))
        finalize_import(self.store, self.transaction_id)
        self.assertIsNone(self.archived()["startedAt"])
        self.assertIsNone(self.archived()["committedAt"])
        self.assertIsNotNone(self.archived()["observedAt"])

    def test_shadow_only_transfer_does_not_create_holdings_account_history(self):
        snapshot = export_snapshot(self.store, ["strategies"])
        revision = preview_import(self.store, snapshot)["currentRevision"]
        prepare_import(self.store, self.transaction_id, snapshot, revision)
        commit_import(self.store, self.transaction_id)
        self.decide()
        finalize_import(self.store, self.transaction_id)
        self.assertEqual(self.transfer_archives(), [])

    def test_private_history_does_not_grant_publication_permission(self):
        from adapter.public_observatory import public_activities, public_overview
        self.prepare()
        commit_import(self.store, self.transaction_id)
        self.decide()
        finalize_import(self.store, self.transaction_id)
        original = (self.history_dir / f"{self.transaction_id}.json").read_bytes()
        with patch.dict("os.environ", {"DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS": "[]"}):
            self.assertEqual(public_activities(self.store, "2026-09-21")["items"], [])
            self.assertEqual(public_overview(self.store, "2026-09-21")["availability"], "unavailable")
        self.assertEqual((self.history_dir / f"{self.transaction_id}.json").read_bytes(), original)
        if os.name != "nt":
            self.assertEqual(self.history_dir.stat().st_mode & 0o777, 0o700)
            self.assertEqual((self.history_dir / f"{self.transaction_id}.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
