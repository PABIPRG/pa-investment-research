# -*- coding: utf-8 -*-
"""跨领域产品数据包：清单、完整性、跨域预览与可恢复导入（V1.3 §9.4）。

运行：
    env/Scripts/python.exe -m unittest tests.test_product_package -v
"""

from __future__ import annotations

import gc
import hashlib
import json
import secrets
import tempfile
import unittest
from pathlib import Path

from adapter.data_transfer import CATEGORY_COLLECTIONS
from adapter.notifications.repository import NotificationRepository
from adapter.product_package import (
    BatchConflict,
    DomainAdapter,
    PackageError,
    PackageImportError,
    PackageIntegrityError,
    PackageJournal,
    ResearchPartnerDomain,
    TradingCoreDomain,
    build_package,
    commit_package_import,
    preview_package_import,
    register_product_package_routes,
    validate_package,
)
from adapter.store import JsonStore
from research_partner.commands import MandateCreateRequest
from research_partner.context import RequestContext
from research_partner.factory import build_service


def batch_id() -> str:
    return "IMP_" + secrets.token_hex(12)


class FakeDomain(DomainAdapter):
    def __init__(self, name: str, records: list[str] | None = None) -> None:
        self.name = name
        self.supported_schema_major = "1"
        self.records = list(records or [])
        self.export_error: str | None = None
        self.commit_error: str | None = None
        self.verify_ok = True
        self.commits: list[str] = []
        self.batches: dict[str, dict] = {}

    def export_domain(self) -> dict:
        if self.export_error:
            raise RuntimeError(self.export_error)
        return {
            "payload": {"records": list(self.records)},
            "schemaVersion": "1.2",
            "consistencyVersion": f"n{len(self.records)}",
            "counts": {"records": len(self.records)},
        }

    def preview(self, payload: dict) -> dict:
        records = list(payload["records"])
        new = len([item for item in records if item not in self.records])
        return {
            "counts": {"new": new, "duplicate": len(records) - new, "conflict": 0},
            "expectedRevision": f"n{len(self.records)}",
        }

    def commit(self, payload, *, batch_id, resolutions, expected_revision=None) -> dict:
        self.commits.append(batch_id)
        if self.commit_error:
            raise RuntimeError(self.commit_error)
        if batch_id in self.batches:
            return {"status": "replayed"}
        for record in payload["records"]:
            if record not in self.records:
                self.records.append(record)
        result = {"status": "applied", "records": len(self.records)}
        self.batches[batch_id] = result
        return result

    def verify(self, payload: dict) -> dict:
        missing = [item for item in payload["records"] if item not in self.records]
        return {"ok": self.verify_ok and not missing, "missing": missing}


class FakeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.journal = PackageJournal(self.root / "journal.sqlite3")

    def tearDown(self) -> None:
        self.journal.close()
        # SQLite 连接通过引用环存活到 GC 才关闭；Windows 下不回收会锁住临时文件。
        gc.collect()
        self.temporary.cleanup()


