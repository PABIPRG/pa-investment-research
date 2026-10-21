# -*- coding: utf-8 -*-
"""工具箱契约：请求、结果与执行调用。

工具层只依赖实体库端口和 ``ToolContext``；不直接读取配置文件、
不直接持有 requests/pandas 对象，便于离线单测替换网络层。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..models import AuthorizationStatus, EntityInstance

if TYPE_CHECKING:  # pragma: no cover - 仅类型检查
    from .context import ToolContext

ToolStatus = Literal["ok", "empty", "unavailable", "error", "needs_authorization"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class ToolRequest(_Model):
    """一次工具调用请求。entity_ids 由 Scope 或调用方传入。"""

    tool_id: str = Field(min_length=1)
    entity_ids: list[str] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    request_id: str | None = None
    # 调用方显式声明用户已授权；工具层不会自行推断授权。
    authorized: bool = False


class ToolResult(_Model):
    """工具执行结果。状态必须如实反映是否真正取到数据。"""

    tool_id: str = Field(min_length=1)
    status: ToolStatus
    entity_ids: list[str] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)
    source: str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    duration_ms: int | None = None
    authorization: AuthorizationStatus = "not_required"
    # 命中本地缓存时保留原始 fetched_at，并显式标记，避免被当作新抓取。
    cache_hit: bool = False

    @property
    def record_count(self) -> int:
        records = self.data.get("records")
        return len(records) if isinstance(records, list) else 0


@dataclass
class ToolCall:
    """交给处理器的不可变调用上下文。"""

    request: ToolRequest
    entities: list[EntityInstance]
    ctx: "ToolContext"
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def tool_id(self) -> str:
        return self.request.tool_id

    @property
    def params(self) -> dict[str, Any]:
        return self.request.params
