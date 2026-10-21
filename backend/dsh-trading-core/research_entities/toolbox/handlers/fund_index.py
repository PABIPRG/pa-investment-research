# -*- coding: utf-8 -*-
"""基金、指数、风格、行业表现类工具。"""

from __future__ import annotations

from typing import Any

from ...errors import SourceUnavailable
from ..context import ToolUnavailable, records_from_frame
from ..contracts import ToolCall
from ..helpers import (
    date_window,
    empty,
    entity_code,
    first_entity,
    ok,
    param_code,
    param_name,
    series_summary,
    staleness_warning,
    unavailable,
)
from ..mappings import (
    STYLE_INDEX,
    UNSUPPORTED_REASONS,
    index_def_for,
    normalize_ths_name,
    security_symbol,
    style_def_for,
)


def _infer_index_sina_code(code: str) -> str | None:
    """按指数代码区间推断新浪符号；股票代码区间不参与推断。"""

    if code.startswith("000"):
        return f"sh{code}"
    if code.startswith("399"):
        return f"sz{code}"
    if code.startswith("899"):
        return f"bj{code}"
    return None


def _index_identity(call: ToolCall) -> tuple[str, str, str] | None:
    entity = first_entity(call, "ENTITY_01_03", "ENTITY_05_03")
    entity_id = entity.entity_id if entity is not None else None
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    code = entity_code(entity) or param_code(call)
    found = index_def_for(entity_id, name)
    if found:
        return found
    if code:
        for csindex, sina, canonical in set(_all_index_defs()):
            if code in (csindex, sina):
                return (csindex, sina, canonical)
        # 主数据导入后会有全量指数；非内置指数按代码区间推断交易所，
        # 中证系指数（93/95 开头）直接走 csindex 接口。
        sina = _infer_index_sina_code(code)
        if sina:
            return (code, sina, name or code)
        if code.startswith(("93", "95")):
            return (code, "", name or code)
    return None


def _all_index_defs() -> list[tuple[str, str, str]]:
    from ..mappings import INDEX_DEFS

    return list(INDEX_DEFS.values())


# ── 基金 ────────────────────────────────────────────────────────────


def fund_lookup(call: ToolCall):
    code = param_code(call) or (entity_code(first_entity(call, "ENTITY_01_02")))
    name = param_name(call)
    if not code and not name:
        return empty(call, reason="基金查询需要代码或名称。", source="akshare.fund_name_em")
    frame = call.ctx.call_akshare("fund_name_em")
    if frame is None or not len(frame):
        return empty(call, reason="基金名录为空。", source="akshare.fund_name_em")
    found = frame
    if code and "基金代码" in frame.columns:
        found = frame[frame["基金代码"].astype(str).str.zfill(6) == code]
    if not len(found) and name and "基金简称" in frame.columns:
        found = frame[frame["基金简称"].astype(str).str.contains(name, na=False)]
    if not len(found):
        return empty(
            call, reason=f"基金名录中没有匹配项：{code or name}", source="akshare.fund_name_em"
        )
    return ok(
        call,
        records=records_from_frame(found, latest_first=False, limit=int(call.params.get("limit") or 20)),
        data={"code": code, "name": name},
        source="akshare.fund_name_em",
    )


def fund_holdings_lookup(call: ToolCall):
    code = param_code(call) or entity_code(first_entity(call, "ENTITY_01_02"))
    if not code:
        return empty(call, reason="缺少基金代码。", source="akshare.fund_portfolio_hold_em")
    year = str(call.params.get("year") or call.ctx.today().year)
    warnings: list[str] = []
    frame = call.ctx.call_akshare("fund_portfolio_hold_em", symbol=code, date=year)
    if frame is None or not len(frame):
        previous = str(int(year) - 1)
        warnings.append(f"{year} 年持仓为空，回退 {previous} 年。")
        frame = call.ctx.call_akshare(
            "fund_portfolio_hold_em", symbol=code, date=previous
        )
        year = previous
    if frame is None or not len(frame):
        return empty(
            call, reason=f"{code} 没有可用的基金持仓数据。", source="akshare.fund_portfolio_hold_em"
        )
    return ok(
        call,
        records=records_from_frame(frame, latest_first=False, limit=int(call.params.get("limit") or 50)),
        data={"code": code, "year": year},
        source="akshare.fund_portfolio_hold_em",
        warnings=warnings,
    )


