# -*- coding: utf-8 -*-
"""历史位置条件与时间状态测试（V1.3 §5.8 C03/C04/C11）。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_history_state -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from research_partner.commands import MandateCreateRequest
from research_partner.conditions import (
    ConditionDefinitionError,
    condition_key_for,
    evaluate_condition,
    validate_condition_definition,
)
from research_partner.context import RequestContext
from research_partner.errors import InvalidRequest
from research_partner.factory import build_service
from research_partner.models import ContactRecord, EventEnvelope, ResearchJobResult
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
        "received_at": FIXED,
    }
    data.update(overrides)
    return ResearchJobResult(**data)


def series(values, *, unit="CNY", source_ref="EV-quote"):
    return {
        "points": [
            {"date": f"2026-01-{index + 1:02d}", "value": value}
            for index, value in enumerate(values)
        ],
        "unit": unit,
        "method_version": "v1",
        "source_ref": source_ref,
    }


class PercentileTests(unittest.TestCase):
    def condition(self, **overrides):
        data = {
            "type": "percentile",
            "series": "close",
            "window": 250,
            "min_samples": 5,
            "operator": "<=",
            "threshold": 20,
            "basis_ref": "user:2026-10-21",
        }
        data.update(overrides)
        return data

    def result(self, values, **entry):
        return make_result(
            structured_result={"series": {"close": series(values, **entry)}}
        )

    def test_low_percentile_is_met(self) -> None:
        # 从 100 一路回落到 10：当前值处于窗口最低端。
        outcome = evaluate_condition(
            self.condition(), self.result(list(range(100, 9, -10)))
        )
        self.assertEqual(outcome.result, "met")
        self.assertIn("10%", outcome.detail)
        self.assertEqual(outcome.evidence_refs, ("EV-quote",))

    def test_high_percentile_is_met(self) -> None:
        outcome = evaluate_condition(
            self.condition(operator=">=", threshold=95),
            self.result(list(range(10, 101, 10))),
        )
        self.assertEqual(outcome.result, "met")

    def test_high_percentile_against_low_threshold_is_unmet(self) -> None:
        outcome = evaluate_condition(
            self.condition(operator="<=", threshold=20),
            self.result(list(range(10, 101, 10))),
        )
        self.assertEqual(outcome.result, "unmet")

    def test_ties_count_as_less_or_equal(self) -> None:
        outcome = evaluate_condition(
            self.condition(threshold=100, min_samples=2), self.result([10, 10, 20])
        )
        self.assertEqual(outcome.result, "met")
        self.assertIn("100%", outcome.detail)

    def test_window_only_uses_recent_points(self) -> None:
        # 窗口 5：只看最后 5 个点（6..10），当前 10 的分位是 100%。
        outcome = evaluate_condition(
            self.condition(window=5, min_samples=5, threshold=100),
            self.result([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        )
        self.assertEqual(outcome.result, "met")
        self.assertIn("样本 5", outcome.detail)

    def test_insufficient_samples_is_unknown(self) -> None:
        outcome = evaluate_condition(
            self.condition(min_samples=50), self.result([1, 2, 3])
        )
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("insufficient_samples", outcome.detail)

    def test_missing_series_is_unknown(self) -> None:
        outcome = evaluate_condition(self.condition(), make_result())
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("series_missing", outcome.detail)

    def test_unit_mismatch_is_unknown(self) -> None:
        outcome = evaluate_condition(
            self.condition(unit="USD"), self.result(list(range(1, 11)))
        )
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("unit_mismatch", outcome.detail)

    def test_missing_basis_is_error(self) -> None:
        condition = self.condition()
        condition.pop("basis_ref")
        outcome = evaluate_condition(condition, self.result(list(range(1, 11))))
        self.assertEqual(outcome.result, "error")
        self.assertIn("missing_basis", outcome.detail)

    def test_non_numeric_point_is_unknown(self) -> None:
        result = make_result(
            structured_result={
                "series": {"close": {"points": [1, 2, "oops"]}}
            }
        )
        outcome = evaluate_condition(self.condition(min_samples=2), result)
        self.assertEqual(outcome.result, "unknown")
        self.assertIn("series_invalid", outcome.detail)


class DrawdownTests(unittest.TestCase):
    def condition(self, **overrides):
        data = {
            "type": "drawdown",
            "series": "close",
            "min_samples": 2,
            "operator": "<=",
            "threshold": -20,
            "basis_ref": "user:2026-10-21",
        }
        data.update(overrides)
        return data

    def result(self, values):
        return make_result(
            structured_result={"series": {"close": series(values)}}
        )

    def test_drawdown_depth_met(self) -> None:
        outcome = evaluate_condition(self.condition(), self.result([100, 120, 90]))
        self.assertEqual(outcome.result, "met")
        self.assertIn("-25%", outcome.detail)

    def test_shallow_drawdown_unmet(self) -> None:
        outcome = evaluate_condition(self.condition(), self.result([100, 95]))
        self.assertEqual(outcome.result, "unmet")

    def test_peak_inside_window(self) -> None:
        # 峰值在窗口内即可；窗口外的更高峰值不参与。
        outcome = evaluate_condition(
            self.condition(window=2, threshold=-5), self.result([200, 100, 90])
        )
        self.assertEqual(outcome.result, "met")
        self.assertIn("-10%", outcome.detail)


class DefinitionValidationTests(unittest.TestCase):
    def test_valid_definition_passes(self) -> None:
        validate_condition_definition(
            {"type": "percentile", "series": "close", "operator": "<=", "threshold": 20}
        )

    def test_invalid_definitions_rejected(self) -> None:
        cases = [
            {"type": "percentile", "series": "close", "operator": "~", "threshold": 20},
            {"type": "percentile", "series": "close", "operator": "<=", "threshold": "20"},
            {"type": "drawdown", "series": "", "operator": "<=", "threshold": -20},
            {"type": "drawdown", "series": "close", "operator": "<=", "threshold": -20, "min_samples": 1},
        ]
        for condition in cases:
            with self.subTest(condition=condition), self.assertRaises(
                ConditionDefinitionError
            ):
                validate_condition_definition(condition)


class RecordingDispatcher:
    def __init__(self) -> None:
        self.decisions = []

    def dispatch(self, decision) -> ContactRecord:
        self.decisions.append(decision)
        return ContactRecord(
            decision_id=decision.decision_id, channel="app", status="queued"
        )


CONDITION = {"type": "semantic", "claim": "x", "evidence_required": False}


class StateTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "state.db"
        self.now = FIXED
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )
        self.dispatcher = RecordingDispatcher()
        self.pipeline = PartnerPipeline(
            self.store,
            runner=StubResearchRunner(now=lambda: self.now),
            dispatcher=self.dispatcher,
            now=lambda: self.now,
        )

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def create_mandate(self, **policy_overrides) -> str:
        policy = {"mode": "condition", "condition": CONDITION}
        policy.update(policy_overrides)
        response = self.service.create(
            self.ctx,
            MandateCreateRequest(
                goal="跟踪条件状态",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available"}],
                contact_policy=policy,
                idempotency_key=key(),
            ),
        )
        self.mandate_id = response["mandate"]["mandate_id"]
        return self.mandate_id

    def baseline(self) -> None:
        self.pipeline.tick()
        self.dispatcher.decisions.clear()

    def next_job(self):
        event_id = "evt-" + secrets.token_hex(4)
        self.store.record_event(
            EventEnvelope(
                event_id=event_id,
                hook_type="company.event_available",
                producer="market-watch",
                occurred_at=self.now,
                observed_at=self.now,
                subject_ids=["company:600519"],
                payload={},
            )
        )
        self.pipeline.publisher.publish()
        self.pipeline.router.route()
        jobs = self.store.claim_jobs(limit=10, lease_seconds=60, now=self.now)
        matches = [item for item in jobs if item.action == "event_review"]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def submit(self, verdict: str):
        job = self.next_job()
        return self.pipeline.worker.submit_result(
            job.job_id,
            job.lease_token,
            run_id="run-" + secrets.token_hex(4),
            outcome="completed",
            contact_suggestion={"judgements": {"x": {"judgement": verdict}}},
        )

    def state(self):
        return self.store.get_condition_state(
            self.mandate_id, condition_key_for({"condition": CONDITION})
        )


class TransitionTests(StateTestCase):
    def test_transition_only_sends_on_entry(self) -> None:
        self.create_mandate(notify_on="transition")
        self.baseline()

        first = self.submit("met")
        self.assertEqual(first.decision, "send")

        same = self.submit("met")
        self.assertEqual(same.decision, "suppress")
        self.assertEqual(same.reason_code, "state_unchanged")

        self.assertEqual(self.submit("unmet").decision, "suppress")
        again = self.submit("met")
        self.assertEqual(again.decision, "send")
        self.assertEqual(len(self.dispatcher.decisions), 2)

    def test_unknown_does_not_reset_state(self) -> None:
        self.create_mandate(notify_on="transition")
        self.baseline()
        self.submit("met")
        deferred = self.submit("unknown")
        self.assertEqual(deferred.decision, "defer")
        after = self.submit("met")
        # 未知没有把状态改成 unmet，所以不算重新进入。
        self.assertEqual(after.decision, "suppress")
        self.assertEqual(after.reason_code, "state_unchanged")

    def test_level_mode_still_repeats(self) -> None:
        self.create_mandate()
        self.baseline()
        self.assertEqual(self.submit("met").decision, "send")
        self.assertEqual(self.submit("met").decision, "send")


class FirstEntryTests(StateTestCase):
    def test_first_entry_only_once(self) -> None:
        self.create_mandate(notify_on="first_entry")
        self.baseline()
        self.assertEqual(self.submit("met").decision, "send")
        self.submit("unmet")
        again = self.submit("met")
        self.assertEqual(again.decision, "suppress")
        self.assertEqual(again.reason_code, "not_first_entry")
        state = self.state()
        self.assertEqual(state.met_episodes, 2)


class ReentryTests(StateTestCase):
    def test_reentry_requires_previous_episode(self) -> None:
        self.create_mandate(notify_on="reentry")
        self.baseline()
        first = self.submit("met")
        self.assertEqual(first.decision, "suppress")
        self.assertEqual(first.reason_code, "not_reentry")

        self.submit("unmet")
        entered = self.submit("met")
        self.assertEqual(entered.decision, "send")

    def test_reentry_cooldown(self) -> None:
        self.create_mandate(notify_on="reentry", reentry_after_seconds=3600)
        self.baseline()
        self.submit("met")  # 首次，不提醒
        self.submit("unmet")
        self.now = self.now + timedelta(minutes=10)
        too_soon = self.submit("met")
        self.assertEqual(too_soon.decision, "suppress")
        self.assertEqual(too_soon.reason_code, "reentry_too_soon")
        self.assertEqual(
            too_soon.eligible_at, FIXED + timedelta(hours=1)
        )

        self.now = FIXED + timedelta(hours=2)
        self.submit("unmet")
        self.now = self.now + timedelta(hours=2)
        entered = self.submit("met")
        self.assertEqual(entered.decision, "send")


class SustainTests(StateTestCase):
    def test_sustain_defers_until_duration_met(self) -> None:
        self.create_mandate(sustain_seconds=3600)
        self.baseline()
        pending = self.submit("met")
        self.assertEqual(pending.decision, "defer")
        self.assertEqual(pending.reason_code, "sustain_pending")
        self.assertEqual(pending.eligible_at, FIXED + timedelta(hours=1))

        self.now = FIXED + timedelta(hours=1)
        satisfied = self.submit("met")
        self.assertEqual(satisfied.decision, "send")

    def test_leaving_resets_sustain(self) -> None:
        self.create_mandate(sustain_seconds=3600)
        self.baseline()
        self.submit("met")
        self.now = FIXED + timedelta(minutes=30)
        self.submit("unmet")
        self.now = FIXED + timedelta(minutes=45)
        restarted = self.submit("met")
        self.assertEqual(restarted.decision, "defer")
        self.assertEqual(
            restarted.eligible_at, FIXED + timedelta(minutes=45, hours=1)
        )


class PolicyValidationTests(StateTestCase):
    def test_invalid_notify_on_rejected(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create_mandate(notify_on="sometimes")

    def test_invalid_sustain_rejected(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create_mandate(sustain_seconds=-1)


if __name__ == "__main__":
    unittest.main()
