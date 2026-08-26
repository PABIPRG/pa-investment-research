# -*- coding: utf-8 -*-
"""个性化右链：O 策略—用户匹配 + D 资讯卡片生成 + P 个性化卡片流 + R 行为捕获。

架构图「C 事件影响图谱 → D 资讯卡片生成器 → P 个性化资讯卡片 feed」与
「O 策略—用户匹配引擎 → R → …」的三期落点，全部落在 trading-core：
  - O：active 策略 × 用户画像确定性打分（0-100，可解释），输出"为你推荐"；
  - D：把 market-watch 结构化事件包装成资讯卡片（命中持仓/自选/策略 → 分桶）；
  - P：按桶优先级 + relevance_score 排序，输出个性化卡片 feed；
  - R：记录 view/click 埋点（data/adapter/behavior.json，环形缓冲），反馈进 P 排序。

market-watch 保持纯数据源（strategies.fetch_events 拉取，TTL 缓存）。
打分全确定性 + 可解释；LLM 点评是可选增强，失败置 null 绝不阻塞主路径。
单用户模型：所有个性化数据用 "default" 键，未来多用户需在 key 加 user_id 前缀。
"""

import logging
import time

from .config import settings

logger = logging.getLogger("adapter.personalize")

# ---- 画像 / 策略激进度（O 打分）-------------------------------------------
# 画像激进度 a ∈ [0,1]；策略需求度 demand = kind + direction 调整。
PROFILE_AGGRESSION = {"conservative": 0.0, "balanced": 0.5, "aggressive": 1.0}
KIND_AGGRESSION = {"ma_cross": 0.30, "momentum": 0.60, "rsi_reversal": 0.80,
                   "breakout": 0.30, "bollinger": 0.80, "volume_breakout": 0.45}
DIRECTION_ADJUST = {"利好": 0.0, "利空": 0.10, "中性": 0.05}

# 四维度权重（合计 100）+ N→O 分散化修正（组合集中度高时的加减分，可负）
W_AFFINITY, W_PROFILE, W_SHADOW, W_QUALITY = 35, 35, 20, 10
W_DIV = 8.0

# ---- 卡片分桶 / 排序（P）---------------------------------------------------
BUCKET_ORDER = {"holdings": 0, "watchlist": 1, "strategy": 2, "fresh": 3}
BUCKET_BASE = {"holdings": 70, "watchlist": 60, "strategy": 50, "fresh": 20}
_TYPE_BONUS = {"业绩": 5, "价格异动": 5, "评级": 5,
               "政策": 3, "产业": 3, "合作": 3, "公告": 3}
_KNOWN_BUCKETS = tuple(BUCKET_ORDER)

# LLM 点评记忆（30min），失败缓存 None 避免反复打 LLM
_COMMENT_MEMO: dict[str, tuple[float, str | None]] = {}


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


# ---- 用户上下文（画像 + 持仓 + 自选 + 影子 + 行为）---------------------------


def _holdings_codes(store) -> list[str]:
    return [str(h.get("ticker") or "").strip()
            for h in (store.get("holdings", "default") or []) if h.get("ticker")]


def _watchlist_codes(store) -> list[str]:
    return [str(w or "").strip() for w in (store.get("watchlist", "default") or []) if w]


def _active_strategies(store) -> list[dict]:
    """推荐对象 = 已通过样本外验证的 active 策略（candidate/rejected 不上推荐位）。

    自进化降级/淘汰联动：`evolve.state` ∈ {watch(观察), retired(淘汰)} 的策略不再进推荐，
    但 status 仍是 active → 影子验证（shadow.py 自读 status）继续记账积累证据。"""
    return [s for s in store.all("strategies").values()
            if isinstance(s, dict)
            and s.get("status") == "active"
            and (s.get("evolve") or {}).get("state") not in ("watch", "retired")]


