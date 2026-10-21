# -*- coding: utf-8 -*-
"""可信请求上下文。

主体与能力只能由服务端接入层构造；模型输出、事件 payload 或客户端
提交的 ``user_id`` 不得直接成为这里的字段。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .errors import Unauthorized


@dataclass(frozen=True)
class RequestContext:
    """一次请求的可信身份与能力边界。"""

    instance_id: str
    principal_id: str
    capabilities: frozenset[str] = field(default_factory=frozenset)
    authenticated: bool = True

    def __post_init__(self) -> None:
        if not self.instance_id.strip():
            raise Unauthorized("缺少实例标识")
        if not self.principal_id.strip():
            raise Unauthorized("缺少主体标识")
        if not self.authenticated:
            raise Unauthorized("请求未通过认证")

    def has(self, capability: str) -> bool:
        return capability in self.capabilities

    def require(self, capability: str) -> None:
        if not self.has(capability):
            raise Unauthorized(f"缺少能力: {capability}")

    @classmethod
    def system(cls, instance_id: str, principal_id: str) -> "RequestContext":
        """后台任务使用；能力由任务登记时确定，不从会话继承。"""
        return cls(
            instance_id=instance_id,
            principal_id=principal_id,
            capabilities=frozenset({"mandate:read", "mandate:write", "job:run"}),
        )
