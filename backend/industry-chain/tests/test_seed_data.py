# -*- coding: utf-8 -*-
"""产业链种子数据首次下载的完整性与并发边界。"""

import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from industry_chain import seed_data
from industry_chain.seed_data import SEED_FILES, SeedDataManager


def _payloads() -> dict[str, bytes]:
    values = {
        "stats.json": {"nodes": 1, "links": 0},
        "companies.json": [{"code": "300750", "name": "宁德时代"}],
        "market-caps.json": {"宁德时代": {"code": "300750", "market_cap": 1}},
        "view-data-all.json": {"companies": {"300750": {"code": "300750", "name": "宁德时代"}}},
        "network-data.json": {"nodes": [{"id": "300750"}], "links": []},
    }
    return {
        name: json.dumps(values[name], ensure_ascii=False).encode("utf-8")
        for name in SEED_FILES
    }


class _Response:
    def __init__(self, payload: bytes, *, failure: Exception | None = None) -> None:
        self.payload = payload
        self.failure = failure
        self.headers = {"Content-Length": str(len(payload))}

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def raise_for_status(self) -> None:
        if self.failure is not None:
            raise self.failure

    def iter_content(self, chunk_size: int):
        for offset in range(0, len(self.payload), max(1, min(chunk_size, 7))):
            yield self.payload[offset : offset + max(1, min(chunk_size, 7))]


class SeedDataManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_dir = Path(self.temporary.name) / "data" / "seed"
        self.payloads = _payloads()

    def _http_get(self, calls: list[str], *, failing_name: str | None = None):
        def get(url: str, **_kwargs):
            name = url.rsplit("/", 1)[-1]
            calls.append(name)
            failure = RuntimeError("upstream unavailable") if name == failing_name else None
            return _Response(self.payloads[name], failure=failure)

        return get

    def test_missing_status_is_read_only_and_does_not_create_directories(self):
        calls: list[str] = []
        manager = SeedDataManager(self.data_dir, "https://fixed.example/data", http_get=self._http_get(calls))

        self.assertEqual(manager.status(), {
            "status": "missing",
            "files_completed": 0,
            "files_total": 5,
            "downloaded_bytes": 0,
            "current_file": None,
            "error": None,
        })
        self.assertEqual(calls, [])
        self.assertFalse(self.data_dir.parent.exists())

    def test_success_downloads_validates_and_atomically_publishes_all_files(self):
        calls: list[str] = []
        manager = SeedDataManager(self.data_dir, "https://fixed.example/data", http_get=self._http_get(calls))

        result = manager.bootstrap()

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["files_completed"], 5)
        self.assertEqual(result["downloaded_bytes"], sum(map(len, self.payloads.values())))
        self.assertEqual(calls, list(SEED_FILES))
        self.assertEqual(sorted(path.name for path in self.data_dir.iterdir()), sorted(SEED_FILES))
        self.assertFalse(any("download" in path.name for path in self.data_dir.parent.iterdir()))
        self.assertEqual(manager.bootstrap(), result)
        self.assertEqual(calls, list(SEED_FILES))

    def test_status_observes_a_complete_dataset_added_after_process_start(self):
        calls: list[str] = []
        manager = SeedDataManager(self.data_dir, "https://fixed.example/data", http_get=self._http_get(calls))
        self.assertEqual(manager.status()["status"], "missing")

        self.data_dir.mkdir(parents=True)
        for name, payload in self.payloads.items():
            (self.data_dir / name).write_bytes(payload)

        status = manager.status()
        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["files_completed"], 5)
        self.assertEqual(calls, [])

    def test_failure_cleans_staging_and_never_publishes_a_partial_dataset(self):
        self.data_dir.mkdir(parents=True)
        existing = self.data_dir / "stats.json"
        existing.write_bytes(self.payloads["stats.json"])
        calls: list[str] = []
        manager = SeedDataManager(
            self.data_dir,
            "https://fixed.example/data",
            http_get=self._http_get(calls, failing_name="market-caps.json"),
        )

        result = manager.bootstrap()

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["files_completed"], 0)
        self.assertIsNotNone(result["error"])
        self.assertEqual(calls, list(SEED_FILES[:3]))
        self.assertEqual(list(self.data_dir.iterdir()), [existing])
        self.assertFalse(any("download" in path.name for path in self.data_dir.parent.iterdir()))

    def test_declared_oversize_file_is_rejected_before_writing(self):
        calls: list[str] = []

        def get(url: str, **_kwargs):
            name = url.rsplit("/", 1)[-1]
            calls.append(name)
            response = _Response(self.payloads[name])
            response.headers["Content-Length"] = "9"
            return response

        with mock.patch.object(seed_data, "MAX_FILE_BYTES", 8):
            result = SeedDataManager(
                self.data_dir, "https://fixed.example/data", http_get=get,
            ).bootstrap()

        self.assertEqual(result["status"], "error")
        self.assertIn("大小上限", result["error"] or "")
        self.assertFalse(self.data_dir.exists())
        self.assertEqual(calls, ["stats.json"])

    def test_invalid_minimum_structure_is_rejected_and_cleaned(self):
        calls: list[str] = []
        invalid_payloads = dict(self.payloads)
        invalid_payloads["companies.json"] = b"{}"

        def get(url: str, **_kwargs):
            name = url.rsplit("/", 1)[-1]
            calls.append(name)
            return _Response(invalid_payloads[name])

        result = SeedDataManager(
            self.data_dir, "https://fixed.example/data", http_get=get,
        ).bootstrap()

        self.assertEqual(result["status"], "error")
        self.assertIn("数据结构不完整", result["error"] or "")
        self.assertEqual(calls, list(SEED_FILES[:2]))
        self.assertFalse(self.data_dir.exists())
        self.assertFalse(any("download" in path.name for path in self.data_dir.parent.iterdir()))

    def test_malformed_json_is_rejected_and_cleaned(self):
        invalid_payloads = dict(self.payloads)
        invalid_payloads["stats.json"] = b"{"

        def get(url: str, **_kwargs):
            return _Response(invalid_payloads[url.rsplit("/", 1)[-1]])

        result = SeedDataManager(
            self.data_dir, "https://fixed.example/data", http_get=get,
        ).bootstrap()

        self.assertEqual(result["status"], "error")
        self.assertIn("有效的 JSON", result["error"] or "")
        self.assertFalse(self.data_dir.exists())

    def test_publish_failure_restores_existing_directory_and_cleans_staging(self):
        self.data_dir.mkdir(parents=True)
        existing = self.data_dir / "legacy.txt"
        existing.write_text("keep", encoding="utf-8")
        calls: list[str] = []
        real_replace = seed_data.os.replace

        def replace(source, destination):
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path.name.startswith(".seed-download-") and destination_path == self.data_dir:
                raise OSError("simulated publish failure")
            return real_replace(source, destination)

        with mock.patch.object(seed_data.os, "replace", side_effect=replace):
            result = SeedDataManager(
                self.data_dir,
                "https://fixed.example/data",
                http_get=self._http_get(calls),
            ).bootstrap()

        self.assertEqual(result["status"], "error")
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")
        self.assertEqual(list(self.data_dir.iterdir()), [existing])
        self.assertFalse(any(path.name.startswith(".seed-") for path in self.data_dir.parent.iterdir()))

    def test_concurrent_bootstrap_calls_share_one_download_and_report_progress(self):
        calls: list[str] = []
        entered = threading.Event()
        resume = threading.Event()

        def get(url: str, **_kwargs):
            name = url.rsplit("/", 1)[-1]
            calls.append(name)
            if name == "stats.json":
                entered.set()
                self.assertTrue(resume.wait(5), "download was not resumed")
            return _Response(self.payloads[name])

        manager = SeedDataManager(self.data_dir, "https://fixed.example/data", http_get=get)
        results: list[dict] = []
        first = threading.Thread(target=lambda: results.append(manager.bootstrap()))
        second = threading.Thread(target=lambda: results.append(manager.bootstrap()))
        first.start()
        self.assertTrue(entered.wait(5), "download did not start")
        second.start()

        progress = manager.status()
        self.assertEqual(progress["status"], "downloading")
        self.assertEqual(progress["current_file"], "stats.json")
        resume.set()
        first.join(5)
        second.join(5)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(calls, list(SEED_FILES))
        self.assertEqual([result["status"] for result in results], ["ready", "ready"])


if __name__ == "__main__":
    unittest.main()
