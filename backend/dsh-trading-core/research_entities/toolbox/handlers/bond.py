# -*- coding: utf-8 -*-
"""可转债工具。"""

from __future__ import annotations

from ..context import records_from_frame
from ..contracts import ToolCall
from ..helpers import (
    empty,
    entity_code,
    first_entity,
    ok,
    param_code,
    param_name,
    unavailable,
)


def _bond_code(call: ToolCall) -> str | None:
    return param_code(call) or entity_code(first_entity(call, "ENTITY_01_04"))


def _basic_from_terms(row: dict) -> dict:
    return {
        "bond_code": row.get("SECURITY_CODE"),
        "bond_name": row.get("SECURITY_NAME_ABBR"),
        "stock_code": row.get("CONVERT_STOCK_CODE"),
        "stock_name": row.get("SECURITY_SHORT_NAME"),
        "rating": row.get("RATING"),
        "listing_date": row.get("LISTING_DATE"),
        "delist_date": row.get("DELIST_DATE"),
        "issue_scale": row.get("ACTUAL_ISSUE_SCALE"),
        "convert_price": row.get("CONVERT_STOCK_PRICE"),
    }


def convertible_bond_lookup(call: ToolCall):
    code = _bond_code(call)
    name = param_name(call)
    if not code and not name:
        return empty(call, reason="可转债查询需要代码或名称。", source="akshare.bond_zh_cov")

    # 有代码时直接查单只转债条款，避免拉取全市场 1000+ 条列表。
    if code:
        try:
            frame = call.ctx.call_akshare("bond_zh_cov_info", symbol=code)
            records = records_from_frame(frame, latest_first=False, limit=1)
            if records:
                return ok(
                    call,
                    records=[_basic_from_terms(records[0])],
                    data={"code": code, "raw": records[0]},
                    source="akshare.bond_zh_cov_info",
                )
        except SourceUnavailable:
            pass

    try:
        frame = call.ctx.call_akshare("bond_zh_cov", timeout=90)
    except SourceUnavailable as exc:
        return unavailable(
            call,
            f"可转债列表接口不可用：{exc}",
            source="akshare.bond_zh_cov",
        )
    if frame is None or not len(frame):
        return empty(call, reason="可转债列表为空。", source="akshare.bond_zh_cov")
    found = frame
    if code and "债券代码" in frame.columns:
        found = frame[frame["债券代码"].astype(str).str.zfill(6) == code]
    if not len(found) and name and "债券简称" in frame.columns:
        found = frame[frame["债券简称"].astype(str).str.contains(name, na=False)]
    if not len(found):
        return empty(
            call,
            reason=f"可转债列表中没有匹配项：{code or name}",
            source="akshare.bond_zh_cov",
        )
    return ok(
        call,
        records=records_from_frame(found, latest_first=False, limit=5),
        data={"code": code, "name": name},
        source="akshare.bond_zh_cov",
    )


def bond_terms_lookup(call: ToolCall):
    code = _bond_code(call)
    if not code:
        return empty(call, reason="缺少可转债代码。", source="akshare.bond_zh_cov_info")
    frame = call.ctx.call_akshare("bond_zh_cov_info", symbol=code)
    records = records_from_frame(frame, latest_first=False, limit=50)
    if not records:
        return empty(
            call,
            reason=f"{code} 没有可转债条款数据。",
            source="akshare.bond_zh_cov_info",
        )
    return ok(
        call,
        records=records,
        data={"code": code},
        source="akshare.bond_zh_cov_info",
    )
