# -*- coding: utf-8 -*-
"""消推配置与暂缓（用户侧命令）。

渠道、时区与静默时段是用户与产品之间的边界，不属于单次研究结果；
保存时即校验，避免坏配置在投递时才变成难以解释的抑制。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .commands import NotificationPreferencesRequest, SnoozeCreateRequest
from .contact_policy import ContactPolicyError, parse_quiet_hours
from .context import RequestContext
from .errors import InvalidRequest, NotFound
from .models import NotificationPreferences, SnoozeEntry
from .ports import BusinessStore


class NotificationSettingsService:
    def __init__(
        self,
        store: BusinessStore,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))

    def get_preferences(self, context: RequestContext) -> dict:
        context.require("notification:read")
        preferences = self.store.get_notification_preferences(
            context.principal_id, context.instance_id
        )
        if preferences is None:
            return {
                "preferences": {
                    "principal_id": context.principal_id,
                    "instance_id": context.instance_id,
                    "timezone": "Asia/Shanghai",
                    "quiet_hours": None,
                    "channels": ["app"],
                    "updated_at": None,
                }
            }
        return {"preferences": preferences.model_dump(mode="json")}

    def save_preferences(
        self, context: RequestContext, request: NotificationPreferencesRequest
    ) -> dict:
        context.require("notification:write")
        try:
            ZoneInfo(request.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise InvalidRequest(f"未知时区: {request.timezone}") from None
        quiet_hours = None
        if request.quiet_hours is not None:
            try:
                quiet_hours = parse_quiet_hours(request.quiet_hours)
            except ContactPolicyError as exc:
                raise InvalidRequest(str(exc)) from None
        preferences = NotificationPreferences(
            principal_id=context.principal_id,
            instance_id=context.instance_id,
            timezone=request.timezone,
            quiet_hours=quiet_hours,
            channels=request.channels,
            updated_at=self._now(),
        )
        saved = self.store.save_notification_preferences(preferences)
        return {"preferences": saved.model_dump(mode="json")}

    def create_snooze(
        self, context: RequestContext, request: SnoozeCreateRequest
    ) -> dict:
        context.require("notification:write")
        at = self._now()
        if request.until <= at:
            raise InvalidRequest("暂缓截止时间必须晚于当前时间")
        if request.scope_type == "mandate":
            if (
                self.store.get_mandate(
                    request.scope_id, principal_id=context.principal_id
                )
                is None
            ):
                raise NotFound("委托不存在")
        entry = SnoozeEntry(
            snooze_id=f"SNO_{secrets.token_hex(16)}",
            principal_id=context.principal_id,
            instance_id=context.instance_id,
            scope_type=request.scope_type,
            scope_id=request.scope_id,
            until=request.until,
            reason=request.reason,
            created_at=at,
        )
        saved = self.store.create_snooze(entry)
        return {"snooze": saved.model_dump(mode="json")}

    def list_snoozes(self, context: RequestContext, *, active_only: bool = True) -> dict:
        context.require("notification:read")
        items = self.store.list_snoozes(
            principal_id=context.principal_id,
            instance_id=context.instance_id,
            now=self._now(),
            active_only=active_only,
        )
        return {"items": [item.model_dump(mode="json") for item in items]}
