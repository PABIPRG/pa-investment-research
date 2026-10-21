# -*- coding: utf-8 -*-
"""同一实体来自多个数据源时的合并规则。

原则：
- 新数据源可以更新标准名与标识，但不得静默丢掉旧别名（例如词典里的“白酒”
  不能被只含行业标准名的证券名称表覆盖）。
- 状态只升不降：已核验记录不会被后来的未核验导入降级。
"""

from __future__ import annotations

from .models import EntityInstance, EntityRelation

_STATUS_RANK = {
    "retired": 0,
    "imported_unverified": 1,
    "unverified": 2,
    "verified": 3,
}


def _dedupe(values) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def merge_entity(existing: EntityInstance, incoming: EntityInstance) -> EntityInstance:
    aliases = list(existing.aliases)
    if existing.canonical_name != incoming.canonical_name:
        aliases.append(existing.canonical_name)
    aliases.extend(incoming.aliases)
    aliases = [item for item in _dedupe(aliases) if item != incoming.canonical_name]

    relations = merge_relations(existing.relations, incoming.relations)

    status = incoming.status
    if _STATUS_RANK.get(existing.status, 0) > _STATUS_RANK.get(incoming.status, 0):
        status = existing.status

    return incoming.model_copy(
        update={
            "aliases": aliases,
            "identifiers": {**existing.identifiers, **incoming.identifiers},
            "attributes": {**existing.attributes, **incoming.attributes},
            "relations": relations,
            "source": incoming.source or existing.source,
            "last_verified_at": incoming.last_verified_at or existing.last_verified_at,
            "status": status,
        }
    )


def merge_relations(
    existing: list[EntityRelation], incoming: list[EntityRelation]
) -> list[EntityRelation]:
    """按 (target, relation_type) 合并关系，返回值不修改入参。"""

    merged = list(existing)
    seen = {(item.target_entity_id, item.relation_type) for item in merged}
    for relation in incoming:
        if (relation.target_entity_id, relation.relation_type) not in seen:
            merged.append(relation)
            seen.add((relation.target_entity_id, relation.relation_type))
    return merged