def _shadow_snapshot(store) -> dict:
    """最新 shadow_equity 日期 → {sid: {nav, closed_count, ...}}。无快照返回 {}。"""
    eq = store.all("shadow_equity")
    if not eq:
        return {}
    latest = max(eq.keys())
    rec = eq[latest]
    if not isinstance(rec, dict):
        return {}
    return rec.get("strategies") or {}


def _profile_ctx(store) -> dict:
    """有效画像 + KYC 答题（qid→score，供画像微调信号）。"""
    from .risk_profiles import get_risk_profile, profile

    key = get_risk_profile()
    kyc = store.get("preferences", "kyc") or {}
    answers = {a.get("qid"): a.get("score")
               for a in (kyc.get("answers") or []) if isinstance(a, dict)}
    return {"profile_key": key, "profile_label": profile(key)["label"],
            "answers": answers}


def _behavior_ctx(store, profile_key: str) -> tuple[dict, float]:
    """L→K：近 N 小时行为 → (behavior 块, 有效激进度)。失败降级为无调整。"""
    try:
        from .behavior_profile import compute_behavior_profile

        beh = compute_behavior_profile(store)
    except Exception as exc:  # noqa: BLE001 — 行为画像失败不影响主路径
        logger.warning("行为画像计算失败（按无调整处理）: %s", exc)
        beh = {"window_hours": settings.personalized_behavior_hours,
               "views": 0, "clicks": 0, "focus_tickers": [], "direction_skew": None,
               "aggression_delta": 0.0, "strategy_affinity": [],
               "notes": ["行为画像暂不可用"]}
    delta = float(beh.get("aggression_delta") or 0.0)
    eff = round(_clamp(PROFILE_AGGRESSION.get(profile_key, 0.5) + delta, 0, 1), 3)
    return beh, eff


def _portfolio_concentration(store, profile_key: str) -> dict:
    """N→O：组合集中度信号（等权 HHI vs 画像预算 hhi_max）。

    无持仓或未超限 → concentrated=False（不干预匹配）。
    返回 {concentrated, n, hhi, limit, label}，供 score_strategy 分散化修正。
    """
    from .risk_profiles import profile

    holdings = _holdings_codes(store)
    n = len(holdings)
    if not n:
        return {"concentrated": False, "n": 0, "hhi": 0.0, "limit": None, "label": None}
    hhi = 1.0 / n
    limit = (profile(profile_key).get("risk_budget") or {}).get("hhi_max")
    concentrated = bool(limit) and hhi > float(limit)
    return {
        "concentrated": concentrated,
        "n": n,
        "hhi": round(hhi, 4),
        "limit": round(float(limit), 4) if limit else None,
        "label": profile(profile_key)["label"],
    }


# ---- O：策略—用户匹配引擎（确定性可解释打分）-------------------------------


def _reason_code(dim: str, b: dict) -> str:
    """维度 → 简短程序化 code（前端可据此做筛选/图标）。"""
    score = b["score"]
    if dim == "affinity":
        return "hit" if score > 0 else "none"
    if dim == "profile_fit":
        if any("画像下" in n for n in b["notes"]):
            return "caution"
        return "aligned" if score >= 21 else "demand_gap"
    if dim == "shadow":
        return "no_nav" if any("尚无净值" in n for n in b["notes"]) else ("profit" if score > 10 else "nav")
    if dim == "diversification":
        return "overlap" if score < 0 else ("diversify" if score > 0 else "neutral")
    return "strong" if score >= 8 else "weak"


