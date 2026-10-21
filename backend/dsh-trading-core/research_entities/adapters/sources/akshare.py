# -*- coding: utf-8 -*-
"""akshare 证券主数据适配器（可选数据源）。

覆盖 A 股、场外/场内基金、指数与可转债的名称表；只在显式启用时使用。
单个品种失败不拖垮整批导入：失败品种写入 warning，全部失败才抛
``SourceUnavailable``，且绝不把上一次结果伪装成新数据。
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timezone
from typing import Any

from ...errors import SourceUnavailable
from ...models import SourceBatch, SourceCapabilities, SourceEntityRecord, SourceHealth
from ...normalizer import infer_exchange

_KINDS = ("stock", "fund", "index", "bond")


def _text(value: Any) -> str:
    if value is None:
        return ""
    try:
        # pandas 的缺失值既不是 None 也不等于自身。
        if value != value:
            return ""
    except Exception:  # pragma: no cover - 非常规标量
        pass
    return str(value).strip()


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        # pandas NaT 是 datetime 的子类，必须先按缺失值处理。
        if value != value:
            return None
    except Exception:  # pragma: no cover - 非常规标量
        pass
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    text = _text(value)
    return text or None


class AkshareSecuritySource:
    source_id = "akshare_security"

    def __init__(
        self,
        *,
        include: tuple[str, ...] | None = None,
        akshare_module: Any = None,
    ) -> None:
        self.include = tuple(
            kind for kind in (include or _KINDS) if kind in _KINDS
        ) or _KINDS
        self._akshare = akshare_module

    def _module(self):
        if self._akshare is not None:
            return self._akshare
        import akshare as ak

        return ak

    def capabilities(self) -> SourceCapabilities:
        return SourceCapabilities(
            source_id=self.source_id,
            authoritative=False,
            supports_incremental=False,
            entity_type_codes=["ENTITY_01_01", "ENTITY_01_02", "ENTITY_01_03", "ENTITY_01_04"],
            notes=[
                "仅提供证券代码与简称，不含公司法定名称或曾用名。",
                "指数与基金代码可能和股票代码重叠，实体 ID 由类型前缀区分。",
                "导入数据标记为 imported_unverified，未经外部核验。",
            ],
        )

    def health(self) -> SourceHealth:
        try:
            self._module()
        except Exception as exc:  # pragma: no cover - 依赖环境
            return SourceHealth(
                source_id=self.source_id,
                available=False,
                detail=f"akshare 不可用: {exc}",
                checked_at=datetime.now(timezone.utc),
            )
        return SourceHealth(
            source_id=self.source_id,
            available=True,
            detail="依赖已安装；实际可用性取决于网络。",
            checked_at=datetime.now(timezone.utc),
        )

    # ── 各品种名称表 ────────────────────────────────────────────────
    def _stock_records(self, ak) -> list[SourceEntityRecord]:
        frame = ak.stock_info_a_code_name()
        records: list[SourceEntityRecord] = []
        for row in frame.to_dict("records"):
            code = _text(row.get("code"))
            name = _text(row.get("name"))
            if len(code) != 6 or not code.isdigit() or not name:
                continue
            records.append(
                SourceEntityRecord(
                    external_code=code,
                    name=name,
                    entity_type_code="ENTITY_01_01",
                    identifiers={
                        "security_code": code,
                        "exchange": infer_exchange(code) or "",
                    },
                    attributes={"name_basis": "securities_short_name", "provider": "akshare"},
                )
            )
        return records

    def _fund_records(self, ak) -> list[SourceEntityRecord]:
        frame = ak.fund_name_em()
        records: list[SourceEntityRecord] = []
        for row in frame.to_dict("records"):
            code = _text(row.get("基金代码"))
            name = _text(row.get("基金简称"))
            if len(code) != 6 or not code.isdigit() or not name:
                continue
            records.append(
                SourceEntityRecord(
                    external_code=code,
                    name=name,
                    entity_type_code="ENTITY_01_02",
                    identifiers={"fund_code": code, "security_code": code},
                    attributes={
                        "name_basis": "fund_short_name",
                        "provider": "akshare",
                        "fund_type": _text(row.get("基金类型")),
                    },
                )
            )
        return records

    def _index_records(self, ak) -> list[SourceEntityRecord]:
        frame = ak.index_stock_info()
        records: list[SourceEntityRecord] = []
        for row in frame.to_dict("records"):
            code = _text(row.get("index_code"))
            name = _text(row.get("display_name"))
            if len(code) != 6 or not code.isdigit() or not name:
                continue
            attributes = {
                "name_basis": "index_display_name",
                "provider": "akshare",
            }
            publish_date = _iso(row.get("publish_date"))
            if publish_date:
                attributes["publish_date"] = publish_date
            # 指数代码与股票代码重叠（如 000001），不能按代码前缀推断交易所。
            records.append(
                SourceEntityRecord(
                    external_code=code,
                    name=name,
                    entity_type_code="ENTITY_01_03",
                    identifiers={"index_code": code, "security_code": code},
                    attributes=attributes,
                )
            )
        return records

    def _bond_records(self, ak) -> list[SourceEntityRecord]:
        frame = ak.bond_zh_cov()
        records: list[SourceEntityRecord] = []
        for row in frame.to_dict("records"):
            code = _text(row.get("债券代码"))
            name = _text(row.get("债券简称"))
            if len(code) != 6 or not code.isdigit() or not name:
                continue
            attributes = {
                "name_basis": "bond_short_name",
                "provider": "akshare",
            }
            underlying_code = _text(row.get("正股代码"))
            if underlying_code:
                attributes["underlying_code"] = underlying_code
            underlying_name = _text(row.get("正股简称"))
            if underlying_name:
                attributes["underlying_name"] = underlying_name
            credit_rating = _text(row.get("信用评级"))
            if credit_rating:
                attributes["credit_rating"] = credit_rating
            listing_date = _iso(row.get("上市时间"))
            if listing_date:
                attributes["listing_date"] = listing_date
            records.append(
                SourceEntityRecord(
                    external_code=code,
                    name=name,
                    entity_type_code="ENTITY_01_04",
                    identifiers={
                        "bond_code": code,
                        "security_code": code,
                        "exchange": infer_exchange(code) or "",
                    },
                    attributes=attributes,
                )
            )
        return records

    _FETCHERS = {
        "stock": _stock_records,
        "fund": _fund_records,
        "index": _index_records,
        "bond": _bond_records,
    }

    def fetch_entities(self, *, since: str | None = None) -> SourceBatch:
        try:
            ak = self._module()
        except Exception as exc:
            raise SourceUnavailable(f"akshare 不可用: {exc}") from exc

        records: list[SourceEntityRecord] = []
        warnings: list[str] = []
        fingerprints: list[str] = []
        for kind in self.include:
            fetcher = self._FETCHERS[kind]
            try:
                batch = fetcher(self, ak)
            except Exception as exc:
                warnings.append(f"{kind} 名称表获取失败: {type(exc).__name__}: {exc}")
                continue
            if not batch:
                warnings.append(f"{kind} 名称表为空")
                continue
            records.extend(batch)
            fingerprints.extend(
                f"{record.entity_type_code}:{record.external_code}" for record in batch
            )

        if not records:
            raise SourceUnavailable(
                "akshare 未返回任何证券主数据：" + "；".join(warnings or ["未知原因"])
            )

        version = hashlib.sha256(
            "\n".join(sorted(fingerprints)).encode("utf-8")
        ).hexdigest()[:16]
        return SourceBatch(
            source_id=self.source_id,
            source_version=version,
            as_of=None,
            fetched_at=datetime.now(timezone.utc),
            records=records,
            warnings=warnings,
        )
