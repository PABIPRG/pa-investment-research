# -*- coding: utf-8 -*-
"""Pusher 抽象基类。"""

from abc import ABC, abstractmethod


class Pusher(ABC):
    """外部消息通道。

    available() 为 False 的通道会被 Manager 跳过；
    send() 失败抛异常，由 Manager 捕获逐通道隔离。
    """

    name: str = "abstract"

    @abstractmethod
    def available(self) -> bool:
        """通道是否已配置（如 SendKey / webhook key 是否填入）。"""

    @abstractmethod
    def send(self, title: str, content: str) -> None:
        """发送一条消息。title 为主标题，content 为正文（可含 Markdown）。"""
