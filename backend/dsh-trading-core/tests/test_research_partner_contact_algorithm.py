# -*- coding: utf-8 -*-
"""消推算法测试：三值条件、联系约定、抑制与合并（V1.3 §5.6）。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_contact_algorithm -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from research_partner.api import create_app
from research_partner.commands import (
    MandateCreateRequest,
    NotificationPreferencesRequest,
    SnoozeCreateRequest,
)
from research_partner.conditions import condition_key_for, evaluate_condition
from research_partner.contact_policy import (
    ContactPolicyError,
    in_quiet_hours,
    parse_contact_policy,
    parse_quiet_hours,
    quiet_hours_until,
)
from research_partner.context import RequestContext
from research_partner.errors import InvalidRequest, NotFound
from research_partner.factory import build_service
from research_partner.models import (
    ContactRecord,
    EventEnvelope,
    ResearchJobResult,
    SnoozeEntry,
)
from research_partner.notifications import NotificationSettingsService
from research_partner.pipeline import PartnerPipeline
from research_partner.worker import StubResearchRunner

FIXED = datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)


def key() -> str:
    return "idem_" + secrets.token_hex(8)


def make_result(**overrides) -> ResearchJobResult:
    data = {
        "result_id": "RES_" + secrets.token_hex(16),
        "job_id": "JOB_" + secrets.token_hex(16),
        "run_id": "run-1",
        "outcome": "completed",
        "structured_result": {},
        "evidence_batch_id": None,
        "contact_suggestion": {},
        "received_at": FIXED,
    }
    data.update(overrides)
    return ResearchJobResult(**data)


def metric(value, *, unit="day", method_version="v1", period="2026Q3", source_ref="EV-1"):
    return {
        "value": value,
        "unit": unit,
        "method_version": method_version,
        "period": period,
        "source_ref": source_ref,
    }


TURNOVER = {
    "type": "numeric",
    "metric": "receivables_turnover_days",
    "operator": ">=",
    "threshold": 15,
    "transform": "difference",
    "baseline_metric": "baseline_receivables_turnover_days",
    "unit": "day",
    "method_version": "v1",
    "basis_ref": "user:2026-10-21",
}

TURNOVER_METRICS = {
    "receivables_turnover_days": metric(90, source_ref="EV-turnover"),
    "baseline_receivables_turnover_days": metric(70, source_ref="EV-baseline"),
}


class ConditionTests(unittest.TestCase):
    def test_numeric_difference_met(self) -> None:
        outcome = evaluate_condition(
            TURNOVER, make_result(structured_result={"metrics": TURNOVER_METRICS})
        )
        self.assertEqual(outcome.result, "met")
        self.assertIn("20", outcome.detail)
        self.assertEqual(outcome.evidence_refs, ("EV-turnover",))

    def test_numeric_difference_unmet(self) -> None:
        metrics = dict(TURNOVER_METRICS)
        metrics["receivables_turnover_days"] = metric(75)
        outcome = evaluate_condition(TURNOVER, make_result(structured_result={"metrics": metrics}))
        self.assertEqual(outcome.result, "unmet")

    def test_numeric_missing_baseline_is_unknown(self) -> None:
        metrics = {"receivables_turnover_days": metric(90)}
        outcome = evaluate_condition(TURNOVER, make_result(structured_result={"metrics": metrics}))
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("baseline_missing", outcome.detail)

    def test_numeric_unit_mismatch_is_unknown(self) -> None:
        metrics = dict(TURNOVER_METRICS)
        metrics["receivables_turnover_days"] = metric(90, unit="ratio")
        outcome = evaluate_condition(TURNOVER, make_result(structured_result={"metrics": metrics}))
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("unit_mismatch", outcome.detail)

    def test_numeric_method_version_mismatch_is_unknown(self) -> None:
        metrics = dict(TURNOVER_METRICS)
        metrics["receivables_turnover_days"] = metric(90, method_version="v2")
        outcome = evaluate_condition(TURNOVER, make_result(structured_result={"metrics": metrics}))
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("method_version_mismatch", outcome.detail)

    def test_numeric_without_basis_is_error(self) -> None:
        condition = {k: v for k, v in TURNOVER.items() if k != "basis_ref"}
        outcome = evaluate_condition(
            condition, make_result(structured_result={"metrics": TURNOVER_METRICS})
        )
        self.assertEqual(outcome.result, "error")
        self.assertIn("missing_basis", outcome.detail)

    def test_basis_can_come_from_revision_basis(self) -> None:
        condition = {k: v for k, v in TURNOVER.items() if k != "basis_ref"}
        outcome = evaluate_condition(
            condition,
            make_result(structured_result={"metrics": TURNOVER_METRICS}),
            basis={"metrics": {"receivables_turnover_days": {"basis_ref": "method:v1"}}},
        )
        self.assertEqual(outcome.result, "met")

    def test_numeric_ratio_transform(self) -> None:
        condition = {
            "type": "numeric",
            "metric": "inventory",
            "operator": ">",
            "threshold": 1.5,
            "transform": "ratio",
            "baseline_metric": "inventory_base",
            "basis_ref": "user:1",
        }
        metrics = {
            "inventory": metric(300),
            "inventory_base": metric(100),
        }
        outcome = evaluate_condition(condition, make_result(structured_result={"metrics": metrics}))
        self.assertEqual(outcome.result, "met")

    def test_numeric_baseline_zero_is_unknown(self) -> None:
        condition = {
            "type": "numeric",
            "metric": "inventory",
            "operator": ">",
            "threshold": 1.5,
            "transform": "ratio",
            "baseline_metric": "inventory_base",
            "basis_ref": "user:1",
        }
        metrics = {"inventory": metric(300), "inventory_base": metric(0)}
        outcome = evaluate_condition(condition, make_result(structured_result={"metrics": metrics}))
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("baseline_zero", outcome.detail)

    def test_semantic_met_with_evidence(self) -> None:
        condition = {"type": "semantic", "claim": "major_customer_loss", "expected": "met"}
        result = make_result(
            evidence_batch_id="EVB-1",
            structured_result={"evidence_ids": ["EV-1", "EV-2"]},
            contact_suggestion={
                "judgements": {
                    "major_customer_loss": {
                        "judgement": "met",
                        "confidence": 0.82,
                        "evidence_refs": ["EV-1"],
                        "reason": "前五大客户占比骤降",
                    }
                }
            },
        )
        outcome = evaluate_condition(condition, result)
        self.assertEqual(outcome.result, "met")
        self.assertEqual(outcome.evidence_refs, ("EV-1",))

    def test_semantic_evidence_not_in_batch_is_unknown(self) -> None:
        condition = {"type": "semantic", "claim": "major_customer_loss"}
        result = make_result(
            evidence_batch_id="EVB-1",
            structured_result={"evidence_ids": ["EV-1"]},
            contact_suggestion={
                "judgements": {
                    "major_customer_loss": {"judgement": "met", "evidence_refs": ["EV-9"]}
                }
            },
        )
        outcome = evaluate_condition(condition, result)
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("evidence_not_in_batch", outcome.detail)

    def test_semantic_without_batch_is_unknown(self) -> None:
        condition = {"type": "semantic", "claim": "major_customer_loss"}
        result = make_result(
            contact_suggestion={
                "judgements": {
                    "major_customer_loss": {"judgement": "met", "evidence_refs": ["EV-1"]}
                }
            }
        )
        outcome = evaluate_condition(condition, result)
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("evidence_batch_missing", outcome.detail)

    def test_semantic_low_confidence_is_unknown(self) -> None:
        condition = {"type": "semantic", "claim": "x", "min_confidence": 0.8}
        result = make_result(
            contact_suggestion={
                "judgements": {"x": {"judgement": "met", "confidence": 0.4}}
            }
        )
        outcome = evaluate_condition(condition, result)
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("low_confidence", outcome.detail)

    def test_semantic_invalid_judgement_is_error(self) -> None:
        condition = {"type": "semantic", "claim": "x"}
        result = make_result(
            contact_suggestion={"judgements": {"x": {"judgement": "probably"}}}
        )
        outcome = evaluate_condition(condition, result)
        self.assertEqual(outcome.result, "error")

    def test_composite_all_unknown_propagates(self) -> None:
        condition = {
            "type": "all",
            "conditions": [
                {"type": "numeric", **{k: v for k, v in TURNOVER.items() if k != "type"}},
                {"type": "semantic", "claim": "x"},
            ],
        }
        result = make_result(structured_result={"metrics": TURNOVER_METRICS})
        outcome = evaluate_condition(condition, result)
        self.assertEqual(outcome.result, "unknown")

    def test_composite_all_short_circuits_unmet(self) -> None:
        condition = {
            "type": "all",
            "conditions": [
                {"type": "semantic", "claim": "a"},
                {"type": "semantic", "claim": "b"},
            ],
        }
        result = make_result(
            contact_suggestion={
                "judgements": {
                    "a": {"judgement": "unmet"},
                    "b": {"judgement": "unknown"},
                }
            }
        )
        self.assertEqual(evaluate_condition(condition, result).result, "unmet")

    def test_composite_any_met(self) -> None:
        condition = {
            "type": "any",
            "conditions": [
                {"type": "semantic", "claim": "a"},
                {"type": "semantic", "claim": "b", "evidence_required": False},
            ],
        }
        result = make_result(
            contact_suggestion={
                "judgements": {"a": {"judgement": "unmet"}, "b": {"judgement": "met"}}
            }
        )
        self.assertEqual(evaluate_condition(condition, result).result, "met")

    def test_composite_not_inverts_but_keeps_unknown(self) -> None:
        condition = {
            "type": "not",
            "condition": {"type": "semantic", "claim": "a", "evidence_required": False},
        }
        met = make_result(contact_suggestion={"judgements": {"a": {"judgement": "met"}}})
        self.assertEqual(evaluate_condition(condition, met).result, "unmet")
        unknown = make_result(
            contact_suggestion={"judgements": {"a": {"judgement": "unknown"}}}
        )
        self.assertEqual(evaluate_condition(condition, unknown).result, "unknown")

    def test_default_condition_uses_contact_suggestion(self) -> None:
        send = evaluate_condition(None, make_result(contact_suggestion={"should_contact": True}))
        self.assertEqual(send.result, "met")
        quiet = evaluate_condition(None, make_result(contact_suggestion={"should_contact": False}))
        self.assertEqual(quiet.result, "unmet")
        missing = evaluate_condition(None, make_result())
        self.assertEqual(missing.result, "unknown")

    def test_condition_key_is_stable_and_content_based(self) -> None:
        policy = {"condition": TURNOVER}
        first = condition_key_for(policy)
        second = condition_key_for({"condition": dict(TURNOVER)})
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("cond:"))
        self.assertEqual(
            condition_key_for({"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}),
            condition_key_for({"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}),
        )


class PolicyTests(unittest.TestCase):
    def test_default_mode_is_condition(self) -> None:
        policy = parse_contact_policy({})
        self.assertEqual(policy.mode, "condition")
        self.assertIsNone(policy.condition)
        self.assertEqual(policy.channels, ("app",))
        self.assertEqual(policy.condition_key, "notable_change")

    def test_schedule_defaults_to_scheduled_delivery(self) -> None:
        policy = parse_contact_policy({"schedule": {"cron": "0 9 * * *"}})
        self.assertEqual(policy.mode, "scheduled_delivery")
        self.assertTrue(policy.delivers_without_change)

    def test_invalid_mode_rejected(self) -> None:
        with self.assertRaises(ContactPolicyError):
            parse_contact_policy({"mode": "whenever"})

    def test_invalid_seconds_rejected(self) -> None:
        with self.assertRaises(ContactPolicyError):
            parse_contact_policy({"cooldown_seconds": -1})

    def test_quiet_hours_cross_midnight(self) -> None:
        quiet = parse_quiet_hours({"start": "22:00", "end": "08:00"})
        # 上海时间 23:00，落在 22:00-08:00 内。
        at = datetime(2026, 10, 21, 15, 0, tzinfo=timezone.utc)
        self.assertTrue(in_quiet_hours(quiet, at, "Asia/Shanghai"))
        until = quiet_hours_until(quiet, at, "Asia/Shanghai")
        self.assertEqual(until, datetime(2026, 10, 22, 0, 0, tzinfo=timezone.utc))

    def test_quiet_hours_morning_segment(self) -> None:
        quiet = parse_quiet_hours({"start": "22:00", "end": "08:00"})
        at = datetime(2026, 10, 21, 23, 30, tzinfo=timezone.utc)  # 上海 07:30
        self.assertTrue(in_quiet_hours(quiet, at, "Asia/Shanghai"))

    def test_outside_quiet_hours(self) -> None:
        quiet = parse_quiet_hours({"start": "22:00", "end": "08:00"})
        at = datetime(2026, 10, 21, 2, 0, tzinfo=timezone.utc)  # 上海 10:00
        self.assertFalse(in_quiet_hours(quiet, at, "Asia/Shanghai"))
        self.assertIsNone(quiet_hours_until(quiet, at, "Asia/Shanghai"))

    def test_quiet_hours_days_filter(self) -> None:
        quiet = parse_quiet_hours({"start": "09:00", "end": "18:00", "days": [0]})
        monday = datetime(2026, 10, 19, 2, 0, tzinfo=timezone.utc)  # 上海周一 10:00
        tuesday = datetime(2026, 10, 20, 2, 0, tzinfo=timezone.utc)
        self.assertTrue(in_quiet_hours(quiet, monday, "Asia/Shanghai"))
        self.assertFalse(in_quiet_hours(quiet, tuesday, "Asia/Shanghai"))

    def test_bad_quiet_hours_rejected(self) -> None:
        with self.assertRaises(ContactPolicyError):
            parse_quiet_hours({"start": "25:00", "end": "08:00"})


class RecordingDispatcher:
    def __init__(self) -> None:
        self.decisions = []

    def dispatch(self, decision) -> ContactRecord:
        self.decisions.append(decision)
        return ContactRecord(
            decision_id=decision.decision_id,
            channel="app",
            status="queued",
            detail="recorded by test",
        )


class AlgorithmTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "algorithm.db"
        self.now = FIXED
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset(
                {"mandate:read", "mandate:write", "notification:read", "notification:write"}
            ),
        )
        self.dispatcher = RecordingDispatcher()
        self.pipeline = PartnerPipeline(
            self.store,
            runner=StubResearchRunner(now=lambda: self.now),
            dispatcher=self.dispatcher,
            now=lambda: self.now,
        )
        self.notifications = NotificationSettingsService(self.store, now=lambda: self.now)

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def advance(self, seconds: int) -> None:
        self.now = self.now + timedelta(seconds=seconds)

    def create_mandate(self, contact_policy: dict, **overrides) -> str:
        data = {
            "goal": "跟踪应收账款周转",
            "subjects": [{"entity_id": "company:600519"}],
            "triggers": [{"hook_type": "company.event_available"}],
            "contact_policy": contact_policy,
            "idempotency_key": key(),
        }
        data.update(overrides)
        response = self.service.create(self.ctx, MandateCreateRequest(**data))
        return response["mandate"]["mandate_id"]

    def baseline(self) -> None:
        self.pipeline.tick()
        self.dispatcher.decisions.clear()

    def next_job(self, event_id: str = None):
        event_id = event_id or "evt-" + secrets.token_hex(4)
        self.store.record_event(
            EventEnvelope(
                event_id=event_id,
                hook_type="company.event_available",
                producer="market-watch",
                occurred_at=self.now,
                observed_at=self.now,
                subject_ids=["company:600519"],
                payload={"title": "公告"},
            )
        )
        self.pipeline.publisher.publish()
        self.pipeline.router.route()
        jobs = self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now)
        event_jobs = [item for item in jobs if item.action == "event_review"]
        self.assertEqual(len(event_jobs), 1)
        return event_jobs[0]

    def retry_job_count(self) -> int:
        return self.store._connect().execute(
            "SELECT COUNT(*) FROM research_jobs WHERE action = 'condition_retry'"
        ).fetchone()[0]

    def submit(self, job, **overrides):
        data = {
            "run_id": "run-" + secrets.token_hex(4),
            "outcome": "completed",
            "structured_result": {},
            "contact_suggestion": {},
        }
        data.update(overrides)
        return self.pipeline.worker.submit_result(
            job.job_id, job.lease_token, **data
        )


class ContactDecisionTests(AlgorithmTestCase):
    def policy(self, **overrides) -> dict:
        data = {"mode": "condition", "condition": TURNOVER}
        data.update(overrides)
        return data

    def test_condition_met_sends_and_records_key(self) -> None:
        mandate_id = self.create_mandate(self.policy())
        self.baseline()
        decision = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(decision.decision, "send")
        self.assertEqual(decision.reason_code, "condition_met")
        self.assertEqual(decision.condition_result, "met")
        self.assertTrue(decision.condition_key.startswith("cond:"))
        self.assertEqual(decision.evidence_ref, "EV-turnover")
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_condition_unmet_stays_quiet(self) -> None:
        self.create_mandate(self.policy())
        self.baseline()
        metrics = dict(TURNOVER_METRICS)
        metrics["receivables_turnover_days"] = metric(71)
        decision = self.submit(
            self.next_job(), structured_result={"metrics": metrics}
        )
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "condition_unmet")
        self.assertEqual(decision.condition_result, "unmet")
        self.assertEqual(self.dispatcher.decisions, [])

    def test_unknown_defers_instead_of_silent(self) -> None:
        self.create_mandate(self.policy(unknown_retry_seconds=600))
        self.baseline()
        decision = self.submit(self.next_job(), structured_result={"metrics": {}})
        self.assertEqual(decision.decision, "defer")
        self.assertEqual(decision.reason_code, "condition_unknown")
        self.assertEqual(decision.condition_result, "unknown")
        self.assertEqual(decision.eligible_at, self.now + timedelta(seconds=600))
        self.assertIsNotNone(decision.expires_at)
        self.assertEqual(self.dispatcher.decisions, [])

    def test_unknown_schedules_bounded_retry(self) -> None:
        self.create_mandate(self.policy(unknown_retry_seconds=600, max_retries=1))
        self.baseline()
        before = self.retry_job_count()
        decision = self.submit(self.next_job(), structured_result={"metrics": {}})
        self.assertEqual(decision.decision, "defer")
        self.assertEqual(self.retry_job_count(), before + 1)
        row = self.store._connect().execute(
            "SELECT * FROM research_jobs WHERE action = 'condition_retry' "
            "ORDER BY created_at DESC, job_id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(row["next_run_at"], decision.eligible_at.isoformat())

        # 到达重试时间后仍为未知；已达上限，不再登记新的重试。
        self.now = decision.eligible_at
        self.pipeline.tick()
        self.assertEqual(self.retry_job_count(), before + 1)

    def test_condition_error_is_recorded_separately(self) -> None:
        policy = self.policy()
        policy["condition"] = {
            k: v for k, v in TURNOVER.items() if k != "basis_ref"
        }
        self.create_mandate(policy)
        self.baseline()
        decision = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "condition_error")
        self.assertEqual(decision.condition_result, "error")

    def test_periodic_check_unmet_is_silent(self) -> None:
        policy = {
            "mode": "periodic_check",
            "condition": {"type": "semantic", "claim": "x"},
            "schedule": {"cron": "0 9 * * *"},
        }
        self.create_mandate(policy)
        self.baseline()
        decision = self.submit(
            self.next_job(),
            contact_suggestion={"judgements": {"x": {"judgement": "unmet"}}},
        )
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "no_material_change")

    def test_scheduled_delivery_delivers_without_change(self) -> None:
        policy = {
            "mode": "scheduled_delivery",
            "condition": {"type": "semantic", "claim": "x"},
            "schedule": {"cron": "0 9 * * *"},
        }
        self.create_mandate(policy)
        self.baseline()
        decision = self.submit(
            self.next_job(),
            contact_suggestion={"judgements": {"x": {"judgement": "unmet"}}},
        )
        self.assertEqual(decision.decision, "send")
        self.assertEqual(decision.reason_code, "scheduled_delivery")
        self.assertEqual(decision.condition_result, "unmet")

    def test_due_reminder_delivers_without_research_condition(self) -> None:
        self.create_mandate(
            {"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}
        )
        self.baseline()
        decision = self.submit(self.next_job())
        self.assertEqual(decision.decision, "send")
        self.assertEqual(decision.reason_code, "due_reminder")
        self.assertEqual(decision.condition_result, "met")

    def test_snooze_suppresses_until_expiry(self) -> None:
        mandate_id = self.create_mandate(self.policy())
        self.baseline()
        self.store.create_snooze(
            SnoozeEntry(
                snooze_id="SNO_" + secrets.token_hex(16),
                principal_id="user-1",
                instance_id="instance-1",
                scope_type="mandate",
                scope_id=mandate_id,
                until=self.now + timedelta(hours=2),
                reason="开会中",
                created_at=self.now,
            )
        )
        decision = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "snoozed")
        self.assertEqual(decision.eligible_at, self.now + timedelta(hours=2))

        # 暂缓到期后恢复发送。
        self.advance(3 * 3600)
        later = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(later.decision, "send")

    def test_snooze_by_condition_key(self) -> None:
        self.create_mandate(self.policy())
        self.baseline()
        condition_key = parse_contact_policy(self.policy()).condition_key
        self.store.create_snooze(
            SnoozeEntry(
                snooze_id="SNO_" + secrets.token_hex(16),
                principal_id="user-1",
                instance_id="instance-1",
                scope_type="decision",
                scope_id=condition_key,
                until=self.now + timedelta(hours=1),
                created_at=self.now,
            )
        )
        decision = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(decision.reason_code, "snoozed")

    def test_cooldown_suppresses_second_send(self) -> None:
        self.create_mandate(self.policy(cooldown_seconds=3600))
        self.baseline()
        self.advance(7200)
        first = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(first.decision, "send")
        second = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(second.decision, "suppress")
        self.assertEqual(second.reason_code, "cooldown_active")
        self.assertEqual(second.eligible_at, first.created_at + timedelta(seconds=3600))

    def test_merge_window_aggregates(self) -> None:
        self.create_mandate(self.policy(merge_window_seconds=300))
        self.baseline()
        self.advance(7200)
        first = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(first.decision, "send")
        second = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(second.decision, "aggregate")
        self.assertEqual(second.reason_code, "merged_with_recent")
        self.assertIn(first.decision_id, second.detail)
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_quiet_hours_defer_until_window_end(self) -> None:
        policy = self.policy(
            quiet_hours={"start": "00:00", "end": "23:59"},
            channels=["app"],
        )
        self.create_mandate(policy)
        self.baseline()
        decision = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(decision.decision, "defer")
        self.assertEqual(decision.reason_code, "quiet_hours")
        self.assertIsNotNone(decision.eligible_at)
        self.assertEqual(self.dispatcher.decisions, [])

    def test_preferences_drive_quiet_hours(self) -> None:
        self.create_mandate(self.policy())
        self.notifications.save_preferences(
            self.ctx,
            NotificationPreferencesRequest(
                quiet_hours={"start": "00:00", "end": "23:59"}
            ),
        )
        self.baseline()
        decision = self.submit(
            self.next_job(), structured_result={"metrics": TURNOVER_METRICS}
        )
        self.assertEqual(decision.reason_code, "quiet_hours")

    def test_invalid_contact_policy_rejected_at_save(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create_mandate({"mode": "whenever"})

    def test_invalid_condition_definition_rejected_at_save(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create_mandate(
                {
                    "mode": "condition",
                    "condition": {
                        "type": "numeric",
                        "metric": "receivables_turnover_days",
                        "operator": ">=",
                        # 缺少 threshold
                    },
                }
            )


class NotificationSettingsTests(AlgorithmTestCase):
    def test_defaults_without_saved_preferences(self) -> None:
        view = self.notifications.get_preferences(self.ctx)["preferences"]
        self.assertEqual(view["channels"], ["app"])
        self.assertEqual(view["timezone"], "Asia/Shanghai")

    def test_save_and_reload_preferences(self) -> None:
        saved = self.notifications.save_preferences(
            self.ctx,
            NotificationPreferencesRequest(
                timezone="Asia/Shanghai",
                quiet_hours={"start": "22:00", "end": "08:00"},
                channels=["app", "email"],
            ),
        )["preferences"]
        self.assertEqual(saved["channels"], ["app", "email"])
        self.assertEqual(saved["quiet_hours"], {"start": "22:00", "end": "08:00"})
        reloaded = self.notifications.get_preferences(self.ctx)["preferences"]
        self.assertEqual(reloaded["channels"], ["app", "email"])

    def test_invalid_quiet_hours_rejected(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.notifications.save_preferences(
                self.ctx,
                NotificationPreferencesRequest(
                    quiet_hours={"start": "22:00", "end": "99:00"}
                ),
            )

    def test_snooze_requires_owned_mandate(self) -> None:
        with self.assertRaises(NotFound):
            self.notifications.create_snooze(
                self.ctx,
                SnoozeCreateRequest(
                    scope_type="mandate",
                    scope_id="MND_" + "0" * 32,
                    until=self.now + timedelta(hours=1),
                ),
            )

    def test_snooze_until_must_be_future(self) -> None:
        mandate_id = self.create_mandate({"mode": "condition"})
        with self.assertRaises(InvalidRequest):
            self.notifications.create_snooze(
                self.ctx,
                SnoozeCreateRequest(
                    scope_type="mandate",
                    scope_id=mandate_id,
                    until=self.now - timedelta(minutes=1),
                ),
            )

    def test_list_snoozes_active_only(self) -> None:
        mandate_id = self.create_mandate({"mode": "condition"})
        self.notifications.create_snooze(
            self.ctx,
            SnoozeCreateRequest(
                scope_type="mandate",
                scope_id=mandate_id,
                until=self.now + timedelta(hours=1),
            ),
        )
        self.assertEqual(len(self.notifications.list_snoozes(self.ctx)["items"]), 1)
        self.advance(2 * 3600)
        self.assertEqual(self.notifications.list_snoozes(self.ctx)["items"], [])
        self.assertEqual(
            len(self.notifications.list_snoozes(self.ctx, active_only=False)["items"]),
            1,
        )


class NotificationApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "api-algorithm.db"
        self._client_ctx = TestClient(create_app(store_path=path))
        self.client = self._client_ctx.__enter__()
        self.headers = {"X-Principal-Id": "user-1", "X-Instance-Id": "instance-1"}

    def tearDown(self) -> None:
        self._client_ctx.__exit__(None, None, None)
        self._tmp.cleanup()

    def test_preferences_roundtrip(self) -> None:
        created = self.client.get(
            "/research/notification/preferences", headers=self.headers
        )
        self.assertEqual(created.status_code, 200)
        saved = self.client.put(
            "/research/notification/preferences",
            json={
                "timezone": "Asia/Shanghai",
                "quiet_hours": {"start": "22:00", "end": "08:00"},
                "channels": ["app"],
            },
            headers=self.headers,
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["preferences"]["quiet_hours"]["start"], "22:00")

    def test_bad_quiet_hours_is_400(self) -> None:
        response = self.client.put(
            "/research/notification/preferences",
            json={"quiet_hours": {"start": "22:00", "end": "8pm"}},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)

    def test_snooze_lifecycle(self) -> None:
        created = self.client.post(
            "/research/mandates",
            json={
                "goal": "跟踪公告",
                "subjects": [{"entity_id": "company:600519"}],
                "triggers": [{"hook_type": "company.event_available"}],
                "idempotency_key": key(),
            },
            headers=self.headers,
        ).json()
        mandate_id = created["mandate"]["mandate_id"]
        until = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        response = self.client.post(
            "/research/notification/snoozes",
            json={
                "scope_type": "mandate",
                "scope_id": mandate_id,
                "until": until,
                "reason": "开会",
            },
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 201)
        listed = self.client.get(
            "/research/notification/snoozes", headers=self.headers
        )
        self.assertEqual(len(listed.json()["items"]), 1)


if __name__ == "__main__":
    unittest.main()
