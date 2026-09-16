from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import market_watch.config as market_config
import market_watch.position_risk as position_risk
from market_watch.position_risk import (
    delete_rule,
    evaluate_and_deliver,
    list_rules,
    upsert_rule,
)
from market_watch.store import JsonStore


class PositionRiskProjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.store = JsonStore(Path(self.tmp.name))
        self.rule = {
            "id": "position-risk:600519:take_profit",
            "ticker": "600519",
            "kind": "take_profit",
            "operator": ">=",
            "target_price": 110.0,
            "config_scope": "global",
            "config_version": 2,
            "generation": 1,
            "effective_at": None,
            "expires_at": None,
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_upsert_replaces_same_stable_rule_without_duplicates(self):
        upsert_rule(self.store, self.rule)
        upsert_rule(self.store, {**self.rule, "target_price": 112.0, "generation": 2})
        rules = list_rules(self.store)
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["target_price"], 112.0)

    @patch("requests.Session")
    def test_trading_core_callback_ignores_environment_proxy(self, session_factory):
        session = session_factory.return_value
        session.post.return_value.json.return_value = {"accepted": True, "terminal": True}
        session.post.return_value.raise_for_status.return_value = None

        with (
            patch.object(market_config.settings, "position_risk_token", "internal-token"),
            patch.object(market_config.settings, "trading_core_url", "http://127.0.0.1:8000"),
        ):
            result = position_risk.deliver_to_trading_core({"event_id": "event-1"})

        self.assertFalse(session.trust_env)
        self.assertTrue(result["accepted"])
        session.post.assert_called_once()

    def test_stale_quote_never_creates_or_delivers_a_hit(self):
        upsert_rule(self.store, self.rule)
        calls = []
        result = evaluate_and_deliver(
            self.store,
            [{
                "code": "600519", "price": 120.0, "freshness": "stale",
                "observed_at": "2026-09-15T02:00:00+00:00", "quote_source": "cache",
            }],
            lambda event: calls.append(event),
        )
        self.assertEqual(result["triggered"], 0)
        self.assertEqual(calls, [])
        self.assertEqual(self.store.all("position_risk_deliveries"), {})

    def test_fresh_hit_is_persisted_before_callback_and_terminal_ack_disables_rule(self):
        upsert_rule(self.store, self.rule)
        observed_pending = []

        def callback(event):
            observed_pending.append(event["event_id"] in self.store.all("position_risk_deliveries"))
            return {"accepted": True, "terminal": True}

        result = evaluate_and_deliver(
            self.store,
            [{
                "code": "600519", "price": 120.0, "freshness": "fresh",
                "observed_at": "2026-09-15T02:00:00+00:00", "quote_source": "eastmoney",
            }],
            callback,
        )
        self.assertEqual(result["triggered"], 1)
        self.assertEqual(observed_pending, [True])
        self.assertEqual(list_rules(self.store), [])
        self.assertEqual(self.store.all("position_risk_deliveries"), {})

    def test_callback_failure_keeps_outbox_and_retries_without_new_quote(self):
        upsert_rule(self.store, self.rule)

        def failed(_event):
            raise ConnectionError("core unavailable")

        first = evaluate_and_deliver(
            self.store,
            [{
                "code": "600519", "price": 120.0, "freshness": "fresh",
                "observed_at": "2026-09-15T02:00:00+00:00", "quote_source": "eastmoney",
            }],
            failed,
        )
        self.assertEqual(first["pending"], 1)
        self.assertEqual(len(self.store.all("position_risk_deliveries")), 1)

        retried = evaluate_and_deliver(
            self.store,
            [],
            lambda _event: {"accepted": True, "terminal": True},
        )
        self.assertEqual(retried["delivered"], 1)
        self.assertEqual(self.store.all("position_risk_deliveries"), {})

    def test_delete_is_idempotent(self):
        upsert_rule(self.store, self.rule)
        self.assertTrue(delete_rule(self.store, self.rule["id"]))
        self.assertFalse(delete_rule(self.store, self.rule["id"]))


if __name__ == "__main__":
    unittest.main()
