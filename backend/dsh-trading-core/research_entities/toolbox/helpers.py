# -*- coding: utf-8 -*-
"""处理器共用的小工具：实体取值、结果构造、序列摘要。"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from ..models import EntityInstance
from .contracts import ToolCall, ToolResult, ToolStatus
from .trading_calendar import calendar_for, latest_trading_day

_CODE_KEYS = (
    "security_code",
    "company_code",
    "fund_code",
    "index_code",
    "bond_code",
    "code",
)


def entity_code(entity: EntityInstance | None) -> str | None:
    if entity is None:
        return None
    for key in _CODE_KEYS:
        value = entity.identifiers.get(key)
        if value:
            return str(value)
    # 仅有部分实体（证券/基金/指数/债券）在 ID 尾部带真实代码；
    # 趋势、政策、风格等实体尾段是 slug，不能当作数据源代码。
    tail = entity.entity_id.rsplit(":", 1)[-1]
    if re.fullmatch(r"\d{5,6}", tail):
        return tail
    return None


def entity_name(entity: EntityInstance | None) -> str | None:
    return entity.canonical_name if entity is not None else None


def first_entity(call: ToolCall, *type_codes: str) -> EntityInstance | None:
    for entity in call.entities:
        if not type_codes or entity.entity_type_code in type_codes:
            return entity
    return call.entities[0] if call.entities else None


def param_code(call: ToolCall, *names: str) -> str | None:
    keys = names or ("code", "security_code", "company_code", "fund_code", "index_code", "bond_code")
    for key in keys:
        value = call.params.get(key)
        if value not in (None, ""):
            return str(value).strip()
    # 单个实体时退化为实体代码。
    if len(call.entities) == 1:
        return entity_code(call.entities[0])
    return None


def param_name(call: ToolCall, *names: str) -> str | None:
    keys = names or ("name", "keyword", "query")
    for key in keys:
        value = call.params.get(key)
        if value not in (None, ""):
            return str(value).strip()
    if len(call.entities) == 1:
        return call.entities[0].canonical_name
    return None


def lookup_entity_by_code(
    call: ToolCall,
    code: str | None,
    *type_codes: str,
) -> EntityInstance | None:
    if not code:
        return None
    for key in ("security_code", "company_code", "fund_code", "index_code", "bond_code"):
        found = call.ctx.repository.find_by_identifier(key, code)
        if not found:
            continue
        if type_codes:
            matching = [item for item in found if item.entity_type_code in type_codes]
            if matching:
                return matching[0]
            continue
        # 同一代码可能同时指向证券与公司；未指定类型时优先证券实体。
        found.sort(key=lambda item: (item.entity_type_code != "ENTITY_01_01", item.entity_id))
        return found[0]
    return None


def lookup_entity_by_name(
    call: ToolCall,
    name: str | None,
    *type_codes: str,
) -> EntityInstance | None:
    if not name:
        return None
    candidates = call.ctx.repository.find_by_name(
        name, type_codes=list(type_codes) or None, limit=5
    )
    if not candidates:
        return None
    return call.ctx.get_entity(candidates[0].entity_id)


def resolve_target(
    call: ToolCall,
    *type_codes: str,
    code_keys: tuple[str, ...] | None = None,
) -> tuple[str | None, str | None, EntityInstance | None]:
    """返回 (code, name, entity)；优先实体，其次显式参数。"""

    entity = first_entity(call, *type_codes)
    code = entity_code(entity) or param_code(call, *(code_keys or ()))
    name = entity_name(entity) or param_name(call)
    return code, name, entity


def _base(call: ToolCall, status: ToolStatus, **kwargs: Any) -> ToolResult:
    return ToolResult(
        tool_id=call.tool_id,
        status=status,
        entity_ids=[item.entity_id for item in call.entities],
        **kwargs,
    )


def ok(
    call: ToolCall,
    *,
    records: Iterable[dict[str, Any]] | None = None,
    data: dict[str, Any] | None = None,
    source: str | None = None,
    warnings: list[str] | None = None,
    status: ToolStatus = "ok",
) -> ToolResult:
    payload = dict(data or {})
    has_records = records is not None
    if has_records:
        items = list(records)
        payload.setdefault("records", items)
        payload.setdefault("count", len(items))
    # 只有显式声明了 records 且为空时才自动降级为 empty；
    # 纯实体/映射类结果即使没有 records 也是有效数据。
    if has_records and not payload.get("records"):
        status = "empty" if status == "ok" else status
    return _base(
        call,
        status,
        data=payload,
        source=source,
        warnings=list(warnings or []),
    )


def empty(
    call: ToolCall,
    *,
    reason: str,
    source: str | None = None,
    data: dict[str, Any] | None = None,
) -> ToolResult:
    payload = dict(data or {})
    payload.setdefault("records", [])
    payload.setdefault("count", 0)
    payload["reason"] = reason
    return _base(call, "empty", data=payload, source=source, warnings=[reason])


def unavailable(call: ToolCall, reason: str, *, source: str | None = None) -> ToolResult:
    return _base(
        call,
        "unavailable",
        data={"records": [], "count": 0, "reason": reason},
        source=source,
        warnings=[reason],
        error=reason,
    )


def error(call: ToolCall, reason: str, *, source: str | None = None) -> ToolResult:
    return _base(
        call,
        "error",
        data={"records": [], "count": 0, "reason": reason},
        source=source,
        error=reason,
    )


def needs_authorization(call: ToolCall, reason: str) -> ToolResult:
    return ToolResult(
        tool_id=call.tool_id,
        status="needs_authorization",
        entity_ids=[item.entity_id for item in call.entities],
        data={"records": [], "count": 0, "reason": reason},
        warnings=[reason],
        authorization="unauthorized",
    )


# ── 日期与序列 ──────────────────────────────────────────────────────


def parse_date(value: Any, default: date | None = None) -> date:
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return default or date.today()
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y/%m/%d"):
        try:
            from datetime import datetime

            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return default or date.today()


_DATE_KEY_HINTS = ("date", "日期", "report_date", "trade_date")


def _is_date_key(key: str) -> bool:
    lowered = key.lower()
    return any(hint in lowered for hint in _DATE_KEY_HINTS)


def parse_record_date(value: Any) -> date | None:
    """把数据源里常见的日期写法归一化为 date；无法识别返回 None。"""

    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = (
        text.replace("年", "-").replace("月", "-").replace("日", "")
        .replace("/", "-")
    )
    head = normalized[:10]
    try:
        return date.fromisoformat(head)
    except ValueError:
        pass
    # 形如 20261019 的整数/字符串。
    digits = re.sub(r"\D", "", normalized)
    if len(digits) >= 8:
        try:
            return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
        except ValueError:
            return None
    return None


def latest_record_date(records: list[dict[str, Any]]) -> date | None:
    latest: date | None = None
    for record in records:
        for key, value in record.items():
            if not _is_date_key(str(key)):
                continue
            day = parse_record_date(value)
            if day is not None and (latest is None or day > latest):
                latest = day
    return latest


def staleness_warning(
    call: ToolCall,
    records: list[dict[str, Any]],
    *,
    label: str = "行情",
    threshold: int | None = None,
) -> str | None:
    """最新记录日期明显落后于最近交易日时给出提示（可能停牌或数据延迟）。

    ``threshold`` 默认 3 个交易日：盘中当日数据未出、周末净值顺延都不会误报。
    """

    if threshold is not None:
        limit = threshold
    else:
        raw = call.params.get("stale_days")
        try:
            limit = 3 if raw is None else int(raw)
        except (TypeError, ValueError):
            limit = 3
    if limit <= 0:
        return None
    latest = latest_record_date(records)
    if latest is None:
        return None
    calendar = calendar_for(call.ctx)
    baseline = calendar.latest_on_or_before(call.ctx.today())
    if latest >= baseline:
        return None
    gap = 0
    cursor = baseline
    while cursor > latest and gap < 30:
        gap += 1
        cursor = calendar.previous_trading_day(cursor)
    if gap < limit:
        return None
    return (
        f"{label}最新日期为 {latest.isoformat()}，落后最近交易日 "
        f"{baseline.isoformat()} 共 {gap} 个交易日，可能停牌或数据源延迟。"
    )


def date_window(call: ToolCall, *, default_days: int = 365) -> tuple[str, str]:
    today = call.ctx.today()
    # 截止日对齐最近交易日：周末/节假日请求不应把区间空转到未开市日期。
    end = latest_trading_day(
        call.ctx, parse_date(call.params.get("end_date"), today)
    )
    start_raw = call.params.get("start_date")
    if start_raw:
        start = parse_date(start_raw, end - timedelta(days=default_days))
    else:
        days = int(call.params.get("days") or default_days)
        start = end - timedelta(days=days)
    return start.strftime("%Y%m%d"), end.strftime("%Y%m%d")


def _to_float(value: Any) -> float | None:
    try:
        if value in (None, "", "-"):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def series_summary(
    records: list[dict[str, Any]],
    *,
    date_key: str | None = None,
    value_key: str | None = None,
) -> dict[str, Any]:
    """对时间序列记录给出首末值、区间涨跌幅与极值。

    记录假定为最新在前（``records_from_frame`` 的默认输出）。
    """

    if not records:
        return {}
    keys = list(records[0].keys())
    value_key = value_key or next(
        (
            key
            for key in (
                "收盘价",
                "收盘",
                "close",
                "最新价",
                "今值",
                "单位净值",
                "累计净值",
                "value",
                "利率",
                "库存",
            )
            if key in keys
        ),
        None,
    )
    date_key = date_key or next(
        (
            key
            for key in (
                "日期",
                "date",
                "净值日期",
                "报告日",
                "月份",
                "TRADE_DATE",
                "报告期",
                "公告时间",
            )
            if key in keys
        ),
        None,
    )
    if value_key is None:
        return {}
    latest = _to_float(records[0].get(value_key))
    oldest = _to_float(records[-1].get(value_key))
    values = [item for item in (_to_float(row.get(value_key)) for row in records) if item is not None]
    if not values:
        return {}
    change = None
    if latest is not None and oldest not in (None, 0):
        change = round((latest - oldest) / oldest * 100, 4)
    return {
        "date_key": date_key,
        "value_key": value_key,
        "latest": latest,
        "latest_date": records[0].get(date_key) if date_key else None,
        "earliest": oldest,
        "earliest_date": records[-1].get(date_key) if date_key else None,
        "change_pct": change,
        "max": max(values),
        "min": min(values),
        "points": len(values),
    }
