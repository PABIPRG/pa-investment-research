# -*- coding: utf-8 -*-
"""K 画像增强 L→K：行为反馈（R 埋点 + 显式反馈）进风险画像，驱动 O/P/Q 微调。

读 behavior.json 近 N 小时（config.personalized_behavior_hours，默认 168）的四类输入：
  - 阅读行为：view/click → focus_tickers / direction_skew / strategy_affinity /
    industry_affinity；方向偏差 → aggression_delta（与四期一致）；
  - 显式反馈：useful/useless → feedback_delta（利空有用/利好没用=风险耐受），
    合并进 aggression_delta；并产出 interest_tickers / interest_industries /
    ignored_tickers 供 R→V→D 卡片排序归因；
  - 关注：当前 watchlist_tickers；
  - 交易代理：影子验证中策略的标的 trading_affinity。

effective_aggression 把画像基础激进度叠上行为 delta（clamp [0,1]），O 打分用；
behavior_boosts/behavior_funnel 供 R→V 效果归因（D 排序 boost、Q 预警灵敏度）。
失败全部降级（按空/零值处理），绝不阻塞主路径。

避免循环依赖：effective_aggression 内延迟 import personalize 的 PROFILE_AGGRESSION，
personalize/risk_engine 侧对本模块也是延迟 import。
"""

import logging
import time
from collections import Counter

from .config import settings

logger = logging.getLogger("adapter.behavior_profile")

DELTA_MAX = 0.15  # 行为对激进度最大修正量
_DIRECTION_BONUS = 0.3


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _parse_ts(ts) -> float | None:
    try:
        return time.mktime(time.strptime(str(ts or "").strip(), "%Y-%m-%d %H:%M:%S"))
    except (ValueError, TypeError):
        return None


def _trading_affinity(store) -> list[str]:
    """交易行为代理：当前在影子验证中真实交易（active 且 nav 快照存在）的策略标的。"""
    eq = store.all("shadow_equity") or {}
    if not eq:
        return []
    latest = max(eq.keys())
    sids = set((eq[latest] or {}).get("strategies") or {})
    out: list[str] = []
    seen: set[str] = set()
    for s in (store.all("strategies") or {}).values():
        if not isinstance(s, dict) or s.get("status") != "active":
            continue
        if str(s.get("id")) not in sids:
            continue
        for sym in (s.get("symbols") or []):
            sym = str(sym or "").strip()
            if sym and sym not in seen:
                seen.add(sym)
                out.append(sym)
    return out[:10]


