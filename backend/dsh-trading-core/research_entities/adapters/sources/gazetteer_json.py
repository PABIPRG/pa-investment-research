# -*- coding: utf-8 -*-
"""本地实体词典只读适配器。

词典中的 ``entities`` 是标准实体（主题、行业、指数、宏观因子等），
``type_only_terms`` 只提供类型候选，不在此生成实体。
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from ...errors import InvalidSourceBatch, SourceUnavailable
from ...models import SourceBatch, SourceCapabilities, SourceEntityRecord, SourceHealth


class GazetteerJsonSource:
    source_id = "gazetteer_json"

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else (
            Path(__file__).resolve().parent.parent.parent / "resources" / "gazetteers.json"
        )

    def capabilities(self) -> SourceCapabilities:
        return SourceCapabilities(
            source_id=self.source_id,
            authoritative=False,
            supports_incremental=False,
            entity_type_codes=[
                "ENTITY_01_02", "ENTITY_01_03", "ENTITY_03_01", "ENTITY_03_02",
                "ENTITY_03_03", "ENTITY_04_01", "ENTITY_04_02", "ENTITY_05_02",
                "ENTITY_06_01", "ENTITY_06_02", "ENTITY_06_03",
            ],
            notes=["本地词典用于类型识别与标准名匹配，不代表真实业务主数据已核验。"],
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
            raise SourceUnavailable(f"词典文件不存在: {self.path}")
        raw_bytes = self.path.read_bytes()
        try:
            payload = json.loads(raw_bytes.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise InvalidSourceBatch("词典文件无法解析") from exc

        records: list[SourceEntityRecord] = []
        for item in payload.get("entities", []):
            entity_id = item.get("entity_id")
            name = item.get("canonical_name")
            type_code = item.get("entity_type_code")
            if not entity_id or not name or not type_code:
                raise InvalidSourceBatch(f"词典条目缺少字段: {item!r}")
            records.append(
                SourceEntityRecord(
                    entity_id=entity_id,
                    external_code=item.get("identifiers", {}).get("code"),
                    name=name,
                    entity_type_code=type_code,
                    aliases=list(item.get("aliases", [])),
                    identifiers=dict(item.get("identifiers", {})),
                    attributes=dict(item.get("attributes", {})),
                )
            )

        return SourceBatch(
            source_id=self.source_id,
            source_version=hashlib.sha256(raw_bytes).hexdigest()[:16],
            as_of=None,
            fetched_at=datetime.now(timezone.utc),
            records=records,
            warnings=[],
        )
