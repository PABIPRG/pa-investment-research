import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from adapter.manual_trades import ManualTradeRequest, apply_trade, history
from adapter.store import JsonStore


class ManualTradesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JsonStore(Path(self.tmp.name))
        self.at = datetime.now(timezone.utc) - timedelta(minutes=5)

    def request(self, **kw):
        return ManualTradeRequest(**dict(dict(request_id="trade-001", ticker="002518", side="buy", quantity=100, price=10, fees=5, traded_at=self.at), **kw))

    def save(self, req):
        preview = apply_trade(self.store, req)
        return apply_trade(self.store, req.model_copy(update={"action": "commit", "version": preview["version"]}))

    def test_buy_sell_clear_and_history(self):
        self.assertEqual(self.save(self.request())["holdings"][0]["cost_price"], 10.05)
        bought = self.save(self.request(request_id="trade-002", price=20, fees=0, traded_at=self.at + timedelta(seconds=1)))
        self.assertEqual(bought["holdings"][0]["cost_price"], 15.025)
        sold = self.save(self.request(request_id="trade-003", side="sell", traded_at=self.at + timedelta(seconds=2)))
        self.assertEqual(sold["holdings"][0]["quantity"], 100)
        self.assertEqual(sold["holdings"][0]["cost_price"], 15.025)
        self.assertEqual(self.save(self.request(request_id="trade-004", side="sell", traded_at=self.at + timedelta(seconds=3)))["holdings"], [])
        self.assertEqual(len(history(JsonStore(Path(self.tmp.name)))["entries"]), 4)

    def test_preview_idempotence_and_conflicting_retry(self):
        req = self.request()
        p = apply_trade(self.store, req)
        self.assertEqual(self.store.all("holdings"), {})
        commit = req.model_copy(update={"action": "commit", "version": p["version"]})
        apply_trade(self.store, commit)
        apply_trade(self.store, commit)
        self.assertEqual(len(history(self.store)["entries"]), 1)
        with self.assertRaisesRegex(ValueError, "另一笔"):
            apply_trade(self.store, commit.model_copy(update={"price": req.price * 2}))

    def test_invalid_sell_time_and_stale_version(self):
        req = self.request()
        p = apply_trade(self.store, req)
        self.save(req)
        for values, message in [({"quantity": 101, "side": "sell"}, "超过"), ({"traded_at": self.at - timedelta(seconds=1)}, "确认"), ({"traded_at": datetime.now(timezone.utc) + timedelta(days=1)}, "晚于")]:
            with self.assertRaisesRegex(ValueError, message):
                apply_trade(self.store, self.request(request_id="trade-bad", **values))
        with self.assertRaisesRegex(ValueError, "发生变化"):
            apply_trade(self.store, self.request(request_id="trade-002", action="commit", version=p["version"]))

    def test_failure_does_not_save_half_transaction(self):
        from unittest.mock import patch
        req = self.request()
        p = apply_trade(self.store, req)
        with patch.object(self.store, "_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                apply_trade(self.store, req.model_copy(update={"action": "commit", "version": p["version"]}))
        self.assertEqual(self.store.all("holdings"), {})

    def test_snapshot_sync_keeps_history_and_blocks_older_trade(self):
        from adapter.portfolio_performance import record_holdings_snapshot
        self.save(self.request())
        at = datetime.now(timezone.utc) - timedelta(seconds=1)
        record_holdings_snapshot(self.store, [{"ticker": "002518", "quantity": 200, "cost_price": 12}], "broker_real", at)
        self.assertEqual(len(history(self.store)["entries"]), 1)
        with self.assertRaisesRegex(ValueError, "确认"):
            apply_trade(self.store, self.request(request_id="trade-002"))

    def test_older_trade_can_be_recorded_without_changing_current_holdings_or_snapshots(self):
        from adapter.portfolio_performance import record_holdings_snapshot
        self.save(self.request())
        record_holdings_snapshot(self.store, [{"ticker": "002518", "quantity": 200, "cost_price": 12}],
                                 "broker_real", datetime.now(timezone.utc) - timedelta(seconds=1))
        before = self.store.all("holdings")
        req = self.request(request_id="trade-history", side="sell", quantity=500,
                           traded_at=self.at - timedelta(days=1), affects_holdings=False)
        preview = apply_trade(self.store, req)
        self.assertTrue(preview["backdated"])
        self.assertEqual(preview["entry"]["before_quantity"], 200)
        self.assertEqual(preview["entry"]["after_quantity"], 200)
        self.assertEqual(self.store.all("holdings"), before)
        commit = req.model_copy(update={"action": "commit", "version": preview["version"]})
        saved = apply_trade(self.store, commit)
        self.assertTrue(saved["saved"])
        self.assertEqual(saved["holdings"], before["default"])
        after = self.store.all("holdings")
        self.assertEqual(after["snapshots"], before["snapshots"])
        self.assertEqual(after["default"], before["default"])
        self.assertFalse(after["manual_trades"][-1]["affects_holdings"])
        apply_trade(self.store, commit)
        self.assertEqual(len(self.store.get("holdings", "manual_trades")), 2)

    def test_explicit_older_trade_can_adjust_current_holdings_without_rewriting_snapshots(self):
        from adapter.portfolio_performance import record_holdings_snapshot
        record_holdings_snapshot(self.store, [{"ticker": "002518", "quantity": 200, "cost_price": 12}],
                                 "broker_real", datetime.now(timezone.utc) - timedelta(seconds=1))
        before = self.store.get("holdings", "snapshots")
        req = self.request(request_id="trade-adjust", traded_at=self.at - timedelta(days=1),
                           affects_holdings=True)
        preview = apply_trade(self.store, req)
        self.assertTrue(preview["backdated"])
        self.assertEqual(preview["entry"]["after_quantity"], 300)
        saved = apply_trade(self.store, req.model_copy(update={"action": "commit", "version": preview["version"]}))
        self.assertEqual(saved["holdings"][0]["quantity"], 300)
        snapshots = self.store.get("holdings", "snapshots")
        self.assertEqual(snapshots[:-1], before)
        self.assertEqual(snapshots[-1]["source"], "manual")

    def test_concurrent_commits_only_apply_one_preview(self):
        from concurrent.futures import ThreadPoolExecutor
        req1, req2 = self.request(), self.request(request_id="trade-002")
        version = apply_trade(self.store, req1)["version"]
        def commit(req):
            try:
                return apply_trade(self.store, req.model_copy(update={"action": "commit", "version": version}))["saved"]
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(commit, [req1, req2])), [False, True])
        self.assertEqual(self.store.get("holdings", "default")[0]["quantity"], 100)