def score_strategy(s: dict, ctx: dict) -> dict:
    """单策略 × 用户上下文 → 确定性打分（纯函数，可单测）。

    ctx = {profile_key, profile_label, answers{qid:score},
           holdings(set), watchlist(set), shadow{sid:snapshot}}
    返回：match_score + fits_profile + caution + breakdown + match_reasons。
    """
    sid = s.get("id")
    symbols = [str(x) for x in (s.get("symbols") or [])]
    kind = s.get("kind")
    direction = s.get("direction") or "中性"
    profile_key = ctx["profile_key"]
    bdelta = float(ctx.get("behavior_delta") or 0.0)
    a = _clamp(PROFILE_AGGRESSION.get(profile_key, 0.5) + bdelta, 0, 1)
    demand = min(1.0, KIND_AGGRESSION.get(kind, 0.5)
                 + DIRECTION_ADJUST.get(direction, 0.05))

    # 1) 持仓/自选关联度 35
    mh = [x for x in symbols if x in ctx["holdings"]]
    mw = [x for x in symbols if x in ctx["watchlist"]]
    affinity = min(W_AFFINITY, len(mh) * 15 + len(mw) * 10)
    aff_notes = []
    if mh:
        aff_notes.append(f"命中持仓 {len(mh)} 只：{'、'.join(mh)}")
    if mw:
        aff_notes.append(f"命中自选 {len(mw)} 只：{'、'.join(mw)}")
    if not aff_notes:
        aff_notes.append("未命中你的持仓/自选")

    # 2) 风险画像契合度 35 + KYC 答题级微调 + 硬约束
    fit_ratio = max(0.0, 1 - abs(a - demand))
    profile_fit = round(W_PROFILE * fit_ratio, 1)
    pf_notes = [
        f"{ctx['profile_label']}画像(激进度{a}) vs {direction}{kind}(需求{demand})，"
        f"契合度{round(fit_ratio * 100)}%"
    ]
    if bdelta:  # L→K 行为画像修正（有方向数据才出现）
        bad_pct = ctx.get("behavior_bad_pct")
        if bad_pct is not None:
            pf_notes.append(f"行为画像{bdelta:+.2f}：你近期利空事件点击占比 {bad_pct*100:.0f}%")
        else:
            pf_notes.append(f"行为画像{bdelta:+.2f}：行为方向修正")
    answers = ctx["answers"]
    try:
        if answers.get("drawdown_reaction") is not None and int(answers["drawdown_reaction"]) <= 2 and kind in ("rsi_reversal", "bollinger"):
            profile_fit -= 4.0
            pf_notes.append("你回撤敏感，超跌反弹策略额外降权")
        if answers.get("product_pref") is not None and int(answers["product_pref"]) >= 4 and kind == "momentum":
            profile_fit += 4.0
            pf_notes.append("你偏好进取品种，动量策略额外加分")
    except (TypeError, ValueError):
        pass
    profile_fit = round(_clamp(profile_fit, 0, W_PROFILE), 1)

    fits_profile = True
    caution = None
    if profile_key == "conservative" and direction == "利空":
        fits_profile = False
        caution = "保守画像下，利空超跌反弹策略回撤风险偏高，建议仅小仓位观察或忽略"
        pf_notes.append(caution)
    elif profile_key == "aggressive" and kind == "ma_cross":
        caution = "进取画像下趋势策略偏慢，可作底仓参考"
        pf_notes.append(caution)

    # 3) 影子实盘表现 20
    snap = (ctx["shadow"] or {}).get(sid) or {}
    nav = snap.get("nav")
    closed = int(snap.get("closed_count") or 0)
    if nav is None:
        shadow_score = 10.0
        sh_notes = ["影子验证进行中，尚无净值"]
    else:
        shadow_score = _clamp(10 + (float(nav) - 1) * 100, 0, W_SHADOW)
        sh_notes = [f"影子净值 {float(nav):.4f}"]
        if closed > 0:
            sh_notes.append(f"已平仓 {closed} 笔（已有已实现证据）")

    # 4) 策略质量 10（样本外）
    oos = (s.get("backtest") or {}).get("out_of_sample") or {}
    q = 5.0
    q_notes = []
    try:
        wr, ret = oos.get("win_rate_pct"), oos.get("avg_simulated_return_pct")
        if wr is not None and float(wr) >= 50:
            q += 3.0
            q_notes.append(f"样本外胜率 {float(wr):.0f}%")
        else:
            q_notes.append("样本外胜率未达 50%")
        if ret is not None and float(ret) > 0:
            q += 2.0
            q_notes.append(f"样本外均收益 {float(ret):.2f}%")
    except (TypeError, ValueError):
        q_notes = ["样本外指标异常"]
    if not q_notes:
        q_notes.append("尚无样本外评估")

    # 5) 分散化修正（N→O）：组合集中度高时，与持仓重叠的策略降权、无重叠加分
    conc = ctx.get("concentration") or {}
    div_score = 0.0
    div_notes = []
    if conc.get("concentrated"):
        overlap = len(set(symbols) & ctx["holdings"])
        if overlap:
            div_score = -W_DIV * (0.5 if overlap == 1 else 1.0)
            div_notes.append(
                f"组合集中度高（HHI={conc['hhi']:.2f} 超 {conc['label']}上限 {conc['limit']:.2f}），"
                f"该策略与持仓重叠 {overlap} 只，加剧集中 → 降权")
        else:
            div_score = W_DIV * 0.4
            div_notes.append(
                f"组合集中度高（HHI={conc['hhi']:.2f}），该策略与持仓无重叠，可分散组合 → 加分")
    else:
        div_notes.append("组合集中度正常，无需分散干预")

    match_score = round(_clamp(affinity + profile_fit + shadow_score + q + div_score), 1)

    breakdown = {
        "affinity": {"score": affinity, "notes": aff_notes},
        "profile_fit": {"score": profile_fit, "notes": pf_notes},
        "shadow": {"score": shadow_score, "notes": sh_notes},
        "quality": {"score": q, "notes": q_notes},
        "diversification": {"score": round(div_score, 1), "notes": div_notes},
    }
    return {
        "strategy_id": sid, "name": s.get("name"), "kind": kind,
        "direction": direction, "symbols": symbols, "status": s.get("status"),
        "nav": snap.get("nav"), "closed_count": closed,
        "match_score": match_score, "fits_profile": fits_profile, "caution": caution,
        "breakdown": breakdown,
        "match_reasons": [
            {"dim": dim, "code": _reason_code(dim, b),
             "text": "；".join(b["notes"]), "score": b["score"]}
            for dim, b in breakdown.items()
        ],
    }


