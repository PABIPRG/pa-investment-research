# -*- coding: utf-8 -*-
"""事件驱动层：快讯 → LLM 结构化事件 → 命中自选/持仓预警 → 个性化排序。

架构图「结构化投资事件 → 资讯卡片生成器 / 风险扫描引擎」的第一期落点：
  fetch_flash 快讯 → extract_events（LLM 抽 type/tickers/industries/direction/summary）
  → event_alerts（命中自选 watchlist + 持仓 holdings 生成预警）
  → enriched_flash（items 附加 event/matched，personal 命中置顶）。
LLM 不可用/失败自动降级为规则抽取（价格异动/涨停跌停关键词），保证事件层始终可用。
"""

import hashlib
import logging
import re
import time
from concurrent.futures import wait

import requests

from . import llm, news, quotes
from .config import settings
from .store import JsonStore

logger = logging.getLogger("market_watch.events")

# 事件类型 → 展示图标（后端给一份保证一致，前端可覆盖）
TYPE_EMOJI = {
    "公告": "📋", "业绩": "📈", "价格异动": "💰", "政策": "🏛",
    "产业": "🏭", "合作": "🤝", "评级": "⭐", "宏观": "🌐", "相关": "🔗", "其他": "📄",
}

_EVENT_CACHE: dict[str, tuple[float, list[dict]]] = {}
_HOLDINGS_CACHE: dict[str, tuple[float, list[str]]] = {}
_WATCH_NAMES_CACHE: dict[str, tuple[float, dict[str, str]]] = {}


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _dedup(rows: list[dict], key: str) -> list[dict]:
    seen: set[str] = set()
    out = []
    for r in rows:
        k = str(r.get(key) or r.get("id") or "")
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


# ---- 事件抽取 ----------------------------------------------------------------


def _seen_ids() -> set[str]:
    return set((JsonStore().get("events", "seen_ids") or [])[-200:])


def _save_seen(ids: list[str]) -> None:
    JsonStore().mutate(
        "events",
        "seen_ids",
        lambda current: (list(current or []) + ids)[-200:],
        [],
    )


def _resolve_code(name: str) -> str:
    """ticker 名称 → code。全局名称表精确解析失败时（如新股 N宇树、简称），
    用关注股（自选+持仓）名称做子串模糊匹配兜底，保证 LLM 事件能命中预警。"""
    codes = quotes.resolve_company_codes(name)
    if codes:
        return codes[0]
    for n, c in _watch_hold_names().items():
        if n and (n in name or name in n):
            return c
    return ""


def _extract_llm(items: list[dict]) -> list[dict]:
    """把 items 拼成一条 LLM 请求 → 结构化事件。失败抛异常（上层规则降级）。"""
    block = "\n".join(
        f"[{i}] {((it.get('title') or '') + ' ' + (it.get('content') or '')).strip()[:200]}"
        for i, it in enumerate(items)
    )
    system = (
        "你是A股市场事件抽取助手。把给定每条快讯抽成结构化投资事件。规则：\n"
        "1) 只对确有信息量的事件输出，无价值的跳过（如纯行情播报）；\n"
        "2) tickers 给涉及上市公司的中文名（未指明公司可留空数组）；industries 给受影响行业；\n"
        "3) direction 利好/利空/中性——有明确利好利空倾向才标，否则中性；\n"
        "4) type 只能是：公告/业绩/价格异动/政策/产业/合作/评级/宏观/其他。\n"
        '只输出 JSON（不要其它文字）：{"events":[{"idx":序号,"type":"...","tickers":[{"name":"公司中文名"}],'
        '"industries":["行业"],"direction":"利好|利空|中性","summary":"一句话"}]}'
    )
    data = llm.chat_json(system, block, max_tokens=2000)
    out = []
    for ev in (data or {}).get("events") or []:
        try:
            idx = int(ev.get("idx", -1))
        except (TypeError, ValueError):
            idx = -1
        if idx < 0 or idx >= len(items):
            continue
        it = items[idx]
        tickers = []
        for t in (ev.get("tickers") or []):
            nm = str(t.get("name") or "").strip()
            if not nm:
                continue
            tickers.append({"name": nm, "code": _resolve_code(nm)})
        out.append({
            "id": "ev-" + hashlib.md5((it["id"] + str(ev.get("summary") or "")).encode()).hexdigest()[:10],
            "item_id": it["id"],
            "type": str(ev.get("type") or "其他"),
            "tickers": tickers,
            "industries": [str(s).strip() for s in (ev.get("industries") or []) if str(s).strip()],
            "direction": str(ev.get("direction") or "中性"),
            "summary": str(ev.get("summary") or "").strip() or it["title"],
            "title": it["title"], "time": it["time"], "source": it["source"], "url": it["url"],
        })
    return out


