# -*- coding: utf-8 -*-
"""外部推送通道（功能4）。单通道失败不影响其它通道。

用法：
    from .push import PusherManager
    results = PusherManager().push(title, content)   # [("serverchan", True), ...]
"""

from .base import Pusher
from .manager import PusherManager
from .serverchan import ServerChanPusher
from .wecom import WeComPusher

__all__ = ["Pusher", "PusherManager", "ServerChanPusher", "WeComPusher"]
