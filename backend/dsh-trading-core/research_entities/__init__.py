# -*- coding: utf-8 -*-
"""研究实体层：类型注册、实体抽取与消歧、研究 Scope、Tool 预挂载。

设计约束：
- 领域层只依赖本包内的模型与端口，不直接依赖 sqlite3 / akshare / pandas。
- 存储与外部数据源通过 ``ports`` 定义，具体实现放在 ``adapters``。
- 上层（未来 API / 编排）只调用 ``service.ResearchEntityService``。
"""

from .models import (
    SCHEMA_VERSION,
    AuditEvent,
    Constraints,
    EntityCandidate,
    EntityCollection,
    EntityInstance,
    EntityMention,
    EntityRelation,
    EntityTypeDef,
    IntentItem,
    PreloadTool,
    ResearchScope,
    SourceBatch,
    SourceCapabilities,
    SourceEntityRecord,
    SourceHealth,
    ToolDefinition,
)

__all__ = [
    "SCHEMA_VERSION",
    "AuditEvent",
    "Constraints",
    "EntityCandidate",
    "EntityCollection",
    "EntityInstance",
    "EntityMention",
    "EntityRelation",
    "EntityTypeDef",
    "IntentItem",
    "PreloadTool",
    "ResearchScope",
    "SourceBatch",
    "SourceCapabilities",
    "SourceEntityRecord",
    "SourceHealth",
    "ToolDefinition",
]
