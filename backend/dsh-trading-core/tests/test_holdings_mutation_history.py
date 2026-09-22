"""日常账户变更：预写日志、故障恢复与不可变归档。"""

import json
import multiprocessing
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from adapter import data_transfer
from adapter.store import JsonStore


def _append_positions(root, index):
    store = JsonStore(Path(root))
    store.mutate("holdings", "default", lambda rows: [*rows, {"ticker": f"{index:06d}", "quantity": 1, "cost_price": 10}], [])


class HoldingsMutationHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = JsonStore(self.root)

    def records(self):
        return [json.loads(path.read_text()) for path in (self.root / "_holdings_operation_history").glob("*.json")]

    def position(self, quantity=1):
        return {"ticker": "600519", "quantity": quantity, "cost_price": 10}

    def test_all_normal_store_mutations_keep_history_outside_business_documents(self):
        self.store.set("holdings", "default", [self.position()])
        self.store.mutate("holdings", "default", lambda _: [self.position(2)])
        self.store.mutate_document("holdings", lambda doc: {**doc, "default": [self.position(3)]})
        self.store.update("holdings", "history_start_override", effective_date="2026-09-01")
        self.store.delete("holdings", "default")
        records = self.records()
        self.assertEqual(len(records), 5)
        self.assertTrue(all(row["kind"] == "holdings_update" for row in records))
        self.assertEqual(self.store.all("holdings"), {"history_start_override": {"effective_date": "2026-09-01"}})

    def test_noop_and_unrelated_state_do_not_create_position_events(self):
        self.store.set("holdings", "default", [self.position()])
        self.store.set("holdings", "default", [self.position()])
        self.store.set("holdings", "account_snapshots", [{"id": "fixture"}])
        self.store.set("watchlist", "default", ["600519"])
        self.assertEqual(len(self.records()), 1)

    def test_snapshot_only_source_or_history_edits_are_audited_as_data_changes(self):
        self.store.set("holdings", "snapshots", [{"snapshot_id": "seed", "source": "legacy_seed"}])
        self.store.delete("holdings", "snapshots")
        self.assertEqual(len(self.records()), 2)
        self.assertEqual(sum(len(row["changes"]["snapshots"]["removed"]) for row in self.records()), 1)

    def test_real_snapshot_source_switch_is_preserved_without_a_position_change(self):
        from adapter.portfolio_performance import record_holdings_snapshot
        at = datetime.now(timezone.utc)
        record_holdings_snapshot(self.store, [self.position()], "broker_real", at)
        record_holdings_snapshot(self.store, [self.position()], "broker_simulated", at + timedelta(seconds=1))
        records = sorted(self.records(), key=lambda row: row["startedAt"])
        self.assertEqual(len(records), 2)
        self.assertEqual(set(records[1]["changes"]), {"snapshots"})
        self.assertEqual(records[1]["changes"]["snapshots"]["added"][0]["source"], "broker_simulated")

    def test_trade_delta_preserves_duplicate_occurrences_and_clears(self):
        row = {"ticker": "600519", "quantity": 1, "secret": "private-account"}
        self.store.set("trades", "entries", [row, row])
        self.store.set("trades", "entries", [row])
        self.store.set("trades", "entries", [])
        records = sorted(self.records(), key=lambda row: row["startedAt"])
        self.assertEqual(records[0]["changes"]["entries"]["added"], [row, row])
        self.assertEqual(records[1]["changes"]["entries"]["removed"], [row])
        self.assertEqual(records[2]["changes"]["entries"]["removed"], [row])

    def test_intent_failure_leaves_business_unchanged(self):
        self.store.set("holdings", "default", [self.position()])
        with patch("adapter.holdings_mutation_history.prepare", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.store.set("holdings", "default", [])
        self.assertEqual(self.store.get("holdings", "default"), [self.position()])
        self.assertEqual(len(self.records()), 1)

    def test_crash_before_replace_is_not_a_success(self):
        from adapter import holdings_mutation_history as audit
        original = self.store._write_path

        def crash(path, content):
            if path.name == "holdings.json":
                raise KeyboardInterrupt()
            original(path, content)

        with patch.object(self.store, "_write_path", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.store.set("holdings", "default", [self.position()])
        self.assertTrue(audit.pending_path(self.store).exists())
        JsonStore(self.root).recover_mutation_history()
        self.assertEqual(self.records(), [])
        self.assertFalse(audit.pending_path(self.store).exists())

    def test_crash_after_replace_recovers_once_with_original_time(self):
        from adapter import holdings_mutation_history as audit
        with patch.object(audit, "complete", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                self.store.set("holdings", "default", [self.position()])
        pending = json.loads(audit.pending_path(self.store).read_text())
        self.assertEqual(self.store.get("holdings", "default"), [self.position()])
        self.assertEqual(self.records(), [])
        restarted = JsonStore(self.root)
        restarted.recover_mutation_history()
        self.assertEqual(self.records(), [pending["record"]])
        restarted.recover_mutation_history()
        self.assertEqual(len(self.records()), 1)

    def test_post_commit_archive_failure_is_retried_before_next_write_and_transfer(self):
        from adapter import holdings_mutation_history as audit
        with patch.object(audit, "publish", side_effect=OSError("archive unavailable")), self.assertLogs("adapter.store", level="ERROR"):
            self.store.set("holdings", "default", [self.position()])
            self.assertEqual(self.store.get("holdings", "default"), [self.position()])
            with self.assertRaises(OSError):
                self.store.set("holdings", "default", [])
            snapshot = data_transfer.export_snapshot(self.store, ["holdings"])
            revision = data_transfer.preview_import(self.store, snapshot)["currentRevision"]
            with self.assertRaises(OSError):
                data_transfer.prepare_reset(self.store, "11111111-1111-4111-8111-111111111111", ["holdings"], revision)
            self.assertIsNone(self.store.active_transfer_id())
        self.store.set("holdings", "default", [])
        self.assertEqual(len(self.records()), 2)

    def test_archive_link_before_cleanup_crash_is_idempotent(self):
        from adapter import holdings_mutation_history as audit
        with patch.object(audit, "discard", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                self.store.set("holdings", "default", [self.position()])
        original = self.records()
        self.store.recover_mutation_history()
        self.assertEqual(self.records(), original)

    def test_unknown_state_blocks_writes_without_destroying_evidence(self):
        from adapter import holdings_mutation_history as audit
        with patch.object(audit, "complete", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                self.store.set("holdings", "default", [self.position()])
        changed = '{"default": []}'
        (self.root / "holdings.json").write_text(changed)
        pending = audit.pending_path(self.store).read_bytes()
        with self.assertRaisesRegex(RuntimeError, "无法判定"):
            self.store.set("holdings", "default", [self.position(2)])
        self.assertEqual((self.root / "holdings.json").read_text(), changed)
        self.assertEqual(audit.pending_path(self.store).read_bytes(), pending)

    def test_transfer_does_not_create_temporary_normal_events_or_erase_history(self):
        self.store.set("holdings", "default", [self.position()])
        original = self.records()
        identity = "11111111-1111-4111-8111-111111111111"
        snapshot = data_transfer.export_snapshot(self.store, ["holdings"])
        revision = data_transfer.preview_import(self.store, snapshot)["currentRevision"]
        data_transfer.prepare_reset(self.store, identity, ["holdings"], revision)
        data_transfer.commit_import(self.store, identity)
        data_transfer.rollback_import(self.store, identity)
        data_transfer.finalize_import(self.store, identity)
        normal = [row for row in self.records() if row["kind"] == "holdings_update"]
        self.assertEqual(normal, original)

    def test_separate_processes_cannot_overwrite_baselines_or_pending(self):
        context = multiprocessing.get_context("spawn")
        processes = [context.Process(target=_append_positions, args=(str(self.root), index)) for index in range(4)]
        for process in processes:
            process.start()
        try:
            for process in processes:
                process.join(20)
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join(5)
        self.assertEqual(len(self.store.get("holdings", "default")), 4)
        self.assertEqual(len(self.records()), 4)

    def test_public_snapshot_read_does_not_create_or_recover_anything(self):
        root = self.root / "absent"
        reader = JsonStore(root, create=False)
        self.assertEqual(reader.read_bounded_snapshot("holdings", max_bytes=100), {})
        self.assertFalse(root.exists())

    def test_real_manual_trade_preview_and_retry_keep_a_single_atomic_event(self):
        from adapter.manual_trades import ManualTradeRequest, apply_trade
        request = ManualTradeRequest(request_id="audit-trade-001", ticker="600519", side="buy",
                                     quantity=3, price=10, fees=1,
                                     traded_at=datetime.now(timezone.utc) - timedelta(minutes=1))
        preview = apply_trade(self.store, request)
        self.assertEqual(self.records(), [])
        commit = request.model_copy(update={"action": "commit", "version": preview["version"]})
        apply_trade(self.store, commit)
        apply_trade(self.store, commit)
        self.assertEqual(len(self.records()), 1)
        changes = self.records()[0]["changes"]
        self.assertEqual(set(changes), {"default", "snapshots", "manual_trades"})
        self.assertEqual(len(changes["manual_trades"]["added"]), 1)

    def test_corrupt_pending_is_preserved_and_stops_all_mutations(self):
        from adapter import holdings_mutation_history as audit
        path = audit.pending_path(self.store)
        path.parent.mkdir()
        path.write_text('{"collection":')
        with self.assertRaisesRegex(RuntimeError, "预写日志损坏"):
            self.store.set("holdings", "default", [])
        self.assertFalse((self.root / "holdings.json").exists())
        self.assertEqual(path.read_text(), '{"collection":')


if __name__ == "__main__":
    unittest.main()
