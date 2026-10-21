# -*- coding: utf-8 -*-
"""研究实体测试夹具。

所有证券数据都是人工构造的最小事实样例，不代表真实行情或主数据核验结果。
"""

from __future__ import annotations

from datetime import datetime, timezone

from research_entities.adapters.sources.gazetteer_json import GazetteerJsonSource
from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.models import (
    EntityCollection,
    EntityInstance,
    EntityRelation,
    SourceBatch,
    SourceEntityRecord,
)
from research_entities.normalizer import entity_id_for_security
from research_entities.service import ResearchEntityService

STOCKS = [
    ("600519", "贵州茅台", "食品饮料"),
    ("000858", "五粮液", "食品饮料"),
    ("300750", "宁德时代", "电力设备"),
    ("601318", "中国平安", "非银金融"),
    ("300785", "值得买", "互联网电商"),
]


def seed_stocks(repository, stocks=STOCKS) -> None:
    entities: list[EntityInstance] = []
    for code, name, industry in stocks:
        security_id = entity_id_for_security("ENTITY_01_01", code)
        company_id = entity_id_for_security("ENTITY_02_01", code)
        industry_id = f"IND:CN:{industry}"
        entities.append(
            EntityInstance(
                entity_id=security_id,
                entity_type_code="ENTITY_01_01",
                canonical_name=name,
                identifiers={"security_code": code, "exchange": code[:1]},
                attributes={"name_basis": "fixture"},
                relations=[
                    EntityRelation(target_entity_id=company_id, relation_type="issuer_company")
                ],
                source="fixture",
                status="imported_unverified",
            )
        )
        entities.append(
            EntityInstance(
                entity_id=company_id,
                entity_type_code="ENTITY_02_01",
                canonical_name=name,
                identifiers={"company_code": code, "security_code": code},
                attributes={"name_basis": "fixture"},
                relations=[
                    EntityRelation(target_entity_id=security_id, relation_type="listed_security"),
                    EntityRelation(target_entity_id=industry_id, relation_type="belongs_to_industry"),
                ],
                source="fixture",
                status="imported_unverified",
            )
        )
    repository.upsert_entities(entities, source_version="fixture-v1")


def build_service(stocks=STOCKS, collection_provider=None, repository=None):
    repository = repository or InMemoryEntityRepository()
    service = ResearchEntityService(
        repository,
        collection_provider=collection_provider,
        gazetteer=_gazetteer(),
    )
    service.import_source(GazetteerJsonSource())
    if stocks:
        seed_stocks(repository, stocks)
    return service


def _gazetteer():
    from research_entities.extractor import Gazetteer

    return Gazetteer()


class FakeCollectionProvider:
    def __init__(self, collections: dict[str, EntityCollection]) -> None:
        self.collections = collections

    def get_collection(self, collection_type: str):
        return self.collections.get(collection_type)


def collection(collection_type: str, codes: list[str], authorization: str = "authorized"):
    return EntityCollection(
        collection_id=collection_type,
        collection_type=collection_type,
        source="test",
        as_of=datetime.now(timezone.utc),
        member_entity_ids=[
            entity_id_for_security("ENTITY_01_01", code) for code in codes
        ],
        filter_definition={"kind": "test"},
        authorization_status=authorization,
    )


def sample_batch(records: list[SourceEntityRecord], source_version: str = "v1") -> SourceBatch:
    return SourceBatch(
        source_id="test_source",
        source_version=source_version,
        fetched_at=datetime.now(timezone.utc),
        records=records,
    )