def compute_behavior_profile(store=None) -> dict:
    """近 N 小时 点击 + 反馈 → 画像微调信号（L→K，四类输入）。

    阅读行为：view/click（方向、行业、策略亲和）；
    显式反馈：useful/useless（进 feedback_delta 与 interest/ignored 集合）；
    关注：当前 watchlist；交易代理：影子验证中的策略标的。
    """
    from .store import JsonStore

    store = store or JsonStore()
    hours = float(settings.personalized_behavior_hours)
    now = time.time()
    window = hours * 3600

    views = clicks = 0
    useful = useless = 0
    tk_counts: Counter = Counter()
    sid_counts: Counter = Counter()
    ind_counts: Counter = Counter()
    useful_tk: Counter = Counter()
    useful_ind: Counter = Counter()
    useless_tk: Counter = Counter()
    good = bad = 0
    fb_good_useful = fb_good_useless = fb_bad_useful = fb_bad_useless = 0
    for r in store.get("behavior", "default") or []:
        if not isinstance(r, dict):
            continue
        ts = _parse_ts(r.get("ts"))
        if ts is None or (now - ts) > window:
            continue
        action = r.get("action")
        meta = r.get("meta") or {}
        inds = [str(i or "").strip() for i in (meta.get("industries") or []) if i]
        if action == "view":
            views += 1
            continue
        if action == "click":
            clicks += 1
            tk = str(meta.get("ticker") or "").strip()
            if tk:
                tk_counts[tk] += 1
            sid = str(meta.get("strategy_id") or "").strip()
            if sid:
                sid_counts[sid] += 1
            d = str(meta.get("direction") or "").strip()
            if d == "利好":
                good += 1
            elif d == "利空":
                bad += 1
            for i in inds:
                ind_counts[i] += 1
            continue
        if action == "feedback":
            sent = r.get("sentiment")
            if sent == "useful":
                useful += 1
            elif sent == "useless":
                useless += 1
            else:
                continue
            tk = str(meta.get("ticker") or "").strip()
            d = str(meta.get("direction") or "").strip()
            for i in inds:
                ind_counts[i] += 1
            if sent == "useful":
                if tk:
                    useful_tk[tk] += 1
                for i in inds:
                    useful_ind[i] += 1
                if d == "利好":
                    fb_good_useful += 1
                elif d == "利空":
                    fb_bad_useful += 1
            else:
                if tk:
                    useless_tk[tk] += 1
                if d == "利好":
                    fb_good_useless += 1
                elif d == "利空":
                    fb_bad_useless += 1

    focus_tickers = [{"ticker": tk, "count": n} for tk, n in tk_counts.most_common(5)]

    # 点击方向偏差（阅读行为）
    direction_skew = None
    click_delta = 0.0
    if good + bad > 0:
        good_pct = good / (good + bad)
        bad_pct = bad / (good + bad)
        click_delta = round(
            _clamp(_DIRECTION_BONUS * (bad_pct - good_pct), -DELTA_MAX, DELTA_MAX), 3)
        direction_skew = {
            "利好": good, "利空": bad,
            "good_pct": round(good_pct, 3), "bad_pct": round(bad_pct, 3),
            "delta": click_delta,
        }

    # 显式反馈方向偏差（R→U→K）：利空标记有用/利好标记没用 → 风险耐受；反之厌恶
    fb_total = useful + useless
    feedback_delta = 0.0
    if fb_total:
        sig = (fb_bad_useful - fb_bad_useless) + (fb_good_useless - fb_good_useful)
        feedback_delta = round(_clamp(0.15 * sig / fb_total, -DELTA_MAX, DELTA_MAX), 3)

    # 自进化 outcome 版（R→S→U→K）：用户参与/激活策略的影子 outcome → outcome_delta
    # （决策被验证→轻微上调激进度；决策受挫→轻微下调）。数据不足/无样本 → delta=0。
    outcome = None
    outcome_delta = 0.0
    try:
        from .evolution import decision_outcome
        outcome = decision_outcome(store)
        outcome_delta = float(outcome.get("delta") or 0.0)
    except Exception as exc:  # noqa: BLE001 — outcome 归因失败不阻塞画像
        logger.debug("outcome 归因失败（按 0 处理）: %s", exc)

    aggression_delta = round(
        _clamp(click_delta + feedback_delta + outcome_delta, -DELTA_MAX, DELTA_MAX), 3)

    interest_tickers = [{"ticker": t, "count": n} for t, n in useful_tk.most_common(5)]
    interest_industries = [{"industry": i, "count": n} for i, n in useful_ind.most_common(5)]
    ignored_tickers = [{"ticker": t, "count": n} for t, n in useless_tk.most_common(5)]
    industry_affinity = [{"industry": i, "count": n} for i, n in ind_counts.most_common(8)]

    strats = {str(k): (v or {}) for k, v in (store.all("strategies") or {}).items()}
    strategy_affinity = [
        {"strategy_id": sid, "kind": strats.get(sid, {}).get("kind"),
         "name": strats.get(sid, {}).get("name"), "count": n}
        for sid, n in sid_counts.most_common(5)
    ]
    watchlist_tickers = [str(w or "").strip()
                         for w in (store.get("watchlist", "default") or []) if w][:10]
    trading_affinity = _trading_affinity(store)

    notes = []
    if not clicks and not fb_total:
        notes.append("暂无足够行为，未推断画像调整")
    elif not direction_skew and not fb_total:
        notes.append("行为记录缺少方向/反馈标记，激进度仅部分调整")
    else:
        parts = [f"近{hours:.0f}小时 {clicks} 次点击、{fb_total} 次反馈"]
        if direction_skew:
            parts.append(f"利空占比 {direction_skew['bad_pct']*100:.0f}%")
        if fb_total:
            parts.append(f"有用{useful}/没用{useless}")
        if outcome and outcome.get("samples"):
            parts.append(outcome.get("note") or "")
        notes.append("；".join(parts) + f"，行为画像激进度{aggression_delta:+.2f}")

    return {
        "window_hours": hours, "views": views, "clicks": clicks,
        "focus_tickers": focus_tickers, "direction_skew": direction_skew,
        "aggression_delta": aggression_delta,
        "feedback": {"useful": useful, "useless": useless, "total": fb_total,
                     "delta": feedback_delta},
        "feedback_delta": feedback_delta,
        "outcome": outcome,
        "outcome_delta": outcome_delta,
        "interest_tickers": interest_tickers,
        "interest_industries": interest_industries,
        "ignored_tickers": ignored_tickers,
        "industry_affinity": industry_affinity,
        "watchlist_tickers": watchlist_tickers,
        "trading_affinity": trading_affinity,
        "strategy_affinity": strategy_affinity, "notes": notes,
    }


