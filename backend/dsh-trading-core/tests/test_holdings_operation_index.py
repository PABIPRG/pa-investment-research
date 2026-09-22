"""不可变操作归档的派生索引：恢复、容量与冻结公开分页。"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from adapter import holdings_mutation_history as audit
from adapter import holdings_operation_index as index
from adapter.public_observatory import public_activities, public_activity_detail
from adapter.store import JsonStore


class HoldingsOperationIndexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = JsonStore(Path(temporary.name))
        environment = patch.dict(os.environ, {
            "DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE": "2026-09-21T00:00:00+08:00",
            "DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS": "[]",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def write(self, count, timestamp="2026-09-21T10:00:00.123456+08:00"):
        with patch.object(audit, "_now", return_value=timestamp):
            self.store.set("trades", "entries", [{"private": "SECRET", "count": count}])

    def test_archive_index_failure_retains_pending_and_recovers_idempotently(self):
        with patch.object(index, "append", side_effect=OSError("injected")):
            with self.assertLogs("adapter.store", level="ERROR"):
                self.write(1)
        self.assertTrue(audit.pending_path(self.store).exists())
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        self.store.recover_mutation_history()
        self.store.recover_mutation_history()
        self.assertFalse(audit.pending_path(self.store).exists())
        self.assertEqual(len(public_activities(self.store, "2026-09-21")["items"]), 1)

    def test_crash_after_index_commit_before_cleanup_does_not_duplicate(self):
        with patch.object(audit, "discard", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                self.write(1)
        self.store.recover_mutation_history()
        self.assertEqual(len(public_activities(self.store, "2026-09-21")["items"]), 1)

    def test_frozen_keyset_pages_ignore_new_and_backdated_insertions(self):
        for count in range(5):
            self.write(count)
        expected = public_activities(self.store, "2026-09-21")["items"]
        page = public_activities(self.store, "2026-09-21", limit=2)
        seen = page["items"]
        self.write(20, "2026-09-21T11:00:00+08:00")
        self.write(21, "2026-09-21T09:00:00+08:00")
        while page["next_cursor"]:
            self.assertLessEqual(len(page["next_cursor"]), 128)
            page = public_activities(self.store, "2026-09-21", limit=2, cursor=page["next_cursor"])
            seen += page["items"]
        self.assertEqual(seen, expected)
        self.assertEqual(len(public_activities(self.store, "2026-09-21")["items"]), 7)

    def test_tampered_filter_policy_and_generation_cursors_are_rejected(self):
        for count in range(3):
            self.write(count)
        cursor = public_activities(self.store, "2026-09-21", limit=1)["next_cursor"]
        with self.assertRaises(ValueError):
            public_activities(self.store, "2026-09-21", cursor=cursor[:-5] + "AAAAA")
        with self.assertRaises(index.CursorExpired):
            public_activities(self.store, "2026-09-20", cursor=cursor)
        with self.assertRaises(index.CursorExpired):
            public_activities(self.store, "2026-09-21", category="operation", cursor=cursor)
        with patch.dict(os.environ, {"DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE": "2026-09-21T01:00:00+08:00"}):
            with self.assertRaises(index.CursorExpired):
                public_activities(self.store, "2026-09-21", cursor=cursor)
        index.rebuild(self.store)
        with self.assertRaises(index.CursorExpired):
            public_activities(self.store, "2026-09-21", cursor=cursor)

    def test_large_archive_is_migrated_once_and_public_reads_do_not_scan_or_write(self):
        directory = self.store.base_dir / "_holdings_operation_history"
        directory.mkdir()
        for number in range(1100):
            identity = str(uuid.UUID(int=number + 1))
            record = {"schemaVersion": 1, "transactionId": identity, "kind": "trades_update",
                      "startedAt": "2026-09-21T10:00:00+08:00", "observedAt": "2026-09-21T10:00:00+08:00",
                      "confirmation": "local_atomic_replace", "changes": {"entries": {"added": [{"private": "SECRET" * 1600}], "removed": []}}}
            (directory / f"{identity}.json").write_text(json.dumps(record))
        index.ensure(self.store)
        before = {str(path): path.read_bytes() for path in self.store.base_dir.rglob("*") if path.is_file()}
        with patch("os.scandir", side_effect=AssertionError("GET cannot scan archives")):
            page = public_activities(self.store, "2026-09-21", limit=50)
            self.assertEqual(len(page["items"]), 50)
            self.assertIsNotNone(page["next_cursor"])
            detail = public_activity_detail(self.store, page["items"][0]["public_id"])
            self.assertNotIn("SECRET", json.dumps(detail))
            identities = [row["public_id"] for row in page["items"]]
            while page["next_cursor"]:
                page = public_activities(self.store, "2026-09-21", limit=50, cursor=page["next_cursor"])
                identities.extend(row["public_id"] for row in page["items"])
            self.assertEqual(len(identities), 1100)
            self.assertEqual(len(set(identities)), 1100)
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.store.base_dir.rglob("*") if path.is_file()})
        self.assertNotIn(b"SECRET", index.path_for(self.store).read_bytes())

    def test_missing_index_is_not_created_by_get_and_failed_rebuild_preserves_index(self):
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        self.assertFalse(index.path_for(self.store).exists())
        self.write(1)
        expected = public_activities(self.store, "2026-09-21")
        with patch.object(index, "_archives", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                index.rebuild(self.store)
        self.assertEqual(public_activities(self.store, "2026-09-21"), expected)

    def test_corrupt_projection_fails_closed(self):
        self.write(1)
        with sqlite3.connect(index.path_for(self.store)) as connection:
            connection.execute("UPDATE records SET summary = ?", ('{"secret":"PRIVATE"}',))
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")

    def test_interrupted_initial_migration_can_retry_from_private_owner(self):
        with patch.object(index, "_archives", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                index.ensure(self.store)
        self.assertTrue(index.path_for(self.store).exists())
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        index.ensure(self.store)
        self.assertEqual(public_activities(self.store, "2026-09-21")["items"], [])

    def test_corrupt_authorization_metadata_never_publishes_old_private_record(self):
        self.write(1, "2026-09-20T10:00:00+08:00")
        self.assertEqual(public_activities(self.store, "2026-09-21")["items"], [])
        with sqlite3.connect(index.path_for(self.store)) as connection:
            identity = connection.execute("SELECT public_id FROM records").fetchone()[0]
            connection.execute("UPDATE records SET started=started+86400000000, occurred=occurred+86400000000")
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        with self.assertRaises(RuntimeError):
            public_activity_detail(self.store, identity)

    def test_private_owner_recovers_hot_sqlite_journal_after_process_crash(self):
        self.write(1)
        expected = public_activities(self.store, "2026-09-21")
        script = """
