# -*- coding: utf-8 -*-
"""JsonStore 的并发、原子写与损坏文件语义。"""

import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from adapter.store import JsonStore, JsonStoreCorruptionError


class JsonStoreTests(unittest.TestCase):
    def test_instances_share_one_lock_for_the_same_normalized_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            data.mkdir()
            nested = data / "nested"
            nested.mkdir()
            first = JsonStore(data)
            second = JsonStore(nested / "..")

            self.assertIs(first._lock("shared"), second._lock("shared"))

    def test_concurrent_instances_preserve_every_update(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stores = [JsonStore(root) for _ in range(8)]

            def write(index: int) -> None:
                stores[index % len(stores)].set("shared", f"key-{index}", index)

            with ThreadPoolExecutor(max_workers=len(stores)) as executor:
                list(executor.map(write, range(96)))

            self.assertEqual(
                stores[0].all("shared"),
                {f"key-{index}": index for index in range(96)},
            )
            self.assertEqual(list(root.glob(".shared.json.*.tmp")), [])

    def test_concurrent_same_key_mutations_preserve_every_append(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stores = [JsonStore(root) for _ in range(8)]
            barrier = threading.Barrier(len(stores))

            def append(index: int) -> None:
                barrier.wait()
                stores[index].mutate(
                    "behavior",
                    "default",
                    lambda current: [*list(current or []), index],
                    [],
                )

            with ThreadPoolExecutor(max_workers=len(stores)) as executor:
                list(executor.map(append, range(len(stores))))

            self.assertCountEqual(stores[0].get("behavior", "default"), range(8))

    def test_corrupt_json_fails_without_replacing_the_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "holdings.json"
            original = b'{"default": '
            path.write_bytes(original)

            with self.assertRaisesRegex(JsonStoreCorruptionError, "持久化文件损坏"):
                JsonStore(root).get("holdings", "default")

            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(root.glob(".holdings.json.*.tmp")), [])

    def test_replace_failure_removes_unique_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = JsonStore(root)
            store.set("holdings", "default", [{"ticker": "600519"}])
            original = (root / "holdings.json").read_bytes()

            with patch("adapter.store.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    store.set("holdings", "default", [])

            self.assertEqual((root / "holdings.json").read_bytes(), original)
            self.assertEqual(list(root.glob(".holdings.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
