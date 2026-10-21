# -*- coding: utf-8 -*-
"""研究委托核心（mandate core）。

职责边界：
- 委托版本、追踪依赖编译、事件路由、持久研究任务、联系决定。
- 研究执行仍由既有 research_entities（:8300）与 DSH 工具承担。
"""

from .context import RequestContext
from .models import (
    SCHEMA_VERSION,
    ContactDecision,
    ContactRecord,
    EventEnvelope,
    IdempotentResponse,
    InboxRecord,
    Mandate,
    MandateRequirement,
    MandateRevision,
    MandateSubject,
    OutboxMessage,
    ResearchJob,
    ResearchJobResult,
    TrackingDependency,
)

__all__ = [
    "SCHEMA_VERSION",
    "ContactDecision",
    "ContactRecord",
    "EventEnvelope",
    "IdempotentResponse",
    "InboxRecord",
    "Mandate",
    "MandateRequirement",
    "MandateRevision",
    "MandateSubject",
    "OutboxMessage",
    "RequestContext",
    "ResearchJob",
    "ResearchJobResult",
    "TrackingDependency",
]
