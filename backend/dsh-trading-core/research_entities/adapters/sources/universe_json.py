# -*- coding: utf-8 -*-
"""A 股证券名称表（JSON）只读适配器。

当前数据来自 ``backend/industry-chain/data/a_share_universe.json``。
该文件只有证券简称、行业、板块和市值，没有公司法定名称，因此：
- 证券实体（ENTITY_01_01）以此为准；
- 公司实体（ENTITY_02_01）先按同一简称建档，并标注 name_basis，不冒充已核验公司主数据。
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...errors import InvalidSourceBatch, SourceUnavailable
from ...models import (
    EntityRelation,
    SourceBatch,
    SourceCapabilities,
    SourceEntityRecord,
    SourceHealth,
)
from ...normalizer import entity_id_for_security, infer_exchange


class UniverseJsonSource:
    source_id = "universe_json"

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def capabilities(self) -> SourceCapabilities:
        return SourceCapabilities(
            source_id=self.source_id,
            authoritative=False,
            supports_incremental=False,
            entity_type_codes=["ENTITY_01_01", "ENTITY_02_01", "ENTITY_03_01"],
            notes=[
                "仅含证券简称，不含公司法定名称、曾用名或英文名。",
                "导入数据标记为 imported_unverified，未经外部核验。",
            ],
        )

    def health(self) -> SourceHealth:
        exists = self.path.is_file()
        return SourceHealth(
            source_id=self.source_id,
            available=exists,
            detail="" if exists else f"文件不存在: {self.path}",
            checked_at=datetime.now(timezone.utc),
        )

    def fetch_entities(self, *, since: str | None = None) -> SourceBatch:
        if not self.path.is_file():
            raise SourceUnavailable(f"universe 文件不存在: {self.path}")
        raw_bytes = self.path.read_bytes()
        try:
            payload = json.loads(raw_bytes.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise InvalidSourceBatch(f"universe 文件无法解析: {self.path}") from exc
        if isinstance(payload, dict):
            payload = payload.get("items", [])
        if not isinstance(payload, list):
            raise InvalidSourceBatch("universe 文件必须是数组或以 items 包装的数组")

        source_version = hashlib.sha256(raw_bytes).hexdigest()[:16]
        records: list[SourceEntityRecord] = []
        warnings: list[str] = []
        seen_codes: set[str] = set()
        seen_names: dict[str, list[str]] = {}
        industries: dict[str, SourceEntityRecord] = {}

        for item in payload:
            if not isinstance(item, dict):
                warnings.append("跳过非对象记录")
                continue
            code = str(item.get("code", "")).strip()
            name = str(item.get("name", "")).strip()
            if len(code) != 6 or not code.isdigit() or not name:
                warnings.append(f"跳过非法证券记录: code={code!r} name={name!r}")
                continue
            if code in seen_codes:
                warnings.append(f"重复代码已跳过: {code}")
                continue
            seen_codes.add(code)
            seen_names.setdefault(name, []).append(code)

            exchange = infer_exchange(code) or ""
            industry = str(item.get("industry", "")).strip()
            attributes: dict[str, Any] = {
                "board": item.get("board"),
                "industry": industry or None,
                "market_cap": item.get("market_cap"),
                "name_basis": "securities_short_name",
            }
            security_id = entity_id_for_security("ENTITY_01_01", code)
            company_id = entity_id_for_security("ENTITY_02_01", code)
            industry_id = f"IND:CN:{industry}" if industry and industry != "-" else None

            relations = [
                EntityRelation(
                    target_entity_id=company_id,
                    relation_type="issuer_company",
                    source="universe_json",
                )
            ]
            company_relations = [
                EntityRelation(
                    target_entity_id=security_id,
                    relation_type="listed_security",
                    source="universe_json",
                )
            ]
            if industry_id:
                company_relations.append(
                    EntityRelation(
                        target_entity_id=industry_id,
                        relation_type="belongs_to_industry",
                        source="universe_json",
                    )
                )

            records.append(
                SourceEntityRecord(
                    external_code=code,
                    name=name,
                    entity_type_code="ENTITY_01_01",
                    identifiers={"security_code": code, "exchange": exchange},
                    attributes=attributes,
                    related=relations,
                )
            )
            records.append(
                SourceEntityRecord(
                    external_code=code,
                    name=name,
                    entity_type_code="ENTITY_02_01",
                    identifiers={"company_code": code, "security_code": code},
                    attributes={**attributes, "entity_role": "company"},
                    related=company_relations,
                )
            )
            if industry_id and industry_id not in industries:
                industries[industry_id] = SourceEntityRecord(
                    external_code=None,
                    name=industry,
                    entity_type_code="ENTITY_03_01",
                    identifiers={},
                    attributes={"taxonomy": "universe_json", "name_basis": "industry_field"},
                )

        records.extend(industries.values())

        duplicates = {name: codes for name, codes in seen_names.items() if len(codes) > 1}
        for name, codes in sorted(duplicates.items()):
            warnings.append(f"证券简称重复: {name} -> {','.join(sorted(codes))}")

        return SourceBatch(
            source_id=self.source_id,
            source_version=source_version,
            as_of=None,
            fetched_at=datetime.now(timezone.utc),
            records=records,
            warnings=warnings,
        )
