# -*- coding: utf-8 -*-
"""C 事件影响图谱：事件直连标的 → 产业链上下游 / 同行业间接波及标的。

trading-core 无独立图数据，复用 industry-chain(:8200) 只读接口：
  - GET /graph/chain/{code}?depth_up=1&depth_down=1   → 上游供应商/下游客户（各 1 跳）
  - GET /companies?keyword={industry}&limit=50       → 同行业公司（行业模糊子串）

每事件 ≤2 次子请求、timeout=1.5、proxies={}；TTL 300s 内存缓存；
:8200 不可达 → 快速失败并记 30s backoff（期间跳过）→ 优雅降级：
chain 挂掉时事件保持原样（不 500、不拖慢、不影响卡片/假设）。

注入点 = strategies.fetch_events（market-watch 返回后、TTL 缓存前），
D(build_cards) 与 E(hypothesize) 自动吃到扩展 codes，无需改路由。
"""

import logging
import time

import requests

from .config import settings
from .strategies import _normalize_symbol

logger = logging.getLogger("adapter.impact")

_IC_DOWN_UNTIL = 0.0  # :8200 熔断截止时间（backoff 期间跳过扩展）
# key=event id → (ts, impact_codes, impact_industries, impact_by)
_IMPACT_CACHE: dict[str, tuple[float, list[str], list[str], list[str]]] = {}

_CACHE_TTL = 300.0
_DOWN_BACKOFF = 30.0
_SUB_TIMEOUT = 1.5
_COMPANY_LIMIT = 50
_CACHE_MAX = 2000


def _ic_down() -> bool:
    return time.time() < _IC_DOWN_UNTIL


def _mark_down() -> None:
    global _IC_DOWN_UNTIL
    _IC_DOWN_UNTIL = time.time() + _DOWN_BACKOFF
    logger.warning("industry-chain :8200 不可达，事件影响图谱降级 %ss", _DOWN_BACKOFF)


def _chain_expand(code: str) -> tuple[list[str], list[str]]:
    """直连标的 → (波及代码, 展示名)，上下游各 1 跳；失败置 backoff 返回空。"""
    try:
        r = requests.get(
            settings.ic_url.rstrip("/") + f"/graph/chain/{code}",
            params={"depth_up": 1, "depth_down": 1},
            timeout=_SUB_TIMEOUT, proxies={},
        )
        r.raise_for_status()
        data = r.json() or {}
    except Exception as exc:  # noqa: BLE001 — :8200 挂掉不拖慢事件流
        logger.debug("产业链扩展失败 %s: %s", code, exc)
        _mark_down()
        return [], []
    if not isinstance(data, dict) or "center" not in data:
        return [], []  # 非核心公司 → {"detail": "未找到..."}
    codes, names = [], []
    for lvl_key in ("up_levels", "down_levels"):
        for lvl in data.get(lvl_key) or []:
            for node in (lvl.get("nodes") or []):
                c = _normalize_symbol(node.get("id") or node.get("code"))
                if not c:
                    continue
                codes.append(c)
                names.append(str(node.get("name") or c))
    return codes, names


def _industry_expand(keyword: str) -> tuple[list[str], list[str]]:
    """行业 → (公司代码, 公司名)；失败置 backoff 返回空。"""
    try:
        r = requests.get(
            settings.ic_url.rstrip("/") + "/companies",
            params={"keyword": keyword, "limit": _COMPANY_LIMIT},
            timeout=_SUB_TIMEOUT, proxies={},
        )
        r.raise_for_status()
        items = (r.json() or {}).get("items") or []
    except Exception as exc:  # noqa: BLE001
        logger.debug("行业扩展失败 %s: %s", keyword, exc)
        _mark_down()
        return [], []
    codes, names = [], []
    for it in items or []:
        c = _normalize_symbol(it.get("code"))
        if not c:
            continue
        codes.append(c)
        names.append(str(it.get("name") or c))
    return codes, names


def _display(pairs: list[tuple[str, str]]) -> str:
    """code/name 对 → 可读串（名字==代码只显示代码）。"""
    return "/".join(f"{n}({c})" if n != c else c for n, c in pairs)


def _expand_one(ev: dict) -> dict:
    """单事件扩展：≤2 次 HTTP（首个直连码产业链 + 首个行业），TTL 缓存。"""
    now = time.time()
    key = str(ev.get("id") or "")
    memo = _IMPACT_CACHE.get(key)
    if memo and (now - memo[0]) < _CACHE_TTL:
        codes, industries, by = memo[1], memo[2], memo[3]
        return {**ev, "impact_codes": codes, "impact_industries": industries, "impact_by": by}
    if _ic_down():
        return {**ev, "impact_codes": [], "impact_industries": [], "impact_by": []}
    if len(_IMPACT_CACHE) >= _CACHE_MAX:
        _IMPACT_CACHE.clear()

    own = {c for t in (ev.get("tickers") or [])
           if (c := _normalize_symbol((t or {}).get("code")))}
    industries: list[str] = [str(x).strip() for x in (ev.get("industries") or []) if str(x or "").strip()][:1]
    codes: list[str] = []
    by: list[str] = []

    direct = next(iter(own), None)
    if direct:
        ch_codes, ch_names = _chain_expand(direct)
        fresh = [c for c in ch_codes if c not in own and c not in codes]
        codes.extend(fresh)
        if fresh:
            pairs = [(n, c) for n, c in zip(ch_names, ch_codes) if c in fresh]
            by.append(f"{direct} 产业链: " + _display(pairs))
    if industries:
        ind = industries[0]
        co_codes, co_names = _industry_expand(ind)
        fresh = [c for c in co_codes if c not in own and c not in codes]
        codes.extend(fresh)
        if fresh:
            pairs = [(n, c) for n, c in zip(co_names, co_codes) if c in fresh]
            by.append(f"行业「{ind}」: " + _display(pairs))

    _IMPACT_CACHE[key] = (now, codes, industries, by)
    return {**ev, "impact_codes": codes, "impact_industries": industries, "impact_by": by}


def expand_events(events: list[dict] | None) -> list[dict]:
    """批量扩展。事件源/chain 不可用 → 返回原样（优雅降级，绝不 500）。"""
    if not events:
        return events or []
    out: list[dict] = []
    for e in events:
        if not isinstance(e, dict):
            out.append(e)
            continue
        try:
            out.append(_expand_one(e))
        except Exception as exc:  # noqa: BLE001 — 单事件扩展失败保持原样
            logger.warning("事件影响图谱扩展失败（保持原样）: %s", exc)
            out.append(e)
    return out


def expand_events_cached(events: list[dict] | None) -> list[dict]:
    """只复用未过期的影响图谱缓存，不在持仓读取链路发起额外 HTTP。"""
    if not events:
        return events or []
    now = time.time()
    out: list[dict] = []
    for event in events:
        if not isinstance(event, dict):
            out.append(event)
            continue
        memo = _IMPACT_CACHE.get(str(event.get("id") or ""))
        if memo is None or (now - memo[0]) >= _CACHE_TTL:
            out.append(event)
            continue
        out.append({
            **event,
            "impact_codes": memo[1],
            "impact_industries": memo[2],
            "impact_by": memo[3],
        })
    return out
