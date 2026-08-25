# -*- coding: utf-8 -*-
"""新闻速递：财联社要闻 + 自选股新闻，LLM 摘要。

数据源：
  stock_info_global_cls(symbol="全部")  财联社资讯（trading-core 已验证）
  stock_news_em(symbol=code)            东财个股新闻（列名实现时防御性读取）
LLM 不可用时降级为纯标题列表，保证速递始终可用。
"""

import hashlib
import html
import json
import logging
import os
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout, wait
from urllib.parse import urlencode

import requests
from datetime import datetime
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

from . import llm, quotes
from .config import settings
from .store import JsonStore

logger = logging.getLogger("market_watch.news")


def _pick(df, *names):
    """按候选列名取第一列；找不到返回 None。"""
    for n in names:
        if n in df.columns:
            return df[n]
    return None


def fetch_global_news(top: int = 8) -> list[dict]:
    """财联社要闻，返回 [{title, source, time}]。失败返回空。"""
    items = []
    try:
        for row in _cls_flash(top):
            title = str(row.get("title") or "").strip() or str(row.get("content") or "").strip()
            if not title:
                continue
            items.append({
                "title": title,
                "source": "财联社",
                "time": str(row.get("time") or ""),
            })
    except Exception as exc:
        logger.warning("财联社要闻拉取失败: %s", exc)
    return items[:top]


def fetch_stock_news(code: str, top: int = 3) -> list[dict]:
    """东财个股新闻。失败返回空。"""
    import akshare as ak

    items = []
    try:
        df = ak.stock_news_em(symbol=code)
        title_col = _pick(df, "新闻标题", "标题", "新闻")
        time_col = _pick(df, "发布时间", "时间", "日期")
        if title_col is None:
            return items
        for i in range(min(top, len(df))):
            title = str(title_col.iloc[i] or "").strip()
            if not title:
                continue
            items.append({
                "title": title,
                "source": "东财",
                "time": str(time_col.iloc[i]) if time_col is not None else "",
            })
    except Exception as exc:
        logger.warning("个股新闻 %s 拉取失败: %s", code, exc)
    return items


def _digest_llm(global_items: list[dict], stock_map: dict[str, list[dict]]) -> str:
    system = (
        "你是A股新闻速递播报助手。根据提供的结构化新闻，输出简洁的中文Markdown摘要。"
        "结构：## 市场要闻总览（1段话）→ ## 自选股相关（逐只列出，每条一行）。"
        "只陈述新闻呈现的事实，不臆测、不荐股、不编造标题。"
    )
    block = {
        "财联社要闻": [n["title"] for n in global_items],
        "自选股新闻": {k: [n["title"] for n in v] for k, v in stock_map.items()},
    }
    return llm.chat(system, json.dumps(block, ensure_ascii=False, indent=1), max_tokens=1500)


def _digest_fallback(global_items: list[dict], stock_map: dict[str, list[dict]]) -> str:
    lines = ["## 市场要闻", ""]
    for n in global_items:
        lines.append(f"- {n['title']}")
    lines.append("")
    if stock_map:
        lines.append("## 自选股相关", "")
        for code, items in stock_map.items():
            if not items:
                continue
            lines.append(f"**{code}**")
            for n in items:
                lines.append(f"- {n['title']}")
            lines.append("")
    return "\n".join(lines)


def express() -> dict:
    """跑一轮新闻速递：拉取 → 摘要 → 落 store → （推送由调度侧负责）。"""
    store = JsonStore()
    watchlist = store.get("watchlist", "default", []) or []
    codes = [w["code"] for w in watchlist]

    global_items = fetch_global_news(top=settings.news_top)
    stock_map: dict[str, list[dict]] = {}
    for code in codes:
        items = fetch_stock_news(code, top=settings.stock_news_top)
        if items:
            stock_map[code] = items

    digest = None
    if settings.llm_available():
        try:
            digest = _digest_llm(global_items, stock_map)
        except Exception as exc:
            logger.warning("新闻 LLM 摘要失败，降级模板: %s", exc)
    if not digest:
        digest = _digest_fallback(global_items, stock_map)

    now = datetime.now(ZoneInfo(settings.timezone))
    record = {
        "id": now.strftime("%Y%m%d%H%M%S"),
        "generated_at": now.isoformat(timespec="seconds"),
        "trade_date": quotes.latest_trade_date(),
        "digest": digest,
        "global_count": len(global_items),
        "stock_count": sum(len(v) for v in stock_map.values()),
        "items": {
            "global": [n["title"] for n in global_items],
            "stocks": {k: [n["title"] for n in v] for k, v in stock_map.items()},
        },
    }
    store.set("news", record["id"], record)
    store.set("news", "latest", record["id"])
    return record