def fund_performance_lookup(call: ToolCall):
    code = param_code(call) or entity_code(first_entity(call, "ENTITY_01_02"))
    if not code:
        return empty(call, reason="缺少基金代码。", source="akshare")
    start, end = date_window(call, default_days=365)
    warnings: list[str] = []
    source = "akshare.fund_open_fund_info_em"
    records: list[dict[str, Any]] = []
    symbol = security_symbol(code)
    is_etf = code.startswith(("15", "51", "56", "58")) and symbol is not None
    if is_etf:
        source = "akshare.fund_etf_hist_sina"
        try:
            frame = call.ctx.call_akshare("fund_etf_hist_sina", symbol=symbol)
            records = records_from_frame(frame, limit=int(call.params.get("limit") or 500))
            # 新浪 ETF 历史没有起止参数，按日期过滤。
            if records and "date" in records[0]:
                records = [
                    item
                    for item in records
                    if start[:4] + "-" + start[4:6] + "-" + start[6:]
                    <= str(item.get("date"))
                    <= end[:4] + "-" + end[4:6] + "-" + end[6:]
                ]
        except SourceUnavailable as exc:
            warnings.append(f"ETF 历史净值不可用，改用基金净值：{exc}")

    if not records:
        source = "akshare.fund_open_fund_info_em"
        frame = call.ctx.call_akshare(
            "fund_open_fund_info_em", symbol=code, indicator="单位净值走势"
        )
        records = records_from_frame(frame, limit=None)
    if records:
        start_iso = f"{start[:4]}-{start[4:6]}-{start[6:]}"
        end_iso = f"{end[:4]}-{end[4:6]}-{end[6:]}"
        date_key = next(
            (key for key in ("净值日期", "date", "日期") if key in records[0]), None
        )
        if date_key:
            records = [
                item
                for item in records
                if start_iso <= str(item.get(date_key))[:10] <= end_iso
            ]
        records = records[: int(call.params.get("limit") or 500)]
    if not records:
        return empty(call, reason=f"{code} 没有净值序列。", source=source)
    stale = staleness_warning(call, records, label="基金净值")
    if stale:
        warnings.append(stale)
    return ok(
        call,
        records=records,
        data={"code": code, "start_date": start, "end_date": end, "summary": series_summary(records)},
        source=source,
        warnings=warnings,
    )


# ── 指数 ────────────────────────────────────────────────────────────


def index_lookup(call: ToolCall):
    identity = _index_identity(call)
    entity = first_entity(call, "ENTITY_01_03", "ENTITY_05_03")
    code = identity[0] if identity else param_code(call)
    name = identity[2] if identity else param_name(call)
    if not code and not name:
        return empty(call, reason="指数查询需要代码或名称。", source="akshare.stock_zh_index_spot_sina")

    frame = call.ctx.call_akshare("stock_zh_index_spot_sina")
    found = frame
    if frame is not None and len(frame):
        if code and "代码" in frame.columns:
            found = frame[frame["代码"].astype(str).str.contains(code, na=False)]
        if not len(found) and name and "名称" in frame.columns:
            found = frame[frame["名称"].astype(str).str.contains(name, na=False)]
    if found is None or not len(found):
        if entity is None:
            return empty(
                call,
                reason=f"实时指数快照中没有匹配项：{code or name}",
                source="akshare.stock_zh_index_spot_sina",
            )
        return ok(
            call,
            data={"entity": entity.model_dump(mode="json"), "quote_found": False},
            source="research_entities.repository",
            warnings=["实体库中有该指数，但新浪实时快照未匹配到。"],
        )
    return ok(
        call,
        records=records_from_frame(found, latest_first=False, limit=5),
        data={
            "entity": entity.model_dump(mode="json") if entity else None,
            "csindex_code": identity[0] if identity else None,
        },
        source="akshare.stock_zh_index_spot_sina",
    )