class ManifestTests(FakeTestCase):
    def test_manifest_lists_versions_counts_attachments_and_integrity(self) -> None:
        attachment = self.root / "evidence.pdf"
        attachment.write_bytes(b"evidence")
        alpha = FakeDomain("alpha", ["a"])
        beta = FakeDomain("beta", ["b1", "b2"])
        package = build_package(
            {"alpha": alpha, "beta": beta},
            attachments=[{"name": "evidence.pdf", "path": attachment}],
        )
        self.assertEqual(package["format"], "pa-product-data-package")
        self.assertEqual(package["formatVersion"], 1)
        self.assertEqual(package["exportScope"]["domains"], ["alpha", "beta"])
        self.assertTrue(package["complete"])
        self.assertEqual(package["missing"], [])
        self.assertEqual(package["domains"]["beta"]["counts"], {"records": 2})
        self.assertEqual(package["domains"]["alpha"]["schemaVersion"], "1.2")
        self.assertEqual(
            package["domains"]["alpha"]["checksum"]["value"],
            hashlib.sha256(
                json.dumps(
                    {"records": ["a"]},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
        )
        self.assertEqual(package["attachments"][0]["name"], "evidence.pdf")
        self.assertEqual(
            package["attachments"][0]["sha256"],
            hashlib.sha256(b"evidence").hexdigest(),
        )
        validated = validate_package(package, adapters={"alpha": alpha, "beta": beta})
        self.assertEqual(sorted(validated["domains"]), ["alpha", "beta"])

    def test_tampered_domain_payload_is_rejected(self) -> None:
        package = build_package({"alpha": FakeDomain("alpha", ["a"])})
        package["domains"]["alpha"]["payload"]["records"].append("injected")
        with self.assertRaises(PackageIntegrityError):
            validate_package(package)

    def test_unsupported_format_and_schema_are_rejected(self) -> None:
        package = build_package({"alpha": FakeDomain("alpha", ["a"])})
        with self.assertRaisesRegex(PackageError, "格式版本"):
            validate_package({**package, "formatVersion": 2})
        adapter = FakeDomain("alpha", ["a"])
        adapter.supported_schema_major = "9"
        with self.assertRaisesRegex(PackageError, "schema 版本"):
            validate_package(package, adapters={"alpha": adapter})

    def test_export_failure_is_explicit(self) -> None:
        broken = FakeDomain("alpha")
        broken.export_error = "offline"
        with self.assertRaisesRegex(PackageError, "无法导出"):
            build_package({"alpha": broken})
        package = build_package({"alpha": broken}, allow_incomplete=True)
        self.assertFalse(package["complete"])
        self.assertEqual(package["missing"][0]["domain"], "alpha")
        self.assertIn("offline", package["missing"][0]["reason"])

    def test_attachment_must_exist_and_match(self) -> None:
        with self.assertRaisesRegex(PackageError, "不存在"):
            build_package(
                {"alpha": FakeDomain("alpha")},
                attachments=[{"name": "missing.pdf", "path": self.root / "nope"}],
            )
        attachment = self.root / "attachment.bin"
        attachment.write_bytes(b"payload")
        package = build_package(
            {"alpha": FakeDomain("alpha")},
            attachments=[{"name": "attachment.bin", "path": attachment}],
        )
        missing = validate_package(
            package, attachments_dir=self.root / "elsewhere"
        )["missingAttachments"]
        self.assertEqual(missing[0]["name"], "attachment.bin")
        attachment.write_bytes(b"changed!")
        with self.assertRaises(PackageIntegrityError):
            validate_package(package, attachments_dir=self.root)


class PreviewTests(FakeTestCase):
    def test_preview_aggregates_without_writing(self) -> None:
        alpha = FakeDomain("alpha", ["a"])
        beta = FakeDomain("beta", ["b"])
        package = build_package({"alpha": alpha, "beta": beta})
        target_alpha = FakeDomain("alpha")
        target_beta = FakeDomain("beta")
        result = preview_package_import(
            package, {"alpha": target_alpha, "beta": target_beta}
        )
        self.assertEqual(result["totals"], {"new": 2, "duplicate": 0, "conflict": 0})
        self.assertEqual(target_alpha.records, [])
        self.assertEqual(target_beta.records, [])
        self.assertEqual(result["domains"]["alpha"]["expectedRevision"], "n0")

    def test_missing_domain_and_missing_adapter_are_warned(self) -> None:
        broken = FakeDomain("beta")
        broken.export_error = "offline"
        package = build_package(
            {"alpha": FakeDomain("alpha", ["a"]), "beta": broken},
            allow_incomplete=True,
        )
        alpha = FakeDomain("alpha", ["a"])
        result = preview_package_import(package, {"alpha": alpha})
        self.assertEqual(result["domains"]["beta"]["state"], "missing")
        self.assertTrue(any("beta" in item for item in result["warnings"]))


class CommitTests(FakeTestCase):
    def test_commit_is_idempotent_for_the_same_batch(self) -> None:
        alpha = FakeDomain("alpha", ["a"])
        package = build_package({"alpha": alpha})
        batch = batch_id()
        first = commit_package_import(
            package, {"alpha": alpha}, self.journal, batch_id=batch
        )
        second = commit_package_import(
            package, {"alpha": alpha}, self.journal, batch_id=batch
        )
        self.assertEqual(first["state"], "committed")
        self.assertEqual(second, first)
        self.assertEqual(alpha.commits, [batch])
        self.assertEqual(self.journal.get(batch)["state"], "committed")

    def test_failed_domain_is_isolated_and_retry_resumes(self) -> None:
        alpha = FakeDomain("alpha", ["a"])
        beta = FakeDomain("beta", ["b"])
        beta.commit_error = "disk full"
        package = build_package({"alpha": alpha, "beta": beta})
        batch = batch_id()
        with self.assertRaises(PackageImportError) as raised:
            commit_package_import(
                package, {"alpha": alpha, "beta": beta}, self.journal, batch_id=batch
            )
        self.assertEqual(raised.exception.domain, "beta")
        self.assertEqual(raised.exception.committed, ("alpha",))
        record = self.journal.get(batch)
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["domains"]["alpha"]["state"], "committed")
        self.assertEqual(record["domains"]["beta"]["state"], "failed")

        beta.commit_error = None
        receipt = commit_package_import(
            package, {"alpha": alpha, "beta": beta}, self.journal, batch_id=batch
        )
        self.assertEqual(receipt["state"], "committed")
        self.assertEqual(alpha.commits, [batch])
        self.assertEqual(beta.commits, [batch, batch])
        self.assertEqual(alpha.records, ["a"])

    def test_batch_identifier_cannot_be_reused_for_another_package(self) -> None:
        alpha = FakeDomain("alpha", ["a"])
        batch = batch_id()
        commit_package_import(
            build_package({"alpha": alpha}), {"alpha": alpha}, self.journal, batch_id=batch
        )
        other = build_package({"alpha": FakeDomain("alpha", ["other"])})
        with self.assertRaises(BatchConflict):
            commit_package_import(
                other,
                {"alpha": FakeDomain("alpha", ["other"])},
                self.journal,
                batch_id=batch,
            )

    def test_bad_batch_identifier_is_rejected(self) -> None:
        alpha = FakeDomain("alpha", ["a"])
        with self.assertRaisesRegex(PackageError, "批次标识"):
            commit_package_import(
                build_package({"alpha": alpha}),
                {"alpha": alpha},
                self.journal,
                batch_id="not-a-batch",
            )

    def test_unavailable_domain_marks_batch_with_gaps(self) -> None:
        broken = FakeDomain("beta")
        broken.export_error = "offline"
        package = build_package(
            {"alpha": FakeDomain("alpha", ["a"]), "beta": broken},
            allow_incomplete=True,
        )
        alpha = FakeDomain("alpha", ["a"])
        receipt = commit_package_import(
            package, {"alpha": alpha}, self.journal, batch_id=batch_id()
        )
        self.assertEqual(receipt["state"], "committed_with_gaps")
        self.assertEqual(receipt["domains"]["beta"]["state"], "missing")
        self.assertTrue(receipt["warnings"])

    def test_verification_failure_is_recorded(self) -> None:
        alpha = FakeDomain("alpha", ["a"])
        alpha.verify_ok = False
        receipt = commit_package_import(
            build_package({"alpha": alpha}),
            {"alpha": alpha},
            self.journal,
            batch_id=batch_id(),
        )
        self.assertEqual(receipt["state"], "verification_failed")
        self.assertFalse(receipt["verification"]["alpha"]["ok"])

    def test_missing_attachment_blocks_commit(self) -> None:
        attachment = self.root / "kept.bin"
        attachment.write_bytes(b"x")
        package = build_package(
            {"alpha": FakeDomain("alpha")},
            attachments=[{"name": "kept.bin", "path": attachment}],
        )
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaisesRegex(PackageError, "缺少附件"):
            commit_package_import(
                package,
                {"alpha": FakeDomain("alpha")},
                self.journal,
                batch_id=batch_id(),
                attachments_dir=empty,
            )
        receipt = commit_package_import(
            package,
            {"alpha": FakeDomain("alpha")},
            self.journal,
            batch_id=batch_id(),
            attachments_dir=empty,
            allow_missing_attachments=True,
        )
        self.assertEqual(receipt["state"], "committed")

    def test_incomplete_batches_are_listed_for_recovery(self) -> None:
        broken = FakeDomain("alpha")
        broken.commit_error = "down"
        package = build_package({"alpha": broken})
        with self.assertRaises(PackageImportError):
            commit_package_import(
                package, {"alpha": broken}, self.journal, batch_id=batch_id()
            )
        pending = self.journal.incomplete()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["state"], "failed")


