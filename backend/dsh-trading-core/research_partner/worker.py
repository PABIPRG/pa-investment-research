# -*- coding: utf-8 -*-
"""持久研究任务的执行编排。

DSH 只负责“一次 run”；任务状态、租约、重试、结果留档与联系评估都在这里。
首期提供同步 stub，DSH 接入后实现异步 runner 或走 ``submit_result``。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Protocol, runtime_checkable

from .contact import ContactDecisionService
from .errors import LeaseExpired
from .models import ContactDecision, ResearchJob, ResearchJobResult
from .ports import BusinessStore


@runtime_checkable
class ResearchRunner(Protocol):
    def run(self, job: ResearchJob) -> ResearchJobResult: ...


class StubResearchRunner:
    """可替换的最小球 stub：用于打通闭环与联调。"""

    def __init__(self, *, should_contact: bool = True, now: Callable[[], datetime] | None = None):
        self.should_contact = should_contact
        self._now = now or (lambda: datetime.now(timezone.utc))

    def run(self, job: ResearchJob) -> ResearchJobResult:
        at = self._now()
        return ResearchJobResult(
            result_id=f"RES_{secrets.token_hex(16)}",
            job_id=job.job_id,
            run_id=f"stub-{job.job_id}",
            outcome="completed",
            structured_result={
                "stub": True,
                "action": job.action,
                "evidence_ids": [f"EV_{job.job_id}"],
            },
            evidence_batch_id=f"EVB_{job.job_id}",
            change_summary="stub 结果：检测到需要复核的变化",
            contact_suggestion={"should_contact": self.should_contact},
            received_at=at,
        )


class ResearchJobWorker:
    def __init__(
        self,
        store: BusinessStore,
        runner: ResearchRunner,
        contact: ContactDecisionService,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.runner = runner
        self.contact = contact
        self._now = now or (lambda: datetime.now(timezone.utc))

    def run_once(self, *, limit: int = 5, lease_seconds: int = 60) -> int:
        at = self._now()
        jobs = self.store.claim_jobs(
            limit=limit, lease_seconds=lease_seconds, now=at
        )
        completed = 0
        for job in jobs:
            try:
                result = self._execute(job, at)
            except Exception as exc:
                self.store.fail_job(
                    job.job_id,
                    job.lease_token or "",
                    str(exc),
                    now=at,
                    retry_at=at + timedelta(seconds=30),
                )
                continue
            if result.job_id != job.job_id:
                result = result.model_copy(update={"job_id": job.job_id})
            try:
                saved = self.store.complete_job(
                    job.job_id, job.lease_token or "", result, now=at
                )
            except LeaseExpired:
                continue
            completed += 1
            self.contact.evaluate(job, saved)
        return completed

    def _execute(self, job: ResearchJob, at: datetime) -> ResearchJobResult:
        """到期提醒是既定时间的义务，不需要跑研究；其余动作交给 runner。"""

        if job.action == "due_reminder":
            return ResearchJobResult(
                result_id=f"RES_{secrets.token_hex(16)}",
                job_id=job.job_id,
                run_id=f"reminder-{job.job_id}",
                outcome="completed",
                structured_result={
                    "mode": "due_reminder",
                    "trigger_event_id": job.trigger_event_id,
                },
                change_summary="按约定到期提醒",
                contact_suggestion={"should_contact": True},
                received_at=at,
            )
        return self.runner.run(job)

    def submit_result(
        self,
        job_id: str,
        lease_token: str,
        *,
        run_id: str,
        outcome: str,
        structured_result: dict[str, Any] | None = None,
        evidence_batch_id: str | None = None,
        gaps: list[dict[str, Any]] | None = None,
        change_summary: str = "",
        contact_suggestion: dict[str, Any] | None = None,
    ) -> ContactDecision | None:
        """DSH 异步回写入口；租约失效时拒绝，迟到结果由调用方决定是否留档。"""
        at = self._now()
        job = self.store.get_job(job_id)
        if job is None:
            return None
        mandate = self.store.get_mandate_internal(job.mandate_id)
        stale = (
            mandate is None
            or mandate.current_revision != job.mandate_revision
            or mandate.status != "tracking"
        )
        result = ResearchJobResult(
            result_id=f"RES_{secrets.token_hex(16)}",
            job_id=job_id,
            run_id=run_id,
            outcome=outcome,
            structured_result=structured_result or {},
            evidence_batch_id=evidence_batch_id,
            gaps=gaps or [],
            change_summary=change_summary,
            contact_suggestion=contact_suggestion or {},
            stale=stale,
            received_at=at,
        )
        saved = self.store.complete_job(job_id, lease_token, result, now=at)
        return self.contact.evaluate(job, saved)