def latest() -> dict | None:
    store = JsonStore()
    key = store.get("news", "latest")
    if not key:
        return None
    return store.get("news", key)


# ---- 实时快讯（源目录 + 并发聚合，借鉴 open-news-mcp 的 feeds.py 源目录思路）-------

_FLASH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.sina.com.cn/7x24/",
}
_FLASH_CACHE: dict[str, tuple[float, dict]] = {}


@dataclass
class _FlashFlight:
    response: Future
    done: Future | None = None


_FLASH_FLIGHTS: dict[str, _FlashFlight] = {}
_FLASH_LOCK = threading.RLock()
_FLASH_REFRESH_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="flash-refresh")
_FLASH_SOURCE_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(1, settings.flash_source_workers), thread_name_prefix="flash-source"
)
_FLASH_CLOCK = time.monotonic

# Google News 源需访问境外，走本机代理（clash）；其余国内源显式 proxies={} 直连
_FLASH_PROXY = os.getenv("MW_FLASH_PROXY", "http://127.0.0.1:7892")
# 追加国内财经域到 NO_PROXY：akshare（财联社）内部走系统代理时对这些域直连
os.environ["NO_PROXY"] = (
    os.environ.get("NO_PROXY", "")
    + ",cls.cn,sina.com.cn,ithome.com,wallstreetcn.com,36kr.com,huxiu.com"
).strip(",")


def _strip_html(src: str) -> str:
    """快讯 HTML → 纯文本（保留段落换行）。"""
    import re

    s = html.unescape(src or "")
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.IGNORECASE)
    s = re.sub(r"</p>", "\n", s, flags=re.IGNORECASE)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"[ \t]+", " ", s).strip()


def _flash_title(content: str) -> str:
    """正文首段以【标题】开头时提取标题，否则截前 36 字作列表预览。"""
    if content.startswith("【"):
        return content.split("】", 1)[0].lstrip("【").strip()
    return content[:36]


def _t8(dt: datetime) -> str:
    """任意 datetime → 东八区 'YYYY-MM-DD HH:MM:SS'（跨源统一时间轴）。"""
    tz = ZoneInfo(settings.timezone)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")


def _rss_time(pub: str) -> str:
    """RSS pubDate（如 'Mon, 24 Aug 2026 02:47:42 GMT'）→ 东八区字符串。失败返回空。"""
    try:
        return _t8(parsedate_to_datetime(pub))
    except Exception:
        return ""


def _sina_flash(limit: int) -> list[dict]:
    """新浪财经 7x24（秒级实时，全文 + 原文链接）。"""
    r = requests.get("https://zhibo.sina.com.cn/api/zhibo/feed", params={
        "page": "1", "page_size": str(max(limit, 20)),
        "zhibo_id": "152", "tag_id": "0", "dire": "f", "dpc": "1",
    }, timeout=settings.flash_source_timeout, proxies={}, headers=_FLASH_HEADERS)
    r.raise_for_status()
    lst = (r.json() or {}).get("result", {}).get("data", {}).get("feed", {}).get("list") or []
    out = []
    for d in lst:
        content = _strip_html(str(d.get("rich_text") or ""))
        if not content:
            continue
        out.append({
            "id": "sina-" + str(d.get("id") or ""),
            "time": str(d.get("create_time") or ""),
            "tag": "新浪财经",
            "title": _flash_title(content),
            "content": content,
            "source": "新浪财经",
            "url": str(d.get("docurl") or ""),
        })
    return out


