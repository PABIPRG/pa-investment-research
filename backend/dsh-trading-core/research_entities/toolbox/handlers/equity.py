# -*- coding: utf-8 -*-
"""个股、公司、事件类工具。"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from ...errors import SourceUnavailable
from ..context import ToolUnavailable, records_from_frame
from ..contracts import ToolCall
from ..helpers import (
    date_window,
    empty,
    entity_code,
    first_entity,
    lookup_entity_by_code,
    lookup_entity_by_name,
    ok,
    param_code,
    param_name,
    parse_record_date,
    resolve_target,
    series_summary,
    staleness_warning,
    unavailable,
)
from ..mappings import exchange_prefix, security_symbol
from ..trading_calendar import recent_trading_days


def quote_history(call: ToolCall):
    code, name, _entity = resolve_target(call, "ENTITY_01_01")
    symbol = security_symbol(code or "")
    if not symbol:
        return empty(call, reason=f"缺少可识别的 6 位 A 股代码：{code}", source="akshare")

    start, end = date_window(call, default_days=365)
    adjust = str(call.params.get("adjust") or "qfq")
    warnings: list[str] = []
    source = "akshare.stock_zh_a_daily"
    try:
        frame = call.ctx.call_akshare(
            "stock_zh_a_daily",
            symbol=symbol,
            start_date=start,
            end_date=end,
            adjust=adjust,
        )
    except ToolUnavailable as first_error:
        warnings.append(f"新浪日线不可用，尝试东方财富：{first_error}")
        source = "akshare.stock_zh_a_hist"
        frame = call.ctx.call_akshare(
            "stock_zh_a_hist",
            symbol=code,
            period="daily",
            start_date=start,
            end_date=end,
            adjust=adjust,
        )
    records = records_from_frame(frame, limit=int(call.params.get("limit") or 500))
    if not records:
        return empty(call, reason=f"{code} 在 {start}~{end} 没有行情记录。", source=source)
    stale = staleness_warning(call, records)
    if stale:
        warnings.append(stale)
    return ok(
        call,
        records=records,
        data={
            "code": code,
            "name": name,
            "start_date": start,
            "end_date": end,
            "adjust": adjust,
            "summary": series_summary(records),
        },
        source=source,
        warnings=warnings,
    )


def financials_lookup(call: ToolCall):
    code, _name, _entity = resolve_target(call, "ENTITY_01_01", "ENTITY_02_01")
    if not code:
        return empty(call, reason="缺少公司/证券代码。", source="akshare.stock_financial_abstract")
    frame = call.ctx.call_akshare("stock_financial_abstract", symbol=code)
    if frame is None or not len(frame):
        return empty(call, reason=f"{code} 没有财务摘要。", source="akshare.stock_financial_abstract")

    period_columns = sorted(
        [str(column) for column in frame.columns if str(column).isdigit() and len(str(column)) == 8],
        reverse=True,
    )
    keep = int(call.params.get("periods") or 8)
    selected = [column for column in ("选项", "指标") if column in frame.columns]
    selected += period_columns[:keep]
    subset = frame[selected] if selected else frame
    records = records_from_frame(subset, latest_first=False)
    latest_period = period_columns[0] if period_columns else None
    return ok(
        call,
        records=records,
        data={
            "code": code,
            "latest_period": latest_period,
            "periods": period_columns[:keep],
            "unit_note": "原始值未做单位换算，按 akshare 摘要口径返回。",
        },
        source="akshare.stock_financial_abstract",
    )


def _fetch_announcement_day(call: ToolCall, day: str) -> Any:
    return call.ctx.call_akshare("stock_notice_report", symbol="全部", date=day)


def announcement_search(call: ToolCall):
    entity = first_entity(call, "ENTITY_02_01", "ENTITY_01_01", "ENTITY_04_03")
    code = entity_code(entity) or param_code(call)
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    if not code and name:
        matched = lookup_entity_by_name(call, name, "ENTITY_01_01", "ENTITY_02_01")
        code = entity_code(matched)
    if not code:
        return empty(
            call,
            reason="公告检索需要可识别的公司代码；仅凭名称无法可靠定位公告主体。",
            source="akshare.stock_zh_a_disclosure_report_cninfo",
        )

    days = int(call.params.get("days") or 365)
    limit = int(call.params.get("limit") or 50)
    start, end = date_window(call, default_days=days)
    warnings: list[str] = []

    # 巨潮按公司检索，一次请求即可拿到区间内全部公告。
    try:
        frame = call.ctx.call_akshare(
            "stock_zh_a_disclosure_report_cninfo",
            symbol=code,
            market="沪深京",
            start_date=start,
            end_date=end,
        )
        records = records_from_frame(frame, limit=limit)
        if records:
            return ok(
                call,
                records=records,
                data={
                    "code": code,
                    "name": name,
                    "start_date": start,
                    "end_date": end,
                },
                source="akshare.stock_zh_a_disclosure_report_cninfo",
                warnings=["公告来自巨潮资讯公告列表，正文未抓取。"],
            )
        warnings.append("巨潮接口在区间内没有返回公告，尝试东方财富最近 3 天列表。")
    except SourceUnavailable as exc:
        warnings.append(f"巨潮公告接口不可用：{exc}；尝试东方财富最近 3 天列表。")

    # 兜底：东方财富按日期分页，只查最近 3 天，避免接口过慢。
    fallback_days = min(days, 3)
    checked: list[str] = []
    fallback_records: list[dict[str, Any]] = []
    for day in recent_trading_days(call.ctx, fallback_days):
        day_text = day.strftime("%Y%m%d")
        checked.append(day_text)
        try:
            frame = _fetch_announcement_day(call, day_text)
        except SourceUnavailable:
            continue
        if frame is None or not len(frame) or "代码" not in frame.columns:
            continue
        found = frame[frame["代码"].astype(str).str.zfill(6) == code]
        if len(found):
            fallback_records.extend(records_from_frame(found, latest_first=False))
        if len(fallback_records) >= limit:
            break

    if fallback_records:
        return ok(
            call,
            records=fallback_records[:limit],
            data={"code": code, "name": name, "checked_dates": checked},
            source="akshare.stock_notice_report",
            warnings=warnings + ["公告来自东方财富公告列表，正文未抓取。"],
        )
    return empty(
        call,
        reason=f"最近 {days} 天没有检索到 {code} 的公告。",
        source="akshare.stock_zh_a_disclosure_report_cninfo",
    )


_PROFILE_KEYS = {
    "公司名称": "legal_name",
    "英文名称": "english_name",
    "曾用简称": "former_names",
    "A股代码": "a_share_code",
    "A股简称": "short_name",
    "H股代码": "h_share_code",
    "入选指数": "indices",
    "所属市场": "market",
    "所属行业": "industry",
    "法人代表": "legal_representative",
    "注册资金": "registered_capital",
    "成立日期": "founded_date",
    "上市日期": "listed_date",
    "官方网站": "website",
    "电子邮箱": "email",
    "联系电话": "phone",
    "注册地址": "registered_address",
    "办公地址": "office_address",
    "主营业务": "main_business",
    "经营范围": "business_scope",
    "机构简介": "company_intro",
}


def _profile_row(call: ToolCall, code: str) -> dict[str, Any] | None:
    frame = call.ctx.call_akshare("stock_profile_cninfo", symbol=code)
    if frame is None or not len(frame):
        return None
    return records_from_frame(frame, latest_first=False, limit=1)[0]


def company_profile(call: ToolCall):
    code, _name, _entity = resolve_target(call, "ENTITY_02_01", "ENTITY_01_01")
    if not code:
        return empty(call, reason="缺少公司代码。", source="akshare.stock_profile_cninfo")
    row = _profile_row(call, code)
    if row is None:
        return empty(call, reason=f"{code} 没有公司资料。", source="akshare.stock_profile_cninfo")

    warnings: list[str] = []
    business: dict[str, Any] = {}
    try:
        zyjs = call.ctx.call_akshare("stock_zyjs_ths", symbol=code)
        if zyjs is not None and len(zyjs):
            business = records_from_frame(zyjs, latest_first=False, limit=1)[0]
    except SourceUnavailable as exc:
        warnings.append(f"主营业务接口不可用：{exc}")

    normalized = {
        target: row.get(source)
        for source, target in _PROFILE_KEYS.items()
        if source in row
    }
    return ok(
        call,
        records=[row],
        data={
            "code": code,
            "profile": normalized,
            "business": business,
            "raw_fields": list(row.keys()),
        },
        source="akshare.stock_profile_cninfo",
        warnings=warnings,
    )


def _local_relations(call: ToolCall, entity_id: str) -> list[dict[str, Any]]:
    items = []
    for relation in call.ctx.relations(entity_id):
        items.append(
            {
                "subject_entity_id": entity_id,
                "target_entity_id": relation.target_entity_id,
                "relation_type": relation.relation_type,
                "source": relation.source,
            }
        )
    return items


def company_relationship_lookup(call: ToolCall):
    entity = first_entity(call, "ENTITY_02_01", "ENTITY_02_02", "ENTITY_02_03", "ENTITY_03_03")
    code = entity_code(entity) or param_code(call)
    entity_id = entity.entity_id if entity is not None else None
    if entity_id is None and code:
        found = lookup_entity_by_code(call, code)
        entity_id = found.entity_id if found else None

    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    if entity_id:
        records.extend(_local_relations(call, entity_id))

    external = None
    if code:
        try:
            external = call.ctx.http_get(
                f"{call.ctx.industry_chain_url}/graph/entity/{code}"
            )
        except ToolUnavailable as exc:
            warnings.append(f"产业链服务不可用，仅返回本地关系：{exc}")

    if not records and external is None:
        if code:
            reason = "实体库没有关系记录，且产业链服务不可用，无法查询公司关系。"
        else:
            reason = (
                "实体库没有关系记录；该实体也没有可映射的证券代码，"
                "无法向产业链服务发起查询。"
            )
        return unavailable(
            call,
            reason,
            source="research_entities.repository + industry-chain",
        )
    return ok(
        call,
        records=records,
        data={
            "entity_id": entity_id,
            "code": code,
            "local_relation_count": len(records),
            "industry_chain": external,
        },
        source="research_entities.repository + industry-chain",
        warnings=warnings,
    )


def company_governance_lookup(call: ToolCall):
    code, _name, _entity = resolve_target(call, "ENTITY_02_01", "ENTITY_02_03")
    if not code:
        return empty(call, reason="缺少公司代码。", source="akshare.stock_profile_cninfo")
    row = _profile_row(call, code)
    if row is None:
        return empty(call, reason=f"{code} 没有公司治理资料。", source="akshare.stock_profile_cninfo")
    governance = {
        "legal_representative": row.get("法人代表"),
        "registered_capital": row.get("注册资金"),
        "founded_date": row.get("成立日期"),
        "listed_date": row.get("上市日期"),
        "registered_address": row.get("注册地址"),
        "company_intro": row.get("机构简介"),
    }
    return ok(
        call,
        records=[governance],
        data={"code": code, "governance": governance},
        source="akshare.stock_profile_cninfo",
        warnings=[
            "当前来源只提供法人代表等工商信息，不含完整董监高名单与持股变动。"
        ],
    )


def capital_flow_lookup(call: ToolCall):
    code, _name, _entity = resolve_target(call, "ENTITY_01_01")
    if not code:
        return empty(call, reason="缺少证券代码。", source="akshare.stock_fund_flow_individual")
    frame = call.ctx.call_akshare(
        "stock_fund_flow_individual", symbol="即时", timeout=90
    )
    if frame is None or not len(frame) or "股票代码" not in frame.columns:
        return empty(call, reason="同花顺资金流快照为空。", source="akshare.stock_fund_flow_individual")
    found = frame[frame["股票代码"].astype(str).str.zfill(6) == code]
    if not len(found):
        return empty(
            call,
            reason=f"资金流快照中没有 {code}。",
            source="akshare.stock_fund_flow_individual",
        )
    records = records_from_frame(found, latest_first=False, limit=1)
    return ok(
        call,
        records=records,
        data={"code": code, "snapshot": True},
        source="akshare.stock_fund_flow_individual",
        warnings=["同花顺“即时”资金流是单日快照，不含历史序列。"],
    )


def _margin_frame(call: ToolCall, exchange: str, day: str) -> Any:
    if exchange == "sh":
        return call.ctx.call_akshare("stock_margin_detail_sse", date=day, timeout=20)
    return call.ctx.call_akshare("stock_margin_detail_szse", date=day, timeout=20)


def margin_balance_lookup(call: ToolCall):
    code, _name, _entity = resolve_target(call, "ENTITY_01_01")
    exchange = exchange_prefix(code or "")
    if not code or exchange not in ("sh", "sz"):
        return unavailable(
            call,
            f"两融明细当前只覆盖沪深市场，不支持代码 {code}。",
            source="akshare.stock_margin_detail_*",
        )

    days = int(call.params.get("days") or 10)
    for day in recent_trading_days(call.ctx, days):
        day_text = day.strftime("%Y%m%d")
        try:
            frame = _margin_frame(call, exchange, day_text)
        except SourceUnavailable:
            continue
        if frame is None or not len(frame):
            continue
        # 上交所列名是“标的证券代码”，深交所是“证券代码”。
        code_key = next(
            (key for key in ("标的证券代码", "证券代码") if key in frame.columns), None
        )
        if code_key is None:
            continue
        found = frame[frame[code_key].astype(str).str.zfill(6) == code]
        if len(found):
            records = records_from_frame(found, latest_first=False, limit=1)
            return ok(
                call,
                records=records,
                data={"code": code, "date": day_text},
                source=f"akshare.stock_margin_detail_{'sse' if exchange == 'sh' else 'szse'}",
            )
    return empty(
        call,
        reason=f"最近 {days} 个自然日没有 {code} 的两融明细（可能非交易日或未覆盖）。",
        source="akshare.stock_margin_detail_*",
    )


def dragon_tiger_lookup(call: ToolCall):
    code, _name, _entity = resolve_target(call, "ENTITY_01_01")
    if not code:
        return empty(call, reason="缺少证券代码。", source="akshare.stock_lhb_detail_em")
    start, end = date_window(call, default_days=30)
    frame = call.ctx.call_akshare(
        "stock_lhb_detail_em", start_date=start, end_date=end
    )
    if frame is None or not len(frame) or "代码" not in frame.columns:
        return empty(call, reason="龙虎榜接口返回空。", source="akshare.stock_lhb_detail_em")
    found = frame[frame["代码"].astype(str).str.zfill(6) == code]
    if not len(found):
        return empty(
            call,
            reason=f"{start}~{end} 期间 {code} 没有上榜记录。",
            source="akshare.stock_lhb_detail_em",
        )
    return ok(
        call,
        records=records_from_frame(found, limit=int(call.params.get("limit") or 50)),
        data={"code": code, "start_date": start, "end_date": end},
        source="akshare.stock_lhb_detail_em",
    )


def _payload_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("items", "records", "list", "data", "news"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        return [payload]
    return []


def event_timeline_lookup(call: ToolCall):
    entity = first_entity(call)
    code = entity_code(entity) or param_code(call)
    keyword = param_name(call)
    limit = int(call.params.get("limit") or 20)
    warnings: list[str] = []

    if code:
        try:
            payload = call.ctx.http_get(
                f"{call.ctx.market_watch_url}/news/stock",
                {"code": code, "limit": max(5, min(20, limit))},
            )
            items = _payload_items(payload)
            if items:
                return ok(
                    call,
                    records=items[:limit],
                    data={"code": code, "source_service": "market-watch"},
                    source="market-watch:/news/stock",
                )
        except ToolUnavailable as exc:
            warnings.append(f"盯盘服务不可用，改用公开新闻：{exc}")

        frame = call.ctx.call_akshare("stock_news_em", symbol=code)
        records = records_from_frame(frame, limit=limit)
        if records:
            return ok(
                call,
                records=records,
                data={"code": code, "fallback": "akshare.stock_news_em"},
                source="akshare.stock_news_em",
                warnings=warnings,
            )
        return empty(
            call,
            reason=f"没有检索到 {code} 的近期事件/新闻。",
            source="market-watch + akshare.stock_news_em",
        )

    try:
        payload = call.ctx.http_get(
            f"{call.ctx.market_watch_url}/news/events",
            {"limit": max(5, min(100, limit * 3))},
        )
        items = _payload_items(payload)
        if keyword:
            items = [
                item
                for item in items
                if keyword in str(item.get("title", ""))
                or keyword in str(item.get("summary", ""))
                or keyword in str(item.get("content", ""))
            ]
        if items:
            return ok(
                call,
                records=items[:limit],
                data={"keyword": keyword, "source_service": "market-watch"},
                source="market-watch:/news/events",
            )
        warnings.append(f"盯盘服务事件流中没有匹配 {keyword or '条件'} 的记录。")
    except ToolUnavailable as exc:
        warnings.append(f"盯盘服务不可用：{exc}")

    # 没有证券代码时，用公开新闻按关键词兜底，避免趋势/政策类实体无工具可用。
    if keyword:
        from .macro import _news_search

        days = int(call.params.get("days") or 7)
        records, sources = _news_search(call, keyword, days=days)
        if records:
            return ok(
                call,
                records=records[:limit],
                data={"keyword": keyword, "searched_sources": sources},
                source=" + ".join(sources),
                warnings=warnings
                + ["事件流不可用，已退回新闻文本关键词检索，不是结构化事件库。"],
            )
        warnings.append(f"公开新闻最近 {days} 天也没有匹配“{keyword}”的记录。")

    return empty(
        call,
        reason="未提供证券代码，盯盘服务与公开新闻检索均没有返回匹配事件。",
        data={"searched_sources": ["market-watch:/news/events", "akshare.news_cctv"]},
        source="market-watch:/news/events + akshare.news_cctv",
    )


# ── 股东与公司行动 ────────────────────────────────────────────────


def _sort_records(records: list[dict[str, Any]], keys: tuple[str, ...], *, reverse: bool = True) -> None:
    def sort_key(record: dict[str, Any]) -> date:
        for key in keys:
            if key in record:
                day = parse_record_date(record.get(key))
                if day is not None:
                    return day
        return date.min

    records.sort(key=sort_key, reverse=reverse)


def shareholder_count_lookup(call: ToolCall):
    code, name, _entity = resolve_target(call, "ENTITY_01_01", "ENTITY_02_01")
    if not code:
        return empty(call, reason="缺少公司/证券代码。", source="akshare.stock_zh_a_gdhs_detail_em")
    frame = call.ctx.call_akshare("stock_zh_a_gdhs_detail_em", symbol=code)
    records = records_from_frame(frame, latest_first=False)
    if not records:
        return empty(
            call,
            reason=f"{code} 没有股东户数明细。",
            source="akshare.stock_zh_a_gdhs_detail_em",
        )
    _sort_records(records, ("股东户数统计截止日", "截止日期"))
    limit = max(1, min(int(call.params.get("limit") or 12), 60))
    records = records[:limit]
    latest = records[0]
    return ok(
        call,
        records=records,
        data={
            "code": code,
            "name": name,
            "latest_date": latest.get("股东户数统计截止日"),
            "latest_holders": latest.get("股东户数-本次"),
            "latest_change_pct": latest.get("股东户数-增减比例"),
        },
        source="akshare.stock_zh_a_gdhs_detail_em",
        warnings=[
            "股东户数为交易所披露口径，统计截止日与公告日可能不同；"
            "户数变化受股本变动影响，不能单独作为筹码集中度结论。"
        ],
    )


def dividend_history_lookup(call: ToolCall):
    code, name, _entity = resolve_target(call, "ENTITY_01_01", "ENTITY_02_01")
    if not code:
        return empty(call, reason="缺少公司/证券代码。", source="akshare.stock_fhps_detail_em")
    frame = call.ctx.call_akshare("stock_fhps_detail_em", symbol=code)
    records = records_from_frame(frame, latest_first=False)
    if not records:
        return empty(
            call,
            reason=f"{code} 没有分红送配记录。",
            source="akshare.stock_fhps_detail_em",
        )
    _sort_records(records, ("报告期", "除权除息日"))
    limit = max(1, min(int(call.params.get("limit") or 12), 60))
    records = records[:limit]
    return ok(
        call,
        records=records,
        data={
            "code": code,
            "name": name,
            "latest_period": records[0].get("报告期"),
            "returned": len(records),
        },
        source="akshare.stock_fhps_detail_em",
        warnings=[
            "分红送配数据按报告期披露，金额与股本口径以原始公告为准；未做复权调整。"
        ],
    )


def restricted_release_lookup(call: ToolCall):
    code, name, _entity = resolve_target(call, "ENTITY_01_01", "ENTITY_02_01")
    if not code:
        return empty(call, reason="缺少公司/证券代码。", source="akshare.stock_restricted_release_detail_em")
    days = max(30, min(int(call.params.get("days") or 180), 730))
    start, end = date_window(call, default_days=days)
    frame = call.ctx.call_akshare(
        "stock_restricted_release_detail_em",
        start_date=start,
        end_date=end,
    )
    records = [
        row
        for row in records_from_frame(frame, latest_first=False)
        if str(row.get("股票代码") or "").strip() == code
    ]
    if not records:
        return empty(
            call,
            reason=f"{code} 在 {start}~{end} 没有限售解禁记录。",
            source="akshare.stock_restricted_release_detail_em",
        )
    _sort_records(records, ("解禁时间",))
    records = records[: max(1, min(int(call.params.get("limit") or 20), 100))]
    return ok(
        call,
        records=records,
        data={"code": code, "name": name, "start_date": start, "end_date": end},
        source="akshare.stock_restricted_release_detail_em",
        warnings=["限售解禁计划可能因公告调整而变化，实际解禁以公司公告为准。"],
    )


def institution_survey_lookup(call: ToolCall):
    code, name, _entity = resolve_target(call, "ENTITY_01_01", "ENTITY_02_01")
    if not code:
        return empty(call, reason="缺少公司/证券代码。", source="akshare.stock_jgdy_tj_em")
    days = max(7, min(int(call.params.get("days") or 30), 180))
    start = (call.ctx.today() - timedelta(days=days)).strftime("%Y%m%d")
    frame = call.ctx.call_akshare(
        "stock_jgdy_tj_em", date=start, timeout=60
    )
    records = [
        row
        for row in records_from_frame(frame, latest_first=False)
        if str(row.get("代码") or "").strip() == code
    ]
    if not records:
        return empty(
            call,
            reason=f"{code} 自 {start} 起没有机构调研记录。",
            source="akshare.stock_jgdy_tj_em",
        )
    _sort_records(records, ("接待日期", "公告日期"))
    records = records[: max(1, min(int(call.params.get("limit") or 20), 100))]
    return ok(
        call,
        records=records,
        data={
            "code": code,
            "name": name,
            "start_date": start,
            "returned": len(records),
        },
        source="akshare.stock_jgdy_tj_em",
        warnings=[
            "机构调研记录来自东方财富互动调研统计，接待机构数量为披露值；"
            "调研不代表机构实际买卖。"
        ],
    )
