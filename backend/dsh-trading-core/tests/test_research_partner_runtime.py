# -*- coding: utf-8 -*-
"""常驻服务形态：单一权威实例锁。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_runtime -v
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from research_partner.runtime import InstanceLock, InstanceLockError, default_lock_path


class InstanceLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "research_partner.lock"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_acquire_records_owner_and_release_removes_it(self) -> None:
        lock = InstanceLock(self.path)
        record = lock.acquire()
        self.assertEqual(record["pid"], os.getpid())
        self.assertTrue(lock.held)
        self.assertTrue(self.path.exists())
        status = lock.status()
        self.assertTrue(status["held"])
        self.assertFalse(status["stale"])
        lock.release()
        self.assertFalse(self.path.exists())
        self.assertFalse(lock.status()["held"])

    def test_second_instance_is_refused_while_owner_is_alive(self) -> None:
        first = InstanceLock(self.path)
        first.acquire()
        with self.assertRaises(InstanceLockError):
            InstanceLock(self.path).acquire()
        first.release()
        InstanceLock(self.path).acquire()

    def test_stale_lock_from_dead_process_is_reclaimed(self) -> None:
        self.path.write_text(
            json.dumps({"pid": 4194303, "startedAt": "2026-01-01T00:00:00+00:00"}),
            encoding="utf-8",
        )
        lock = InstanceLock(self.path)
        self.assertTrue(lock.status()["stale"])
        record = lock.acquire()
        self.assertEqual(record["pid"], os.getpid())

    def test_corrupted_lock_is_treated_as_stale(self) -> None:
        self.path.write_text("{not json", encoding="utf-8")
        lock = InstanceLock(self.path)
        self.assertTrue(lock.status()["stale"])
        lock.acquire()
        self.assertTrue(lock.held)

    def test_context_manager_releases_on_exit(self) -> None:
        with InstanceLock(self.path):
            self.assertTrue(self.path.exists())
        self.assertFalse(self.path.exists())

    def test_default_path_follows_store_location(self) -> None:
        with patch.dict(
            os.environ,
            {"RESEARCH_PARTNER_SQLITE_PATH": str(Path(self.temporary.name) / "core.db")},
            clear=False,
        ):
            self.assertEqual(
                default_lock_path(), Path(self.temporary.name) / "research_partner.lock"
            )


if __name__ == "__main__":
    unittest.main()