def _cls_flash(limit: int) -> list[dict]:
    """财联社电报直连（真实 requests timeout，避免 akshare 的无界重试）。"""
    url = "https://www.cls.cn/v1/roll/get_roll_list"
    params = {
        "app": "CailianpressWeb",
        "category": "",
        "last_time": int(time.time()),
        "os": "web",
        "refresh_type": "1",
        "rn": str(max(20, limit)),
        "sv": "8.4.6",
    }
    params["sign"] = hashlib.md5(
        hashlib.sha1(urlencode(params).encode("utf-8")).hexdigest().encode("utf-8")
    ).hexdigest()
    response = requests.get(
        url,
        params=params,
        timeout=settings.flash_source_timeout,
        proxies={},
        headers={**_FLASH_HEADERS, "Referer": "https://www.cls.cn/telegraph"},
    )
    response.raise_for_status()
    rows = ((response.json() or {}).get("data") or {}).get("roll_data") or []
    out = []
    for row in rows:
        content = _strip_html(str(row.get("content") or "")).strip()
        title = str(row.get("title") or "").strip()
        if not content and not title:
            continue
        if not title:
            title = _flash_title(content)
        try:
            published = _t8(datetime.fromtimestamp(int(row.get("ctime")), tz=ZoneInfo(settings.timezone)))
        except (TypeError, ValueError, OSError):
            published = ""
        out.append({
            "id": "cls-" + str(row.get("id") or hashlib.md5((content or title).encode()).hexdigest()[:10]),
            "time": published,
            "tag": "财联社",
            "title": title,
            "content": content,
            "source": "财联社",
            "url": "",
        })
        if len(out) >= limit:
            break
    return out


def _wallstreetcn_flash(limit: int) -> list[dict]:
    """华尔街见闻 7×24 实时快讯（全文 content_text + 原文链接 uri）。"""
    r = requests.get("https://api-one.wallstcn.com/apiv1/content/lives", params={
        "channel": "global-channel", "limit": str(limit),
    }, timeout=settings.flash_source_timeout, proxies={}, headers=_FLASH_HEADERS)
    r.raise_for_status()
    items = (r.json() or {}).get("data", {}).get("items") or []
    out = []
    for d in items:
        content = str(d.get("content_text") or _strip_html(str(d.get("content") or ""))).strip()
        if not content:
            continue
        ts = d.get("display_time")
        try:
            time_s = _t8(datetime.fromtimestamp(int(ts), tz=ZoneInfo(settings.timezone))) if ts else ""
        except Exception:
            time_s = ""
        out.append({
            "id": "ws-" + str(d.get("id") or ""),
            "time": time_s,
            "tag": "华尔街见闻",
            "title": str(d.get("title") or "").strip() or _flash_title(content),
            "content": content,
            "source": "华尔街见闻",
            "url": str(d.get("uri") or ""),
        })
    return out


def _rss_flash(url: str, name: str, limit: int) -> list[dict]:
    """通用 RSS 源（IT之家）：标题 + 摘要 + 原文链接。"""
    r = requests.get(url, timeout=settings.flash_source_timeout, proxies={}, headers=_FLASH_HEADERS)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []

    def g(it, tag):
        e = it.find(tag)
        return (e.text or "").strip() if e is not None and e.text else ""

    for it in (root.findall(".//item") or []):
        title, link, pub, desc = g(it, "title"), g(it, "link"), g(it, "pubDate"), g(it, "description")
        if not title:
            continue
        content = _strip_html(desc)
        out.append({
            "id": name + "-" + hashlib.md5((link or title).encode()).hexdigest()[:10],
            "time": _rss_time(pub),
            "tag": name,
            "title": title,
            "content": content or title,
            "source": name,
            "url": link,
        })
        if len(out) >= limit:
            break
    return out


