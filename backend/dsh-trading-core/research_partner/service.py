# -*- coding: utf-8 -*-
"""委托命令与查询服务（Slice 2）。

边界：
- 状态写入、版本推进、待补充项与事件 outbox 在同一个事务提交。
- 写命令必须携带幂等键；同键不同内容拒绝，同键同内容返回原回执。
- 这里不评估触发条件、不启动研究、不发送通知；后续切片接入。
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone
from typing import Any, Callable

from .commands import (
    MandateCreateRequest,
    MandateReviseRequest,
    MandateStatusRequest,
    RequirementResolutionRequest,
)
from .conditions import ConditionDefinitionError, validate_condition_definition
from .contact_policy import ContactPolicy, ContactPolicyError, parse_contact_policy
from .context import RequestContext
from .dependencies import compile_dependencies
from .errors import Conflict, InvalidRequest, NotFound
from .events import mandate_event
from .models import (
    IdempotentResponse,
    Mandate,
    MandateRequirement,
    MandateRevision,
    MandateSubject,
)
from .ports import BusinessStore
from .schedules import ScheduleError, ScheduleSpec, compile_schedules


def _hash_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class MandateService:
    def __init__(
        self,
        store: BusinessStore,
        *,
        now: Callable[[], datetime] | None = None,
        calendar=None,
    ):
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.calendar = calendar

    # ── 写命令 ──────────────────────────────────────────────────────

    def create(self, ctx: RequestContext, request: MandateCreateRequest) -> dict:
        ctx.require("mandate:write")
        payload = request.model_dump(mode="json", exclude={"idempotency_key"})
        return self._idempotent(
            ctx,
            "mandate.create",
            request.idempotency_key,
            payload,
            lambda: self._create(ctx, request),
        )

    def revise(
        self,
        ctx: RequestContext,
        mandate_id: str,
        request: MandateReviseRequest,
    ) -> dict:
        ctx.require("mandate:write")
        payload = {
            "mandate_id": mandate_id,
            **request.model_dump(mode="json", exclude={"idempotency_key"}),
        }
        return self._idempotent(
            ctx,
            "mandate.revise",
            request.idempotency_key,
            payload,
            lambda: self._revise(ctx, mandate_id, request),
        )

    def pause(
        self, ctx: RequestContext, mandate_id: str, request: MandateStatusRequest
    ) -> dict:
        return self._change_status(ctx, mandate_id, request, target="paused")

    def resume(
        self, ctx: RequestContext, mandate_id: str, request: MandateStatusRequest
    ) -> dict:
        return self._change_status(ctx, mandate_id, request, target="tracking")

    def end(
        self, ctx: RequestContext, mandate_id: str, request: MandateStatusRequest
    ) -> dict:
        return self._change_status(ctx, mandate_id, request, target="ended")

    def resolve_requirement(
        self,
        ctx: RequestContext,
        mandate_id: str,
        requirement_id: str,
        request: RequirementResolutionRequest,
    ) -> dict:
        ctx.require("mandate:write")
        payload = {
            "mandate_id": mandate_id,
            "requirement_id": requirement_id,
            **request.model_dump(mode="json", exclude={"idempotency_key"}),
        }
        return self._idempotent(
            ctx,
            "mandate.resolve-requirement",
            request.idempotency_key,
            payload,
            lambda: self._resolve_requirement(ctx, mandate_id, requirement_id, request),
        )

    # ── 查询 ────────────────────────────────────────────────────────

    def get(self, ctx: RequestContext, mandate_id: str) -> dict:
        ctx.require("mandate:read")
        mandate = self._require_mandate(ctx, mandate_id)
        return self._view(mandate)

    def list(
        self,
        ctx: RequestContext,
        *,
        status: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict:
        ctx.require("mandate:read")
        mandates, next_cursor = self.store.list_mandates(
            ctx.principal_id,
            instance_id=ctx.instance_id,
            status=status,
            limit=limit,
            cursor=cursor,
        )
        items = []
        for mandate in mandates:
            revision = self.store.get_revision(
                mandate.mandate_id, mandate.current_revision
            )
            items.append(
                {
                    **mandate.model_dump(mode="json"),
                    "goal": revision.goal if revision else None,
                }
            )
        return {"items": items, "next_cursor": next_cursor}

    # ── 内部实现 ────────────────────────────────────────────────────

    def _create(self, ctx: RequestContext, request: MandateCreateRequest) -> dict:
        at = self._now()
        policy = _validate_contact_policy(request.contact_policy)
        mandate_id = f"MND_{secrets.token_hex(16)}"
        triggers = [
            item.model_dump(mode="json", exclude_none=True) for item in request.triggers
        ]
        schedules = compile_schedules(
            mandate_id,
            1,
            policy,
            now=at,
            default_timezone=self._default_timezone(ctx),
            calendar=self.calendar,
        )
        if schedules:
            triggers = _with_schedule_trigger(triggers)
        subjects = [
            MandateSubject(
                mandate_id=mandate_id,
                revision=1,
                entity_id=item.entity_id,
                role=item.role,
                scope_mode=item.scope_mode,
                collection_version=item.collection_version,
            )
            for item in request.subjects
        ]
        requirements = [
            MandateRequirement(
                requirement_id=f"REQ_{secrets.token_hex(16)}",
                mandate_id=mandate_id,
                revision=1,
                code=item.code,
                detail=item.detail,
                status="open",
                created_at=at,
            )
            for item in request.requirements
        ]
        status = "pending_requirements" if requirements else "tracking"
        revision = MandateRevision(
            mandate_id=mandate_id,
            revision=1,
            goal=request.goal,
            scope=request.scope,
            triggers=triggers,
            contact_policy=request.contact_policy,
            basis=request.basis,
            change_summary="初始委托",
            created_by=ctx.principal_id,
            created_at=at,
        )
        dependencies = compile_dependencies(
            mandate_id,
            1,
            subjects=subjects,
            triggers=revision.triggers,
            now=at,
        )
        mandate = Mandate(
            mandate_id=mandate_id,
            principal_id=ctx.principal_id,
            instance_id=ctx.instance_id,
            status=status,
            current_revision=1,
            source_session_id=request.source_session_id,
            source_message_ref=request.source_message_ref,
            created_at=at,
            updated_at=at,
        )
        outbox = [
            mandate_event(
                "mandate.created",
                mandate_id,
                revision=1,
                payload={
                    "status": status,
                    "open_requirements": len(requirements),
                },
                occurred_at=at,
            )
        ]
        if status == "pending_requirements":
            outbox.append(
                mandate_event(
                    "mandate.review_requested",
                    mandate_id,
                    revision=1,
                    payload={"open_requirements": len(requirements)},
                    occurred_at=at,
                )
            )
        self.store.create_mandate(
            mandate,
            revision,
            subjects=subjects,
            requirements=requirements,
            dependencies=dependencies,
            outbox=outbox,
        )
        self.store.replace_schedules(mandate_id, 1, schedules, now=at)
        return self._view(self._require_mandate(ctx, mandate_id))

    def _revise(
        self,
        ctx: RequestContext,
        mandate_id: str,
        request: MandateReviseRequest,
    ) -> dict:
        at = self._now()
        policy = _validate_contact_policy(request.contact_policy)
        mandate = self._require_mandate(ctx, mandate_id)
        if mandate.status == "ended":
            raise Conflict("已结束的委托不能调整")
        if mandate.current_revision != request.expected_revision:
            raise Conflict("委托已被其他请求修改，请重新读取")

        revision_no = request.expected_revision + 1
        triggers = [
            item.model_dump(mode="json", exclude_none=True) for item in request.triggers
        ]
        schedules = compile_schedules(
            mandate_id,
            revision_no,
            policy,
            now=at,
            default_timezone=self._default_timezone(ctx),
            calendar=self.calendar,
        )
        if schedules:
            triggers = _with_schedule_trigger(triggers)
        subjects = [
            MandateSubject(
                mandate_id=mandate_id,
                revision=revision_no,
                entity_id=item.entity_id,
                role=item.role,
                scope_mode=item.scope_mode,
                collection_version=item.collection_version,
            )
            for item in request.subjects
        ]
        requirements = [
            MandateRequirement(
                requirement_id=f"REQ_{secrets.token_hex(16)}",
                mandate_id=mandate_id,
                revision=revision_no,
                code=item.code,
                detail=item.detail,
                status="open",
                created_at=at,
            )
            for item in request.requirements
        ]
        revision = MandateRevision(
            mandate_id=mandate_id,
            revision=revision_no,
            goal=request.goal,
            scope=request.scope,
            triggers=triggers,
            contact_policy=request.contact_policy,
            basis=request.basis,
            change_summary=request.change_summary or "调整委托",
            created_by=ctx.principal_id,
            created_at=at,
        )
        dependencies = compile_dependencies(
            mandate_id,
            revision_no,
            subjects=subjects,
            triggers=revision.triggers,
            now=at,
        )
        change = self._next_status(mandate.status, has_open_requirements=bool(requirements))
        outbox = [
            mandate_event(
                "mandate.revised",
                mandate_id,
                revision=revision_no,
                payload={
                    "change_summary": revision.change_summary,
                    "status": change,
                },
                occurred_at=at,
            )
        ]
        if change == "pending_requirements":
            outbox.append(
                mandate_event(
                    "mandate.review_requested",
                    mandate_id,
                    revision=revision_no,
                    payload={"open_requirements": len(requirements)},
                    occurred_at=at,
                )
            )
        self.store.add_revision(
            revision,
            expected_revision=request.expected_revision,
            subjects=subjects,
            requirements=requirements,
            dependencies=dependencies,
            outbox=outbox,
            status=change,
        )
        self.store.replace_schedules(mandate_id, revision_no, schedules, now=at)
        return self._view(self._require_mandate(ctx, mandate_id))

    def _change_status(
        self,
        ctx: RequestContext,
        mandate_id: str,
        request: MandateStatusRequest,
        *,
        target: str,
    ) -> dict:
        ctx.require("mandate:write")
        payload = {
            "mandate_id": mandate_id,
            "target": target,
            **request.model_dump(mode="json", exclude={"idempotency_key"}),
        }
        return self._idempotent(
            ctx,
            f"mandate.{target}",
            request.idempotency_key,
            payload,
            lambda: self._apply_status(ctx, mandate_id, request, target),
        )

    def _apply_status(
        self,
        ctx: RequestContext,
        mandate_id: str,
        request: MandateStatusRequest,
        target: str,
    ) -> dict:
        at = self._now()
        mandate = self._require_mandate(ctx, mandate_id)
        if mandate.status == "ended" and target != "ended":
            raise Conflict("已结束的委托不能恢复")
        if mandate.current_revision != request.expected_revision:
            raise Conflict("委托已被其他请求修改，请重新读取")
        open_requirements = self.store.list_requirements(
            mandate_id, status="open"
        )
        effective = target
        if target == "tracking" and open_requirements:
            effective = "pending_requirements"
        if effective == mandate.status:
            return self._view(mandate)
        updated = self.store.set_status(
            mandate_id,
            principal_id=ctx.principal_id,
            expected_revision=request.expected_revision,
            status=effective,
            outbox=[
                mandate_event(
                    f"mandate.{_EVENT_BY_STATUS[effective]}",
                    mandate_id,
                    revision=mandate.current_revision,
                    payload={"reason": request.reason},
                    occurred_at=at,
                )
            ],
            now=at,
        )
        return self._view(updated)

    def _resolve_requirement(
        self,
        ctx: RequestContext,
        mandate_id: str,
        requirement_id: str,
        request: RequirementResolutionRequest,
    ) -> dict:
        at = self._now()
        mandate = self._require_mandate(ctx, mandate_id)
        requirement = self.store.get_requirement(requirement_id)
        if requirement is None or requirement.mandate_id != mandate_id:
            raise NotFound("待补充项不存在")
        if requirement.status != "open":
            if requirement.status != request.resolution:
                raise Conflict("待补充项已被其他请求处理")
        else:
            requirement = self.store.update_requirement(
                requirement_id,
                status=request.resolution,
                resolved_at=at,
            )

        open_count = len(self.store.list_requirements(mandate_id, status="open"))
        if open_count == 0 and mandate.status == "pending_requirements":
            mandate = self.store.set_status(
                mandate_id,
                principal_id=ctx.principal_id,
                expected_revision=mandate.current_revision,
                status="tracking",
                outbox=[
                    mandate_event(
                        "mandate.requirements_completed",
                        mandate_id,
                        revision=mandate.current_revision,
                        payload={"requirement_id": requirement_id},
                        occurred_at=at,
                    )
                ],
                now=at,
            )
        return {
            "mandate": mandate.model_dump(mode="json"),
            "requirement": requirement.model_dump(mode="json"),
            "open_requirements": open_count,
        }

    # ── 公共辅助 ────────────────────────────────────────────────────

    def _idempotent(
        self,
        ctx: RequestContext,
        operation: str,
        key: str,
        payload: dict[str, Any],
        action: Callable[[], dict],
    ) -> dict:
        request_hash = _hash_payload(payload)
        at = self._now()
        with self.store.transaction():
            existing = self.store.get_idempotent_response(
                ctx.principal_id, operation, key
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise Conflict("同一幂等键已用于不同内容的请求")
                return dict(existing.response)
            response = action()
            self.store.save_idempotent_response(
                IdempotentResponse(
                    principal_id=ctx.principal_id,
                    operation=operation,
                    idempotency_key=key,
                    request_hash=request_hash,
                    response=response,
                    created_at=at,
                )
            )
            return response

    def _require_mandate(self, ctx: RequestContext, mandate_id: str) -> Mandate:
        mandate = self.store.get_mandate(mandate_id, principal_id=ctx.principal_id)
        if mandate is None:
            raise NotFound("委托不存在")
        return mandate

    def _default_timezone(self, ctx: RequestContext) -> str:
        """日程未指定时区时跟随用户的消推配置，而不是写死服务器时区。"""

        preferences = self.store.get_notification_preferences(
            ctx.principal_id, ctx.instance_id
        )
        return preferences.timezone if preferences else "Asia/Shanghai"

    def _view(self, mandate: Mandate) -> dict:
        revision = self.store.get_revision(mandate.mandate_id, mandate.current_revision)
        return {
            "mandate": mandate.model_dump(mode="json"),
            "revision": revision.model_dump(mode="json") if revision else None,
            "subjects": [
                item.model_dump(mode="json")
                for item in self.store.list_subjects(
                    mandate.mandate_id, mandate.current_revision
                )
            ],
            "requirements": [
                item.model_dump(mode="json")
                for item in self.store.list_requirements(mandate.mandate_id)
            ],
            "dependencies": [
                item.model_dump(mode="json")
                for item in self.store.list_dependencies(
                    mandate.mandate_id,
                    revision=mandate.current_revision,
                    active_only=True,
                )
            ],
            "schedules": [
                item.model_dump(mode="json")
                for item in self.store.list_schedules(
                    mandate.mandate_id,
                    revision=mandate.current_revision,
                    active_only=True,
                )
            ],
        }

    @staticmethod
    def _next_status(current: str, *, has_open_requirements: bool) -> str:
        if current in {"pending_requirements", "tracking"}:
            return "pending_requirements" if has_open_requirements else "tracking"
        return current  # paused 保持暂停；ended 在调用前已拒绝


_EVENT_BY_STATUS = {
    "tracking": "resumed",
    "paused": "paused",
    "ended": "ended",
    "pending_requirements": "review_requested",
}


def _with_schedule_trigger(triggers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """带日程的委托必须订阅 ``schedule.due``，否则到期实例没有路由目标。"""

    if any(item.get("hook_type") == "schedule.due" for item in triggers):
        return triggers
    return [*triggers, {"hook_type": "schedule.due", "rule_version": "1"}]


def _validate_contact_policy(policy: dict[str, Any]) -> ContactPolicy:
    """保存委托时即校验联系约定；坏配置不能等到投递时才被发现。"""

    try:
        parsed = parse_contact_policy(policy)
        validate_condition_definition(parsed.condition)
        if parsed.mode != "condition" and parsed.schedule is None:
            raise ContactPolicyError(f"{parsed.mode} 必须提供 schedule")
        if parsed.schedule is not None:
            ScheduleSpec.parse(parsed.schedule)
    except (ContactPolicyError, ConditionDefinitionError, ScheduleError) as exc:
        raise InvalidRequest(f"联系约定无效：{exc}") from None
    return parsed
