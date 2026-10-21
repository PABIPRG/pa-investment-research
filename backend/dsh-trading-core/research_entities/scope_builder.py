# -*- coding: utf-8 -*-
"""研究 Scope 构建。

Scope 是实体识别与实际研究执行之间的中间层：
- 不绕过实体校验构造"已确认"实体；
- 允许部分完成，但只有全部关键实体确认后才标记 scope_ready。
"""

from __future__ import annotations

import re

from .disambiguator import clarification_for
from .models import (
    Constraints,
    EntityCollection,
    EntityMention,
    IntentItem,
    PreloadTool,
    ResearchScope,
    ScopeEntity,
)
from .registry.intents import INTENT_REGISTRY

_SUBJECT_TYPES = {"ENTITY_01_01", "ENTITY_02_01"}
_THEME_TYPES = {
    "ENTITY_03_01", "ENTITY_03_02", "ENTITY_03_03",
    "ENTITY_04_01", "ENTITY_04_02", "ENTITY_05_02",
}
_BENCHMARK_TYPES = {"ENTITY_01_03", "ENTITY_05_03"}
_EVENT_TYPES = {"ENTITY_04_03", "ENTITY_04_04"}
_MACRO_TYPES = {"ENTITY_06_01", "ENTITY_06_02", "ENTITY_06_03"}

_COLLECTION_LABELS = {
    "USER_PORTFOLIO": "用户持仓",
    "USER_WATCHLIST": "用户自选",
    "DYNAMIC_COMPARABLES": "动态可比对象",
    "TASK_GENERATED_SET": "任务生成集合",
}

_TIME_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?:最近|近)\s*(?:半)\s*年"), "近半年"),
    (re.compile(r"(?:最近|近)\s*(?:一|1)\s*年"), "近一年"),
    (re.compile(r"(?:最近|近)\s*(?:两|二|2)\s*年"), "近两年"),
    (re.compile(r"(?:最近|近)\s*(?:三|3)\s*年"), "近三年"),
    (re.compile(r"(?:最近|近)\s*(?:一|1)\s*个?月"), "近一个月"),
    (re.compile(r"(?:最近|近)\s*(?:三|3)\s*个?月"), "近三个月"),
    (re.compile(r"(?:最近|近)\s*(?:六|6)\s*个?月"), "近六个月"),
    (re.compile(r"(?:最近|近)\s*(?:一|1)\s*周"), "近一周"),
    (re.compile(r"(?:最近|近)\s*(?:一|1)\s*(?:天|日)"), "近一天"),
    (re.compile(r"今年以来|今年"), "今年以来"),
    (re.compile(r"去年"), "去年"),
    (re.compile(r"(20\d{2})\s*年"), r"\1年"),
)


def parse_time_range(query: str) -> str | None:
    for pattern, replacement in _TIME_PATTERNS:
        match = pattern.search(query)
        if match:
            if "\\1" in replacement:
                return f"{match.group(1)}年"
            return replacement
    return None


def detect_market_scope(query: str) -> str:
    if "港股" in query or "恒生" in query:
        return "港股"
    if "美股" in query or "纳斯达克" in query or "标普" in query:
        return "美股"
    return "A股"