def _google_news_flash(site: str, name: str, limit: int) -> list[dict]:
    """Google News RSS 按站聚合（36氪 / 虎嗅 无官方 RSS 的替代）：
    仅标题 + 原文链接（Google 中转页，需能访问 Google）。走本机代理。"""
    r = requests.get("https://news.google.com/rss/search", params={
        "q": f"site:{site}+when:1d", "hl": "zh-CN", "gl": "CN", "ceid": "CN:zh",
    }, timeout=settings.flash_source_timeout, proxies={"http": _FLASH_PROXY, "https": _FLASH_PROXY}, headers=_FLASH_HEADERS)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []

    def g(it, tag):
        e = it.find(tag)
        return (e.text or "").strip() if e is not None and e.text else ""

    for it in (root.findall(".//item") or []):
        raw, link, pub = g(it, "title"), g(it, "link"), g(it, "pubDate")
        if not raw:
            continue
        # Google News 标题常带「 - 平台名」后缀，去掉
        title = raw.rsplit(" - ", 1)[0].strip() if " - " in raw else raw
        out.append({
            "id": name + "-" + hashlib.md5(link.encode()).hexdigest()[:10],
            "time": _rss_time(pub),
            "tag": name,
            "title": title,
            "content": title,
            "source": name,
            "url": link,
        })
        if len(out) >= limit:
            break
    return out


# 快讯源目录：并发拉取，失败源自动降级；新平台在此加一项即可
_FLASH_SOURCES = [
    {"name": "新浪财经", "fetch": lambda n: _sina_flash(n)},
    {"name": "财联社", "fetch": lambda n: _cls_flash(n)},
    {"name": "华尔街见闻", "fetch": lambda n: _wallstreetcn_flash(n)},
    {"name": "IT之家", "fetch": lambda n: _rss_flash("https://www.ithome.com/rss/", "IT之家", n)},
    {"name": "36氪", "fetch": lambda n: _google_news_flash("36kr.com", "36氪", n)},
    {"name": "虎嗅", "fetch": lambda n: _google_news_flash("huxiu.com", "虎嗅", n)},
]

_BASE_FLASH_SOURCE_NAMES = frozenset(("新浪财经", "财联社"))


def _norm_key(s: str) -> str:
    """标题归一化 key：去【】/标点/空白，取前 24 字，用于跨源去重同一事件。"""
    import re

    return re.sub(r"[\s【】\.,，。!！?？:：;；\"'“”‘’()（）]", "", s or "")[:24]


def _flash_result(
    futures: dict[Future, str],
    selected: set[Future],
    limit: int,
    tier: str,
    logged_failures: set[Future],
) -> dict:
    """合并指定的已完成来源；调用方决定这是 deadline 快照还是最终结果。"""
    merged: list[dict] = []
    seen: set[str] = set()
    used: list[str] = []
    failed = False
    for future in selected:
        name = futures[future]
        try:
            rows = future.result()
        except Exception as exc:
            if future not in logged_failures:
                logger.warning("快讯源 %s 拉取失败: %s", name, exc)
                logged_failures.add(future)
            failed = True
            continue
        if rows:
            used.append(name)
        for item in rows:
            key = _norm_key(item["title"]) or item["id"]
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    merged.sort(key=lambda item: item["time"], reverse=True)
    return {
        "as_of": datetime.now(ZoneInfo(settings.timezone)).strftime("%Y-%m-%d %H:%M:%S"),
        "sources": sorted(set(used)),
        "items": merged[:limit],
        "tier": tier,
        "complete": len(selected) == len(futures) and not failed,
    }