def _constituents(call: ToolCall, code: str) -> tuple[Any, str]:
    try:
        frame = call.ctx.call_akshare("index_stock_cons", symbol=code)
        if frame is not None and len(frame):
            return frame, "akshare.index_stock_cons"
    except SourceUnavailable:
        pass
    frame = call.ctx.call_akshare("index_stock_cons_csindex", symbol=code)
    return frame, "akshare.index_stock_cons_csindex"


def index_constituents_lookup(call: ToolCall):
    identity = _index_identity(call)
    code = identity[0] if identity else param_code(call)
    if not code:
        return empty(call, reason="缺少指数代码。", source="akshare.index_stock_cons")
    frame, source = _constituents(call, code)
    records = records_from_frame(frame, latest_first=False, limit=int(call.params.get("limit") or 1000))
    if not records:
        return empty(call, reason=f"{code} 没有成分股数据。", source=source)
    return ok(call, records=records, data={"index_code": code}, source=source)


def _filter_records_by_date(
    records: list[dict[str, Any]], start: str, end: str
) -> list[dict[str, Any]]:
    """把 YYYYMMDD 区间应用到记录上；无日期字段时原样返回。"""

    if not records:
        return records
    date_key = next((key for key in ("日期", "date") if key in records[0]), None)
    if date_key is None:
        return records
    start_iso = f"{start[:4]}-{start[4:6]}-{start[6:]}"
    end_iso = f"{end[:4]}-{end[4:6]}-{end[6:]}"
    # 窗口内没有数据时不能回退整段历史，否则会把多年前的净值/点位
    # 当作当前区间表现返回。返回空由调用方切换到其它数据源。
    return [
        item
        for item in records
        if start_iso <= str(item.get(date_key))[:10] <= end_iso
    ]


def _index_daily(call: ToolCall, csindex: str, sina: str) -> tuple[list[dict[str, Any]], str]:
    start, end = date_window(call, default_days=365)
    limit = int(call.params.get("limit") or 500)
    if sina:
        try:
            frame = call.ctx.call_akshare("stock_zh_index_daily", symbol=sina)
            records = _filter_records_by_date(
                records_from_frame(frame, limit=None), start, end
            )
            records = records[:limit]
            if records:
                return records, "akshare.stock_zh_index_daily"
        except SourceUnavailable:
            pass
    frame = call.ctx.call_akshare(
        "stock_zh_index_hist_csindex", symbol=csindex, start_date=start, end_date=end
    )
    return (
        records_from_frame(frame, limit=limit),
        "akshare.stock_zh_index_hist_csindex",
    )


def benchmark_performance_lookup(call: ToolCall):
    """按证券所属板块映射基准，并返回基准指数表现。"""

    from adapter.benchmark import candidate_benchmarks

    entity = first_entity(call)
    code = entity_code(entity) or param_code(call)
    if not code or len(code) != 6:
        return empty(call, reason="缺少 6 位证券代码，无法映射基准。", source="adapter.benchmark")
    warnings: list[str] = []
    for benchmark_code, benchmark_name in candidate_benchmarks(code):
        normalized = benchmark_code.replace(".", "")
        identity = index_def_for(None, normalized)
        sina = identity[1] if identity else normalized
        csindex = identity[0] if identity else normalized
        try:
            records, source = _index_daily(call, csindex, sina)
        except SourceUnavailable as exc:
            warnings.append(f"基准 {benchmark_name} 不可用：{exc}")
            continue
        if records:
            return ok(
                call,
                records=records,
                data={
                    "benchmark_code": benchmark_code,
                    "benchmark_name": benchmark_name,
                    "summary": series_summary(records),
                },
                source=source,
                warnings=warnings,
            )
        warnings.append(f"基准 {benchmark_name} 没有行情。")
    return empty(
        call,
        reason=f"{code} 的候选基准都没有可用行情。",
        source="akshare.stock_zh_index_daily",
    )