# 定向新闻：direction/type 关键词（与 _extract_rule 同风格；_extract_rule 只复用核心价格正则，行为不变）
_DIR_UP = re.compile(r"涨停|大涨|涨超|上涨|飙升|升逾")
_DIR_DOWN = re.compile(r"跌停|大跌|跌超|下跌|重挫|暴跌|挫逾")
_DIRECTED_UP = re.compile(
    r"涨停|大涨|涨超|上涨|飙升|升逾|预增|净流入|增持|回购|中标|签约|利好|扭亏")
_DIRECTED_DOWN = re.compile(
    r"跌停|大跌|跌超|下跌|重挫|暴跌|挫逾|预减|净流出|减持|解禁|利空|亏损|违规|处罚|风险提示")
_DIRECTED_TYPE_RULES = (
    ("业绩", ("业绩", "净利润", "营收", "财报", "中报", "年报", "季报", "业绩预告", "分红", "派息", "预增", "预减")),
    ("公告", ("公告", "预案", "回购", "增持", "减持", "定增", "重组", "停牌", "复牌", "解禁", "披露")),
    ("评级", ("评级", "研报", "目标价", "买入", "增持评级")),
    ("价格异动", ("涨停", "跌停", "大涨", "大跌", "异动", "涨超", "跌超", "封板", "龙虎榜", "换手")),
    ("政策", ("政策", "监管", "证监会", "央行", "发改委", "财政部", "国务院", "新规", "征求意见")),
    ("合作", ("合作", "签约", "中标", "订单", "合同", "战略合作", "联手")),
    ("产业", ("行业", "板块", "产业链", "供需", "产能", "涨价", "降价", "出口")),
    ("宏观", ("GDP", "CPI", "PMI", "降准", "降息", "通胀", "利率", "经济")),
    ("相关", ("资金", "净流入", "净流出", "主力", "北向", "融资", "机构", "上榜")),
)


def _directed_direction(txt: str) -> str:
    if _DIRECTED_UP.search(txt):
        return "利好"
    if _DIRECTED_DOWN.search(txt):
        return "利空"
    return "中性"


def _classify_directed(txt: str) -> str:
    for ev_type, kws in _DIRECTED_TYPE_RULES:
        if any(k in txt for k in kws):
            return ev_type
    return "其他"


def _extract_rule(it: dict, names: dict[str, str]) -> dict | None:
    """无 LLM 时的规则降级：
    - 含价格百分比 / 涨停跌停关键词 → 价格异动事件；
    - 提到自选/持仓股名（子串命中）→ 相关事件（无 LLM 下预警也可用）。
    两者可叠加。"""
    txt = f"{it.get('title') or ''} {it.get('content') or ''}"
    mentioned = {n: c for n, c in names.items() if n and n in txt}
    is_price = bool(re.search(r"\d+\.?\d*\s*%", txt)) or bool(re.search(r"涨停|跌停", txt))
    if not is_price and not mentioned:
        return None
    direction = "中性"
    if is_price:
        if _DIR_UP.search(txt):
            direction = "利好"
        if _DIR_DOWN.search(txt):
            direction = "利空"
    ev_type = "价格异动" if is_price else "相关"
    return {
        "id": "ev-rule-" + hashlib.md5(it["id"].encode()).hexdigest()[:10],
        "item_id": it["id"],
        "type": ev_type,
        "tickers": [{"name": n, "code": c} for n, c in mentioned.items()],
        "industries": [], "direction": direction,
        "summary": it["title"], "title": it["title"], "time": it["time"],
        "source": it["source"], "url": it["url"],
    }