class RouteTests(FakeTestCase):
    def setUp(self) -> None:
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        self.adapters = {"alpha": FakeDomain("alpha", ["a"])}
        app = FastAPI()
        register_product_package_routes(
            app, self.adapters, self.journal.path, token="secret"
        )
        self.client = TestClient(app)

    def headers(self) -> dict:
        return {"Authorization": "Bearer secret"}

    def test_export_preview_commit_and_inspect(self) -> None:
        response = self.client.get("/product-data/package", headers=self.headers())
        self.assertEqual(response.status_code, 200)
        package = response.json()
        self.assertEqual(package["exportScope"]["domains"], ["alpha"])

        preview = self.client.post(
            "/product-data/import/preview",
            json={"package": package},
            headers=self.headers(),
        )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json()["totals"]["new"], 0)  # 导出源本身已有该记录

        batch = batch_id()
        target = FakeDomain("alpha")
        self.adapters["alpha"] = target  # 模拟导入目标实例尚无记录
        commit = self.client.post(
            "/product-data/import",
            json={"package": package, "batch_id": batch},
            headers=self.headers(),
        )
        self.assertEqual(commit.status_code, 200)
        self.assertEqual(commit.json()["state"], "committed")
        self.assertEqual(target.records, ["a"])

        stored = self.client.get(
            f"/product-data/imports/{batch}", headers=self.headers()
        )
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.json()["state"], "committed")
        missing = self.client.get("/product-data/imports/IMP_unknown", headers=self.headers())
        self.assertEqual(missing.status_code, 404)

    def test_authorization_and_invalid_package(self) -> None:
        self.assertEqual(self.client.get("/product-data/package").status_code, 401)
        response = self.client.post(
            "/product-data/import/preview",
            json={"package": {"format": "wrong"}},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 422)


