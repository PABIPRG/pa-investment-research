# -*- coding: utf-8 -*-
"""联系决定的真实投递适配器：交给统一通知中心。

委托核心只决定“是否联系、为什么联系”；渠道、静默、重试与设备订阅属于
通知中心。这里把 ``ContactDecision`` 转成已注册的通知事件
``research.contact.send.v1``；重复投递由通知中心按 ``event_id`` 幂等吸收。

未配置地址或令牌时不要构造本适配器——核心会记录决定但不发送，避免把
“没有投递通道”伪装成“已经送达”。
"""

from __future__ import annotations

from datetime import timezone
from typing import Any

import requests

from .models import ContactDecision, ContactRecord


class NotificationCenterDispatcher:
    """``ContactDispatcher`` 的 HTTP 实现。"""

    producer = "research-partner"

    def __init__(
        self,
        endpoint: str,
        token: str,
        *,
        timeout: float = 3.0,
        channel: str = "browser",
        session: requests.Session | None = None,
    ) -> None:
        if not endpoint.strip():
            raise ValueError("通知中心地址不能为空")
        if not token.strip():
            raise ValueError("通知中心内部令牌不能为空")
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.channel = channel
        self._session = session or requests.Session()
        # 内网直连，不继承系统代理。
        self._session.trust_env = False

    def envelope(self, decision: ContactDecision) -> dict[str, Any]:
        summary = (decision.detail or decision.reason_code).strip() or decision.reason_code
        return {
            "eventId": f"research-contact:{decision.decision_id}",
            "schemaVersion": 1,
            "type": "research.contact.send.v1",
            "producer": self.producer,
            "occurredAt": decision.created_at.astimezone(timezone.utc).isoformat(),
            "subject": {"kind": "mandate", "id": decision.mandate_id},
            "correlationId": decision.job_id or decision.decision_id,
            "payload": {
                "mandateId": decision.mandate_id,
                "mandateRevision": decision.mandate_revision,
                "decisionId": decision.decision_id,
                "title": "研究委托有新进展",
                "summary": summary[:2000],
                "reasonCode": decision.reason_code,
            },
        }

    def dispatch(self, decision: ContactDecision) -> ContactRecord:
        response = self._session.post(
            f"{self.endpoint}/internal/notification-events",
            json=self.envelope(decision),
            headers={"X-Notification-Token": self.token},
            timeout=self.timeout,
        )
        response.raise_for_status()
        body = response.json() if response.content else {}
        notification_id = body.get("id")
        return ContactRecord(
            decision_id=decision.decision_id,
            channel=self.channel,
            status="duplicate" if body.get("duplicate") else "queued",
            sent_at=decision.created_at,
            delivery_job_id=str(notification_id) if notification_id else None,
            detail="通知中心已接收" if not body.get("duplicate") else "通知中心已有同一事件",
        )