import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA cache_size=1')
connection.execute('BEGIN IMMEDIATE')
connection.execute('UPDATE records SET detail=zeroblob(1048576)')
os._exit(7)
"""
        result = subprocess.run([sys.executable, "-B", "-c", script, str(index.path_for(self.store))], check=False)
        self.assertEqual(result.returncode, 7)
        self.assertTrue(Path(str(index.path_for(self.store)) + "-journal").exists())
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        index.ensure(self.store)
        self.assertEqual(public_activities(self.store, "2026-09-21"), expected)

    def test_signed_private_payload_cannot_be_spliced_into_an_approved_row(self):
        self.write(1, "2026-09-20T10:00:00+08:00")
        self.write(2)
        approved = public_activities(self.store, "2026-09-21")["items"][0]["public_id"]
        with sqlite3.connect(index.path_for(self.store)) as connection:
            private = connection.execute("SELECT summary,detail,signature FROM records WHERE seq=1").fetchone()
            connection.execute("UPDATE records SET summary=?,detail=?,signature=? WHERE seq=2", private)
        with self.assertRaises(RuntimeError):
            public_activities(self.store, "2026-09-21")
        with self.assertRaises(RuntimeError):
            public_activity_detail(self.store, approved)


if __name__ == "__main__":
    unittest.main()