class ResearchPartnerDomainTests(FakeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.source, self.source_service = build_service(self.root / "source.db")
        self.target, self.target_service = build_service(self.root / "target.db")
        self.context = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )

    def tearDown(self) -> None:
        self.source.close()
        self.target.close()
        super().tearDown()

    def test_round_trip_imports_mandates_as_paused(self) -> None:
        created = self.source_service.create(
            self.context,
            MandateCreateRequest(
                goal="跟踪茅台",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available", "event_type": "公告"}],
                contact_policy={"mode": "condition"},
                idempotency_key="idem_" + secrets.token_hex(8),
            ),
        )
        mandate_id = created["mandate"]["mandate_id"]
        source_domain = ResearchPartnerDomain(
            self.source, principal_id="user-1", instance_id="instance-1"
        )
        target_domain = ResearchPartnerDomain(
            self.target, principal_id="user-1", instance_id="instance-1"
        )
        package = build_package({"research-partner": source_domain})
        self.assertEqual(package["domains"]["research-partner"]["counts"]["mandates"], 1)
        preview = preview_package_import(
            package, {"research-partner": target_domain}
        )
        self.assertEqual(preview["totals"]["new"], 1)
        batch = batch_id()
        receipt = commit_package_import(
            package, {"research-partner": target_domain}, self.journal, batch_id=batch
        )
        self.assertEqual(receipt["state"], "committed")
        imported = self.target.get_mandate_internal(mandate_id)
        self.assertIsNotNone(imported)
        self.assertEqual(imported.status, "paused")
        replay = commit_package_import(
            package, {"research-partner": target_domain}, self.journal, batch_id=batch
        )
        self.assertEqual(replay, receipt)


class TradingCoreDomainTests(FakeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.source = JsonStore(self.root / "source")
        self.target = JsonStore(self.root / "target")
        self.source_notifications = NotificationRepository(self.root / "n1.sqlite3")
        self.target_notifications = NotificationRepository(self.root / "n2.sqlite3")

    def tearDown(self) -> None:
        super().tearDown()

    def test_round_trip_restores_holdings_and_trades(self) -> None:
        self.source.set(
            "holdings", "default", [{"ticker": "600519", "quantity": 100, "cost_price": 1500}]
        )
        self.source.set(
            "trades",
            "entries",
            [
                {
                    "ticker": "600519",
                    "side": "buy",
                    "price": 1500,
                    "quantity": 100,
                    "amount": 150000,
                    "traded_at": "2026-08-03T10:14:00",
                    "account_mode": "simulated",
                }
            ],
        )
        source_domain = TradingCoreDomain(
            lambda: self.source, notification_repository=self.source_notifications
        )
        target_domain = TradingCoreDomain(
            lambda: self.target, notification_repository=self.target_notifications
        )
        package = build_package({"trading-core": source_domain})
        self.assertEqual(package["domains"]["trading-core"]["schemaVersion"], "4")
        preview = preview_package_import(package, {"trading-core": target_domain})
        self.assertGreaterEqual(preview["totals"]["new"], 1)

        receipt = commit_package_import(
            package,
            {"trading-core": target_domain},
            self.journal,
            batch_id=batch_id(),
            resolutions={"trading-core": {"holdings": "use_import"}},
        )
        self.assertEqual(receipt["state"], "committed")
        self.assertEqual(self.target.get("holdings", "default")[0]["ticker"], "600519")
        self.assertEqual(len(self.target.get("trades", "entries")), 1)

    def test_export_covers_every_category(self) -> None:
        domain = TradingCoreDomain(
            lambda: self.source, notification_repository=self.source_notifications
        )
        exported = domain.export_domain()
        self.assertEqual(
            set(exported["payload"]["categories"]), set(CATEGORY_COLLECTIONS)
        )
        self.assertEqual(exported["schemaVersion"], "4")


if __name__ == "__main__":
    unittest.main()
