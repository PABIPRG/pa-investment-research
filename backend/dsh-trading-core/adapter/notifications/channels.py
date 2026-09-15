# -*- coding: utf-8 -*-
"""统一通知中心的外部渠道适配器。"""

from __future__ import annotations

import json
import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any

from ..push.serverchan import ServerChanPusher
from ..push.wecom import WeComPusher
from .delivery import DeliveryError, DeliverySuppressed
from .repository import NotificationRepository


class LegacyPusherAdapter:
    """复用已有 Server 酱与企业微信实现，同时接入新投递状态机。"""

    def __init__(self, pusher: Any):
        self.pusher = pusher

    def send(self, job: dict) -> None:
        if not self.pusher.available():
            raise DeliverySuppressed("channel_not_configured", "通知渠道尚未配置")
        try:
            self.pusher.send(job["title"], job["content"])
        except Exception as exc:  # requests 与渠道业务错误都由队列统一退避
            raise DeliveryError(
                "channel_request_failed",
                retryable=True,
                outcome_uncertain=True,
                message=str(exc),
            ) from exc


class EmailAdapter:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str,
        password: str,
        sender: str,
    ):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.sender = sender

    def send(self, job: dict) -> None:
        if not self.host or not self.sender or job["destination"] in {"", "configured", "default"}:
            raise DeliverySuppressed("email_not_configured", "邮件通知尚未配置完整")
        message = EmailMessage()
        message["Subject"] = job["title"]
        message["From"] = self.sender
        message["To"] = job["destination"]
        message.set_content(job["content"])
        try:
            with smtplib.SMTP(self.host, self.port, timeout=15) as client:
                client.starttls(context=ssl.create_default_context())
                if self.username:
                    client.login(self.username, self.password)
                client.send_message(message)
        except (OSError, smtplib.SMTPException) as exc:
            raise DeliveryError(
                "smtp_failed",
                retryable=True,
                outcome_uncertain=True,
                message=str(exc),
            ) from exc


class WebPushAdapter:
    def __init__(
        self,
        repository: NotificationRepository,
        *,
        vapid_private_key: str,
        vapid_subject: str,
    ):
        self.repository = repository
        self.vapid_private_key = vapid_private_key
        self.vapid_subject = vapid_subject

    def send(self, job: dict) -> None:
        if not self.vapid_private_key:
            raise DeliverySuppressed("webpush_not_configured", "浏览器推送密钥尚未配置")
        subscriptions = (
            self.repository.active_subscriptions("browser")
            if job["destination"] in {"subscribers", "default"}
            else [self.repository.active_subscription("browser", job["destination"])]
        )
        subscriptions = [subscription for subscription in subscriptions if subscription is not None]
        if not subscriptions:
            raise DeliverySuppressed("subscription_inactive", "浏览器推送订阅已失效")
        try:
            from pywebpush import WebPushException, webpush
        except ImportError as exc:
            raise DeliverySuppressed("webpush_dependency_missing", "浏览器推送运行依赖未安装") from exc
        payload = json.dumps(
            {
                "notificationId": job["notificationId"],
                "title": job["title"],
                "body": job["content"],
                "action": job["action"],
            },
            ensure_ascii=False,
        )
        delivered = 0
        for subscription in subscriptions:
            try:
                webpush(
                    subscription_info=subscription["subscription"],
                    data=payload,
                    vapid_private_key=self.vapid_private_key,
                    vapid_claims={"sub": self.vapid_subject},
                    ttl=300,
                )
                delivered += 1
            except WebPushException as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status in {404, 410}:
                    self.repository.deactivate_subscription(
                        "browser", subscription["deviceId"], datetime.now(timezone.utc)
                    )
                    continue
                retryable = status is None or status == 429 or status >= 500
                raise DeliveryError(
                    "webpush_failed",
                    retryable=retryable,
                    outcome_uncertain=status is None or retryable,
                    message=str(exc),
                ) from exc
        if delivered == 0:
            raise DeliverySuppressed("subscription_expired", "浏览器推送订阅已全部过期")


def build_delivery_adapters(repository: NotificationRepository, settings: Any) -> dict[str, Any]:
    return {
        "serverchan": LegacyPusherAdapter(ServerChanPusher()),
        "wecom": LegacyPusherAdapter(WeComPusher()),
        "email": EmailAdapter(
            host=settings.notification_smtp_host,
            port=settings.notification_smtp_port,
            username=settings.notification_smtp_username,
            password=settings.notification_smtp_password,
            sender=settings.notification_smtp_from,
        ),
        "browser": WebPushAdapter(
            repository,
            vapid_private_key=settings.notification_vapid_private_key,
            vapid_subject=settings.notification_vapid_subject,
        ),
    }
