# -*- coding: utf-8 -*-
"""聊天式“我的投研”的会话级策略与标的选择。"""

from datetime import datetime, timezone
from typing import Any

from .schemas import ResearchChatContextSaveRequest
from .store import JsonStore


COLLECTION = "research_chat_contexts"


class ResearchChatRevisionConflict(RuntimeError):
    """客户端修订号落后于后端已确认状态。"""

    def __init__(self, current_revision: int):
        super().__init__(f"research chat context revision conflict: {current_revision}")
        self.current_revision = current_revision


class ResearchChatStrategyNotFound(KeyError):
    """保存请求引用了策略池中不存在的策略。"""


def get_research_chat_context(store: JsonStore, session_id: str) -> dict | None:
    """读取一个会话的完整上下文；从未保存时返回 None。"""

    value = store.get(COLLECTION, session_id)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TypeError("会话投研上下文必须是 JSON 对象")
    return value


def save_research_chat_context(
    store: JsonStore,
    session_id: str,
    request: ResearchChatContextSaveRequest,
) -> dict:
    """以 compare-and-swap 语义保存完整目标上下文并返回已提交记录。"""

    if request.strategy_id is not None and store.get("strategies", request.strategy_id) is None:
        raise ResearchChatStrategyNotFound(request.strategy_id)

    def transform(current: Any) -> dict:
        if current is None:
            current_revision = 0
        elif isinstance(current, dict):
            raw_revision = current.get("revision")
            if not isinstance(raw_revision, int) or raw_revision < 1:
                raise TypeError("会话投研上下文修订号无效")
            current_revision = raw_revision
        else:
            raise TypeError("会话投研上下文必须是 JSON 对象")

        if current_revision != request.expected_revision:
            raise ResearchChatRevisionConflict(current_revision)

        return {
            "schema_version": 1,
            "session_id": session_id,
            "strategy_id": request.strategy_id,
            "instrument": (
                None if request.instrument is None else request.instrument.model_dump()
            ),
            "revision": current_revision + 1,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    return store.mutate(COLLECTION, session_id, transform, None)
