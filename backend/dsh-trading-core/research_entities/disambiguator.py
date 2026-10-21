# -*- coding: utf-8 -*-
"""候选排序、阈值判定与澄清问题。

原则：
- 有歧义不默选；没有标准数据时不伪造 entity_id。
- 公司与证券是互补对，不是冲突；按意图选择主实体，两者都保留。
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import EntityCandidate, EntityMention

HIGH_CONFIDENCE = 0.85
MEDIUM_CONFIDENCE = 0.60
AMBIGUITY_MARGIN = 0.08

_PORTFOLIO_INTENTS = {"PORTFOLIO_ANALYSIS", "PORTFOLIO_RISK_ANALYSIS"}
_QUOTE_INTENTS = {"QUOTE_CHECK"}
# 行情、个股分析、组合任务以证券为主实体，公司实体作为关联保留在候选中。
_SECURITY_PREFERRED_INTENTS = _PORTFOLIO_INTENTS | _QUOTE_INTENTS | {"STOCK_ANALYSIS"}


@dataclass
class Context:
    intent_codes: list[str]
    preferred_types: list[str]
    portfolio_members: set[str]


class Disambiguator:
    def __init__(self, repository) -> None:
        self.repository = repository

    def resolve(
        self,
        mention: EntityMention,
        candidates: list[EntityCandidate],
        context: Context,
    ) -> EntityMention:
        if mention.dynamic_collection_types:
            return mention.model_copy(
                update={
                    "resolution_status": "pending",
                    "resolution_reason": "dynamic_collection",
                    "candidates": [],
                    "confidence": None,
                }
            )

        if not candidates:
            reason = mention.resolution_reason or "no_candidate"
            return mention.model_copy(
                update={
                    "resolution_status": "unresolved",
                    "resolution_reason": reason,
                    "confidence": None,
                    "candidates": [],
                }
            )

        scored = [self._boost(candidate, context) for candidate in candidates]
        scored.sort(key=lambda item: (-item.confidence, item.entity_id))

        # 公司与证券指向同一代码：视为互补对。
        pair = self._company_security_pair(scored, context)
        if pair is not None:
            primary, secondary = pair
            return mention.model_copy(
                update={
                    "candidate_entity_ids": [item.entity_id for item in scored],
                    "resolved_entity_id": primary.entity_id,
                    "confidence": primary.confidence,
                    "resolution_status": "resolved",
                    "resolution_reason": f"company_security_pair:{secondary.entity_type_code}",
                    "candidates": scored,
                }
            )

        distinct = self._distinct_underlying(scored)
        top = scored[0]
        margin = top.confidence - scored[1].confidence if len(scored) > 1 else 1.0

        if len(distinct) > 1 and margin < AMBIGUITY_MARGIN:
            return mention.model_copy(
                update={
                    "candidate_entity_ids": [item.entity_id for item in scored],
                    "confidence": top.confidence,
                    "resolution_status": "ambiguous",
                    "resolution_reason": "multiple_distinct_candidates",
                    "candidates": scored,
                }
            )

        if top.confidence >= HIGH_CONFIDENCE:
            return mention.model_copy(
                update={
                    "candidate_entity_ids": [item.entity_id for item in scored],
                    "resolved_entity_id": top.entity_id,
                    "confidence": top.confidence,
                    "resolution_status": "resolved",
                    "resolution_reason": ",".join(top.match_reason) or "matched",
                    "candidates": scored,
                }
            )

        status = "ambiguous" if len(distinct) > 1 else "pending"
        reason = "medium_confidence" if top.confidence >= MEDIUM_CONFIDENCE else "low_confidence"
        return mention.model_copy(
            update={
                "candidate_entity_ids": [item.entity_id for item in scored],
                "confidence": top.confidence,
                "resolution_status": status,
                "resolution_reason": reason,
                "candidates": scored,
            }
        )

    def _boost(self, candidate: EntityCandidate, context: Context) -> EntityCandidate:
        confidence = candidate.confidence
        if candidate.entity_type_code in context.preferred_types:
            confidence += 0.03
        if any(code in _PORTFOLIO_INTENTS for code in context.intent_codes):
            if self._underlying_key(candidate) in context.portfolio_members:
                confidence += 0.05
        return candidate.model_copy(update={"confidence": round(min(confidence, 1.0), 3)})

    def _underlying_key(self, candidate: EntityCandidate) -> str:
        entity = self.repository.get(candidate.entity_id)
        if entity is None:
            return candidate.entity_id
        return (
            entity.identifiers.get("security_code")
            or entity.identifiers.get("company_code")
            or entity.identifiers.get("fund_code")
            or entity.identifiers.get("index_code")
            or entity.identifiers.get("bond_code")
            or entity.entity_id
        )

    def _distinct_underlying(self, candidates: list[EntityCandidate]) -> set[str]:
        return {self._underlying_key(candidate) for candidate in candidates}

    def _company_security_pair(
        self, scored: list[EntityCandidate], context: Context
    ) -> tuple[EntityCandidate, EntityCandidate] | None:
        if len(scored) < 2:
            return None
        first, second = scored[0], scored[1]
        if {first.entity_type_code, second.entity_type_code} != {"ENTITY_01_01", "ENTITY_02_01"}:
            return None
        if self._underlying_key(first) != self._underlying_key(second):
            return None
        security = first if first.entity_type_code == "ENTITY_01_01" else second
        company = second if security is first else first
        prefer_security = any(
            code in _SECURITY_PREFERRED_INTENTS for code in context.intent_codes
        )
        return (security, company) if prefer_security else (company, security)


def clarification_for(mention: EntityMention) -> str | None:
    """为需要确认的提及生成一条简洁问题；已解决或仅类型命中时返回 None。"""

    if mention.resolution_status == "resolved" or mention.dynamic_collection_types:
        return None
    if mention.resolution_status == "ambiguous":
        names = []
        for candidate in mention.candidates:
            names.append(f"{candidate.canonical_name}（{candidate.entity_id}）")
        label = "、".join(names[:5]) if names else "多个候选"
        return f"“{mention.raw_text}”对应多个对象（{label}），请确认你要研究的是哪一个？"
    if mention.resolution_status == "pending":
        if mention.candidates:
            top = mention.candidates[0]
            return f"“{mention.raw_text}”最可能是{top.canonical_name}（{top.entity_id}），请确认。"
        return f"“{mention.raw_text}”的实体信息还不确定，请补充证券代码或完整名称。"
    if mention.resolution_status == "unresolved":
        if mention.resolution_reason == "scenario_context":
            return (
                f"“{mention.raw_text}”可以指已发生事件、市场预期或宏观情景，"
                "请确认本次研究属于哪一种？"
            )
        if mention.resolution_reason in ("type_only_term", "fact_context"):
            return f"“{mention.raw_text}”还没有对应的标准事件记录，请补充公司或事件时间。"
        return f"没有找到“{mention.raw_text}”对应的标准实体，请补充证券代码或完整名称。"
    return None
