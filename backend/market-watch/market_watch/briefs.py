# -*- coding: utf-8 -*-
"""盘前/盘后 LLM 简报：自建轻量版（模块内数据，不依赖 trading-core）。

盘前 pre  ：指数状态 + 自选隔夜/实时涨跌 + 要闻摘要 → LLM「今日关注点」
盘后 post ：自选当日表现 + 当日触发记录 + 主力资金流 + 要闻 → LLM「复盘 + 明日关注」
无 LLM 时回退纯数据模板。结果落 data/briefs.json，latest 指针按 period 存储。
"""

import json
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from . import llm, news, quotes
from .config import settings
from .store import JsonStore

logger = logging.getLogger("market_watch.briefs")

MAIN_INDICES = {
    "上证指数": "sh000001",
    "深证成指": "sz399001",
    "创业板指": "sz399006",
    "沪深300": "sh000300",
}


def _indices_spot() -> list[dict]:
    """关键指数实时快照（best-effort，失败空）。"""
    import akshare as ak

    rows = []
    try:
        df = ak.stock_zh_index_spot_sina()
        for code, name, price, pct in df[["代码", "名称", "最新价", "涨跌幅"]].itertuples(index=False):
            if code in MAIN_INDICES.values():
                rows.append({
                    "name": str(name), "code": str(code),
                    "price": float(price), "pct": float(pct),
                })
    except Exception as exc:
        logger.warning("指数快照拉取失败: %s", exc)
    return rows


def _watch_status() -> list[dict]:
    """自选实时行情 + 主力资金流（best-effort）。"""
    store = JsonStore()
    watchlist = store.get("watchlist", "default", []) or []
    out = []
    for w in watchlist:
        q = quotes.cache().get_quote(w["code"])
        if q is None:
            continue
        item = {
            "code": q["code"], "name": q["name"],
            "price": q.get("price"), "pct_change": q.get("pct_change"),
        }
        if settings.fund_flow_enabled:
            item["fund_flow_yi"] = quotes.get_fund_flow(q["code"])
        out.append(item)
    return out


def _today_triggers() -> list[dict]:
    """当日已触发的规则记录（供盘后复盘）。"""
    store = JsonStore()
    state = store.get("state", "triggers", []) or []
    today = datetime.now(ZoneInfo(settings.timezone)).strftime("%Y-%m-%d")
    return [t for t in state if t.get("date") == today]


def _watch_titles(top: int = 8) -> list[str]:
    return [n["title"] for n in news.fetch_global_news(top=top)]


def _llm_brief(period: str, indices: list[dict], watch: list[dict],
               triggers: list[dict], titles: list[str]) -> str:
    if period == "pre":
        system = (
            "你是A股盘前策略助手。基于下面的市场快照，输出一份简洁的《盘前关注》Markdown 简报："
            "## 市场状态（指数一段话）→ ## 自选股观察（逐只一行：名称/现价/涨跌幅/资金流，可补充一句点评）"
            "→ ## 今日关注点（结合要闻给 2-3 条要点）。客观陈述数据，不荐股、不臆造数字。"
        )
    else:
        system = (
            "你是A股盘后复盘助手。基于下面的当日数据，输出一份《盘后复盘》Markdown 简报："
            "## 当日综述（指数+自选表现一段话）→ ## 触发记录（如有）→ ## 自选股明细（逐只：涨跌幅+资金流）"
            "→ ## 明日关注（结合要闻给 2-3 条要点）。客观复盘，不荐股、不臆造数字。"
        )
    block = {
        "period": "盘前" if period == "pre" else "盘后",
        "indices": indices,
        "watchlist": watch,
        "today_triggers": triggers,
        "global_news": titles,
    }
    return llm.chat(system, json.dumps(block, ensure_ascii=False, indent=1, default=str), max_tokens=1800)


def _fallback_brief(period: str, indices: list[dict], watch: list[dict],
                    triggers: list[dict], titles: list[str]) -> str:
    lines = ["# 盘前关注" if period == "pre" else "# 盘后复盘", ""]
    lines.append("## 市场状态")
    for ix in indices:
        lines.append(f"- {ix['name']} {ix['price']}（{ix['pct']:+.2f}%）")
    lines.append("")
    lines.append("## 自选股")
    for w in watch:
        fund = f"，主力净流入 {w.get('fund_flow_yi')}亿" if w.get("fund_flow_yi") is not None else ""
        lines.append(f"- {w['name']}（{w['code']}）{w['price']}（{w['pct_change']:+.2f}%）{fund}")
    lines.append("")
    if triggers:
        lines.append("## 当日触发")
        for t in triggers:
            lines.append(f"- {t.get('rule_name', t.get('id'))} @ {t.get('code')} {t.get('value')}")
        lines.append("")
    if titles:
        lines.append("## 要闻")
        for t in titles:
            lines.append(f"- {t}")
    return "\n".join(lines)


def generate(period: str = "pre", manual: bool = False) -> dict:
    """生成盘前(pre)/盘后(post)简报，返回落盘记录。manual=True 绕过交易日守卫（供测试）。"""
    if period not in ("pre", "post"):
        raise ValueError("period 必须为 pre 或 post")
    if not manual and not quotes.is_trading_day(quotes.latest_trade_date()):
        raise RuntimeError("非交易日，生成简报无意义；manual 可强制（仅测试）")

    indices = _indices_spot()
    watch = _watch_status()
    triggers = _today_triggers()
    titles = _watch_titles(top=settings.news_top)

    text = None
    if settings.llm_available():
        try:
            text = _llm_brief(period, indices, watch, triggers, titles)
        except Exception as exc:
            logger.warning("简报 LLM 生成失败，降级模板: %s", exc)
    if not text:
        text = _fallback_brief(period, indices, watch, triggers, titles)

    store = JsonStore()
    now = datetime.now(ZoneInfo(settings.timezone))
    record = {
        "id": f"{period}-{now.strftime('%Y%m%d')}-{now.strftime('%H%M%S')}",
        "period": period,
        "generated_at": now.isoformat(timespec="seconds"),
        "trade_date": quotes.latest_trade_date(),
        "content": text,
        "llm_used": text is not None and settings.llm_available(),
    }
    store.set("briefs", record["id"], record)
    store.set("briefs", f"latest-{period}", record["id"])
    return record


def latest(period: str) -> dict | None:
    store = JsonStore()
    key = store.get("briefs", f"latest-{period}")
    if not key:
        return None
    return store.get("briefs", key)