def match_strategies(store=None) -> dict:
    """O 输出：active 策略 × 画像 → 推荐排序（fits_profile 前置，分高在前）。"""
    from .store import JsonStore

    store = store or JsonStore()
    pctx = _profile_ctx(store)
    beh, eff = _behavior_ctx(store, pctx["profile_key"])
    ctx = {**pctx,
           "holdings": set(_holdings_codes(store)),
           "watchlist": set(_watchlist_codes(store)),
           "shadow": _shadow_snapshot(store),
           "concentration": _portfolio_concentration(store, pctx["profile_key"]),
           "behavior_delta": beh["aggression_delta"],
           "behavior_bad_pct": (beh["direction_skew"] or {}).get("bad_pct")
                               if beh["direction_skew"] else None,
           }
    items = [score_strategy(s, ctx) for s in _active_strategies(store)]
    items.sort(key=lambda x: (not x["fits_profile"], -x["match_score"]))
    return {
        "as_of": _now(),
        "profile": pctx["profile_key"], "profile_label": pctx["profile_label"],
        "effective_aggression": eff,
        "behavior": beh,
        "portfolio_concentration": ctx["concentration"],
        "count": len(items), "items": items,
    }


# ---- D：资讯卡片生成器 ------------------------------------------------------


def _card_tickers(ev: dict) -> list[str]:
    """事件涉及的可交易代码（容忍 code 为空串，空则落 fresh 桶）。

    并入 C 事件影响图谱的 impact_codes：间接波及标的也参与分桶/命中/
    「你近期看过」加分（fetch_events 注入后事件自带 impact_codes）。"""
    codes = [str((t or {}).get("code") or "").strip()
             for t in (ev.get("tickers") or []) if (t or {}).get("code")]
    for c in (ev.get("impact_codes") or []):
        c = str(c or "").strip()
        if c and c not in codes:
            codes.append(c)
    return codes


