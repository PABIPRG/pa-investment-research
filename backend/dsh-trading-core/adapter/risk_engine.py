# -*- coding: utf-8 -*-
"""N 组合风险模型 + Q 风险预警中心（架构图 N/Q 节点）。

轻量确定性实现，无实时行情调用（同步 def 路由，避免阻塞事件循环）：
  - N：等权组合风险 = 持仓数 → 单股权重 / HHI 集中度 / 影子回撤波动，
       对比 risk_profiles.profile()["risk_budget"] 预算上限；
  - Q：聚合 4 源预警 = 组合(N) + 影子(I) + 事件(F) + 画像(K)，按严重度排序。

复用 personalize 私有函数（_holdings_codes/_watchlist_codes/_active_strategies/
_shadow_snapshot/_classify/_risk_level），breach 形状与 holdings_runner 的
_risk_budget_check 保持一致：{indicator, label, value, limit, excess}，额外加 severity。
"""

import copy
import threading
import time
from dataclasses import dataclass, field

from .personalize import (
    _active_strategies,
    _classify,
    _holdings_codes,
    _now,
    _risk_level,
    _shadow_snapshot,
    _watchlist_codes,
)

_SEVERITY_ORDER = {"高": 2, "中": 1, "低": 0}
_BREACH_LABELS = {
    "single_stock_weight": "单股权重",
    "hhi": "集中度 HHI",
    "portfolio_vol": "组合波动率",
}
# V→Q：用户反馈校准只作用于事件源（软信号），组合/影子/画像永不抑制
_DOWNGRADE = {"高": "中", "中": "低", "低": "低"}
_PORTFOLIO_CACHE: dict[tuple, tuple[float, dict]] = {}


@dataclass
class _PortfolioFlight:
    """一次组合计算的共享终态，等待者读取同一结果或同一异常。"""

    event: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None
    error: Exception | None = None


_PORTFOLIO_FLIGHTS: dict[tuple, _PortfolioFlight] = {}
_PORTFOLIO_CACHE_LOCK = threading.Lock()


def _feedback_counts(store) -> dict:
    """近 N 小时反馈记录 → {card_id(预警/卡片 id): {useful, useless}}（V→Q 归因）。"""
    from .config import settings

    now = time.time()
    win = float(settings.personalized_behavior_hours) * 3600
    out: dict[str, dict] = {}
    for r in store.get("behavior", "default") or []:
        if not isinstance(r, dict) or r.get("action") != "feedback":
            continue
        try:
            t = time.mktime(time.strptime(str(r.get("ts") or "").strip(), "%Y-%m-%d %H:%M:%S"))
        except (ValueError, TypeError):
            continue
        if (now - t) > win:
            continue
        cid = str(r.get("card_id") or "").strip()
        if not cid:
            continue
        d = out.setdefault(cid, {"useful": 0, "useless": 0})
        sent = r.get("sentiment")
        if sent == "useful":
            d["useful"] += 1
        elif sent == "useless":
            d["useless"] += 1
    return out


def _severity(excess: float) -> str:
    """超限倍数 → 严重度：超 1.5 倍高 / 超 1 倍中 / 其余低。"""
    return "高" if excess > 1.5 else ("中" if excess > 1 else "低")


def _excess_ratio(value, limit) -> float | None:
    """value / limit；limit 缺失或非正数返回 None（不产出 breach）。"""
    try:
        l = float(limit)
    except (TypeError, ValueError):
        return None
    if l <= 0:
        return None
    try:
        return float(value) / l
    except (TypeError, ValueError):
        return None


def _collection_revision(store, collection: str) -> tuple[int, int, int, int, int]:
    """用文件身份、ctime、mtime 与尺寸识别原子替换及原地改写。"""
    try:
        stat = store._path(collection).stat()
    except FileNotFoundError:
        return (0, 0, 0, 0, 0)
    return (
        int(getattr(stat, "st_dev", 0)),
        int(getattr(stat, "st_ino", 0)),
        int(getattr(stat, "st_ctime_ns", 0)),
        int(stat.st_mtime_ns),
        int(stat.st_size),
    )


def _portfolio_revision(store, profile_key: str) -> tuple:
    return (
        str(store.base_dir.resolve()),
        profile_key,
        _collection_revision(store, "holdings"),
        _collection_revision(store, "shadow_equity"),
    )