def index_performance_lookup(call: ToolCall):
    identity = _index_identity(call)
    if identity is None:
        return empty(
            call,
            reason=f"没有可识别的指数：{param_code(call) or param_name(call)}",
            source="akshare",
        )
    csindex, sina, name = identity
    records, source = _index_daily(call, csindex, sina)
    if not records:
        return empty(call, reason=f"{name} 没有指数行情。", source=source)
    stale = staleness_warning(call, records, label="指数行情")
    return ok(
        call,
        records=records,
        data={"index_code": csindex, "index_name": name, "summary": series_summary(records)},
        source=source,
        warnings=[stale] if stale else [],
    )


# ── 风格 / 行业 / 主题 ──────────────────────────────────────────────


def _style_identity(call: ToolCall) -> tuple[str, str, str] | None:
    entity = first_entity(call, "ENTITY_05_02")
    entity_id = entity.entity_id if entity is not None else None
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    return style_def_for(entity_id, name)


def style_performance_lookup(call: ToolCall):
    entity = first_entity(call, "ENTITY_05_02")
    entity_id = entity.entity_id if entity is not None else None
    if entity_id in UNSUPPORTED_REASONS:
        return unavailable(call, UNSUPPORTED_REASONS[entity_id], source="akshare")
    identity = _style_identity(call)
    if identity is None:
        return unavailable(
            call,
            f"风格 {param_name(call) or entity_id or '未知'} 还没有映射到可复现的公开指数。",
            source="akshare",
        )
    csindex, sina, index_name = identity
    records, source = _index_daily(call, csindex, sina)
    if not records:
        return empty(call, reason=f"风格代表指数 {index_name} 没有行情。", source=source)
    warnings = [
        f"风格表现以 {index_name}（{csindex}）作为代理指数，不是风格因子本身。"
    ]
    stale = staleness_warning(call, records, label="风格代理指数行情")
    if stale:
        warnings.append(stale)
    return ok(
        call,
        records=records,
        data={
            "style_entity_id": entity_id,
            "proxy_index_code": csindex,
            "proxy_index_name": index_name,
            "summary": series_summary(records),
        },
        source=source,
        warnings=warnings,
    )


def style_constituents_lookup(call: ToolCall):
    entity = first_entity(call, "ENTITY_05_02")
    entity_id = entity.entity_id if entity is not None else None
    if entity_id in UNSUPPORTED_REASONS:
        return unavailable(call, UNSUPPORTED_REASONS[entity_id], source="akshare")
    identity = _style_identity(call)
    if identity is None:
        return unavailable(
            call,
            f"风格 {param_name(call) or entity_id or '未知'} 还没有映射到公开指数。",
            source="akshare",
        )
    csindex, _sina, index_name = identity
    frame, source = _constituents(call, csindex)
    records = records_from_frame(frame, latest_first=False, limit=int(call.params.get("limit") or 1000))
    if not records:
        return empty(call, reason=f"风格代表指数 {index_name} 没有成分数据。", source=source)
    return ok(
        call,
        records=records,
        data={
            "style_entity_id": entity_id,
            "proxy_index_code": csindex,
            "proxy_index_name": index_name,
        },
        source=source,
        warnings=[f"成分股来自代理指数 {index_name}（{csindex}）。"],
    )


def _ths_name_match(frame: Any, candidates: list[str]) -> str | None:
    if frame is None or not len(frame) or "name" not in frame.columns:
        return None
    names = [str(item) for item in frame["name"].tolist()]
    for candidate in candidates:
        if candidate in names:
            return candidate
    for candidate in candidates:
        for name in names:
            if candidate and (candidate in name or name in candidate):
                return name
    return None


