# -*- coding: utf-8 -*-
"""新闻速递：财联社要闻 + 自选股新闻，LLM 摘要。

数据源：
  stock_info_global_cls(symbol="全部")  财联社资讯（trading-core 已验证）
  stock_news_em(symbol=code)            东财个股新闻（列名实现时防御性读取）
LLM 不可用时降级为纯标题列表，保证速递始终可用。
"""

import json
import logging
from datetime import datetime
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
    import akshare as ak

    items = []
    try:
        df = ak.stock_info_global_cls(symbol="全部")
        for r in df.to_dict("records"):
            title = str(r.get("标题") or "").strip() or str(r.get("内容") or "").strip()
            if not title:
                continue
            items.append({
                "title": title,
                "source": "财联社",
                "time": f"{r.get('发布日期')} {r.get('发布时间')}".strip(),
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
