# -*- coding: utf-8 -*-
"""持仓止盈止损配置、激活与触发的领域回归测试。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from adapter.position_risk import (
    HttpMarketPriceRulePort,
    PositionRiskValidationError,
    accept_price_hit,
    delete_override,
    effective_plan,
    explicit_kyc_suggestion,
    reconcile,
    rearm,
    save_global_config,
    save_override,
    suggestion_for_profile,
    trigger_alert_items,
)
from adapter.store import JsonStore


class FakeRulePort:
    def __init__(self):
        self.upserts: list[dict] = []
        self.disabled: list[str] = []
        self.fail = False

    def upsert(self, rule: dict) -> None:
        if self.fail:
            raise RuntimeError("market-watch unavailable")
        self.upserts.append(rule)

    def disable(self, rule_id: str) -> None:
        self.disabled.append(rule_id)


class PositionRiskTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temporary.name))
        self.store.set(
            "holdings",
            "default",
            [{"ticker": "600519", "quantity": 100, "cost_price": 10}],
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_profile_suggestion_is_deterministic_and_unconfirmed(self):
        suggestion = suggestion_for_profile("balanced")

        self.assertEqual(suggestion["profile"], "balanced")
        self.assertFalse(suggestion["confirmed"])
        self.assertGreater(suggestion["take_profit_pct"], suggestion["stop_loss_pct"])

    @patch("requests.Session")
    def test_market_rule_http_port_ignores_environment_proxy(self, session_factory):
        session = session_factory.return_value
        session.put.return_value.raise_for_status.return_value = None
        session.delete.return_value.raise_for_status.return_value = None
        port = HttpMarketPriceRulePort("http://127.0.0.1:8100", "internal-token")

        port.upsert({"ticker": "600519", "kind": "take_profit"})
        port.disable("position-risk:600519:take_profit")

        self.assertFalse(session.trust_env)
        session.put.assert_called_once()
        session.delete.assert_called_once()

    def test_suggestion_requires_an_explicitly_completed_kyc(self):
        self.store.set("preferences", "risk_profile", "aggressive")
        self.assertIsNone(explicit_kyc_suggestion(self.store))

        self.store.set("preferences", "kyc", {"status": "completed", "inferred_profile": "aggressive"})
        suggestion = explicit_kyc_suggestion(self.store)

        self.assertIsNotNone(suggestion)
        self.assertEqual(suggestion["profile"], "aggressive")

    def test_global_config_is_single_and_effective_plan_is_resolved_without_override_copy(self):
        port = FakeRulePort()
        save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )

        config = self.store.all("position_risk_config")
        self.assertEqual(set(config), {"global", "overrides"})
        self.assertEqual(config["overrides"], {})
        plan = effective_plan(self.store, "600519")
        self.assertEqual(plan["source"], "global")
        self.assertEqual(plan["targets"]["take_profit"]["resolved_price"], 12)
        self.assertEqual(plan["targets"]["stop_loss"]["resolved_price"], 9)
        self.assertEqual(len(port.upserts), 2)

    def test_complete_override_wins_and_delete_restores_global(self):
        port = FakeRulePort()
        save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )
        save_override(
            self.store,
            "600519",
            {
                "take_profit": {"enabled": True, "mode": "price", "value": 15},
                "stop_loss": {"enabled": True, "mode": "percent", "value": 0.05},
                "confirmed": True,
            },
            port,
        )

        plan = effective_plan(self.store, "600519")
        self.assertEqual(plan["source"], "override")
        self.assertEqual(plan["targets"]["take_profit"]["resolved_price"], 15)
        self.assertEqual(plan["targets"]["stop_loss"]["resolved_price"], 9.5)

        delete_override(self.store, "600519", port)
        self.assertEqual(effective_plan(self.store, "600519")["source"], "global")

    def test_explicit_disable_prevents_global_inheritance(self):
        port = FakeRulePort()
        save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )
        save_override(
            self.store,
            "600519",
            {"monitoring_disabled": True, "confirmed": True},
            port,
        )

        plan = effective_plan(self.store, "600519")
        self.assertEqual(plan["status"], "disabled")
        self.assertEqual(plan["targets"], {})

    def test_cost_change_keeps_the_confirmed_activation_price(self):
        port = FakeRulePort()
        save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )
        self.store.set(
            "holdings",
            "default",
            [{"ticker": "600519", "quantity": 100, "cost_price": 11}],
        )

        reconcile(self.store, port)
        plan = effective_plan(self.store, "600519")
        self.assertEqual(plan["targets"]["take_profit"]["resolved_price"], 12)
        self.assertTrue(plan["basis_changed"])

    def test_sync_failure_keeps_config_and_reports_partial_success(self):
        port = FakeRulePort()
        port.fail = True

        result = save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )

        self.assertEqual(result["sync_status"], "error")
        self.assertEqual(self.store.all("position_risk_config")["global"]["version"], 1)

    def test_price_hit_is_authenticated_by_freshness_version_and_idempotency(self):
        port = FakeRulePort()
        save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )
        rule = next(item for item in port.upserts if item["kind"] == "take_profit")
        observed_at = datetime.now(timezone.utc).isoformat()
        event = {
            "event_id": "event-1",
            "ticker": "600519",
            "kind": "take_profit",
            "rule_id": rule["id"],
            "config_scope": rule["config_scope"],
            "config_version": rule["config_version"],
            "generation": rule["generation"],
            "price": 12.1,
            "observed_at": observed_at,
            "quote_source": "fixture",
            "freshness": "fresh",
        }

        accepted = accept_price_hit(self.store, event)
        duplicate = accept_price_hit(self.store, event)

        self.assertTrue(accepted["accepted"])
        self.assertTrue(duplicate["duplicate"])
        runtime = self.store.all("position_risk_runtime")
        self.assertEqual(runtime["activations"]["600519:take_profit"]["status"], "triggered")
        self.assertEqual(len(runtime["triggers"]), 1)

        stale = dict(event, event_id="event-2", freshness="stale")
        self.assertFalse(accept_price_hit(self.store, stale)["accepted"])
        alert = trigger_alert_items(self.store)[0]
        self.assertEqual(alert["source"], "position_plan")
        self.assertIn("不会执行交易", alert["detail"])

    def test_triggered_target_requires_explicit_rearm_for_a_new_generation(self):
        port = FakeRulePort()
        save_global_config(
            self.store,
            {"take_profit_pct": 0.2, "stop_loss_pct": 0.1, "confirmed": True},
            port,
        )
        rule = next(item for item in port.upserts if item["kind"] == "take_profit")
        accept_price_hit(self.store, {
            "event_id": "event-rearm-1", "ticker": "600519", "kind": "take_profit",
            "rule_id": rule["id"], "config_scope": rule["config_scope"],
            "config_version": rule["config_version"], "generation": rule["generation"],
            "price": 12.1, "observed_at": datetime.now(timezone.utc).isoformat(),
            "quote_source": "fixture", "freshness": "fresh",
        })

        result = rearm(self.store, "600519", "take_profit", port)

        self.assertEqual(result["activation"]["status"], "active")
        self.assertEqual(result["activation"]["generation"], 2)
        self.assertEqual(result["activation"]["resolved_price"], 12)

    def test_expired_config_cannot_activate(self):
        port = FakeRulePort()
        expired = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        save_global_config(
            self.store,
            {
                "take_profit_pct": 0.2,
                "stop_loss_pct": 0.1,
                "confirmed": True,
                "expires_at": expired,
            },
            port,
        )

        self.assertEqual(effective_plan(self.store, "600519")["status"], "expired")
        self.assertEqual(port.upserts, [])

    def test_scheduled_rule_is_projected_and_can_trigger_only_inside_its_window(self):
        port = FakeRulePort()
        effective_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        save_global_config(
            self.store,
            {
                "take_profit_pct": 0.2,
                "stop_loss_pct": 0.1,
                "confirmed": True,
                "effective_at": effective_at.isoformat(),
            },
            port,
        )
        rule = next(item for item in port.upserts if item["kind"] == "take_profit")
        self.assertEqual(effective_plan(self.store, "600519")["status"], "scheduled")

        early = accept_price_hit(self.store, {
            "event_id": "event-early", "ticker": "600519", "kind": "take_profit",
            "rule_id": rule["id"], "config_scope": rule["config_scope"],
            "config_version": rule["config_version"], "generation": rule["generation"],
            "price": 12.1, "observed_at": (effective_at - timedelta(seconds=1)).isoformat(),
            "quote_source": "fixture", "freshness": "fresh",
        })

        self.assertFalse(early["accepted"])
        self.assertEqual(early["reason"], "config_inactive")

        def activate(document):
            updated = dict(document)
            updated["global"] = {
                **updated["global"],
                "effective_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            }
            return updated

        self.store.mutate_document("position_risk_config", activate)
        accepted = accept_price_hit(self.store, {
            "event_id": "event-scheduled-active", "ticker": "600519", "kind": "take_profit",
            "rule_id": rule["id"], "config_scope": rule["config_scope"],
            "config_version": rule["config_version"], "generation": rule["generation"],
            "price": 12.1, "observed_at": datetime.now(timezone.utc).isoformat(),
            "quote_source": "fixture", "freshness": "fresh",
        })

        self.assertTrue(accepted["accepted"])
        self.assertEqual(
            self.store.all("position_risk_runtime")["activations"]["600519:take_profit"]["status"],
            "triggered",
        )

    def test_override_requires_a_holding_and_complete_targets(self):
        port = FakeRulePort()
        with self.assertRaises(PositionRiskValidationError):
            save_override(
                self.store,
                "000001",
                {"monitoring_disabled": True, "confirmed": True},
                port,
            )
        with self.assertRaises(PositionRiskValidationError):
            save_override(
                self.store,
                "600519",
                {"take_profit": {"enabled": True, "mode": "price", "value": 12}, "confirmed": True},
                port,
            )


if __name__ == "__main__":
    unittest.main()