def _run_flash_refresh(
    sources: list[dict], limit: int, deadline: float, tier: str, response: Future
) -> dict:
    """先发布 deadline 快照，再等待有界 provider 完成以维持真实 single-flight。"""
    per_source = max(4, limit // max(1, len(sources)))
    futures = {
        _FLASH_SOURCE_EXECUTOR.submit(source["fetch"], per_source): source["name"]
        for source in sources
    }
    logged_failures: set[Future] = set()
    try:
        done, pending = wait(futures, timeout=max(0.0, deadline))
        first = _flash_result(futures, done, limit, tier, logged_failures)
        if not response.done():
            response.set_result(first)
        if pending:
            wait(pending)
        return _flash_result(futures, set(futures), limit, tier, logged_failures)
    except BaseException as exc:
        if not response.done():
            response.set_exception(exc)
        raise


def _finish_flash_refresh(key: str, flight: _FlashFlight, future: Future) -> None:
    try:
        result = future.result()
    except Exception as exc:
        logger.warning("快讯刷新失败: %s", exc)
        result = None
    with _FLASH_LOCK:
        now = _FLASH_CLOCK()
        cached = _FLASH_CACHE.get(key)
        cached_usable = bool(
            cached is not None and (now - cached[0]) <= settings.flash_stale_ttl
        )
        # incomplete refresh 只作为本次降级响应；不能覆盖仍可用的更完整旧值。
        # 若旧值已超出 stale 窗口，则保存当前降级结果，避免每次请求都立即重启 refresh。
        if result and result.get("items") and (result.get("complete") or not cached_usable):
            _FLASH_CACHE[key] = (now, result)
        if _FLASH_FLIGHTS.get(key) is flight:
            _FLASH_FLIGHTS.pop(key, None)


def _start_flash_refresh(key: str, sources: list[dict], limit: int, deadline: float, tier: str) -> _FlashFlight:
    flight = _FLASH_FLIGHTS.get(key)
    if flight is None:
        flight = _FlashFlight(response=Future())
        done = _FLASH_REFRESH_EXECUTOR.submit(
            _run_flash_refresh, sources, limit, deadline, tier, flight.response
        )
        flight.done = done
        _FLASH_FLIGHTS[key] = flight
        done.add_done_callback(lambda future: _finish_flash_refresh(key, flight, future))
    return flight


def _response(data: dict, *, stale: bool, limit: int) -> dict:
    return {**data, "items": list(data.get("items") or [])[:limit], "stale": stale}


def fetch_flash(limit: int = 30, *, include_slow: bool = False) -> dict:
    """按档位聚合快讯，支持短总体 deadline、TTL/stale cache 与 single-flight。

    默认基础档只访问新浪财经和财联社，并以首屏 deadline 返回已完成来源。
    include_slow=True 是结构化事件/个性化富化的显式完整档，会访问全部来源。
    """
    limit = max(5, min(limit, 100))
    tier = "full" if include_slow else "base"
    sources = list(_FLASH_SOURCES) if include_slow else [
        source for source in _FLASH_SOURCES if source["name"] in _BASE_FLASH_SOURCE_NAMES
    ]
    deadline = settings.flash_full_deadline if include_slow else settings.flash_first_paint_deadline
    key = tier
    refresh_limit = max(limit, 40)
    now = _FLASH_CLOCK()
    with _FLASH_LOCK:
        cached = _FLASH_CACHE.get(key)
        age = (now - cached[0]) if cached else None
        if cached and age is not None and age <= settings.flash_cache_ttl:
            return _response(cached[1], stale=False, limit=limit)
        flight = _start_flash_refresh(key, sources, refresh_limit, deadline, tier)
        if cached and age is not None and age <= settings.flash_stale_ttl:
            return _response(cached[1], stale=True, limit=limit)

    try:
        result = flight.response.result(timeout=max(0.0, deadline) + 0.25)
    except FutureTimeout:
        result = None
    except Exception as exc:
        logger.warning("快讯冷请求失败: %s", exc)
        result = None
    if result is not None:
        return _response(result, stale=False, limit=limit)
    with _FLASH_LOCK:
        cached = _FLASH_CACHE.get(key)
        if cached and (_FLASH_CLOCK() - cached[0]) <= settings.flash_stale_ttl:
            return _response(cached[1], stale=True, limit=limit)
    return {
        "as_of": datetime.now(ZoneInfo(settings.timezone)).strftime("%Y-%m-%d %H:%M:%S"),
        "sources": [], "items": [], "tier": tier, "complete": False, "stale": False,
    }


def shutdown_background_workers() -> None:
    """应用退出时停止接收 refresh，并等待真实 provider 线程收敛。"""
    _FLASH_REFRESH_EXECUTOR.shutdown(wait=True, cancel_futures=True)
    _FLASH_SOURCE_EXECUTOR.shutdown(wait=True, cancel_futures=True)