def extract_events(limit: int = 30, *, force: bool = False) -> list[dict]:
    """快讯 → 结构化事件列表。懒抽取（每轮最多 event_batch 条新快讯）+ TTL 缓存 + 去重游标。

    force=True 由后台 event-warm 线程周期调用：跳过 TTL 命中直接续热刷新。
    去重游标保证只增量抽取新快讯（无新内容时开销近零），缓存时间戳随之前移。
    LLM 不可用/失败 → 规则降级。event_enabled=false 返回空。"""
    limit = max(5, min(limit, 100))
    if not settings.event_enabled:
        return []
    now = time.time()
    hit = _EVENT_CACHE.get("events")
    if hit and not force and (now - hit[0]) < settings.event_ttl:
        return hit[1][:limit]

    items = news.fetch_flash(limit=max(limit, 40), include_slow=True)["items"]
    seen = _seen_ids()
    fresh = [it for it in items if it["id"] not in seen][: settings.event_batch]
    if fresh:
        new_events: list[dict] = []
        try:
            if settings.llm_available():
                new_events = _extract_llm(fresh)
            else:
                names = _watch_hold_names()
                new_events = [ev for it in fresh if (ev := _extract_rule(it, names))]
        except Exception as exc:
            logger.warning("事件 LLM 抽取失败，规则降级: %s", exc)
            names = _watch_hold_names()
            new_events = [ev for it in fresh if (ev := _extract_rule(it, names))]
        # 无论抽取结果多寡都推进游标，避免反复打 LLM
        _save_seen([it["id"] for it in fresh])
        if new_events:
            JsonStore().mutate(
                "events",
                "latest",
                lambda current: _dedup(
                    new_events + list(current or []), "item_id"
                )[:60],
                [],
            )

    events = _dedup(list(JsonStore().get("events", "latest") or []), "item_id")
    directed = directed_events()
    if directed:
        events = _dedup(directed + events, "item_id")  # 定向版本优先（_dedup 保首次出现）
    # 定向事件（ev-stock-*）恒排最前，组内按 time 倒序——否则其东财新闻日期偏旧，
    # 会被 [:limit] 截断导致个性化面板定向卡片消失；LLM 事件在其后仍按新→旧。
    events.sort(key=lambda e: (str(e.get("id", "")).startswith("ev-stock"), e.get("time", "")), reverse=True)
    _EVENT_CACHE["events"] = (now, events)
    return events[:limit]


# ---- 命中 / 预警 --------------------------------------------------------------


def _holdings_codes() -> list[str]:
    """trading-core 持仓 ticker 列表（TTL 60s 缓存，失败返回空 → 预警降级为仅自选）。"""
    now = time.time()
    hit = _HOLDINGS_CACHE.get("codes")
    if hit and (now - hit[0]) < 60.0:
        return hit[1]
    codes: list[str] = []
    try:
        r = requests.get(settings.trading_core_url.rstrip("/") + "/holdings", timeout=4, proxies={})
        r.raise_for_status()
        codes = [str(h.get("ticker") or "") for h in (r.json() or {}).get("items") or [] if h.get("ticker")]
    except Exception as exc:
        logger.warning("拉取持仓失败（预警降级为仅自选）: %s", exc)
    _HOLDINGS_CACHE["codes"] = (now, codes)
    return codes


def _watch_codes() -> list[str]:
    return [w["code"] for w in (JsonStore().get("watchlist", "default") or [])]


def _watch_hold_names() -> dict[str, str]:
    """自选+持仓的 name→code 映射（TTL 30s），供规则降级检测文本里提到哪只关注股。
    持仓只有 ticker 没名字，用行情缓存补名称；查不到时兜底用 code 当 name。"""
    now = time.time()
    hit = _WATCH_NAMES_CACHE.get("names")
    if hit and (now - hit[0]) < 30.0:
        return hit[1]
    m: dict[str, str] = {}
    _add = lambda nm, cd: m.__setitem__(str(nm), cd)
    for w in (JsonStore().get("watchlist", "default") or []):
        if w.get("name") and w.get("code"):
            _add(w["name"], w["code"])
    for c in _holdings_codes():
        q = quotes.cache().get_quote(c) or {}
        nm = str(q.get("name") or "").strip()
        if nm:
            _add(nm, c)
        else:
            _add(c, c)
    # 新上市股票名带 N/C 前缀（如 N宇树），新闻通常只写"宇树"；补无前缀别名提高命中
    for nm in list(m):
        base = re.sub(r"^[NC]", "", nm)
        if base and base != nm:
            _add(base, m[nm])
    _WATCH_NAMES_CACHE["names"] = (now, m)
    return m


# ---- 定向个股新闻（按持仓+自选逐只拉东财搜索，直接标注已知 code，不走 LLM）-------


def _directed_code_names(watchlist: list[dict], hold_codes: list[str]) -> dict[str, str]:
    """code → 展示名：自选用自选名，持仓用行情名兜底，再兜底 code。"""
    m: dict[str, str] = {}
    for w in watchlist:
        if w.get("code"):
            m[str(w["code"])] = str(w.get("name") or "").strip() or str(w["code"])
    for c in hold_codes:
        if c and c not in m:
            q = quotes.cache().get_quote(c) or {}
            m[c] = str(q.get("name") or "").strip() or c
    return m


def _fetch_directed_for(code: str, name: str, top: int) -> list[dict]:
    """单只标的：先按 code，空结果（如 ETF）再按名称兜底。"""
    items = news.fetch_directed_news(code, top)
    if not items and name and name != code:
        items = news.fetch_directed_news(name, top)
    return items