def behavior_boosts(store=None) -> dict:
    """R→V→D：反馈归因信号（近 N 小时）→ 卡片排序 boost 集合。失败返回空 dict。"""
    from .store import JsonStore

    try:
        store = store or JsonStore()
        beh = compute_behavior_profile(store)
        return {
            "interest_tickers": {x["ticker"] for x in beh.get("interest_tickers") or []},
            "interest_industries": {x["industry"] for x in beh.get("interest_industries") or []},
            "ignored_tickers": {x["ticker"] for x in beh.get("ignored_tickers") or []},
        }
    except Exception as exc:  # noqa: BLE001 — 归因失败不阻塞卡片流
        logger.warning("行为归因信号失败（按空处理）: %s", exc)
        return {}


def behavior_funnel(store=None) -> dict:
    """R→V 效果漏斗：近 N 小时 曝光/点击/有用/没用 → CTR。失败返回零值块。"""
    from .store import JsonStore

    try:
        store = store or JsonStore()
        beh = compute_behavior_profile(store)
        views = int(beh.get("views") or 0)
        clicks = int(beh.get("clicks") or 0)
        useful = int((beh.get("feedback") or {}).get("useful") or 0)
        useless = int((beh.get("feedback") or {}).get("useless") or 0)
        return {
            "window_hours": beh.get("window_hours"),
            "views": views, "clicks": clicks,
            "useful": useful, "useless": useless,
            "ctr": round(clicks / views, 3) if views else None,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("行为漏斗统计失败（按零值处理）: %s", exc)
        return {"window_hours": settings.personalized_behavior_hours,
                "views": 0, "clicks": 0, "useful": 0, "useless": 0, "ctr": None}


def effective_aggression(store=None, profile_key: str = "balanced") -> float:
    """画像基础激进度 + 行为 delta（clamp [0,1]）。O 打分用。"""
    from .personalize import PROFILE_AGGRESSION

    base = PROFILE_AGGRESSION.get(profile_key, 0.5)
    delta = float(compute_behavior_profile(store).get("aggression_delta") or 0.0)
    return round(_clamp(base + delta, 0.0, 1.0), 3)


def profile_view(store=None) -> dict:
    """前端展示视图：基础画像 + 有效激进度 + 行为信号。"""
    from .personalize import PROFILE_AGGRESSION
    from .risk_profiles import get_risk_profile, profile as _profile

    if store is None:
        from .store import JsonStore
        store = JsonStore()

    key = get_risk_profile()
    base = PROFILE_AGGRESSION.get(key, 0.5)
    beh = compute_behavior_profile(store)
    delta = float(beh.get("aggression_delta") or 0.0)
    eff = round(_clamp(base + delta, 0.0, 1.0), 3)
    return {
        "as_of": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base_profile": key,
        "profile_label": _profile(key)["label"],
        "base_aggression": base,
        "effective_aggression": eff,
        "behavior": beh,
        "notes": beh.get("notes") or [],
    }
