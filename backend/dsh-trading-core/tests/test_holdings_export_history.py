"""仅接受 Host 已持久校验的备份回执，不把读快照冒充导出成功。"""

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from adapter import data_transfer, holdings_mutation_history as audit
from adapter.public_holdings_operations import _project
from adapter.store import JsonStore

IDENTITY = "11111111-1111-4111-8111-111111111111"


class HoldingsExportHistoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.store = JsonStore(root / "store")
        self.directory = root / "coordinator" / "export-receipts"
        self.directory.mkdir(parents=True)
        environment = patch.dict(os.environ, {"DSH_DATA_TRANSFER_COORDINATOR_DIR": str(self.directory.parent)})
        environment.start()
        self.addCleanup(environment.stop)
        app = FastAPI()
        data_transfer.register_data_transfer_routes(app, lambda: self.store, token="private-token")
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.receipt = {
            "schemaVersion": 1, "operationId": IDENTITY, "phase": "verified",
            "startedAt": "2026-09-21T01:00:00.000Z", "verifiedAt": "2026-09-21T01:01:00.000Z",
            "reason": "manual", "categories": ["holdings", "strategies"], "size": 123,
            "sha256": "a" * 64, "archivePath": "/private/canary-account.pabackup",
        }
        self.write_receipt()

    def write_receipt(self):
        (self.directory / f"{IDENTITY}.json").write_text(json.dumps(self.receipt))

    def post(self, payload=None, token="private-token"):
        return self.client.post("/data-transfer/export-completed", json=payload or {"operation_id": IDENTITY},
                                headers={"Authorization": f"Bearer {token}"})

    def records(self):
        return [json.loads(path.read_text()) for path in (self.store.base_dir / "_holdings_operation_history").glob("*.json")]

    def test_authenticated_receipt_is_immutable_idempotent_and_does_not_change_account(self):
        for _ in range(2):
            self.assertEqual(self.post().json(), {"status": "recorded", "operation_id": IDENTITY})
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.store.all("holdings"), {})
        record = self.records()[0]
        self.assertNotIn("archivePath", record)
        public = _project(record, IDENTITY, datetime(2026, 9, 20, tzinfo=timezone.utc))
        self.assertIn("备份文件已生成并校验通过", public["summary"])
        self.assertNotIn("canary", json.dumps(public))
        self.assertNotIn("strategies", json.dumps(public))
        self.assertNotIn("a" * 64, json.dumps(public))
        self.assertIsNone(_project(record, IDENTITY, datetime(2026, 9, 22, tzinfo=timezone.utc)))
        self.receipt["reason"] = "pre-reset"
        self.write_receipt()
        self.assertGreaterEqual(self.post().status_code, 400)
        self.assertEqual(self.records(), [record])

    def test_no_snapshot_read_or_bad_receipt_can_claim_success(self):
        self.assertEqual(self.client.get("/data-transfer/export?categories=holdings", headers={"Authorization": "Bearer private-token"}).status_code, 200)
        self.assertEqual(self.post(token="wrong").status_code, 401)
        self.assertEqual(self.post({"operation_id": IDENTITY, "path": "/elsewhere"}).status_code, 422)
        self.assertEqual(self.post({"operation_id": "../escape"}).status_code, 422)
        for change in ({"phase": "preparing"}, {"reason": "free-text"}, {"categories": ["strategies"]},
                       {"size": 2**30}, {"verifiedAt": "2020-01-01T00:00:00Z"}):
            original = dict(self.receipt)
            self.receipt.update(change)
            self.write_receipt()
            self.assertEqual(self.post().status_code, 422)
            self.receipt = original
        self.assertEqual(self.records(), [])

    def test_symlink_and_oversize_are_rejected(self):
        path = self.directory / f"{IDENTITY}.json"
        path.unlink()
        target = self.directory / "secret"
        target.write_text(json.dumps(self.receipt))
        path.symlink_to(target)
        self.assertEqual(self.post().status_code, 422)
        path.unlink()
        path.write_bytes(b" " * (16 * 1024 + 1))
        self.assertEqual(self.post().status_code, 422)

    def test_index_failure_recovery_keeps_original_verified_record(self):
        with patch("adapter.holdings_operation_index.append", side_effect=OSError("disk unavailable")):
            self.assertEqual(self.post().status_code, 500)
        self.assertTrue(audit.pending_path(self.store).exists())
        original = self.records()
        self.store.recover_mutation_history()
        self.assertFalse(audit.pending_path(self.store).exists())
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.records(), original)


if __name__ == "__main__":
    unittest.main()
