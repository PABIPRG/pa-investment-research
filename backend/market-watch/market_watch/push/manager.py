# -*- coding: utf-8 -*-
"""PusherManager：按配置聚合可用通道，逐通道推送，单失败不影响其它。"""

import logging

from ..config import settings
from .base import Pusher
from .serverchan import ServerChanPusher
from .wecom import WeComPusher

logger = logging.getLogger("market_watch.push")


class PusherManager:
    def __init__(self):
        self.pushers: list[Pusher] = []
        for pusher in (ServerChanPusher(), WeComPusher()):
            if not pusher.available():
                continue
            # MW_PUSH_CHANNELS 显式列出时只启用列出的通道
            if settings.push_channels and pusher.name not in settings.push_channels:
                continue
            self.pushers.append(pusher)

    def push(self, title: str, content: str) -> list[dict]:
        """向所有已配置通道发送，返回 [(channel, ok, error?)]。"""
        results = []
        if not self.pushers:
            logger.info("无可用推送通道（未配置 SendKey/webhook）")
            return results
        for p in self.pushers:
            try:
                p.send(title, content)
                results.append({"channel": p.name, "ok": True})
                logger.info("推送成功: %s", p.name)
            except Exception as exc:  # 单通道失败不拖垮其它通道
                results.append({"channel": p.name, "ok": False, "error": str(exc)})
                logger.warning("推送失败 %s: %s", p.name, exc)
        return results