class ScopeBuilder:
    def build(
        self,
        *,
        request_id: str,
        raw_query: str,
        intents: list[IntentItem],
        mentions: list[EntityMention],
        collections: list[EntityCollection],
        tools: list[PreloadTool],
        tool_warnings: list[str],
        entity_sources: dict[str, str] | None = None,
    ) -> ResearchScope:
        intent_codes = [item.intent_code for item in intents]
        warnings = list(tool_warnings)
        questions: list[str] = []
        scope_entities: list[ScopeEntity] = []

        collection_by_type = {item.collection_type: item for item in collections}
        dynamic_mentions = [item for item in mentions if item.dynamic_collection_types]
        entity_mentions = [item for item in mentions if not item.dynamic_collection_types]

        # 动态集合：只约束范围，不伪造静态实体。
        for mention in dynamic_mentions:
            for collection_type in mention.dynamic_collection_types:
                label = _COLLECTION_LABELS.get(collection_type, collection_type)
                collection = collection_by_type.get(collection_type)
                if collection is None or collection.authorization_status != "authorized":
                    questions.append(
                        f"无法读取{label}数据，是否愿意提供{label}，或者改为只研究指定标的？"
                    )
                    warnings.append(f"{label}未授权或不可读，未使用任何成员。")

        subject_order = 0
        comparison = "COMPANY_COMPARISON" in intent_codes
        for mention in entity_mentions:
            role = self._role_for(mention, subject_order, comparison)
            if role in ("primary_subject", "comparison_target"):
                subject_order += 1
            entity_id = mention.resolved_entity_id
            resolved_candidate = next(
                (
                    item
                    for item in mention.candidates
                    if item.entity_id == mention.resolved_entity_id
                ),
                None,
            )
            type_code = (
                resolved_candidate.entity_type_code
                if resolved_candidate is not None
                else (
                    mention.entity_type_candidates[0]
                    if mention.entity_type_candidates
                    else None
                )
            )
            canonical_name = None
            if mention.candidates:
                canonical_name = (
                    resolved_candidate.canonical_name
                    if resolved_candidate is not None
                    else mention.candidates[0].canonical_name
                )
            scope_entities.append(
                ScopeEntity(
                    mention_id=mention.mention_id,
                    entity_id=entity_id,
                    entity_type_code=type_code,
                    raw_text=mention.raw_text,
                    role=role,
                    resolution_status=mention.resolution_status,
                    confidence=mention.confidence,
                    canonical_name=canonical_name,
                )
            )
            question = clarification_for(mention)
            if question:
                questions.append(question)

        if not entity_mentions and not dynamic_mentions:
            questions.append("请补充你要研究的具体对象，例如证券代码、公司名称或产业主题。")

        # 未核验数据要在 Scope 里显式提示。
        sources = entity_sources or {}
        if any(source and "universe_json" in source for source in sources.values()):
            warnings.append("部分实体来自未核验的本地证券名称表，标准名称与关系尚未核验。")

        blockers = [
            item
            for item in entity_mentions
            if item.resolution_status != "resolved"
        ]
        unauthorized_collections = [
            item
            for item in dynamic_mentions
            if any(
                (collection_by_type.get(collection_type) is None
                 or collection_by_type[collection_type].authorization_status != "authorized")
                for collection_type in item.dynamic_collection_types
            )
        ]

        if not entity_mentions and not dynamic_mentions:
            status = "scope_incomplete"
        elif blockers or unauthorized_collections:
            status = "pending_clarification" if questions else "pending_entity_resolution"
        else:
            status = "scope_ready"

        constraint_notes = [
            f"数据范围：{_COLLECTION_LABELS.get(mention.dynamic_collection_types[0], mention.dynamic_collection_types[0])}"
            for mention in dynamic_mentions
            for collection_type in mention.dynamic_collection_types[:1]
        ]

        time_range = parse_time_range(raw_query)
        if time_range is None and "QUOTE_CHECK" in intent_codes:
            warnings.append("未指定时间范围，行情查询需要默认窗口。")

        return ResearchScope(
            request_id=request_id,
            raw_query=raw_query,
            intent_list=intents,
            entity_list=scope_entities,
            constraints=Constraints(
                time_range=time_range,
                market_scope=detect_market_scope(raw_query),
                other_constraints=constraint_notes,
            ),
            preload_tool_ids=[tool.tool_id for tool in tools],
            preload_tools=tools,
            clarification_questions=list(dict.fromkeys(questions)),
            warnings=list(dict.fromkeys(warnings)),
            status=status,
        )

    @staticmethod
    def _role_for(mention: EntityMention, subject_order: int, comparison: bool) -> str:
        types = set(mention.entity_type_candidates)
        if mention.dynamic_collection_types:
            return "constraint_source"
        if types & _EVENT_TYPES:
            return "event"
        if types & _MACRO_TYPES:
            return "macro_factor"
        if types & _BENCHMARK_TYPES:
            return "benchmark"
        if types & _SUBJECT_TYPES:
            if subject_order == 0:
                return "primary_subject"
            return "comparison_target" if comparison else "primary_subject"
        if types & _THEME_TYPES:
            return "primary_subject" if subject_order == 0 else "research_theme"
        return "primary_subject" if subject_order == 0 else "research_theme"
