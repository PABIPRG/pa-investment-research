# -*- coding: utf-8 -*-
"""只读外部数据源适配器与通用批次转换。"""

from __future__ import annotations

from ...errors import InvalidSourceBatch
from ...models import EntityInstance, SourceBatch, SourceEntityRecord
from ...normalizer import entity_id_for_security


def records_to_entities(batch: SourceBatch, *, source_label: str) -> list[EntityInstance]:
    """把标准化批次转换为实体实例；不做重名合并或业务推断。"""

    entities: list[EntityInstance] = []
    for record in batch.records:
        entity_id = record.entity_id or _derive_entity_id(record)
        entities.append(
            EntityInstance(
                entity_id=entity_id,
                entity_type_code=record.entity_type_code,
                canonical_name=record.name,
                aliases=list(record.aliases),
                identifiers=dict(record.identifiers),
                attributes=dict(record.attributes),
                relations=list(record.related),
                source=source_label,
                last_verified_at=None,
                status="imported_unverified",
            )
        )
    return entities


def _derive_entity_id(record: SourceEntityRecord) -> str:
    if record.entity_type_code in (
        "ENTITY_01_01", "ENTITY_02_01", "ENTITY_01_02", "ENTITY_01_03", "ENTITY_01_04"
    ):
        code = (
            record.identifiers.get("security_code")
            or record.identifiers.get("company_code")
            or record.identifiers.get("fund_code")
            or record.identifiers.get("index_code")
            or record.identifiers.get("bond_code")
            or record.external_code
        )
        if not code:
            raise InvalidSourceBatch(f"证券记录缺少代码: {record.name}")
        return entity_id_for_security(record.entity_type_code, code)
    if record.entity_type_code == "ENTITY_03_01":
        return f"IND:CN:{record.name}"
    raise InvalidSourceBatch(
        f"数据源记录缺少 entity_id，且类型无法推导: {record.entity_type_code} / {record.name}"
    )
