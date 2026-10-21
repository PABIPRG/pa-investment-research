# -*- coding: utf-8 -*-
"""联系决定：按 V1.3 §5.6 的两段判断产出 send / suppress / defer / aggregate。

处理顺序：

1. 读取当前委托版本与联系约定（配置错误单独记为 error）；
2. 资格：委托仍存在、处于 tracking、任务版本仍有效、结果不是迟到结果；
3. 结果完整性：研究未成功完成时不发出联系；
4. 条件评估：met / unmet / unknown / error（定时交付、到期提醒按约定跳过）；
5. 抑制与合并：暂缓、冷却、合并窗口、静默时段；
6. 落 contact_decision；只有新建的 send 决定才交给通知模块投递。

投递失败只记录投递结果，不反向改判；发送前重验资格由调用方在投递前完成。
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Mapping, Protocol, runtime_checkable

from .conditions import ConditionOutcome, evaluate_condition
from .contact_policy import (
    ContactPolicy,
    ContactPolicyError,
    parse_contact_policy,
    parse_quiet_hours,
    quiet_hours_until,
)
from .errors import Conflict
from .models import (
    ConditionState,
    ContactDecision,
    ContactRecord,
    Mandate,
    NotificationPreferences,
    ResearchJob,
    ResearchJobResult,
)
from .ports import BusinessStore

DEFAULT_TIMEZONE = "Asia/Shanghai"


@runtime_checkable
class ContactDispatcher(Protocol):
    """通知模块的最小投递接口；渠道、静默与重试属于实现方。"""

    def dispatch(self, decision: ContactDecision) -> ContactRecord: ...


@dataclass(frozen=True)
class _Outcome:
    decision: str
    reason_code: str
    condition_result: str
    detail: str = ""
    condition_key: str = ""
    eligible_at: datetime | None = None
    expires_at: datetime | None = None


class ContactDecisionService:
    def __init__(
        self,
        store: BusinessStore,
        *,
        dispatcher: ContactDispatcher | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.dispatcher = dispatcher
        self._now = now or (lambda: datetime.now(timezone.utc))

    def evaluate(self, job: ResearchJob, result: ResearchJobResult) -> ContactDecision:
        at = self._now()
        outcome, evidence, policy = self._decide(job, result, at)
        decision = ContactDecision(
            decision_id=_new_decision_id(),
            mandate_id=job.mandate_id,
            mandate_revision=job.mandate_revision,
            job_id=job.job_id,
            decision=outcome.decision,
            reason_code=outcome.reason_code,
            condition_result=outcome.condition_result,
            detail=outcome.detail,
            evidence_ref=evidence or result.evidence_batch_id,
            dedupe_key=f"job:{job.job_id}",
            condition_key=outcome.condition_key,
            eligible_at=outcome.eligible_at,
            expires_at=outcome.expires_at,
            created_at=at,
        )
        stored = self.store.save_contact_decision(decision)
        if stored.decision_id == decision.decision_id:
            if (
                policy is not None
                and stored.decision == "defer"
                and stored.reason_code == "condition_unknown"
            ):
                self._schedule_retry(job, stored, policy, at)
            self._dispatch(stored)
        return stored

    def _schedule_retry(
        self,
        job: ResearchJob,
        decision: ContactDecision,
        policy: ContactPolicy,
        at: datetime,
    ) -> None:
        """未知结论进入有限重试；超过约定次数就停在“等待资料/受阻”。"""

        retry_index = int((job.budget or {}).get("retry_index", 0) or 0) + 1
        if retry_index > policy.max_retries:
            return
        retry_job = ResearchJob(
            job_id=f"JOB_{secrets.token_hex(16)}",
            mandate_id=job.mandate_id,
            mandate_revision=job.mandate_revision,
            trigger_event_id=job.trigger_event_id,
            action="condition_retry",
            status="pending",
            attempt_count=0,
            budget={**(job.budget or {}), "retry_of": job.job_id, "retry_index": retry_index},
            next_run_at=decision.eligible_at or at,
            dedupe_key=f"retry:{job.job_id}:{decision.decision_id}",
            created_at=at,
            updated_at=at,
        )
        try:
            self.store.create_job(retry_job)
        except Conflict:
            # 同一决定只登记一次重试。
            return

    # ── 判定流程 ────────────────────────────────────────────────────

    def _decide(
        self, job: ResearchJob, result: ResearchJobResult, at: datetime
    ) -> tuple[_Outcome, str, ContactPolicy | None]:
        mandate = self.store.get_mandate_internal(job.mandate_id)
        if mandate is None:
            return (
                _Outcome("suppress", "mandate_missing", "unknown", "委托已不存在"),
                "",
                None,
            )

        preferences = self.store.get_notification_preferences(
            mandate.principal_id, mandate.instance_id
        )
        revision = self.store.get_revision(mandate.mandate_id, mandate.current_revision)
        if revision is None:
            return (
                _Outcome("suppress", "revision_missing", "error", "当前委托版本缺失"),
                "",
                None,
            )
        try:
            policy = parse_contact_policy(
                revision.contact_policy,
                default_channels=preferences.channels if preferences else None,
            )
        except ContactPolicyError as exc:
            return (
                _Outcome(
                    "suppress",
                    "contact_policy_invalid",
                    "error",
                    f"联系约定无效：{exc}",
                ),
                "",
                None,
            )

        # ── 资格 ────────────────────────────────────────────────────
        if mandate.status != "tracking":
            return (
                _Outcome(
                    "suppress",
                    "mandate_not_tracking",
                    "unknown",
                    f"委托状态为 {mandate.status}",
                    policy.condition_key,
                ),
                "",
                policy,
            )
        if mandate.current_revision != job.mandate_revision:
            return (
                _Outcome(
                    "suppress",
                    "stale_revision",
                    "unknown",
                    "任务版本已不是当前委托版本",
                    policy.condition_key,
                ),
                "",
                policy,
            )
        if result.stale:
            return (
                _Outcome(
                    "suppress",
                    "stale_result",
                    "unknown",
                    "迟到结果不获得新的联系许可",
                    policy.condition_key,
                ),
                "",
                policy,
            )

        # ── 结果完整性 ──────────────────────────────────────────────
        if result.outcome != "completed":
            return (
                _Outcome(
                    "suppress",
                    "research_failed",
                    "error",
                    f"研究结果为 {result.outcome}",
                    policy.condition_key,
                    eligible_at=at + timedelta(seconds=policy.error_retry_seconds),
                ),
                "",
                policy,
            )

        # ── 条件评估 ────────────────────────────────────────────────
        outcome, condition = self._evaluate_by_mode(policy, revision.basis, result, at)
        evidence = condition.evidence_refs[0] if condition.evidence_refs else ""

        # ── 时间状态 ────────────────────────────────────────────────
        outcome = self._apply_state_gate(mandate, policy, condition, outcome, at)

        if outcome.decision != "send_candidate":
            return outcome, evidence, policy

        # ── 抑制与合并 ──────────────────────────────────────────────
        return (
            self._suppress_or_send(policy, mandate, preferences, at, outcome),
            evidence,
            policy,
        )

    def _condition_outcome(
        self, policy: ContactPolicy, basis: Mapping[str, Any], result: ResearchJobResult
    ) -> ConditionOutcome:
        if policy.mode == "due_reminder":
            return ConditionOutcome("met", "到期提醒按约定直接提醒")
        if policy.condition is None and policy.mode == "scheduled_delivery":
            return ConditionOutcome("met", "定时交付按约交付本次成果")
        return evaluate_condition(policy.condition, result, basis=basis)

    def _evaluate_by_mode(
        self,
        policy: ContactPolicy,
        basis: Mapping[str, Any],
        result: ResearchJobResult,
        at: datetime,
    ) -> tuple[_Outcome, ConditionOutcome]:
        condition = self._condition_outcome(policy, basis, result)
        key = policy.condition_key

        if policy.mode == "due_reminder":
            return (
                _Outcome("send_candidate", "due_reminder", "met", condition.detail, key),
                condition,
            )

        if policy.mode == "scheduled_delivery":
            # 定时交付即使没有新发现也按约交付；条件结论只作记录。
            return (
                _Outcome(
                    "send_candidate",
                    "scheduled_delivery",
                    condition.result,
                    condition.detail,
                    key,
                ),
                condition,
            )

        if condition.result == "met":
            return (
                _Outcome("send_candidate", "condition_met", "met", condition.detail, key),
                condition,
            )
        if condition.result == "unmet":
            if policy.mode == "periodic_check" or policy.condition is None:
                reason = "no_material_change"
            else:
                reason = "condition_unmet"
            return _Outcome("suppress", reason, "unmet", condition.detail, key), condition
        if condition.result == "error":
            return (
                _Outcome(
                    "suppress",
                    "condition_error",
                    "error",
                    condition.detail,
                    key,
                    eligible_at=at + timedelta(seconds=policy.error_retry_seconds)
                    if policy.error_retry_seconds
                    else None,
                ),
                condition,
            )
        # unknown：进入等待资料 / 有限重试，明确区别于“没有变化”。
        if policy.unknown_retry_seconds:
            return (
                _Outcome(
                    "defer",
                    "condition_unknown",
                    "unknown",
                    condition.detail,
                    key,
                    eligible_at=at + timedelta(seconds=policy.unknown_retry_seconds),
                    expires_at=at
                    + timedelta(seconds=max(policy.unknown_retry_seconds * 4, 60)),
                ),
                condition,
            )
        return (
            _Outcome("suppress", "condition_unknown", "unknown", condition.detail, key),
            condition,
        )

    def _apply_state_gate(
        self,
        mandate: Mandate,
        policy: ContactPolicy,
        condition: ConditionOutcome,
        candidate: _Outcome,
        at: datetime,
    ) -> _Outcome:
        """记录条件时间状态，并按 notify_on / sustain 决定这次是否真的联系。

        unknown / error 不写入状态：未知不是“已经离开条件”，不能把持续满足
        的计时清零，也不能因为一次资料缺失就重新提醒。
        """

        if policy.mode not in {"condition", "periodic_check"}:
            return candidate
        if condition.result not in {"met", "unmet"}:
            return candidate

        key = policy.condition_key
        prior = self.store.get_condition_state(mandate.mandate_id, key)
        entering = condition.result == "met" and (
            prior is None or prior.state != "met"
        )
        if condition.result == "met":
            state_since = at if entering else prior.state_since  # type: ignore[union-attr]
            episodes = (prior.met_episodes if prior else 0) + (1 if entering else 0)
            last_met_at = at
        else:
            leaving = prior is None or prior.state != "unmet"
            state_since = at if leaving else prior.state_since  # type: ignore[union-attr]
            episodes = prior.met_episodes if prior else 0
            last_met_at = prior.last_met_at if prior else None
        state = ConditionState(
            mandate_id=mandate.mandate_id,
            condition_key=key,
            state=condition.result,
            state_since=state_since,
            met_episodes=episodes,
            last_met_at=last_met_at,
            last_evaluated_at=at,
        )
        self.store.save_condition_state(state)

        if candidate.decision != "send_candidate":
            return candidate

        if policy.sustain_seconds:
            ready_at = state_since + timedelta(seconds=policy.sustain_seconds)
            if at < ready_at:
                return _Outcome(
                    "defer",
                    "sustain_pending",
                    "met",
                    f"条件已满足，等待持续 {policy.sustain_seconds} 秒",
                    key,
                    eligible_at=ready_at,
                )

        if policy.notify_on == "level":
            return candidate
        if policy.notify_on == "first_entry":
            if episodes > 1:
                return _Outcome(
                    "suppress",
                    "not_first_entry",
                    "met",
                    "该条件此前已经满足过，首次进入提醒不再重复",
                    key,
                )
            return candidate
        if policy.notify_on == "transition":
            if not entering:
                return _Outcome(
                    "suppress",
                    "state_unchanged",
                    "met",
                    "条件持续满足，不是新的进入",
                    key,
                )
            return candidate
        # reentry：必须是“曾经满足过 → 离开 → 再次进入”。
        if not (prior is not None and prior.state == "unmet" and prior.met_episodes >= 1):
            return _Outcome(
                "suppress",
                "not_reentry",
                "met",
                "尚未完成一次“满足→离开→重新进入”的完整过程",
                key,
            )
        if policy.reentry_after_seconds and prior.last_met_at is not None:
            ready_at = prior.last_met_at + timedelta(
                seconds=policy.reentry_after_seconds
            )
            if at < ready_at:
                return _Outcome(
                    "suppress",
                    "reentry_too_soon",
                    "met",
                    "距上次满足时间过短，暂不视为重新进入",
                    key,
                    eligible_at=ready_at,
                )
        return candidate

    def _suppress_or_send(
        self,
        policy: ContactPolicy,
        mandate: Mandate,
        preferences: NotificationPreferences | None,
        at: datetime,
        candidate: _Outcome,
    ) -> _Outcome:
        key = candidate.condition_key

        snoozes = self.store.list_active_snoozes(
            principal_id=mandate.principal_id,
            instance_id=mandate.instance_id,
            mandate_id=mandate.mandate_id,
            condition_key=key,
            now=at,
        )
        if snoozes:
            until = max(item.until for item in snoozes)
            return _Outcome(
                "suppress",
                "snoozed",
                candidate.condition_result,
                "用户暂缓了该类联系",
                key,
                eligible_at=until,
            )

        if policy.applies_cooldown and policy.cooldown_seconds:
            since = at - timedelta(seconds=policy.cooldown_seconds)
            recent = self.store.find_recent_contact_decision(
                mandate.mandate_id, since=since, condition_key=key
            )
            if recent is not None:
                return _Outcome(
                    "suppress",
                    "cooldown_active",
                    candidate.condition_result,
                    f"冷却期内已联系过（{recent.decision_id}）",
                    key,
                    eligible_at=recent.created_at + timedelta(seconds=policy.cooldown_seconds),
                )

        if policy.merge_window_seconds:
            since = at - timedelta(seconds=policy.merge_window_seconds)
            recent = self.store.find_recent_contact_decision(
                mandate.mandate_id, since=since, condition_key=key
            )
            if recent is not None:
                return _Outcome(
                    "aggregate",
                    "merged_with_recent",
                    candidate.condition_result,
                    f"与 {recent.decision_id} 合并展示",
                    key,
                )

        quiet = policy.quiet_hours
        if quiet is None and preferences is not None and preferences.quiet_hours:
            try:
                quiet = parse_quiet_hours(preferences.quiet_hours)
            except ContactPolicyError:
                quiet = None
        if quiet is not None:
            timezone_name = (
                preferences.timezone if preferences is not None else DEFAULT_TIMEZONE
            )
            try:
                until = quiet_hours_until(quiet, at, timezone_name)
            except ContactPolicyError:
                until = None
            if until is not None:
                return _Outcome(
                    "defer",
                    "quiet_hours",
                    candidate.condition_result,
                    "处于静默时段，顺延投递",
                    key,
                    eligible_at=until,
                )

        return _Outcome(
            "send",
            candidate.reason_code,
            candidate.condition_result,
            candidate.detail,
            key,
            eligible_at=at,
        )

    # ── 投递 ────────────────────────────────────────────────────────

    def _dispatch(self, decision: ContactDecision) -> None:
        if decision.decision != "send" or self.dispatcher is None:
            return
        try:
            record = self.dispatcher.dispatch(decision)
        except Exception as exc:  # 投递失败只记录，不回滚决定
            record = ContactRecord(
                decision_id=decision.decision_id,
                channel="unknown",
                status="failed",
                detail=str(exc),
            )
        self.store.save_contact_record(record)


def _new_decision_id() -> str:
    return f"DEC_{secrets.token_hex(16)}"