def industry_performance_lookup(call: ToolCall):
    entity = first_entity(call, "ENTITY_03_01")
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    if not name:
        return empty(call, reason="缺少行业名称。", source="akshare.stock_board_industry_index_ths")
    candidates = normalize_ths_name(name)
    industry_frame = call.ctx.call_akshare("stock_board_industry_name_ths")
    matched = _ths_name_match(industry_frame, candidates)
    board_type = "industry"

    if matched is None:
        concept_frame = call.ctx.call_akshare("stock_board_concept_name_ths")
        matched = _ths_name_match(concept_frame, candidates)
        board_type = "concept"
    if matched is None:
        return empty(
            call,
            reason=f"同花顺行业/概念板块中没有匹配“{name}”的名称（候选：{candidates}）。",
            source="akshare.stock_board_*_name_ths",
        )

    start, end = date_window(call, default_days=180)
    function = (
        "stock_board_industry_index_ths"
        if board_type == "industry"
        else "stock_board_concept_index_ths"
    )
    frame = call.ctx.call_akshare(
        function, symbol=matched, start_date=start, end_date=end
    )
    records = records_from_frame(frame, limit=int(call.params.get("limit") or 500))
    if not records:
        return empty(call, reason=f"板块 {matched} 没有行情。", source=f"akshare.{function}")
    warnings = [
        "同花顺板块分类与本地行业分类不是同一套口径，匹配结果需人工复核。"
    ]
    stale = staleness_warning(call, records, label="板块行情")
    if stale:
        warnings.append(stale)
    return ok(
        call,
        records=records,
        data={
            "industry_name": name,
            "matched_board": matched,
            "board_type": board_type,
            "summary": series_summary(records),
        },
        source=f"akshare.{function}",
        warnings=warnings,
    )


_THS_CONSTITUENT_HEADERS = {
    "序号": "序号",
    "代码": "股票代码",
    "名称": "股票简称",
    "现价": "现价",
    "涨跌幅(%)": "涨跌幅",
    "涨跌": "涨跌额",
    "涨速(%)": "涨速",
    "换手(%)": "换手率",
    "量比(%)": "量比",
    "振幅(%)": "振幅",
    "成交额": "成交额",
    "流通股": "流通股",
    "流通市值": "流通市值",
    "市盈率": "市盈率",
}
_THS_TEXT_FIELDS = {"股票代码", "股票简称"}


def _ths_concept_code(frame: Any, candidates: list[str]) -> tuple[str, str] | None:
    """在同花顺概念名录里匹配名称，返回 (标准名, 板块代码)。"""

    if frame is None or not len(frame) or "name" not in frame.columns:
        return None
    names = [str(item) for item in frame["name"].tolist()]
    codes = [str(item) for item in frame["code"].tolist()]
    for candidate in candidates:
        if candidate in names:
            return candidate, codes[names.index(candidate)]
    for candidate in candidates:
        for name, code in zip(names, codes):
            if candidate and (candidate in name or name in candidate):
                return name, code
    return None


def _parse_ths_constituents(html: str) -> tuple[list[dict[str, Any]], int | None]:
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover - 依赖缺失
        raise ToolUnavailable("缺少 beautifulsoup4，无法解析同花顺板块页面") from exc

    soup = BeautifulSoup(html, "lxml")
    table = soup.select_one("table.m-table")
    if table is None:
        return [], None
    page_info = soup.select_one("span.page_info")
    total_pages = None
    if page_info is not None:
        text = page_info.get_text(strip=True)
        if "/" in text:
            try:
                total_pages = int(text.split("/")[-1])
            except ValueError:
                total_pages = None

    header_cells = [cell.get_text(strip=True) for cell in table.select("thead tr th")]
    if not header_cells:
        first_row = table.find("tr")
        header_cells = (
            [cell.get_text(strip=True) for cell in first_row.find_all(["th", "td"])]
            if first_row is not None
            else []
        )
    headers = [
        _THS_CONSTITUENT_HEADERS.get(cell, cell) for cell in header_cells
    ]
    records: list[dict[str, Any]] = []
    for row in table.find_all("tr"):
        cells = [cell.get_text(strip=True) for cell in row.find_all("td")]
        if len(cells) < 3 or not cells[1].isdigit():
            continue
        record: dict[str, Any] = {}
        for index, value in enumerate(cells):
            key = headers[index] if index < len(headers) else f"字段{index + 1}"
            if key in _THS_TEXT_FIELDS:
                record[key] = value
            elif value in ("", "--"):
                record[key] = None
            else:
                try:
                    record[key] = float(value)
                except ValueError:
                    record[key] = value
        records.append(record)
    return records, total_pages