def _classify(ev: dict, holdings: set, watchlist: set, actives: list[dict]):
    """分桶：holdings > watchlist > strategy > fresh；返回 (bucket, mh, mw, strats)。"""
    codes = set(_card_tickers(ev))
    mh = sorted(codes & holdings)
    mw = sorted(codes & watchlist)
    strats = [s for s in actives if set(s.get("symbols") or []) & codes]
    if mh:
        bucket = "holdings"
    elif mw:
        bucket = "watchlist"
    elif strats:
        bucket = "strategy"
    else:
        bucket = "fresh"
    return bucket, mh, mw, strats


def _event_age_hours(ev: dict) -> float:
    """事件距今小时数；time 空/异常按 99（无新鲜加成，不报错）。"""
    ts = str(ev.get("time") or "").strip()
    if not ts:
        return 99.0
    try:
        t = time.mktime(time.strptime(ts, "%Y-%m-%d %H:%M:%S"))
    except (ValueError, TypeError):
        return 99.0
    return max(0.0, (time.time() - t) / 3600.0)


def _relevance(ev: dict, bucket: str, strats: list[dict], recent_codes: set,
               boosts: dict | None = None) -> dict:
    """P 排序核心：base + recency + direction + type + strategy_winner + behavior + V→D 归因。"""
    score = float(BUCKET_BASE[bucket])
    reasons = []

    age = _event_age_hours(ev)
    if age < 1:
        score += 15
        reasons.append("新鲜：<1小时")
    elif age < 4:
        score += 10
        reasons.append("新鲜：<4小时")
    elif age < 24:
        score += 5
        reasons.append("新鲜：<24小时")

    direction = str(ev.get("direction") or "中性")
    if direction in ("利好", "利空"):
        score += 10
        reasons.append(f"{direction}事件")
    else:
        score += 3

    score += _TYPE_BONUS.get(str(ev.get("type") or "其他"), 0)

    if bucket == "strategy" and any(
            s.get("nav") is not None and float(s.get("nav")) > 1 for s in strats):
        score += 5
        reasons.append("关联策略盈利中")

    if set(_card_tickers(ev)) & recent_codes:
        score += 5
        reasons.append("你近期看过相关个股")

    # V→D 效果归因：你反馈有用/无用的个股与行业进排序（P→R→V→D 闭环）
    if boosts:
        tcodes = set(_card_tickers(ev))
        interest_tk = boosts.get("interest_tickers") or set()
        ignored_tk = boosts.get("ignored_tickers") or set()
        if tcodes & interest_tk:
            score += 6
            reasons.append("你反馈有用的个股")
        elif tcodes & ignored_tk:
            score -= 4
            reasons.append("你反馈无用的个股")
        inds = set(ev.get("impact_industries") or []) | set(ev.get("industries") or [])
        if inds & (boosts.get("interest_industries") or set()):
            score += 4
            reasons.append("你关注的行业")

    return {"score": round(_clamp(score), 0), "reasons": reasons}


def _risk_level(ev: dict, profile_key: str) -> dict:
    """逐事件风险等级 + 画像护栏文案（引用 risk_profiles guardrail 可解释）。"""
    from .risk_profiles import profile as _profile

    direction = str(ev.get("direction") or "中性")
    p = _profile(profile_key)
    if direction == "利空":
        if profile_key == "aggressive":
            guard = p.get("guardrail", {}).get("sell_risk_score_min")
            return {"level": "中",
                    "note": f"利空事件对{p['label']}画像或为左侧机会（弱卖出信号阈值 {guard}）"}
        guard = p.get("guardrail", {}).get("buy_risk_score_max")
        return {"level": "高",
                "note": f"利空事件，{p['label']}画像需关注持仓风险（买入风险分上限 {guard}）"}
    if direction == "利好":
        vol = p.get("risk_budget", {}).get("portfolio_vol_max")
        return {"level": "低",
                "note": f"利好事件，{p['label']}画像潜在机会（组合波动上限 {vol}）"}
    return {"level": "中", "note": f"中性事件，{p['label']}画像正常关注"}


