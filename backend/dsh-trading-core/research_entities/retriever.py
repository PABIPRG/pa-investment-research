# -*- coding: utf-8 -*-
"""候选实体检索。

只做"找到可能对应的标准实体"，不做最终判定；判定交给 disambiguator。
"""

from __future__ import annotations

from typing import Sequence

from .models import EntityCandidate, EntityMention
from .normalizer import is_six_digit_code, normalize_name, security_kind_for_code


class CandidateRetriever:
    def __init__(self, repository) -> None:
        self.repository = repository

    def retrieve(self, mention: EntityMention) -> list[EntityCandidate]:
        candidates: dict[str, EntityCandidate] = {}
        text = mention.normalized_text or mention.raw_text
        allowed = list(mention.entity_type_candidates) or None

        # 1) 抽取阶段已经命中的索引项。
        for entity_id in mention.candidate_entity_ids:
            entity = self.repository.get(entity_id)
            if entity is None:
                continue
            reasons = ["index_match"]
            confidence = 0.85
            if normalize_name(entity.canonical_name) == normalize_name(text):
                reasons = ["exact_name_match"]
                confidence = 0.95
            elif any(normalize_name(alias) == normalize_name(text) for alias in entity.aliases):
                reasons = ["alias_match"]
                confidence = 0.90
            if allowed and entity.entity_type_code not in allowed:
                continue
            self._merge(candidates, entity.entity_id, entity.entity_type_code,
                        entity.canonical_name, reasons, confidence, entity.source)

        # 2) 六位代码：按标识符精确查询。
        if is_six_digit_code(text):
            kind = security_kind_for_code(text)
            keys = {
                "stock": ("security_code", "company_code"),
                "fund": ("fund_code", "security_code"),
                "bond": ("bond_code",),
            }.get(kind, ("security_code", "index_code", "fund_code", "bond_code", "company_code"))
            for key in keys:
                for entity in self.repository.find_by_identifier(key, text):
                    if allowed and entity.entity_type_code not in allowed:
                        continue
                    self._merge(
                        candidates,
                        entity.entity_id,
                        entity.entity_type_code,
                        entity.canonical_name,
                        ["identifier_match"],
                        1.0,
                        entity.source,
                    )

        # 3) 名称/别名精确检索。
        for candidate in self.repository.find_by_name(text, type_codes=allowed, limit=30):
            self._merge(
                candidates,
                candidate.entity_id,
                candidate.entity_type_code,
                candidate.canonical_name,
                list(candidate.match_reason) or ["name_match"],
                candidate.confidence,
                candidate.source,
            )

        return sorted(candidates.values(), key=lambda item: (-item.confidence, item.entity_id))

    @staticmethod
    def _merge(
        bucket: dict[str, EntityCandidate],
        entity_id: str,
        type_code: str,
        canonical_name: str,
        reasons: Sequence[str],
        confidence: float,
        source: str | None,
    ) -> None:
        existing = bucket.get(entity_id)
        if existing is None:
            bucket[entity_id] = EntityCandidate(
                entity_id=entity_id,
                entity_type_code=type_code,
                canonical_name=canonical_name,
                match_reason=list(dict.fromkeys(reasons)),
                confidence=confidence,
                source=source,
            )
            return
        for reason in reasons:
            if reason not in existing.match_reason:
                existing.match_reason.append(reason)
        if confidence > existing.confidence:
            existing.confidence = confidence