def portfolio_risk(store=None) -> dict:
    """短 TTL + revision + single-flight 的组合风险读取。"""
    from .config import settings
    from .risk_profiles import get_risk_profile
    from .store import JsonStore

    store = store or JsonStore()
    profile_key = get_risk_profile()
    revision = _portfolio_revision(store, profile_key)
    ttl = max(0.0, float(settings.risk_portfolio_cache_ttl))

    now = time.monotonic()
    with _PORTFOLIO_CACHE_LOCK:
        cached = _PORTFOLIO_CACHE.get(revision)
        if cached is not None and (now - cached[0]) <= ttl:
            return copy.deepcopy(cached[1])
        flight = _PORTFOLIO_FLIGHTS.get(revision)
        if flight is None:
            flight = _PortfolioFlight()
            _PORTFOLIO_FLIGHTS[revision] = flight
            owner = True
        else:
            owner = False

    if not owner:
        flight.event.wait()
        if flight.error is not None:
            raise flight.error
        if flight.result is None:
            raise RuntimeError("组合风险 single-flight 未发布终态")
        return copy.deepcopy(flight.result)

    try:
        result = _compute_portfolio_risk(store, profile_key)
    except Exception as exc:
        with _PORTFOLIO_CACHE_LOCK:
            _PORTFOLIO_FLIGHTS.pop(revision, None)
            flight.error = exc
            flight.event.set()
        raise
    with _PORTFOLIO_CACHE_LOCK:
        if len(_PORTFOLIO_CACHE) >= 32:
            _PORTFOLIO_CACHE.clear()
        _PORTFOLIO_CACHE[revision] = (time.monotonic(), result)
        _PORTFOLIO_FLIGHTS.pop(revision, None)
        flight.result = result
        flight.event.set()
    return copy.deepcopy(result)


def _compute_portfolio_risk(store, profile_key: str) -> dict:
    """N 组合风险模型的无缓存确定性计算。

    - 持仓 N → 等权 w = 1/N，HHI = 1/N（无价格时等权是唯一诚实假设）；
    - 对比 profile(profile_key)["risk_budget"]：single_stock_weight_max / hhi_max /
      portfolio_vol_max，breach 形状 {indicator,label,value,limit,excess,severity}；
    - 影子回撤/波动：shadow_equity/{date}.overall_nav ≥2 日才评估，否则 null + 数据不足。
    """
    holdings = _holdings_codes(store)
    n = len(holdings)
    w = 1.0 / n if n else 0.0
    hhi = 1.0 / n if n else 0.0

    from .risk_profiles import profile as _profile

    key = profile_key
    p = _profile(profile_key)
    budget = p["risk_budget"]
    as_of = _now()

    # ---- 影子回撤 / 年化波动（≥2 日净值才评估）-------------------------------
    eq = store.all("shadow_equity") or {}
    navs = []
    for date in sorted(eq.keys()):
        try:
            v = float((eq[date] or {}).get("overall_nav"))
        except (TypeError, ValueError):
            continue
        if v > 0:
            navs.append((date, v))

    shadow_max_drawdown = None
    shadow_annualized_vol = None
    data_note = None
    vol_breach = None
    if len(navs) >= 2:
        peak = navs[0][1]
        mdd = 0.0
        for _d, v in navs:
            peak = max(peak, v)
            if peak > 0:
                mdd = max(mdd, (peak - v) / peak)
        shadow_max_drawdown = round(mdd, 4)
        rets = [navs[i][1] / navs[i - 1][1] - 1.0 for i in range(1, len(navs))]
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1 if len(rets) > 1 else 1)
        shadow_annualized_vol = round((var ** 0.5) * (252 ** 0.5), 4)
        vol_limit = budget.get("portfolio_vol_max")
        vratio = _excess_ratio(shadow_annualized_vol, vol_limit)
        if vratio is not None and vratio > 1:
            vol_breach = {
                "indicator": "portfolio_vol",
                "label": _BREACH_LABELS["portfolio_vol"],
                "value": shadow_annualized_vol,
                "limit": float(vol_limit),
                "excess": round(vratio, 2),
                "severity": _severity(vratio),
            }
    else:
        data_note = "影子净值不足2日，回撤/波动未评估"

    # ---- 集中度 breaches（单股权重 + HHI）-------------------------------------
    breaches = []
    if n:
        sw_limit = budget.get("single_stock_weight_max")
        sw_ratio = _excess_ratio(w, sw_limit)
        if sw_ratio is not None and sw_ratio > 1:
            breaches.append({
                "indicator": "single_stock_weight",
                "label": _BREACH_LABELS["single_stock_weight"],
                "value": round(w, 4),
                "limit": float(sw_limit),
                "excess": round(sw_ratio, 2),
                "severity": _severity(sw_ratio),
            })
        hi_limit = budget.get("hhi_max")
        hi_ratio = _excess_ratio(hhi, hi_limit)
        if hi_ratio is not None and hi_ratio > 1:
            breaches.append({
                "indicator": "hhi",
                "label": _BREACH_LABELS["hhi"],
                "value": round(hhi, 4),
                "limit": float(hi_limit),
                "excess": round(hi_ratio, 2),
                "severity": _severity(hi_ratio),
            })
    if vol_breach:
        breaches.append(vol_breach)

    return {
        "as_of": as_of,
        "profile": key,
        "profile_label": p["label"],
        "summary": {
            "n_positions": n,
            "equal_weight": round(w, 4),
            "hhi": round(hhi, 4),
            "shadow_max_drawdown": shadow_max_drawdown,
            "shadow_annualized_vol": shadow_annualized_vol,
            "data_note": data_note,
        },
        "breaches": breaches,
    }