def _attach_llm_comments(cards: list[dict], profile_key: str) -> None:
    """可选：对前几张 matched 卡附加 LLM 一句话点评。失败置 null，绝不阻塞。"""
    if not settings.llm_available() or not settings.personalized_comment_enabled:
        return
    from .llm import summarize

    now = time.time()
    ttl = settings.personalized_comment_ttl
    if len(_COMMENT_MEMO) > 800:  # 防止长期运行无限增长
        for k in [k for k, (ts, _v) in _COMMENT_MEMO.items() if (now - ts) > ttl * 2]:
            _COMMENT_MEMO.pop(k, None)
    for card in cards[:5]:
        if card["bucket"] == "fresh":
            continue
        cid = card["card_id"]
        memo = _COMMENT_MEMO.get(cid)
        if memo and (now - memo[0]) < ttl:
            card["llm_comment"] = memo[1]
            continue
        try:
            names = "、".join((t or {}).get("name", "") for t in (card["tickers"] or []))
            comment = summarize(
                system=("你是A股资讯点评助手。基于用户画像与事件信息，用 1 句（≤40字）"
                        "面向该画像的中性点评，不谈策略优劣，不提具体买卖建议。"),
                user=f"画像：{profile_key}。事件：{card['summary'] or card['title'] or ''}。"
                     f"方向：{card['direction']}。涉及：{names}",
                max_tokens=80,
            )
            _COMMENT_MEMO[cid] = (now, comment)
            card["llm_comment"] = comment
        except Exception as exc:
            logger.warning("资讯点评失败（置 null 不阻塞）: %s", exc)
            _COMMENT_MEMO[cid] = (now, None)


def build_cards(store=None, limit: int = 30, bucket: str = "all",
                match_only: bool = False, strategy_id: str | None = None,
                comment: bool = False) -> dict:
    """D+P：事件 → 资讯卡片 → 按桶 + relevance 排序 → 个性化卡片 feed。"""
    from .store import JsonStore
    from .strategies import fetch_events, _str2md5

    store = store or JsonStore()
    pctx = _profile_ctx(store)
    profile_key = pctx["profile_key"]
    beh, eff = _behavior_ctx(store, profile_key)
    holdings = set(_holdings_codes(store))
    watchlist = set(_watchlist_codes(store))
    actives = _active_strategies(store)
    shadow = _shadow_snapshot(store)
    recent_codes = _recent_clicks(store, hours=24)
    # V→D 效果归因信号：你反馈有用/无用的个股与行业（读行为库，失败置空）
    try:
        from .behavior_profile import behavior_boosts

        boosts = behavior_boosts(store)
    except Exception:  # noqa: BLE001 — 归因信号失败不阻塞卡片流
        boosts = {}

    # timeout=15 等 market-watch 懒抽取完成（实测冷缓存抽取 ~4.2s，4s 恰在边界上）
    events = fetch_events(limit=max(int(limit) * 2, 60), timeout=15.0)
    cards: list[dict] = []
    for ev in events:
        bk, mh, mw, strats = _classify(ev, holdings, watchlist, actives)
        if bucket != "all" and bk != bucket:
            continue
        if match_only and bk == "fresh":
            continue
        if strategy_id and not any(str(s.get("id")) == strategy_id for s in strats):
            continue
        strat_list = []
        for s in strats:
            snap = (shadow or {}).get(s.get("id")) or {}
            strat_list.append({
                "id": s.get("id"), "name": s.get("name"), "kind": s.get("kind"),
                "direction": s.get("direction"), "symbols": s.get("symbols"),
                "status": s.get("status"),
                "nav": snap.get("nav"), "closed_count": snap.get("closed_count", 0),
            })
        rel = _relevance(ev, bk, strats, recent_codes, boosts)
        reasons = []
        if mh:
            reasons.append("命中持仓：" + "、".join(mh))
        if mw:
            reasons.append("命中自选：" + "、".join(mw))
        if bk != "fresh" and (ev.get("impact_by") or []):  # C 间接波及（命中才展示）
            reasons.append("间接波及：" + "、".join(str(x) for x in ev["impact_by"])[:80])
        reasons.extend(rel["reasons"])
        cards.append({
            "card_id": "card-" + _str2md5(str(ev.get("id") or "")),
            "event_id": ev.get("id"), "item_id": ev.get("item_id"),
            "bucket": bk, "relevance_score": rel["score"],
            "type": ev.get("type"), "direction": ev.get("direction"),
            "title": ev.get("title"), "summary": ev.get("summary"),
            "time": ev.get("time"), "source": ev.get("source"), "url": ev.get("url"),
            "tickers": ev.get("tickers"), "industries": ev.get("industries"),
            "impact": {"codes": ev.get("impact_codes") or [],
                       "industries": ev.get("impact_industries") or [],
                       "by": ev.get("impact_by") or []},
            "matched": {"holdings": mh, "watchlist": mw, "strategies": strat_list},
            "risk": _risk_level(ev, profile_key),
            "reasons": reasons[:3],
            "llm_comment": None,
            "event": ev,
        })

    # P 排序：桶优先级优先（持仓>自选>策略>新鲜），桶内按 relevance desc
    cards.sort(key=lambda c: (BUCKET_ORDER[c["bucket"]], -c["relevance_score"]))

    if comment and cards:
        _attach_llm_comments(cards, profile_key)

    limit = max(1, min(int(limit), 100))
    return {
        "as_of": _now(),
        "profile": profile_key, "profile_label": pctx["profile_label"],
        "effective_aggression": eff,
        "behavior": beh,
        "count": len(cards[:limit]), "cards": cards[:limit],
    }


