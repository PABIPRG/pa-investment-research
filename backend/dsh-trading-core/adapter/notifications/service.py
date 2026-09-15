# -*- coding: utf-8 -*-
"""通知事件渲染、偏好决议与应用操作。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from .models import NotificationEvent
from .repository import NotificationRepository


CATEGORIES = {"market_risk", "holding_plan", "holdings_sync", "research"}
CHANNELS = {"browser", "macos", "serverchan", "wecom", "email"}
SEVERITIES = {"action_required", "important", "information"}


def _text(value: Any, fallback: str = "—") -> str:
    result = str(value).strip() if value is not None else ""
    return result or fallback


def _render(event: NotificationEvent) -> dict[str, Any]:
    payload = event.payload
    kind = event.event_type
    action = {"kind": event.subject_kind, "id": event.subject_id}
    if kind == "market.price_alert.triggered.v1":
        name = _text(payload.get("securityName"), event.subject_id)
        title = f"{name}触发{_text(payload.get('ruleName'), '行情预警')}"
        summary = _text(payload.get("condition"))
        return {
            "category": "market_risk", "severity": "important", "title": title,
            "summary": summary, "body": summary, "action": action,
            "dedupeKey": f"{kind}:{event.subject_id}:{_text(payload.get('ruleName'))}",
            "externalContent": f"{name}：{summary}",
        }
    if kind == "market.event.matched.v1":
        headline = _text(payload.get("headline"))
        return {
            "category": "market_risk", "severity": "information", "title": headline,
            "summary": f"来源：{_text(payload.get('sourceName'))}", "body": headline,
            "action": action, "dedupeKey": f"{kind}:{event.subject_id}:{headline}",
            "externalContent": headline,
        }
    if kind.startswith("portfolio.plan."):
        plan_name = _text(payload.get("planName"), "持仓计划")
        suffixes = {
            "portfolio.plan.due.v1": ("计划即将到期", "important"),
            "portfolio.plan.threshold_reached.v1": (f"触发{_text(payload.get('triggerName'))}", "important"),
            "portfolio.plan.expired.v1": ("计划已失效", "action_required"),
            "portfolio.plan.reconciliation_required.v1": ("需要重新核对", "action_required"),
        }
        suffix, severity = suffixes[kind]
        summary = f"{plan_name}{suffix}"
        return {
            "category": "holding_plan", "severity": severity, "title": summary,
            "summary": summary, "body": summary, "action": action,
            "dedupeKey": f"{kind}:{_text(payload.get('planId'), event.subject_id)}:{_text(payload.get('planRevision'), 'current')}",
            "externalContent": summary,
        }
    if kind.startswith("holdings."):
        source = _text(payload.get("sourceName"), "持仓同步")
        if kind == "holdings.snapshot.changed.v1":
            title, severity = "持仓已更新", "important"
            summary = _text(payload.get("changeSummary"), "持仓发生变化")
            dedupe = f"{kind}:{_text(payload.get('syncRunId'))}"
        elif kind == "holdings.sync.action_required.v1":
            title, severity = "持仓同步需要处理", "action_required"
            summary = f"{source}需要人工处理：{_text(payload.get('reasonCode'))}"
            dedupe = f"{kind}:{source}:{_text(payload.get('reasonCode'))}"
        elif kind == "holdings.sync.failed.v1":
            title, severity = "持仓同步失败", "action_required"
            summary = f"{source}同步失败：{_text(payload.get('reasonCode'))}"
            dedupe = f"{kind}:{source}:{_text(payload.get('reasonCode'))}"
        elif kind == "holdings.sync.stale.v1":
            title, severity = "持仓数据已过期", "action_required"
            summary = f"{source}最后成功于 {_text(payload.get('lastSuccessfulAt'))}"
            dedupe = f"{kind}:{source}"
        else:
            title, severity = "持仓同步已恢复", "information"
            summary = f"{source}已恢复正常同步"
            dedupe = f"{kind}:{source}"
        return {
            "category": "holdings_sync", "severity": severity, "title": title,
            "summary": summary, "body": summary, "action": action,
            "dedupeKey": dedupe, "externalContent": summary,
        }
    if kind in {"research.brief.completed.v1", "research.brief.failed.v1"}:
        name = _text(payload.get("briefName"), "投研简报")
        failed = kind.endswith("failed.v1")
        title = f"{name}{'生成失败' if failed else '已生成'}"
        summary = _text(payload.get("summary") or payload.get("reasonCode"), title)
        return {
            "category": "research", "severity": "action_required" if failed else "information",
            "title": title, "summary": summary, "body": summary, "action": action,
            "dedupeKey": f"{kind}:{_text(payload.get('briefId'), name)}",
            "externalContent": f"{title}：{summary}",
        }
    summary = _text(payload.get("summary"), "自进化闭环已完成")
    return {
        "category": "research", "severity": "information", "title": "自进化闭环已完成",
        "summary": summary, "body": summary, "action": action,
        "dedupeKey": f"{kind}:{_text(payload.get('runId'))}", "externalContent": summary,
    }


class NotificationService:
    """通知中心的确定性应用接口。"""

    def __init__(
        self,
        repository: NotificationRepository,
        *,
        now: Callable[[], datetime] | None = None,
        channel_defaults: Mapping[str, Mapping[str, bool]] | None = None,
        channel_destinations: Mapping[str, str] | None = None,
        dedupe_window_seconds: int = 1800,
    ):
        self.repository = repository
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.channel_defaults = {
            category: dict(channels) for category, channels in (channel_defaults or {}).items()
        }
        self.channel_destinations = dict(channel_destinations or {})
        self.dedupe_window_seconds = dedupe_window_seconds

    def _channels(self, event_type: str, category: str) -> list[tuple[str, str]]:
        defaults = self.channel_defaults.get(event_type, self.channel_defaults.get(category, {}))
        result: list[tuple[str, str]] = []
        for channel in sorted(CHANNELS):
            explicit = self.repository.preference(category, channel)
            enabled = defaults.get(channel, False) if explicit is None else explicit
            if enabled:
                if channel == "browser":
                    # 每个设备独立一项投递，单设备失败重试不会让已送达设备收到重复通知。
                    result.extend(
                        (channel, subscription["deviceId"])
                        for subscription in self.repository.active_subscriptions("browser")
                    )
                else:
                    result.append((channel, self.channel_destinations.get(channel, "default")))
        return result

    def publish(self, event: NotificationEvent) -> dict[str, Any]:
        rendered = _render(event)
        mapping = event.to_mapping()
        mapping["occurredAt"] = event.occurred_at
        return self.repository.publish(
            event=mapping,
            notification=rendered,
            channels=self._channels(event.event_type, rendered["category"]),
            now=self.now(),
            dedupe_window_seconds=self.dedupe_window_seconds,
        )

    def get(self, notification_id: str) -> dict[str, Any]:
        return self.repository.get(notification_id)

    def list_notifications(self, *, view: str = "all", archived: bool = False, **filters: Any) -> dict[str, Any]:
        return self.repository.list(view=view, archived=archived, **filters)

    def set_read(self, notification_id: str, read: bool) -> dict[str, Any]:
        return self.repository.set_read(notification_id, read, self.now())

    def mark_all_read(self) -> list[str]:
        return self.repository.mark_all_read(self.now())

    def bulk_set_read(self, notification_ids: list[str], read: bool) -> list[str]:
        return self.repository.bulk_set_read(notification_ids, read, self.now())

    def set_archived(self, notification_id: str, archived: bool) -> dict[str, Any]:
        return self.repository.set_archived(notification_id, archived, self.now())

    def set_preference(self, category: str, channel: str, enabled: bool) -> None:
        if category not in CATEGORIES or channel not in CHANNELS:
            raise ValueError("不支持的通知偏好")
        self.repository.set_preference(category, channel, enabled, self.now())

    def preferences(self) -> dict[str, Any]:
        stored = {(row["category"], row["channel"]): row for row in self.repository.list_preferences()}
        items = []
        for category in sorted(CATEGORIES):
            for channel in sorted(CHANNELS):
                row = stored.get((category, channel))
                enabled = self.channel_defaults.get(category, {}).get(channel, False) if row is None else row["enabled"]
                items.append({"category": category, "channel": channel, "enabled": enabled, "explicit": row is not None})
        return {"items": items}

    def save_subscription(
        self,
        *,
        channel: str,
        device_id: str,
        endpoint: str,
        subscription: dict[str, Any],
    ) -> dict[str, Any]:
        if channel not in {"browser", "macos"}:
            raise ValueError("只有浏览器和系统通知可以注册设备")
        return self.repository.save_subscription(
            channel=channel,
            device_id=device_id,
            endpoint=endpoint,
            subscription=subscription,
            now=self.now(),
        )

    def active_subscriptions(self, channel: str) -> list[dict[str, Any]]:
        return self.repository.active_subscriptions(channel)

    def deactivate_subscription(self, channel: str, device_id: str) -> dict[str, Any]:
        return self.repository.deactivate_subscription(channel, device_id, self.now())

    def retry_delivery(self, notification_id: str, channel: str) -> dict[str, Any]:
        if channel not in CHANNELS:
            raise ValueError("不支持的通知渠道")
        return self.repository.retry_delivery(notification_id, channel, self.now())