def risk_alerts(store=None) -> dict:
    """Q 风险预警中心：聚合 4 源（组合 N / 影子 I / 事件 F / 画像 K），按严重度排序。

    每项 {id, source, severity, title, detail, codes[], ts, strategy_id?}。
    """
    from .store import JsonStore

    store = store or JsonStore()
    from .risk_profiles import profile as _profile

    pr = portfolio_risk(store)
    key = pr["profile"]
    p = _profile(key)
    budget = p["risk_budget"]
    items: list[dict] = []
    fb_counts = _feedback_counts(store)  # V→Q 效果归因：每预警的 有用/没用 反馈

    # 1) 组合（N）--------------------------------------------------------------
    holdings_codes = list(_holdings_codes(store))
    for b in pr["breaches"]:
        label = b["label"]
        if b["indicator"] == "single_stock_weight":
            detail = f"当前单股等权占比 {b['value']*100:.0f}%，{p['label']}预算上限 {b['limit']*100:.0f}%（超 {b['excess']:.1f} 倍）"
        elif b["indicator"] == "hhi":
            detail = f"当前集中度 HHI={b['value']:.2f}，{p['label']}预算上限 {b['limit']:.2f}（超 {b['excess']:.1f} 倍）"
        else:
            detail = f"影子组合年化波动 {b['value']*100:.0f}%，预算上限 {b['limit']*100:.0f}%（超 {b['excess']:.1f} 倍）"
        items.append({
            "id": "risk-" + _md5("portfolio:" + b["indicator"]),
            "source": "portfolio",
            "severity": b["severity"],
            "title": label + "超预算",
            "detail": detail,
            "codes": holdings_codes,
            "strategy_id": None,
            "ts": pr["as_of"],
        })

    # 2) 影子（I）--------------------------------------------------------------
    snap = _shadow_snapshot(store) or {}
    equity = store.all("shadow_equity") or {}
    latest_errors = {}
    if equity:
        latest = max(equity.keys())
        latest_errors = (equity[latest] or {}).get("strategy_errors") or {}
    for sid, s in snap.items():
        name = s.get("name") or sid
        codes = list(s.get("symbols") or [])
        nav = s.get("nav")
        if nav is not None:
            try:
                nav = float(nav)
            except (TypeError, ValueError):
                nav = None
            if nav is not None and nav < 1.0:
                items.append({
                    "id": "risk-" + _md5("shadow:nav:" + sid),
                    "source": "shadow",
                    "severity": "高" if nav < 0.95 else "中",
                    "title": "影子策略净值回撤",
                    "detail": f"策略「{name}」影子净值 {nav:.4f} < 1，持仓浮亏中",
                    "codes": codes,
                    "strategy_id": sid,
                    "ts": _now(),
                })
        closed = int(s.get("closed_count") or 0)
        if closed > 0:
            trades = {k: v for k, v in (store.all("shadows") or {}).items()
                      if k.startswith(f"trades:{sid}")}
            net = 0.0
            for t in trades.values():
                try:
                    net += float(t.get("ret_pct") or 0)
                except (TypeError, ValueError):
                    pass
            if trades and net < 0:
                items.append({
                    "id": "risk-" + _md5("shadow:closed:" + sid),
                    "source": "shadow",
                    "severity": "中",
                    "title": "影子策略已实现亏损",
                    "detail": f"策略「{name}」已平仓 {closed} 笔，累计收益 {net:.1f}%",
                    "codes": codes,
                    "strategy_id": sid,
                    "ts": _now(),
                })
        errs = latest_errors.get(sid) if isinstance(latest_errors, dict) else None
        if errs:
            items.append({
                "id": "risk-" + _md5("shadow:err:" + sid),
                "source": "shadow",
                "severity": "低",
                "title": "影子运行告警",
                "detail": "策略「{}」部分标的行情/下单异常：{}".format(
                    name, "、".join(str(e) for e in list(errs)[:3])),
                "codes": codes,
                "strategy_id": sid,
                "ts": _now(),
            })

    # 3) 事件（F）--------------------------------------------------------------
    from .config import settings
    from .strategies import _str2md5, fetch_events_with_status

    holdings_set = set(holdings_codes)
    watchlist_set = set(_watchlist_codes(store))
    actives = _active_strategies(store)
    events, event_status = fetch_events_with_status(
        limit=30,
        timeout=settings.risk_event_deadline,
        allow_stale=True,
        failure_backoff=True,
        cached_impact=True,
    )
    for ev in events or []:
        if str(ev.get("direction") or "") != "利空":
            continue
        bk, mh, mw, _strats = _classify(ev, holdings_set, watchlist_set, actives)
        if bk not in ("holdings", "watchlist"):
            continue
        base = "高" if bk == "holdings" else "中"
        cal = _risk_level(ev, key)["level"]
        sev = base if _SEVERITY_ORDER[base] >= _SEVERITY_ORDER[cal] else cal
        items.append({
            "id": "risk-" + _str2md5("event:" + str(ev.get("id") or "")),
            "source": "event",
            "severity": sev,
            "title": ("持仓" if bk == "holdings" else "自选") + "利空事件",
            "detail": (ev.get("summary") or ev.get("title") or "")[:120],
            "codes": mh or mw,
            "strategy_id": None,
            "ts": ev.get("time") or _now(),
        })

    # 4) 画像（K，advisory 上下文）---------------------------------------------
    items.append({
        "id": "risk-" + _md5("profile:" + key),
        "source": "profile",
        "severity": "低",
        "title": "画像预算提示",
        "detail": "当前画像 {}，组合预算 波动≤{:.0f}% / HHI≤{:.2f}".format(
            p["label"], budget.get("portfolio_vol_max", 0) * 100, budget.get("hhi_max", 0)),
        "codes": [],
        "strategy_id": None,
        "ts": _now(),
    })

    # V→Q：每项附反馈计数；事件源灵敏度按反馈校准（组合/影子/画像永不抑制）
    for it in items:
        it["feedback"] = fb_counts.get(it["id"]) or {"useful": 0, "useless": 0}
    for it in items:
        if it["source"] != "event":
            continue
        fb = it["feedback"]
        if fb["useless"] >= 2 and fb["useless"] >= fb["useful"]:
            it["severity"] = _DOWNGRADE.get(it["severity"], it["severity"])
            it["detail"] = str(it["detail"]) + \
                f"（你近期标记此类预警无用 {fb['useless']} 次，灵敏度已下调）"

    # R→V 效果漏斗（曝光→点击→有用/没用，观察整体归因）
    from .behavior_profile import behavior_funnel

    items.sort(key=lambda x: (-_SEVERITY_ORDER[x["severity"]], x["source"]))
    return {
        "as_of": _now(),
        "profile": key,
        "profile_label": p["label"],
        "count": len(items),
        "items": items,
        "effect": behavior_funnel(store),
        "degraded": bool(event_status["degraded"]),
        "upstreams": {"market_watch_events": event_status},
    }


def _reset_risk_cache_for_tests() -> None:
    """测试隔离：生产调用不使用。"""
    with _PORTFOLIO_CACHE_LOCK:
        _PORTFOLIO_CACHE.clear()
        for flight in _PORTFOLIO_FLIGHTS.values():
            flight.error = RuntimeError("测试重置终止了组合风险 single-flight")
            flight.event.set()
        _PORTFOLIO_FLIGHTS.clear()


def _md5(text: str) -> str:
    import hashlib
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:12]