# ---- R：行为捕获（view/click 埋点 → 环形缓冲）-------------------------------


def record_interaction(store, card_id: str, action: str, ts: str | None = None,
                       meta: dict | None = None) -> dict:
    """R：写 view/click 记录，插头部 + 截断 cap。"""
    rec = {"card_id": card_id, "action": action, "ts": ts or _now(),
           "meta": meta or {}, "server_ts": _now()}
    store.mutate(
        "behavior",
        "default",
        lambda current: ([rec] + list(current or []))[
            : settings.personalized_behavior_cap
        ],
        [],
    )
    return {"ok": True, "stored": True, "action": action, "card_id": card_id}


def record_feedback(store, card_id: str, sentiment: str, ts: str | None = None,
                    meta: dict | None = None) -> dict:
    """R 显式反馈（P→R 决策信号）：卡片/预警 有用/没用，落行为库。

    供 R→U→K 画像修正（feedback_delta / interest_tickers）与 R→V 效果归因
    （卡片排序 boost、事件预警灵敏度校准）。
    """
    rec = {"card_id": card_id, "action": "feedback", "sentiment": sentiment,
           "ts": ts or _now(), "meta": meta or {}, "server_ts": _now()}
    store.mutate(
        "behavior",
        "default",
        lambda current: ([rec] + list(current or []))[
            : settings.personalized_behavior_cap
        ],
        [],
    )
    return {"ok": True, "stored": True, "sentiment": sentiment, "card_id": card_id}


def _recent_clicks(store, hours: float = 24.0) -> set[str]:
    """近 N 小时 click 记录涉及的 ticker 集合（供 P 排序 behavior_bonus）。"""
    now = time.time()
    codes: set[str] = set()
    for r in (store.get("behavior", "default") or []):
        if not isinstance(r, dict) or r.get("action") != "click":
            continue
        ts = str(r.get("ts") or "").strip()
        try:
            t = time.mktime(time.strptime(ts, "%Y-%m-%d %H:%M:%S"))
        except (ValueError, TypeError):
            continue
        if (now - t) > hours * 3600:
            continue
        tk = str((r.get("meta") or {}).get("ticker") or "").strip()
        if tk:
            codes.add(tk)
    return codes


def list_interactions(store, limit: int = 50) -> dict:
    """R 读取：最近埋点（时间倒序）。"""
    rows = list(store.get("behavior", "default") or [])[: max(1, min(int(limit), 500))]
    return {"count": len(rows), "items": rows}