def theme_constituents_lookup(call: ToolCall):
    entity = first_entity(call, "ENTITY_03_02")
    name = (entity.canonical_name if entity is not None else None) or param_name(call)
    aliases = list(entity.aliases) if entity is not None else []
    raw_code = str(call.params.get("theme_code") or call.params.get("code") or "").strip()
    if not name and not raw_code:
        return empty(call, reason="缺少主题名称或同花顺板块代码。", source="同花顺概念板块")

    if not aliases and name:
        aliases = [name]
    candidates = []
    for item in [name, *aliases]:
        if not item:
            continue
        for candidate in normalize_ths_name(item):
            if candidate not in candidates:
                candidates.append(candidate)
    if not candidates and raw_code:
        candidates = [raw_code]

    try:
        concept_frame = call.ctx.call_akshare("stock_board_concept_name_ths")
    except ToolUnavailable as exc:
        return unavailable(call, f"同花顺概念名录不可用：{exc}", source="同花顺概念板块")

    matched = None
    if raw_code:
        names = (
            [str(item) for item in concept_frame["name"].tolist()]
            if concept_frame is not None and len(concept_frame)
            else []
        )
        codes = (
            [str(item) for item in concept_frame["code"].tolist()]
            if concept_frame is not None and len(concept_frame)
            else []
        )
        if raw_code in codes:
            matched = (names[codes.index(raw_code)], raw_code)
    if matched is None:
        matched = _ths_concept_code(concept_frame, candidates)
    if matched is None:
        return empty(
            call,
            reason=(
                f"同花顺概念板块中没有匹配“{name or raw_code}”的名称"
                f"（候选：{candidates[:6]}）。"
            ),
            source="akshare.stock_board_concept_name_ths",
        )

    matched_name, board_code = matched
    base_url = f"https://q.10jqka.com.cn/gn/detail/code/{board_code}/"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        ),
        "Referer": "https://q.10jqka.com.cn/gn/",
    }
    try:
        first_html = call.ctx.http_get_text(base_url, headers=headers, encoding="gbk")
    except ToolUnavailable as exc:
        return unavailable(
            call,
            f"同花顺概念成分页不可用：{exc}",
            source="同花顺概念板块详情页",
        )

    records, total_pages = _parse_ths_constituents(first_html)
    if not records:
        return empty(
            call,
            reason=f"同花顺板块“{matched_name}”页面没有解析到成分股。",
            source="同花顺概念板块详情页",
        )

    requested_pages = int(call.params.get("pages") or 3)
    requested_pages = max(1, min(requested_pages, 10))
    fetch_pages = min(requested_pages, total_pages or requested_pages)
    warnings: list[str] = []
    fetched_pages = 1
    for page in range(2, fetch_pages + 1):
        url = f"{base_url}page/{page}/"
        try:
            html = call.ctx.http_get_text(url, headers=headers, encoding="gbk")
        except ToolUnavailable as exc:
            warnings.append(f"第 {page} 页抓取失败，已保留前 {fetched_pages} 页：{exc}")
            break
        page_records, _page_total = _parse_ths_constituents(html)
        if not page_records:
            break
        records.extend(page_records)
        fetched_pages = page

    limit = int(call.params.get("limit") or 100)
    records = records[:limit]
    if total_pages and total_pages > fetched_pages:
        warnings.append(
            f"同花顺显示该板块共 {total_pages} 页，本次只抓取前 {fetched_pages} 页"
            f"（{len(records)} 只），不是完整成分股。"
        )
    warnings.append(
        "同花顺概念板块按涨幅排序展示成分，分类口径与申万/中证行业不同，需人工复核。"
    )
    return ok(
        call,
        records=records,
        data={
            "theme_name": name,
            "matched_board": matched_name,
            "board_code": board_code,
            "total_pages": total_pages,
            "fetched_pages": fetched_pages,
            "returned": len(records),
        },
        source="同花顺概念板块详情页",
        warnings=warnings,
    )
