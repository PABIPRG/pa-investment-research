# -*- coding: utf-8 -*-
"""把 market-watch 已提交的业务事实发布到统一通知中心。"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import requests

from .config import settings


logger = logging.getLogger("market_watch.notification_publisher")


def center_enabled() -> bool:
    mode = settings.notification_mode
    return mode == "center" or (mode == "auto" and bool(settings.notification_internal_token))


def publish_event(event: dict[str, Any]) -> dict[str, Any]:
    if not center_enabled():
        return {"ok": False, "skipped": True, "reason": "legacy_mode"}
    if not settings.notification_internal_token:
        return {"ok": False, "skipped": True, "reason": "token_missing"}
    try:
        response = requests.post(
            f"{settings.trading_core_url.rstrip('/')}/internal/notification-events",
            json=event,
            headers={"X-Notification-Token": settings.notification_internal_token},
            timeout=settings.notification_timeout,
        )
        response.raise_for_status()
        return {"ok": True, "notificationId": response.json().get("id")}
    except Exception as exc:  # noqa: BLE001 — 通知失败不能回滚已登记的业务触发
        logger.warning("统一通知事件发布失败 type=%s: %s", event.get("type"), exc)
        return {"ok": False, "error": str(exc)[:300]}


def price_alert_event(trigger: dict[str, Any]) -> dict[str, Any]:
    return {
        "eventId": f"price-alert:{trigger['rule_id']}:{trigger['code']}:{trigger['ts']}",
        "schemaVersion": 1,
        "type": "market.price_alert.triggered.v1",
        "producer": "market-watch",
        "occurredAt": trigger["ts"],
        "subject": {"kind": "security", "id": trigger["code"]},
        "payload": {
            "securityName": trigger["name"],
            "ruleName": trigger["rule_name"],
            "condition": trigger["condition_text"],
            "price": trigger.get("price"),
            "value": trigger.get("value"),
        },
    }


def market_event_event(alert: dict[str, Any]) -> dict[str, Any]:
    event_id = str(alert.get("id") or "").strip()
    code = str(alert.get("code") or "").strip()
    headline = str(alert.get("summary") or alert.get("name") or "市场事件").strip()
    return {
        "eventId": f"market-event:{event_id}",
        "schemaVersion": 1,
        "type": "market.event.matched.v1",
        "producer": "market-watch",
        "occurredAt": datetime.now(ZoneInfo(settings.timezone)).isoformat(timespec="seconds"),
        "subject": {"kind": "security" if code else "none", "id": code or event_id},
        "payload": {
            "headline": headline,
            "sourceName": str(alert.get("source") or "市场资讯"),
            "hit": str(alert.get("hit") or ""),
            "url": str(alert.get("url") or ""),
        },
    }
