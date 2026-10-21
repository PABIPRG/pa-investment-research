# -*- coding: utf-8 -*-
"""迁移演练：空目标、完整核对、拒绝覆盖已有数据。

运行：
    env/Scripts/python.exe -m unittest tests.test_migration_rehearsal -v
"""

from __future__ import annotations

import gc
import tempfile
import unittest
from pathlib import Path

from adapter.data_transfer import CATEGORY_COLLECTIONS
from adapter.migration_rehearsal import RehearsalError, rehearse_package_import
from adapter.notifications.repository import NotificationRepository
from adapter.product_package import (
    DomainAdapter,
    PackageJournal,
    TradingCoreDomain,
)
from adapter.store import JsonStore


class FakeDomain(DomainAdapter):
    name = "alpha"
    supported_schema_major = "1"

    def __init__(self, records: list[str] | None = None) -> None:
        self.records = list(records or [])
        self.verify_ok = True

    def export_domain(self) -> dict:
        return {
            "payload": {"records": list(self.records)},
            "schemaVersion": "1.0",
            "consistencyVersion": f"n{len(self.records)}",
            "counts": {"records": len(self.records)},
        }

    def preview(self, payload: dict) -> dict:
        return {"counts": {"new": len(payload["records"]), "duplicate": 0, "conflict": 0}}

    def commit(self, payload, *, batch_id, resolutions, expected_revision=None) -> dict:
        for record in payload["records"]:
            if record not in self.records:
                self.records.append(record)
        return {"status": "applied"}

    def verify(self, payload: dict) -> dict:
        missing = [item for item in payload["records"] if item not in self.records]
        return {"ok": self.verify_ok and not missing, "missing": missing}

    def is_empty(self) -> bool:
        return not self.records


class RehearsalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.journal = PackageJournal(self.root / "journal.sqlite3")

    def tearDown(self) -> None:
        self.journal.close()
        gc.collect()
        self.temporary.cleanup()

    def test_rehearsal_reports_source_preview_and_verification(self) -> None:
        source = FakeDomain(["a", "b"])
        target = FakeDomain()
        report = rehearse_package_import(
            {"alpha": source},
            {"alpha": target},
            self.journal,
            batch_id="IMP_" + "a" * 24,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["source"]["alpha"]["counts"], {"records": 2})
        self.assertEqual(report["preview"]["totals"]["new"], 2)
        self.assertEqual(report["result"]["state"], "committed")
        self.assertEqual(target.records, ["a", "b"])
        self.assertEqual(source.records, ["a", "b"])

    def test_non_empty_target_is_refused_before_writing(self) -> None:
        source = FakeDomain(["a"])
        target = FakeDomain(["existing"])
        with self.assertRaises(RehearsalError) as raised:
            rehearse_package_import(
                {"alpha": source}, {"alpha": target}, self.journal, batch_id="IMP_" + "b" * 24
            )
        self.assertEqual(raised.exception.report["reason"], "target_not_empty")
        self.assertEqual(target.records, ["existing"])

    def test_verification_failure_fails_the_rehearsal(self) -> None:
        target = FakeDomain()
        target.verify_ok = False
        with self.assertRaises(RehearsalError) as raised:
            rehearse_package_import(
                {"alpha": FakeDomain(["a"])},
                {"alpha": target},
                self.journal,
                batch_id="IMP_" + "c" * 24,
            )
        self.assertEqual(raised.exception.report["result"]["state"], "verification_failed")

    def test_missing_target_adapter_is_refused(self) -> None:
        with self.assertRaises(RehearsalError) as raised:
            rehearse_package_import(
                {"alpha": FakeDomain(["a"])}, {}, self.journal, batch_id="IMP_" + "d" * 24
            )
        self.assertEqual(raised.exception.report["reason"], "missing_target_adapter")

    def test_trading_core_rehearsal_restores_holdings_and_trades(self) -> None:
        source = JsonStore(self.root / "source")
        target = JsonStore(self.root / "target")
        source_notifications = NotificationRepository(self.root / "sn.sqlite3")
        target_notifications = NotificationRepository(self.root / "tn.sqlite3")
        source.set(
            "holdings", "default", [{"ticker": "600519", "quantity": 100, "cost_price": 1500}]
        )
        source.set(
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
        report = rehearse_package_import(
            {
                "trading-core": TradingCoreDomain(
                    lambda: source, notification_repository=source_notifications
                )
            },
            {
                "trading-core": TradingCoreDomain(
                    lambda: target, notification_repository=target_notifications
                )
            },
            self.journal,
            batch_id="IMP_" + "e" * 24,
            resolutions={
                "trading-core": {
                    category: "use_import" for category in CATEGORY_COLLECTIONS
                }
            },
        )
        self.assertTrue(report["ok"])
        self.assertEqual(target.get("holdings", "default")[0]["ticker"], "600519")
        self.assertEqual(len(target.get("trades", "entries")), 1)


if __name__ == "__main__":
    unittest.main()
