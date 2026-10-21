# -*- coding: utf-8 -*-
"""宏观、大宗商品、政策与新闻检索类工具。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ...errors import SourceUnavailable
from ..context import ToolUnavailable, records_from_frame
from ..contracts import ToolCall
from ..helpers import (
    date_window,
    empty,
    first_entity,
    ok,
    param_name,
    series_summary,
    unavailable,
)
from ..mappings import COMMODITY_SERIES, INVENTORY_SYMBOLS, MACRO_SERIES, UNSUPPORTED_REASONS


def _macro_key(call: ToolCall) -> str | None:
    entity = first_entity(call, "ENTITY_06_01")
    if entity is not None and entity.entity_id in MACRO_SERIES:
        return entity.entity_id
    if entity is not None and entity.entity_id in UNSUPPORTED_REASONS:
        return entity.entity_id
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    if name:
        for macro_id, (_fn, _kwargs, display) in MACRO_SERIES.items():
            if name in (display, macro_id.rsplit(":", 1)[-1]):
                return macro_id
        for macro_id in UNSUPPORTED_REASONS:
            if name == macro_id.rsplit(":", 1)[-1]:
                return macro_id
    return None


def macro_series_lookup(call: ToolCall):
    macro_id = _macro_key(call)
    if macro_id is None:
        return empty(
            call,
            reason=f"没有可识别的宏观指标：{param_name(call) or '未提供'}",
            source="akshare.macro_china_*",
        )
    if macro_id in UNSUPPORTED_REASONS:
        return unavailable(call, UNSUPPORTED_REASONS[macro_id], source="akshare")
    function, kwargs, display = MACRO_SERIES[macro_id]
    frame = call.ctx.call_akshare(function, **kwargs)
    records = records_from_frame(frame, limit=int(call.params.get("limit") or 60))
    if not records:
        return empty(call, reason=f"{display} 没有返回序列。", source=f"akshare.{function}")
    return ok(
        call,
        records=records,
        data={
            "macro_entity_id": macro_id,
            "indicator": display,
            "summary": series_summary(records),
        },
        source=f"akshare.{function}",
    )


def _commodity_key(call: ToolCall) -> str | None:
    entity = first_entity(call, "ENTITY_06_02")
    if entity is not None:
        if entity.entity_id in COMMODITY_SERIES or entity.entity_id in UNSUPPORTED_REASONS:
            return entity.entity_id
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    if not name:
        return None
    for commodity_id, (_symbol, display) in COMMODITY_SERIES.items():
        if name == display or name == commodity_id.rsplit(":", 1)[-1]:
            return commodity_id
    for commodity_id in UNSUPPORTED_REASONS:
        if name == commodity_id.rsplit(":", 1)[-1]:
            return commodity_id
    for commodity_id, (_symbol, display) in COMMODITY_SERIES.items():
        if name in display or display in name:
            return commodity_id
    return None


def commodity_price_lookup(call: ToolCall):
    commodity_id = _commodity_key(call)
    if commodity_id is None:
        return empty(
            call,
            reason=f"没有可识别的大宗商品：{param_name(call) or '未提供'}",
            source="akshare.futures_main_sina",
        )
    if commodity_id in UNSUPPORTED_REASONS:
        return unavailable(call, UNSUPPORTED_REASONS[commodity_id], source="akshare")
    symbol, display = COMMODITY_SERIES[commodity_id]
    start, end = date_window(call, default_days=365)
    frame = call.ctx.call_akshare(
        "futures_main_sina", symbol=symbol, start_date=start, end_date=end
    )
    records = records_from_frame(frame, limit=int(call.params.get("limit") or 500))
    if not records:
        return empty(call, reason=f"{display}（{symbol}）没有行情。", source="akshare.futures_main_sina")
    return ok(
        call,
        records=records,
        data={
            "commodity_entity_id": commodity_id,
            "display_name": display,
            "contract": symbol,
            "summary": series_summary(records),
        },
        source="akshare.futures_main_sina",
        warnings=["使用新浪主力连续合约，价格不是某一具体交割月合约。"],
    )


def inventory_lookup(call: ToolCall):
    commodity_id = _commodity_key(call)
    if commodity_id is None or commodity_id not in INVENTORY_SYMBOLS:
        return unavailable(
            call,
            f"没有 {param_name(call) or commodity_id or '该商品'} 的公开库存数据。",
            source="akshare.futures_inventory_em",
        )
    symbol = INVENTORY_SYMBOLS[commodity_id]
    frame = call.ctx.call_akshare("futures_inventory_em", symbol=symbol)
    records = records_from_frame(frame, limit=int(call.params.get("limit") or 120))
    if not records:
        return empty(call, reason=f"{symbol} 没有库存序列。", source="akshare.futures_inventory_em")
    return ok(
        call,
        records=records,
        data={
            "commodity_entity_id": commodity_id,
            "inventory_symbol": symbol,
            "summary": series_summary(records),
        },
        source="akshare.futures_inventory_em",
    )


# ── 新闻 / 政策检索 ────────────────────────────────────────────────


def _news_search(call: ToolCall, keyword: str | None, *, days: int) -> tuple[list[dict[str, Any]], list[str]]:
    """在央视新闻与财联社电报中做关键词检索。"""

    records: list[dict[str, Any]] = []
    sources: list[str] = []
    seen: set[str] = set()

    try:
        frame = call.ctx.call_akshare("stock_info_global_cls", symbol="全部")
        for item in records_from_frame(frame, latest_first=False, limit=50):
            title = str(item.get("标题") or "")
            content = str(item.get("内容") or "")
            if keyword and keyword not in title and keyword not in content:
                continue
            key = title or content[:60]
            if key in seen:
                continue
            seen.add(key)
            records.append({**item, "matched_source": "财联社电报"})
        sources.append("akshare.stock_info_global_cls")
    except SourceUnavailable:
        pass

    # news_cctv 只能逐日抓取且单次较慢；限制最近 3 天，避免 30 天窗口串行请求数分钟。
    for day in call.ctx.recent_dates(max(1, min(days, 3))):
        day_text = day.strftime("%Y%m%d")
        try:
            frame = call.ctx.call_akshare("news_cctv", date=day_text)
        except SourceUnavailable:
            continue
        for item in records_from_frame(frame, latest_first=False, limit=200):
            title = str(item.get("title") or "")
            content = str(item.get("content") or "")
            if keyword and keyword not in title and keyword not in content:
                continue
            key = title or content[:60]
            if key in seen:
                continue
            seen.add(key)
            records.append({**item, "matched_source": f"新闻联播 {day_text}"})
        sources.append(f"akshare.news_cctv({day_text})")

    # 盯盘服务的事件流如果有，作为补充来源。
    try:
        payload = call.ctx.http_get(
            f"{call.ctx.market_watch_url}/news/events", {"limit": 60}
        )
        items = payload.get("items", []) if isinstance(payload, dict) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            text = " ".join(
                str(item.get(key) or "") for key in ("title", "summary", "content")
            )
            if keyword and keyword not in text:
                continue
            key = str(item.get("title") or text[:60])
            if key in seen:
                continue
            seen.add(key)
            records.append({**item, "matched_source": "market-watch 事件流"})
        sources.append("market-watch:/news/events")
    except ToolUnavailable:
        pass

    return records, sources


def _keyword(call: ToolCall) -> str | None:
    # 显式传入的 keyword 优先于实体名称，便于在同一实体上换检索词。
    return param_name(call)


def macro_event_search(call: ToolCall):
    keyword = _keyword(call)
    if not keyword:
        return empty(call, reason="宏观事件检索需要关键词。", source="akshare.news_cctv")
    days = int(call.params.get("days") or 3)
    records, sources = _news_search(call, keyword, days=days)
    if not records:
        return empty(
            call,
            reason=f"最近 {days} 天的新闻来源中没有检索到“{keyword}”。",
            source=" + ".join(sources) or "none",
        )
    return ok(
        call,
        records=records[: int(call.params.get("limit") or 30)],
        data={"keyword": keyword, "searched_sources": sources},
        source=" + ".join(sources),
        warnings=["事件检索基于新闻文本关键词匹配，不是结构化宏观事件库。"],
    )


def policy_search(call: ToolCall):
    keyword = _keyword(call)
    if not keyword:
        return empty(call, reason="政策检索需要主题关键词。", source="akshare.news_cctv")
    days = int(call.params.get("days") or 5)
    records, sources = _news_search(call, keyword, days=days)
    if not records:
        return empty(
            call,
            reason=f"最近 {days} 天没有与“{keyword}”相关的公开新闻/政策报道。",
            source=" + ".join(sources) or "none",
        )
    return ok(
        call,
        records=records[: int(call.params.get("limit") or 30)],
        data={"keyword": keyword, "searched_sources": sources, "document_type": "news"},
        source=" + ".join(sources),
        warnings=["该工具检索新闻报道，不等同于官方政策原文库。"],
    )


def supply_demand_lookup(call: ToolCall):
    return unavailable(
        call,
        "当前没有可复现的供需平衡表数据源；已核查库存、价格与新闻接口，"
        "均不能替代供需数据，可用 inventory_lookup 与 commodity_price_lookup 做辅助判断。",
        source="none",
    )


# ── 官方文件检索 ──────────────────────────────────────────────────

_GOV_DOC_TYPES = {
    "国务院文件": "zhengcelibrary_gw",
    "国务院": "zhengcelibrary_gw",
    "gw": "zhengcelibrary_gw",
    "部门文件": "zhengcelibrary_bm",
    "部门": "zhengcelibrary_bm",
    "bm": "zhengcelibrary_bm",
}


def _strip_em(text: Any) -> str:
    import re

    return re.sub(r"<[^>]+>", "", str(text or "")).strip()


def _gov_date(item: dict[str, Any]) -> str | None:
    value = item.get("pubtimeStr")
    if value:
        return str(value).replace(".", "-")
    stamp = item.get("ptime") or item.get("pubtime")
    try:
        return datetime.fromtimestamp(int(stamp) / 1000, tz=timezone.utc).date().isoformat()
    except (TypeError, ValueError, OSError):
        return None


def official_document_search(call: ToolCall):
    keyword = _keyword(call)
    if not keyword:
        return empty(call, reason="官方文件检索需要关键词。", source="gov.cn 政策文件库")

    doc_type = str(call.params.get("doc_type") or "国务院文件").strip()
    library = _GOV_DOC_TYPES.get(doc_type)
    if library is None:
        return empty(
            call,
            reason=f"不支持的文件类型“{doc_type}”，可选：国务院文件、部门文件。",
            source="gov.cn 政策文件库",
        )
    page = max(1, int(call.params.get("page") or 1))
    limit = max(1, min(int(call.params.get("limit") or 20), 50))
    sort = "pubtime" if str(call.params.get("sort") or "score") == "date" else "score"
    params = {
        "t": library,
        "q": keyword,
        "p": str(page),
        "n": str(limit),
        "sort": sort,
        "sortType": "1",
        "timetype": "timeqb",
    }
    payload = call.ctx.http_get("https://sousuo.www.gov.cn/search-gov/data", params)
    search_vo = payload.get("searchVO") if isinstance(payload, dict) else None
    if not isinstance(search_vo, dict):
        return unavailable(call, "gov.cn 搜索接口返回结构异常。", source="gov.cn 政策文件库")
    items = search_vo.get("listVO") or []
    total = int(search_vo.get("totalCount") or 0)
    records: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        records.append(
            {
                "标题": _strip_em(item.get("title")),
                "发布机构": str(item.get("puborg") or "").strip(),
                "发布日期": _gov_date(item),
                "文号": str(item.get("pcode") or "").strip(),
                "分类": str(item.get("childtype") or "").replace("\\", "/"),
                "链接": str(item.get("url") or "").strip(),
                "摘要": _strip_em(item.get("summary")),
            }
        )
    if not records:
        return empty(
            call,
            reason=f"gov.cn 政策文件库中没有检索到“{keyword}”（类型：{doc_type}）。",
            source="gov.cn 政策文件库",
        )
    return ok(
        call,
        records=records,
        data={
            "keyword": keyword,
            "doc_type": doc_type,
            "library": library,
            "total": total,
            "page": page,
            "document_type": "official_document",
        },
        source="gov.cn 政策文件库",
        warnings=[
            "仅覆盖中国政府网政策文件库（国务院/部门文件），不含地方政府与监管机构网站全文；"
            "检索结果为标题与摘要，引用前应打开原文核对。"
        ],
    )


def regional_policy_search(call: ToolCall):
    keyword = _keyword(call)
    if not keyword:
        return empty(call, reason="区域政策检索需要区域关键词。", source="akshare.news_cctv")
    days = int(call.params.get("days") or 7)
    records, sources = _news_search(call, keyword, days=days)
    if not records:
        return empty(
            call,
            reason=f"最近 {days} 天没有与“{keyword}”相关的公开报道。",
            source=" + ".join(sources) or "none",
        )
    return ok(
        call,
        records=records[: int(call.params.get("limit") or 30)],
        data={"keyword": keyword, "searched_sources": sources, "document_type": "news"},
        source=" + ".join(sources),
        warnings=["区域政策检索基于新闻关键词，不是官方文件库。"],
    )
