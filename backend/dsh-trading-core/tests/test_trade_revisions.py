# -*- coding: utf-8 -*-
"""成交修订：修改/撤销、时间更正、从最早受影响位置重算与事实修订事件。

运行：
    env/Scripts/python.exe -m unittest tests.test_trade_revisions -v
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from adapter.investment_events import pending_events, publish_pending
from adapter.manual_trades import ManualTradeRequest, apply_trade
from adapter.portfolio_performance import record_holdings_snapshot
from adapter.store import JsonStore
from adapter.trade_revisions import (
    TradeRevisionRequest,
    apply_revision,
    revision_history,
)

FIXED = datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)
T0 = FIXED - timedelta(hours=2)
TICKER = "002518"


class RevisionTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonStore(Path(self.tmp.name))

    def save_trade(self, *, request_id="trade-001", **overrides):
        data = {
            "request_id": request_id,
            "ticker": TICKER,
            "side": "buy",
            "quantity": 100,
            "price": 10,
            "fees": 5,
            "traded_at": T0,
            "affects_holdings": True,
        }
        data.update(overrides)
        req = ManualTradeRequest(**data)
        preview = apply_trade(self.store, req, )
        return apply_trade(
            self.store,
            req.model_copy(update={"action": "commit", "version": preview["version"]}),
        )

    def revision(self, target, **overrides) -> TradeRevisionRequest:
        data = {
            "revision_id": "rev-0001",
            "trade_request_id": target,
            "operation": "amend",
        }
        data.update(overrides)
        return TradeRevisionRequest(**data)

    def preview(self, req):
        return apply_revision(self.store, req)

    def commit(self, req, *, now=FIXED):
        preview = self.preview(req)
        return apply_revision(
            self.store,
            req.model_copy(update={"action": "commit", "version": preview["version"]}),
            now=now,
        )

    def position(self):
        holdings = self.store.get("holdings", "default", []) or []
        return next((item for item in holdings if item["ticker"] == TICKER), None)

    def document(self):
        return self.store.all("holdings")


class AmendTests(RevisionTestCase):
    def test_amend_price_recalculates_without_adding_a_trade(self) -> None:
        self.save_trade()
        self.save_trade(request_id="trade-002", price=20, fees=0, traded_at=T0 + timedelta(seconds=1))

        result = self.commit(self.revision("trade-002", price=10), now=FIXED)

        self.assertTrue(result["saved"])
        self.assertEqual(self.position()["quantity"], 200)
        self.assertAlmostEqual(self.position()["cost_price"], 10.025)
        entries = self.store.get("holdings", "manual_trades")
        self.assertEqual(len(entries), 2)
        revised = next(item for item in entries if item["request_id"] == "trade-002")
        self.assertEqual(revised["price"], 10.0)
        self.assertEqual(revised["revision_no"], 1)
        self.assertEqual(revised["revision_ids"], ["rev-0001"])
        self.assertEqual(float(revised["request"]["price"]), 20.0)  # 原请求保留
        self.assertEqual(len(revision_history(self.store)), 1)

    def test_amend_records_three_times_and_changes(self) -> None:
        self.save_trade()
        original = self.store.get("holdings", "manual_trades")[0]
        self.assertIn("recorded_at", original)
        self.assertIn("occurred_at", original)

        corrected = T0 - timedelta(minutes=30)
        result = self.commit(
            self.revision("trade-001", quantity=200, traded_at=corrected), now=FIXED
        )
        revision = result["revision"]
        self.assertEqual(revision["occurred_at"], corrected.isoformat())
        self.assertEqual(revision["recorded_at"], original["recorded_at"])
        self.assertEqual(revision["revised_at"], FIXED.isoformat())
        self.assertEqual(revision["changes"]["quantity"], [100.0, 200.0])
        self.assertEqual(revision["changes"]["traded_at"], [T0.isoformat(), corrected.isoformat()])

    def test_void_removes_the_trade_but_keeps_the_record(self) -> None:
        self.save_trade()
        self.save_trade(request_id="trade-002", price=20, fees=0, traded_at=T0 + timedelta(seconds=1))

        result = self.commit(self.revision("trade-002", operation="void"), now=FIXED)

        self.assertEqual(self.position()["quantity"], 100)
        self.assertAlmostEqual(self.position()["cost_price"], 10.05)
        entries = self.store.get("holdings", "manual_trades")
        self.assertEqual(len(entries), 2)
        voided = next(item for item in entries if item["request_id"] == "trade-002")
        self.assertTrue(voided["voided"])
        self.assertEqual(voided["voided_at"], FIXED.isoformat())
        self.assertEqual(revision_history(self.store)[0]["operation"], "void")

    def test_cannot_revise_an_already_voided_trade(self) -> None:
        self.save_trade()
        self.commit(self.revision("trade-001", operation="void"), now=FIXED)
        with self.assertRaisesRegex(ValueError, "已经撤销"):
            self.commit(
                self.revision("trade-001", revision_id="rev-0002", quantity=50), now=FIXED
            )

    def test_ticker_change_is_rejected(self) -> None:
        self.save_trade()
        with self.assertRaisesRegex(ValueError, "股票代码"):
            self.preview(self.revision("trade-001", ticker="600519"))

    def test_noop_amendment_is_rejected(self) -> None:
        self.save_trade()
        with self.assertRaisesRegex(ValueError, "没有改变"):
            self.preview(self.revision("trade-001", price=10))

    def test_unknown_trade_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "找不到"):
            self.preview(self.revision("missing-trade", quantity=1))

    def test_idempotent_retry_applies_once(self) -> None:
        self.save_trade()
        req = self.revision("trade-001", quantity=50)
        self.commit(req, now=FIXED)
        self.commit(req, now=FIXED)

        document = self.document()
        self.assertEqual(len(document["trade_revisions"]), 1)
        self.assertEqual(len(document["investment_outbox"]), 1)
        self.assertEqual(self.position()["quantity"], 50)

        with self.assertRaisesRegex(ValueError, "另一次修订"):
            self.preview(self.revision("trade-001", quantity=70))

    def test_stale_version_is_rejected(self) -> None:
        self.save_trade()
        preview = self.preview(self.revision("trade-001", quantity=50))
        self.save_trade(request_id="trade-002", price=20, traded_at=T0 + timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "发生变化"):
            apply_revision(
                self.store,
                self.revision("trade-001", quantity=50).model_copy(
                    update={"action": "commit", "version": preview["version"]}
                ),
            )

    def test_failed_write_keeps_document_unchanged(self) -> None:
        self.save_trade()
        before = self.document()
        req = self.revision("trade-001", quantity=50)
        preview = self.preview(req)
        with patch.object(self.store, "_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                apply_revision(
                    self.store,
                    req.model_copy(update={"action": "commit", "version": preview["version"]}),
                )
        self.assertEqual(self.document(), before)


class TimeCorrectionTests(RevisionTestCase):
    def test_sell_time_moved_after_a_later_buy(self) -> None:
        self.save_trade()  # buy 100 @10.05
        self.save_trade(
            request_id="trade-002", side="sell", quantity=50, price=12, fees=0,
            traded_at=T0 + timedelta(seconds=1), affects_holdings=True,
        )
        self.save_trade(
            request_id="trade-003", price=20, fees=0, traded_at=T0 + timedelta(seconds=2)
        )
        # 原顺序：买100 → 卖50（成本不变）→ 买100，成本 (50*10.05+2000)/150
        self.assertAlmostEqual(self.position()["cost_price"], 16.683333, places=5)

        # 把卖出时间改到最后：先买满 200 再卖 50，成本回到 15.025。
        self.commit(
            self.revision(
                "trade-002", revision_id="rev-time-01", traded_at=T0 + timedelta(seconds=3)
            ),
            now=FIXED,
        )
        self.assertEqual(self.position()["quantity"], 150)
        self.assertAlmostEqual(self.position()["cost_price"], 15.025)

    def test_negative_position_gap_blocks_holdings_update(self) -> None:
        self.save_trade()
        self.save_trade(
            request_id="trade-002", side="sell", quantity=100, price=12, fees=0,
            traded_at=T0 + timedelta(seconds=1),
        )
        self.assertIsNone(self.position())

        preview = self.preview(self.revision("trade-001", quantity=50))
        codes = [gap["code"] for gap in preview["gaps"]]
        self.assertIn("negative_position", codes)
        self.assertFalse(preview["impact"]["reliable"])

        with self.assertRaisesRegex(ValueError, "历史缺口"):
            self.commit(self.revision("trade-001", quantity=50), now=FIXED)

    def test_record_only_commit_keeps_holdings_and_snapshots(self) -> None:
        self.save_trade()
        before_default = self.store.get("holdings", "default")
        before_snapshots = self.store.get("holdings", "snapshots")

        result = self.commit(
            self.revision("trade-001", price=12, affects_holdings=False), now=FIXED
        )

        self.assertTrue(result["saved"])
        self.assertEqual(self.store.get("holdings", "default"), before_default)
        self.assertEqual(self.store.get("holdings", "snapshots"), before_snapshots)
        self.assertEqual(self.store.get("holdings", "manual_trades")[0]["price"], 12.0)
        self.assertTrue(result["revision"]["affects_holdings"] is False)

    def test_trade_before_opening_snapshot_is_reported(self) -> None:
        record_holdings_snapshot(
            self.store, [{"ticker": TICKER, "quantity": 200, "cost_price": 12}],
            "broker_real", FIXED - timedelta(hours=1),
        )
        request = ManualTradeRequest(
            request_id="trade-old", ticker=TICKER, side="buy", quantity=10, price=9,
            fees=0, traded_at=FIXED - timedelta(hours=3), affects_holdings=False,
        )
        preview = apply_trade(self.store, request)
        apply_trade(
            self.store,
            request.model_copy(update={"action": "commit", "version": preview["version"]}),
        )

        result = self.preview(self.revision("trade-old", quantity=20))
        codes = [gap["code"] for gap in result["gaps"]]
        self.assertIn("trades_before_opening_snapshot", codes)
        advisory = next(
            gap for gap in result["gaps"] if gap["code"] == "trades_before_opening_snapshot"
        )
        self.assertEqual(advisory["severity"], "advisory")
        # 只补记录的修订不改变当前持仓；缺口作为待补充项展示，不阻断提交。
        committed = self.commit(self.revision("trade-old", quantity=20), now=FIXED)
        self.assertTrue(committed["saved"])
        self.assertEqual(self.position()["quantity"], 200)

    def test_external_snapshot_after_the_trade_is_the_current_truth(self) -> None:
        self.save_trade()
        record_holdings_snapshot(
            self.store, [{"ticker": TICKER, "quantity": 180, "cost_price": 11}],
            "broker_real", FIXED - timedelta(minutes=30),
        )
        # 券商快照晚于成交，当前持仓以券商为准；修订历史成交不改变当前持仓。
        result = self.commit(self.revision("trade-001", price=15), now=FIXED)
        self.assertEqual(result["impact"]["current"]["quantity"], 180)
        self.assertEqual(self.position()["quantity"], 180)
        self.assertAlmostEqual(self.position()["cost_price"], 11)


class FactsEventTests(RevisionTestCase):
    def test_revision_is_in_the_same_commit_as_the_event(self) -> None:
        self.save_trade()
        result = self.commit(
            self.revision("trade-001", quantity=80, reason="录错了数量"), now=FIXED
        )

        document = self.document()
        self.assertEqual(len(document["trade_revisions"]), 1)
        self.assertEqual(len(document["investment_outbox"]), 1)
        event = document["investment_outbox"][0]
        self.assertEqual(event["event_id"], "facts-rev:rev-0001")
        self.assertEqual(event["hook_type"], "investment.facts_revised")
        self.assertEqual(event["subject_ids"], [f"company:{TICKER}"])
        self.assertEqual(event["payload"]["feature_key"], f"holding:{TICKER}")
        self.assertEqual(event["payload"]["operation"], "amend")
        self.assertEqual(event["payload"]["changes"]["quantity"], [100.0, 80.0])
        self.assertEqual(event["payload"]["revised_at"], FIXED.isoformat())
        self.assertEqual(result["revision"]["reason"], "录错了数量")

    def test_publish_is_idempotent_and_marks_published(self) -> None:
        from research_partner.factory import build_service

        self.save_trade()
        self.commit(self.revision("trade-001", quantity=80), now=FIXED)

        partner_store, _ = build_service(Path(self.tmp.name) / "partner.db")
        self.addCleanup(partner_store.close)

        first = publish_pending(self.store, partner_store)
        second = publish_pending(self.store, partner_store)
        self.assertEqual(first["published"], 1)
        self.assertEqual(second["published"], 0)
        self.assertEqual(pending_events(self.store), [])
        self.assertEqual(
            partner_store.get_event("facts-rev:rev-0001").hook_type,
            "investment.facts_revised",
        )


class PartnerRoutingTests(RevisionTestCase):
    def test_only_mandates_depending_on_the_fact_are_reviewed(self) -> None:
        from research_partner.commands import MandateCreateRequest
        from research_partner.context import RequestContext
        from research_partner.factory import build_service
        from research_partner.pipeline import PartnerPipeline

        partner_store, service = build_service(Path(self.tmp.name) / "partner.db")
        self.addCleanup(partner_store.close)
        ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )

        def create(feature_key: str, subject: str) -> str:
            response = service.create(
                ctx,
                MandateCreateRequest(
                    goal="持仓变化后复核",
                    subjects=[{"entity_id": subject}],
                    triggers=[
                        {
                            "hook_type": "investment.facts_revised",
                            "feature_key": feature_key,
                        }
                    ],
                    contact_policy={"mode": "condition"},
                    idempotency_key="idem-" + feature_key.replace(":", "-"),
                ),
            )
            return response["mandate"]["mandate_id"]

        matching = create(f"holding:{TICKER}", f"company:{TICKER}")
        create("holding:600519", f"company:{TICKER}")

        self.save_trade()
        self.commit(self.revision("trade-001", quantity=80), now=FIXED)
        publish_pending(self.store, partner_store)

        pipeline = PartnerPipeline(partner_store, now=lambda: FIXED)
        pipeline.publisher.publish()
        created = pipeline.router.route()
        self.assertEqual(created, 1)

        jobs = partner_store.claim_jobs(limit=10, lease_seconds=60, now=FIXED)
        facts_jobs = [job for job in jobs if job.trigger_event_id == "facts-rev:rev-0001"]
        self.assertEqual(len(facts_jobs), 1)
        self.assertEqual(facts_jobs[0].mandate_id, matching)


if __name__ == "__main__":
    unittest.main()
