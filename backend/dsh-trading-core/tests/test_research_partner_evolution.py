# -*- coding: utf-8 -*-
"""策略自进化复用为委托：事件 → 任务 → 只读复核 → 联系决定。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_evolution -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from research_partner.commands import MandateCreateRequest
from research_partner.context import RequestContext
from research_partner.evolution_runner import StrategyEvolutionRunner
from research_partner.factory import build_service
from research_partner.models import ContactRecord, EventEnvelope
from research_partner.pipeline import PartnerPipeline
from research_partner.worker import StubResearchRunner


def key() -> str:
    return "idem_" + secrets.token_hex(8)


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


class FakePort:
    """只读自进化端口；记录调用，便于断言没有写动作。"""

    def __init__(
        self,
        *,
        ready: bool = True,
        overall: dict | None = None,
        preview: dict | None = None,
        error: Exception | None = None,
    ) -> None:
        self.ready = ready
        self.overall = overall
        self.preview_payload = preview or {
            "preview_status": "none",
            "actions": [],
            "count": 0,
        }
        self.error = error
        self.calls: list[tuple[str, str | None]] = []

    def status(self, *, strategy_id=None, include_history=False):
        self.calls.append(("status", strategy_id))
        if self.error is not None:
            raise self.error
        return {
            "as_of": "2026-10-21 15:30:00",
            "days_of_data": 8 if self.ready else 2,
            "min_days": 5,
            "ready": self.ready,
            "counts": {"promote": 1, "demote": 0, "retire": 0, "mutate": 0},
            "note": None if self.ready else "影子净值仅 2 日，自进化待累积至 5 日",
            "recent_run_at": "2026-10-21 15:20:00",
            "per_strategy": [
                {
                    "strategy_id": "S001",
                    "name": "均线跟随",
                    "tier": 2,
                    "decision": "promote" if self.ready else "none",
                    "behavior": "待判定" if not self.ready else "判定完成",
                }
            ],
        }

    def attribution(self, *, strategy_id=None):
        self.calls.append(("attribution", strategy_id))
        if self.error is not None:
            raise self.error
        return {
            "as_of": "2026-10-21 15:30:00",
            "days_of_data": 8 if self.ready else 2,
            "min_days": 5,
            "data_note": None if self.ready else "影子净值仅 2 日，尚不可归因",
            "overall": self.overall,
            "strategies": [
                {
                    "strategy_id": "S001",
                    "name": "均线跟随",
                    "return_pct": 3.2,
                    "max_drawdown_pct": -1.1,
                }
            ],
        }

    def preview(self, *, strategy_id=None):
        self.calls.append(("preview", strategy_id))
        if self.error is not None:
            raise self.error
        return self.preview_payload


class EvolutionMandateTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "partner.db"
        self.now = datetime(2026, 10, 21, 15, 30, tzinfo=timezone.utc)
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )
        self.dispatcher = RecordingDispatcher()

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def pipeline(self, port: FakePort) -> PartnerPipeline:
        return PartnerPipeline(
            self.store,
            runner=StrategyEvolutionRunner(
                self.store,
                port,
                fallback=StubResearchRunner(now=lambda: self.now),
                now=lambda: self.now,
            ),
            dispatcher=self.dispatcher,
            now=lambda: self.now,
        )

    def create_mandate(self, *, subject: str, hook_type: str, event_type=None) -> str:
        trigger: dict = {"hook_type": hook_type}
        if event_type is not None:
            trigger["event_type"] = event_type
        response = self.service.create(
            self.ctx,
            MandateCreateRequest(
                goal="跟踪策略自进化",
                subjects=[{"entity_id": subject}],
                triggers=[trigger],
                idempotency_key=key(),
            ),
        )
        return response["mandate"]["mandate_id"]

    def ingest(
        self,
        event_id: str,
        *,
        hook_type: str,
        subjects: list[str],
        payload: dict,
    ) -> bool:
        return self.store.record_event(
            EventEnvelope(
                event_id=event_id,
                hook_type=hook_type,
                producer="trading-core-evolution",
                occurred_at=self.now,
                observed_at=self.now,
                subject_ids=subjects,
                content_hash="hash-" + event_id,
                payload=payload,
            )
        )

    def event_job_id(self, mandate_id: str) -> str:
        row = self.store._connect().execute(
            "SELECT job_id FROM research_jobs "
            "WHERE mandate_id = ? AND action = 'event_review'",
            (mandate_id,),
        ).fetchone()
        self.assertIsNotNone(row)
        return row["job_id"]

    def latest_result(self, mandate_id: str):
        results = self.store.list_job_results(self.event_job_id(mandate_id))
        self.assertTrue(results)
        return results[-1]

    def test_stage_change_reviews_status_and_proposes_contact(self) -> None:
        mandate_id = self.create_mandate(
            subject="strategy:S001",
            hook_type="strategy.condition_changed",
            event_type="promote",
        )
        port = FakePort(overall={"return_pct": 4.1, "max_drawdown_pct": -1.3})
        pipeline = self.pipeline(port)
        pipeline.tick()  # 先消费委托创建基线任务
        self.assertTrue(
            self.ingest(
                "evt-strategy-1",
                hook_type="strategy.condition_changed",
                subjects=["strategy:S001", "strategy_pool:default"],
                payload={
                    "event_type": "promote",
                    "run_id": "2026-10-21",
                    "strategy_id": "S001",
                    "from_stage": "watch",
                    "to_stage": "active",
                    "reason": "影子 8 日胜率 62%",
                    "action_count": 1,
                },
            )
        )
        tick = pipeline.tick()
        self.assertEqual(tick["jobs_created"], 1)
        self.assertEqual(tick["jobs_completed"], 1)

        result = self.latest_result(mandate_id)
        self.assertEqual(result.outcome, "completed")
        structured = result.structured_result
        self.assertEqual(structured["capability"], "strategy_evolution")
        self.assertEqual(structured["strategy_id"], "S001")
        self.assertEqual(structured["stage_change"]["to"], "active")
        self.assertEqual(structured["metrics"]["stage_changed"]["value"], 1)
        self.assertEqual(structured["metrics"]["shadow_days"]["value"], 8)
        self.assertIn("升级", result.change_summary)

        # 只读能力：三个查询都带策略范围，且没有应用预案的入口。
        self.assertEqual(
            [name for name, _ in port.calls], ["status", "attribution", "preview"]
        )
        self.assertTrue(all(sid == "S001" for _, sid in port.calls))

        decisions = self.store.list_contact_decisions(mandate_id)
        self.assertEqual(len(decisions), 2)
        event_decision = [
            item
            for item in decisions
            if item.job_id == self.event_job_id(mandate_id)
        ]
        self.assertEqual(len(event_decision), 1)
        self.assertEqual(event_decision[0].decision, "send")

    def test_completed_event_without_ready_data_stays_silent(self) -> None:
        mandate_id = self.create_mandate(
            subject="strategy_pool:default",
            hook_type="strategy.evolution_completed",
        )
        port = FakePort(ready=False)
        pipeline = self.pipeline(port)
        pipeline.tick()
        self.assertTrue(
            self.ingest(
                "evt-evolution-1",
                hook_type="strategy.evolution_completed",
                subjects=["strategy_pool:default"],
                payload={
                    "run_id": "2026-10-21",
                    "status": "completed",
                    "action_count": 0,
                    "actions": [],
                },
            )
        )
        tick = pipeline.tick()
        self.assertEqual(tick["jobs_completed"], 1)

        result = self.latest_result(mandate_id)
        self.assertEqual(result.outcome, "completed")
        self.assertFalse(result.structured_result["status"]["ready"])
        self.assertEqual(
            [gap["code"] for gap in result.gaps], ["shadow_data_insufficient"]
        )
        self.assertFalse(result.contact_suggestion["should_contact"])

        decisions = self.store.list_contact_decisions(mandate_id)
        self.assertEqual(len(decisions), 2)
        event_decision = [
            item
            for item in decisions
            if item.job_id == self.event_job_id(mandate_id)
        ]
        self.assertEqual(len(event_decision), 1)
        self.assertNotEqual(event_decision[0].decision, "send")
        # 只有基线任务产生过一次投递。
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_non_strategy_event_keeps_original_runner(self) -> None:
        mandate_id = self.create_mandate(
            subject="company:600519", hook_type="company.event_available"
        )
        port = FakePort()
        pipeline = self.pipeline(port)
        pipeline.tick()
        self.ingest(
            "evt-company-1",
            hook_type="company.event_available",
            subjects=["company:600519"],
            payload={"event_type": "announcement"},
        )
        pipeline.tick()
        result = self.latest_result(mandate_id)
        self.assertTrue(result.structured_result.get("stub"))
        self.assertEqual(port.calls, [])

    def test_capability_failure_is_retried_not_reported_as_no_change(self) -> None:
        mandate_id = self.create_mandate(
            subject="strategy:S001",
            hook_type="strategy.condition_changed",
            event_type="promote",
        )
        port = FakePort(error=RuntimeError("trading-core 不可达"))
        pipeline = self.pipeline(port)
        pipeline.tick()
        self.ingest(
            "evt-strategy-2",
            hook_type="strategy.condition_changed",
            subjects=["strategy:S001"],
            payload={"event_type": "promote", "strategy_id": "S001", "run_id": "2026-10-21"},
        )
        tick = pipeline.tick()
        self.assertEqual(tick["jobs_created"], 1)
        self.assertEqual(tick["jobs_completed"], 0)
        # 能力不可用时任务失败等待重试，不能落成“没有变化”的结果。
        self.assertEqual(
            self.store.list_job_results(self.event_job_id(mandate_id)), []
        )
        self.assertEqual(len(self.store.list_contact_decisions(mandate_id)), 1)


class HookCatalogTests(unittest.TestCase):
    def test_strategy_hooks_are_active_with_evolution_producer(self) -> None:
        from research_partner.hooks import hook_catalog

        by_type = {item["hook_type"]: item for item in hook_catalog()}
        for hook_type in (
            "strategy.condition_changed",
            "strategy.evolution_completed",
        ):
            self.assertIn(hook_type, by_type)
            self.assertTrue(by_type[hook_type]["active"])
            self.assertEqual(
                by_type[hook_type]["producer"], "trading-core-evolution"
            )


if __name__ == "__main__":
    unittest.main()
