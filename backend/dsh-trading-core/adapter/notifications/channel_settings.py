"""Host 管理的渠道配置仅驻留内存，发送复用通知队列。"""
from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from typing import Callable

from .channels import EmailAdapter, LegacyPusherAdapter
from .delivery import DeliveryError, DeliverySuppressed
from ..push.serverchan import ServerChanPusher
from ..push.wecom import WeComPusher

EXTERNAL_CHANNELS = {"serverchan", "wecom", "email"}
TEST_TITLE = "投研智能体 · 通知渠道测试"
TEST_CONTENT = "这是一条由你主动发起的渠道测试消息，不包含持仓、账户或研究数据。"
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def validate_snapshot(snapshot: dict) -> dict:
    if not isinstance(snapshot, dict) or set(snapshot) - EXTERNAL_CHANNELS:
        raise ValueError("不支持的通知渠道配置")
    result = {}
    for channel, config in snapshot.items():
        if not isinstance(config, dict) or set(config) != {"revision", "enabled", "fields"}:
            raise ValueError("渠道配置格式不正确")
        revision, enabled, fields = config["revision"], config["enabled"], config["fields"]
        if not isinstance(revision, str) or not IDENTIFIER.fullmatch(revision) or not isinstance(enabled, bool):
            raise ValueError("渠道版本或启用状态无效")
        allowed = {"sendkey"} if channel == "serverchan" else {"key"} if channel == "wecom" else {"host", "port", "username", "password", "sender", "recipient"}
        if not isinstance(fields, dict) or set(fields) != allowed:
            raise ValueError("请填写完整的渠道参数")
        if any(not isinstance(value, str) or not value or len(value) > 4096 or any(c in value for c in "\r\n\0") for value in fields.values()):
            raise ValueError("渠道参数不能为空、超长或包含换行")
        if channel == "serverchan" and not re.fullmatch(r"SCT[A-Za-z0-9_-]+", fields["sendkey"]):
            raise ValueError("请填写 Server 酱 Turbo 的 SCT 开头 SendKey")
        if channel == "wecom" and not re.fullmatch(r"[A-Za-z0-9_-]+", fields["key"]):
            raise ValueError("企业微信机器人 key 格式不正确")
        if channel == "email":
            if not re.fullmatch(r"[A-Za-z0-9.-]+", fields["host"]) or len(fields["host"]) > 253:
                raise ValueError("请填写 SMTP 服务器域名，不要填写网址")
            if not fields["port"].isdigit() or not 1 <= int(fields["port"]) <= 65535 or int(fields["port"]) == 465:
                raise ValueError("请输入 STARTTLS 端口（通常为 587），不支持 465 隐式 TLS")
            if any(not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", fields[name]) for name in ("sender", "recipient")):
                raise ValueError("发件人和收件人必须是单个有效邮箱地址")
        result[channel] = {"revision": revision, "enabled": enabled, "fields": dict(fields)}
    return result


def send_channel(channel: str, fields: dict, job: dict) -> None:
    if channel == "serverchan":
        adapter = LegacyPusherAdapter(ServerChanPusher(sendkey=fields["sendkey"]))
    elif channel == "wecom":
        adapter = LegacyPusherAdapter(WeComPusher(key=fields["key"]))
    else:
        adapter = EmailAdapter(host=fields["host"], port=int(fields["port"]), username=fields["username"], password=fields["password"], sender=fields["sender"])
        job = {**job, "destination": fields["recipient"]}
    adapter.send(job)


class RuntimeNotificationChannels:
    def __init__(self, repository, *, sender: Callable = send_channel):
        self.repository = repository
        self.sender = sender
        self.ready = False
        self.snapshot = {}
        self.lock = threading.RLock()

    def apply(self, snapshot: dict) -> None:
        validated = validate_snapshot(snapshot)
        with self.lock:
            for channel, config in validated.items():
                previous = self.snapshot.get(channel)
                if previous and previous["revision"] == config["revision"] and previous != config:
                    raise ValueError("配置发生变化时必须使用新版本")
            destinations = {}
            for channel in EXTERNAL_CHANNELS:
                config = validated.get(channel)
                destination = self._destination(channel, config) if config and config["enabled"] else None
                destinations[channel] = destination
            self.repository.cancel_channel_jobs(destinations, datetime.now(timezone.utc))
            self.snapshot = validated
            self.ready = True

    @staticmethod
    def _destination(channel, config):
        return f"managed:{channel}:{config['revision']}"

    def destination(self, channel: str) -> str | None:
        # Published snapshots are immutable; business event handlers never wait for network I/O.
        config = self.snapshot.get(channel)
        return self._destination(channel, config) if config and config["enabled"] else None

    def adapters(self) -> dict:
        runtime = self

        class Adapter:
            def __init__(self, channel):
                self.channel = channel

            def send(self, job):
                runtime.send(self.channel, job)

        return {channel: Adapter(channel) for channel in EXTERNAL_CHANNELS}

    def send(self, channel: str, job: dict) -> None:
        # Configuration cannot change between the final check and network dispatch.
        with self.lock:
            if job["destination"] != self.destination(channel):
                raise DeliverySuppressed("channel_configuration_changed", "渠道已停用或配置已变化，请勿重发旧目标告警")
            notification = self.repository.get(job["notificationId"])
            is_test = notification["action"]["kind"] == "notification-test"
            if not is_test and self.repository.preference(notification["category"], channel) is False:
                raise DeliverySuppressed("preference_disabled", "该类型的渠道投递已关闭")
            try:
                self.sender(channel, self.snapshot[channel]["fields"], job)
            except Exception:
                # Provider responses and URLs may contain credentials: never retain their text.
                raise DeliveryError("channel_send_failed", retryable=not is_test, outcome_uncertain=True,
                                    message="渠道发送未确认成功，请检查接收端、凭据、服务权限和网络。") from None

    def test(self, channel: str, request_id: str, revision: str) -> dict:
        if not isinstance(channel, str) or channel not in EXTERNAL_CHANNELS:
            raise ValueError("不支持的通知渠道")
        if not isinstance(request_id, str) or not IDENTIFIER.fullmatch(request_id):
            raise ValueError("测试请求标识无效")
        with self.lock:
            destination = self.destination(channel)
            if not destination or self.snapshot[channel]["revision"] != revision:
                raise ValueError("请先保存并启用当前渠道配置，再发送测试通知")
            now = datetime.now(timezone.utc)
            identifier = f"{channel}:{revision}:{request_id}"
            return self.repository.publish(
                event={"producer": "notification-channel-test", "eventId": identifier, "type": "notification.channel.test.v1",
                       "occurredAt": now, "subject": {"kind": "notification-test", "id": channel}, "payload": {}},
                notification={"category": "research", "severity": "information", "title": TEST_TITLE, "summary": TEST_CONTENT,
                              "body": TEST_CONTENT, "externalContent": TEST_CONTENT, "dedupeKey": identifier,
                              "action": {"kind": "notification-test", "id": channel}},
                channels=[(channel, destination)], now=now, dedupe_window_seconds=0,
            )
