# -*- coding: utf-8 -*-
"""研究实体工具执行层。

设计边界：
- 实体识别（Scope）只负责确定研究对象；
- 本包负责把已确认的实体映射到具体工具并执行；
- 工具结果必须带来源与状态，取不到数据时明确返回 unavailable/empty。
"""

from __future__ import annotations

from .contracts import ToolCall, ToolRequest, ToolResult
from .context import ToolContext, ToolUnavailable, build_context, records_from_frame
from .executor import ToolExecutor, summarize_results
from .registry import HANDLERS, get_handler, missing_handlers, validate_toolbox
from .samples import ENTITY_SAMPLES

__all__ = [
    "ENTITY_SAMPLES",
    "HANDLERS",
    "ToolCall",
    "ToolContext",
    "ToolExecutor",
    "ToolRequest",
    "ToolResult",
    "ToolUnavailable",
    "build_context",
    "get_handler",
    "missing_handlers",
    "records_from_frame",
    "summarize_results",
    "validate_toolbox",
]
