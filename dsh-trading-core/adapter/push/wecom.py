# -*- coding: utf-8 -*-
"""企业微信（群机器人）通道。

webhook key 从 .env 的 WECOM_WEBHOOK_KEY 读取（机器人 webhook 里的 key 部分）。
API：POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={KEY}
markdown 消息单条限制 4096 字节，超长时截断。
"""

import requests

from ..config import settings
from .base import Pusher


class WeComPusher(Pusher):
    name = "wecom"

    def __init__(self):
        self.key = settings.wecom_webhook_key

    def available(self) -> bool:
        return bool(self.key)

    def send(self, title: str, content: str) -> None:
        payload = {"msgtype": "markdown", "markdown": {"content": f"**{title}**\n{content}"}}
        # 微信 markdown 不支持表格，压缩成行式；单条 <4096 字节
        body = payload["markdown"]["content"]
        if len(body.encode("utf-8")) > 4000:
            body = body.encode("utf-8")[:4000].decode("utf-8", "ignore")
            payload["markdown"]["content"] = body
        resp = requests.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={self.key}",
            json=payload,
            timeout=15,
        )
        data = resp.json()
        if data.get("errcode") != 0:
            raise RuntimeError(f"企业微信返回错误: {data}")