def directed_events() -> list[dict]:
    """按持仓+自选每只标的定向拉个股新闻 → 直接标注已知 code 的事件（不走 LLM）。
    单只失败跳过；整体 deadline 内返回部分结果。"""
    if not settings.directed_news_enabled:
        return []
    watchlist = JsonStore().get("watchlist", "default") or []
    watch_codes = [str(w["code"]) for w in watchlist if w.get("code")]
    hold_codes = [c for c in _holdings_codes() if c]
    codes = list(dict.fromkeys(watch_codes + hold_codes))  # 去重保序
    if not codes:
        return []
    code_names = _directed_code_names(watchlist, hold_codes)
    per = max(1, settings.directed_news_per_stock)
    futures = {
        news._DIRECTED_NEWS_EXECUTOR.submit(
            _fetch_directed_for, c, code_names.get(c, c), per
        ): c
        for c in codes
    }
    done, _ = wait(futures, timeout=settings.directed_news_deadline)
    events: list[dict] = []
    for fut in done:
        code = futures[fut]
        try:
            items = fut.result() or []
        except Exception as exc:
            logger.warning("定向新闻任务 %s 异常: %s", code, exc)
            continue
        name = code_names.get(code, code)
        for it in items:
            txt = f"{it.get('title') or ''} {it.get('content') or ''}"
            events.append({
                "id": f"ev-stock-{code}-"
                      f"{hashlib.md5((it.get('url') or it.get('title') or '').encode()).hexdigest()[:8]}",
                "item_id": it.get("id") or "",
                "type": _classify_directed(txt),
                "tickers": [{"name": name, "code": code}],
                "industries": [],
                "direction": _directed_direction(txt),
                "summary": (it.get("title") or it.get("content") or "")[:120],
                "title": it.get("title") or "",
                "time": it.get("time") or "",
                "source": it.get("source") or "东财",
                "url": it.get("url") or "",
            })
    return events


def _event_match_flags(ev: dict | None, watch: set[str], hold: set[str]) -> set[str]:
    flags: set[str] = set()
    if not ev:
        return flags
    for t in ev.get("tickers") or []:
        c = t.get("code") or ""
        if c and c in watch:
            flags.add("watch")
        if c and c in hold:
            flags.add("hold")
    return flags


def event_alerts() -> dict:
    """事件命中自选/持仓 → 预警列表（时间倒序，保留 50 条）。"""
    watch = _watch_codes()
    hold = _holdings_codes()
    wset, hset = set(watch), set(hold)
    alerts = []
    for ev in extract_events(limit=60):
        flags = _event_match_flags(ev, wset, hset)
        if not flags:
            continue
        hit = "both" if len(flags) == 2 else next(iter(flags))
        code = next((t.get("code") for t in (ev.get("tickers") or []) if t.get("code")), "")
        name = next((t.get("name") for t in (ev.get("tickers") or []) if t.get("name")), "") or ev.get("title") or ""
        alerts.append({
            "id": ev["id"], "code": code, "name": name,
            "event_type": ev.get("type"), "direction": ev.get("direction"),
            "summary": ev.get("summary"), "time": ev.get("time"),
            "source": ev.get("source"), "url": ev.get("url"), "hit": hit,
        })
    alerts.sort(key=lambda a: a["time"], reverse=True)
    alerts = alerts[:50]
    JsonStore().set("event_alerts", "latest", alerts)
    return {
        "as_of": _now(), "items": alerts,
        "watch": sorted(watch), "hold": sorted(hold),
    }


# ---- 个性化 ----------------------------------------------------------------


def enriched_flash(limit: int = 30, personal: bool = False) -> dict:
    """fetch_flash 快讯 → 每项附加 event/matched（命中自选/持仓标 "hit"）。
    personal=True 命中置顶；否则保持时间倒序。"""
    flash = news.fetch_flash(limit=limit, include_slow=True)
    events = extract_events(limit=max(limit * 2, 40))
    by_item = {e["item_id"]: e for e in events if e.get("item_id")}
    watch = set(_watch_codes())
    hold = set(_holdings_codes())

    def annotate(it: dict) -> dict:
        item = dict(it)
        ev = by_item.get(it["id"])
        if ev:
            item["event"] = ev
            item["matched"] = "hit" if _event_match_flags(ev, watch, hold) else ""
        else:
            item["matched"] = ""
        return item

    items = [annotate(it) for it in flash["items"]]
    if personal:
        items.sort(key=lambda x: (0 if x.get("matched") else 1, x.get("time") or ""), reverse=True)
    return {**flash, "items": items}
