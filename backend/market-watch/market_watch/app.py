# -*- coding: utf-8 -*-
"""盯盘 Agent 适配器：同步 FastAPI，端口 8100。

所有盯盘操作均为秒级（实时快照 TTL 缓存复用），无需 SSE/TaskManager。
端点在 adapter/README 与 dsh-plugin 的 11 个工具一一对应。
"""

import logging
import time
import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import briefs, news, quotes, rules, scanner, scheduler
from .config import settings
from .indicators import compute_indicators, summarize
from .schemas import (
    AlertRule, BriefRequest, ScanRequest, TechSignalRequest,
    WatchAddRequest, WatchRemoveRequest,
)
from .store import JsonStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("market_watch.app")

app = FastAPI(title="Market Watch Adapter", version="0.1.0")
store = JsonStore()


def _list(key: str, default: list | None = None) -> list:
    return store.get(key, "default", [] if default is None else default)


def _save_list(key: str, items: list) -> None:
    store.set(key, "default", items)


# ---- 自选 ---------------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "service": "market-watch", "port": 8100, "ts": int(time.time())}


@app.post("/watchlist/add")
def watchlist_add(req: WatchAddRequest):
    try:
        code = quotes.normalize_code(req.code)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    items = _list("watchlist")
    for w in items:
        if w["code"] == code:
            return {"ok": True, "duplicate": True, "code": code, "name": w.get("name")}
    q = quotes.cache().get_quote(code)
    name = req.name or (q or {}).get("name") or code
    items.append({"code": code, "name": name, "added_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    _save_list("watchlist", items)
    return {"ok": True, "duplicate": False, "code": code, "name": name}


@app.post("/watchlist/remove")
def watchlist_remove(req: WatchRemoveRequest):
    items = _list("watchlist")
    kept = [w for w in items if w["code"] != req.code]
    if len(kept) == len(items):
        return {"ok": True, "removed": False, "code": req.code}
    _save_list("watchlist", kept)
    return {"ok": True, "removed": True, "code": req.code}


@app.get("/watchlist")
def watchlist_get():
    items = _list("watchlist")
    return {"items": items, "count": len(items)}


# ---- 盯盘规则 ------------------------------------------------------------


@app.get("/alerts")
def alerts_get():
    items = _list("alerts")
    return {"items": items, "count": len(items)}


@app.post("/alerts")
def alerts_add(rule: AlertRule):
    if rule.time_frame not in ("trading", "anytime"):
        raise HTTPException(422, "time_frame 必须为 trading 或 anytime")
    if rule.combine not in ("and", "or"):
        raise HTTPException(422, "combine 必须为 and 或 or")
    for c in rule.conditions:
        if c.field not in ("price", "pct_change", "volume_ratio", "amount", "turnover"):
            raise HTTPException(422, f"非法条件字段: {c.field}")
        if c.operator not in (">", ">=", "<", "<="):
            raise HTTPException(422, f"非法操作符: {c.operator}")
    if rule.ticker:
        try:
            rule.ticker = quotes.normalize_code(rule.ticker)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
    rule_dict = rule.model_dump()
    rule_dict["id"] = uuid.uuid4().hex[:12]
    rule_dict["created_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    items = _list("alerts")
    items.append(rule_dict)
    _save_list("alerts", items)
    return {"ok": True, "id": rule_dict["id"], "rule": rule_dict}


@app.delete("/alerts/{rule_id}")
def alerts_remove(rule_id: str):
    items = _list("alerts")
    kept = [r for r in items if r.get("id") != rule_id]
    if len(kept) == len(items):
        return {"ok": True, "removed": False, "id": rule_id}
    _save_list("alerts", kept)
    return {"ok": True, "removed": True, "id": rule_id}


# ---- 盯盘面板 / 扫描 / 技术信号 ---------------------------------------------


@app.get("/overview")
def overview():
    items = _list("watchlist")
    rows = quotes.cache().get_quotes([w["code"] for w in items])
    alerts = [a for a in _list("alerts") if a.get("enabled", True)]
    out = []
    for q in rows:
        hit, near = rules.matching_alerts(alerts, q)
        row = {
            "code": q["code"], "name": q["name"], "price": q.get("price"),
            "pct_change": q.get("pct_change"), "volume_ratio": q.get("volume_ratio"),
            "turnover": q.get("turnover"), "amount_yi": q.get("amount_yi"),
            "fund_flow_yi": quotes.get_fund_flow(q["code"]) if settings.fund_flow_enabled else None,
            "hit": hit, "near": near,
        }
        out.append(row)
    return {
        "as_of": time.strftime("%Y-%m-%d %H:%M:%S"),
        "trade_date": quotes.latest_trade_date(),
        "items": out,
    }


@app.post("/scan")
def scan(req: ScanRequest):
    try:
        return scanner.scan(kind=req.kind, top_n=req.top_n, min_amount_yi=req.min_amount_yi)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@app.post("/tech-signal")
def tech_signal(req: TechSignalRequest):
    try:
        code = quotes.normalize_code(req.code)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    df = quotes.get_kline(code, lookback=req.lookback)
    if df is None or df.empty:
        raise HTTPException(404, f"{code} 无 K 线数据")
    ind = compute_indicators(df)
    q = quotes.cache().get_quote(code)
    return {
        "code": code, "name": (q or {}).get("name") or "",
        "as_of": time.strftime("%Y-%m-%d %H:%M:%S"),
        "bars": len(df), "last": df.iloc[-1].to_dict(),
        "indicators": ind, "signals": summarize(ind),
    }


# ---- 新闻 / 简报 -----------------------------------------------------------


@app.post("/news/express")
def news_express():
    return news.express()


@app.get("/news/latest")
def news_latest():
    record = news.latest()
    if record is None:
        raise HTTPException(404, "暂无新闻速递，先调 POST /news/express")
    return record


@app.post("/brief/generate")
def brief_generate(req: BriefRequest):
    try:
        return briefs.generate(req.period, manual=req.manual)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@app.get("/brief/latest")
def brief_latest(period: str = "pre"):
    record = briefs.latest(period)
    if record is None:
        raise HTTPException(404, f"暂无 {period} 简报，先调 POST /brief/generate")
    return record


# ---- 调度器 -------------------------------------------------------------


@app.get("/scheduler/status")
def scheduler_status():
    return scheduler.status()


@app.post("/scheduler/tick")
def scheduler_tick():
    return scheduler.run_watch_cycle(manual=True)


@app.on_event("startup")
def _startup():
    scheduler.start_scheduler()


@app.on_event("shutdown")
def _shutdown():
    scheduler.stop_scheduler()
