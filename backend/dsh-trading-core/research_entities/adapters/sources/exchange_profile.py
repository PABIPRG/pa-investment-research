# -*- coding: utf-8 -*-
"""交易所上市公司名录（免费数据源）。

上交所/北交所名录附带公司全称，可用于补齐 ``ENTITY_02_01`` 的法定名称
与别名；深交所名录只有证券简称，不编造全称。数据只标记为
``imported_unverified``，法定名称以巨潮 ``company_profile`` 为准。
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timezone
from typing import Any

from ...errors import SourceUnavailable
from ...models import SourceBatch, SourceCapabilities, SourceEntityRecord, SourceHealth
from ...normalizer import infer_exchange

_LISTINGS: tuple[tuple[str, str, dict[str, str]], ...] = (
    ("sh_main", "stock_info_sh_name_code", {"symbol": "主板A股"}),
    ("sh_star", "stock_info_sh_name_code", {"symbol": "科创板"}),
    ("sz_a", "stock_info_sz_name_code", {"symbol": "A股列表"}),
    ("bj", "stock_info_bj_name_code", {}),
)

_CODE_KEYS = ("证券代码", "A股代码", "代码")
_NAME_KEYS = ("证券简称", "A股简称", "简称")
_FULL_NAME_KEYS = ("公司全称", "证券全称")
_LISTING_DATE_KEYS = ("上市日期", "A股上市日期")


def _text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if value != value:  # pandas 缺失值
            return ""
    except Exception:  # pragma: no cover - 非常规标量
        pass
    return str(value).strip()


def _first(row: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = _text(row.get(key))
        if value:
            return value
    return ""


def _iso(value: Any) -> str | None:
    if value is None:
        return ""
    try:
        if value != value:
            return None
    except Exception:  # pragma: no cover - 非常规标量
        pass
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = _text(value)
    return text or None


class ExchangeProfileSource:
    source_id = "exchange_profile"

    def __init__(self, *, akshare_module: Any = None) -> None:
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
            entity_type_codes=["ENTITY_02_01"],
            notes=[
                "上交所/北交所名录含公司全称；深交所名录不含，缺失字段保持为空。",
                "仅补充法定名称与别名，不覆盖证券简称与已核验数据。",
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
            detail="依赖已安装；实际可用性取决于交易所接口。",
            checked_at=datetime.now(timezone.utc),
        )

    def fetch_entities(self) -> SourceBatch:
        ak = self._module()
        records: list[SourceEntityRecord] = []
        warnings: list[str] = []
        failures = 0
        for label, function_name, kwargs in _LISTINGS:
            function = getattr(ak, function_name, None)
            if function is None:
                failures += 1
                warnings.append(f"{label}: 当前 akshare 版本不提供 {function_name}")
                continue
            try:
                frame = function(**kwargs)
            except Exception as exc:  # noqa: BLE001 - 单个交易所失败不影响其他
                failures += 1
                warnings.append(f"{label}: {type(exc).__name__}: {exc}")
                continue
            rows = frame.to_dict("records") if hasattr(frame, "to_dict") else []
            kept = 0
            for row in rows:
                record = self._record(row, label=label)
                if record is not None:
                    records.append(record)
                    kept += 1
            if not kept:
                warnings.append(f"{label}: 名录为空或缺少必要列")
        if failures == len(_LISTINGS) or not records:
            raise SourceUnavailable(
                "交易所名录全部不可用：" + "；".join(warnings or ["无可用记录"])
            )
        return SourceBatch(
            source_id=self.source_id,
            source_version=self._version(records),
            as_of=datetime.now(timezone.utc),
            fetched_at=datetime.now(timezone.utc),
            records=records,
            warnings=warnings,
        )

    @staticmethod
    def _record(row: dict[str, Any], *, label: str) -> SourceEntityRecord | None:
        code = _first(row, _CODE_KEYS)
        if len(code) != 6 or not code.isdigit():
            return None
        short_name = _first(row, _NAME_KEYS)
        full_name = _first(row, _FULL_NAME_KEYS)
        name = short_name or full_name
        if not name:
            return None
        aliases = [full_name] if full_name and full_name != name else []
        attributes: dict[str, Any] = {
            "name_basis": "exchange_short_name",
            "provider": "exchange_list",
            "listing_board": label,
        }
        if full_name:
            attributes["legal_name"] = full_name
        listing_date = _iso(next((row.get(k) for k in _LISTING_DATE_KEYS if row.get(k)), None))
        if listing_date:
            attributes["listing_date"] = listing_date
        return SourceEntityRecord(
            external_code=code,
            name=name,
            entity_type_code="ENTITY_02_01",
            aliases=aliases,
            identifiers={
                "company_code": code,
                "security_code": code,
                "exchange": infer_exchange(code) or "",
            },
            attributes=attributes,
        )

    @staticmethod
    def _version(records: list[SourceEntityRecord]) -> str:
        digest = hashlib.sha256()
        for record in sorted(records, key=lambda item: item.external_code or ""):
            legal_name = str(record.attributes.get("legal_name") or "")
            digest.update(
                f"{record.entity_type_code}:{record.external_code}:"
                f"{record.name}:{legal_name}|".encode("utf-8")
            )
        return digest.hexdigest()[:16]
