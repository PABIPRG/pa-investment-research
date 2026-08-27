# -*- coding: utf-8 -*-
"""自进化闭环：S_shadow → T 归因 → W 升降级/变异 → W→H 回流 + R→S→U→K outcome 版。

架构图里自进化链是 S(真实组合) → T(策略归因) → W(升级/降级/变异) → H(策略池回流) → I 再验证，
以及 R→U→K 的行为→画像增强。真实 S 依赖用户实盘组合，这里用**影子组合替身**：
  影子组合 = 真实行情 + 虚拟资金，逐日记账（`shadow_equity` + `shadows/trades:{sid}`）。
影子替身足够喂完整条闭环：

  S_shadow ─T→ attribution()   整体净值 + 每策略 收益/回撤/平仓胜率/累计盈亏
      │
      ├─T→ W ── 升降级/淘汰（evolve）：nav 超阈值升级、跌破观察线降级 watch、
      │       跌破淘汰线或平仓胜率过低 → retired（不再推荐、不再进影子）
      │
      ├─W─H── 变异回流（mutate）：对升级策略做参数轻变异 + 标的子集 → 新 candidate
      │       写回 strategies 池（H），走既有 E→G→H→I 再验证。W→H 闭环成立。
      │
      └─R→S→U→K  outcome 版（decision_outcome）：用户参与/激活的策略影子 outcome
              → outcome_delta 并入行为画像 aggression_delta（决策被验证则强化，
              决策受挫则纠正）。R→U→K 在 U 上补了 outcome 证据。

三道护栏（设计保证）：
  1. 数据不足（shadow_equity < EVOLVE_MIN_DAYS，默认 5）→ 只出归因报告，不产生动作；
  2. 变异只从「样本外达标 + 影子盈利（升级）」的 active 策略出发，参数小步微扰；
  3. 升降级阈值全部可配置（EVOLVE_*），每次 run 返回 actions 清单，apply=False 只预览。

生命周期存策略记录的 `evolve` 字段：`{state: active|watch|retired, tier:1|2, ...}`。
- watch（降级观察）：status 仍 active，影子继续记账积累证据，但不再进推荐（O 过滤）。
- retired（淘汰）：status→retired，不再推荐、不再进影子。
- tier=2（升级）：标记高置信，之后不再重复升级/变异（冷却期内）。
"""

import hashlib
import json
import secrets
import threading
import time

from .config import settings
from .store import JsonStore
from .strategies import _str2md5

# 可变异策略种类（与技术规则 DSL 对齐；LLM 规则降级生成的也能变）
_MUTABLE_KINDS = ("ma_cross", "rsi_reversal", "momentum", "breakout", "bollinger", "volume_breakout")
_PREVIEW_COLLECTION = "evolution_previews"
_CURRENT_PREVIEW_KEY = "_current"
_PREVIEW_TTL_SECONDS = 30 * 60
_EVOLUTION_LOCK = threading.Lock()


class EvolutionPreviewConflict(RuntimeError):
    """待确认预案已失效、已提交或与当前业务状态不一致。"""


def _source_version(store: JsonStore) -> str:
    """绑定所有会影响进化动作的持久化输入与阈值。"""
    payload = {
        "strategies": store.all("strategies") or {},
        "shadow_equity": store.all("shadow_equity") or {},
        "shadows": store.all("shadows") or {},
        "settings": {
            "min_days": settings.evolve_min_days,
            "retire_nav": settings.evolve_retire_nav,
            "retire_closed_win": settings.evolve_retire_closed_win,
            "demote_nav": settings.evolve_demote_nav,
            "promote_nav": settings.evolve_promote_nav,
            "mutate_cooldown_days": settings.evolve_mutate_cooldown_days,
            "mutate_branches": settings.evolve_mutate_branches,
        },
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _public_preview(record: dict) -> dict:
    return {key: value for key, value in record.items() if not key.startswith("_")}


def _store_preview(store: JsonStore, response: dict, state_version: str) -> dict:
    token = secrets.token_hex(16)
    now = time.time()
    record = {
        **response,
        "preview_token": token,
        "state_version": state_version,
        "preview_status": "pending",
        "expires_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now + _PREVIEW_TTL_SECONDS)),
        "_expires_at_epoch": now + _PREVIEW_TTL_SECONDS,
    }
    previous = store.get(_PREVIEW_COLLECTION, _CURRENT_PREVIEW_KEY)
    if isinstance(previous, str):
        old = store.get(_PREVIEW_COLLECTION, previous)
        if isinstance(old, dict) and old.get("preview_status") == "pending":
            store.update(_PREVIEW_COLLECTION, previous, preview_status="superseded")
    store.set(_PREVIEW_COLLECTION, token, record)
    store.set(_PREVIEW_COLLECTION, _CURRENT_PREVIEW_KEY, token)
    return _public_preview(record)


def current_preview(store: JsonStore | None = None) -> dict:
    """返回模型可读取的当前待确认预案及其有效性，不暴露内部存储字段。"""
    store = store or JsonStore()
    token = store.get(_PREVIEW_COLLECTION, _CURRENT_PREVIEW_KEY)
    record = store.get(_PREVIEW_COLLECTION, token) if isinstance(token, str) else None
    if not isinstance(record, dict) or record.get("preview_status") != "pending":
        return {"preview_status": "none", "actions": [], "count": 0}
    result = _public_preview(record)
    if time.time() > float(record.get("_expires_at_epoch") or 0):
        return {**result, "preview_status": "expired", "valid": False}
    valid = record.get("state_version") == _source_version(store)
    return {**result, "preview_status": "pending" if valid else "stale", "valid": valid}


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _parse_ts(ts) -> float | None:
    """'%Y-%m-%d %H:%M:%S' → epoch；解析失败返回 None。"""
    if not ts:
        return None
    try:
        return time.mktime(time.strptime(str(ts).strip(), "%Y-%m-%d %H:%M:%S"))
    except (ValueError, TypeError):
        return None


# ---- 影子数据读取 ---------------------------------------------------------


def _shadow_series(store: JsonStore) -> tuple[list[dict], int]:
    """shadow_equity 按日期升序 → ( [{date, overall_nav, strategies{sid:{nav,…}}}], days )。

    overall_nav 非法/≤0 的日期跳过（幂等跑当日只留一笔）。"""
    eq = store.all("shadow_equity") or {}
    days: list[dict] = []
    for d in sorted(eq.keys()):
        rec = eq[d] or {}
        try:
            ov = float(rec.get("overall_nav") or 0.0)
        except (TypeError, ValueError):
            continue
        if ov > 0:
            days.append(
                {
                    "date": d,
                    "overall_nav": ov,
                    "strategies": rec.get("strategies") or {},
                }
            )
    return days, len(days)


def _per_strategy_series(days: list[dict]) -> dict[str, list[dict]]:
    """每策略影子净值序列 → {sid: [{date, nav}]}（正数只收，非法跳过）。"""
    out: dict[str, list[dict]] = {}
    for d in days:
        for sid, rec in (d.get("strategies") or {}).items():
            try:
                nav = float((rec or {}).get("nav") or 0.0)
            except (TypeError, ValueError):
                continue
            if nav > 0:
                out.setdefault(sid, []).append({"date": d["date"], "nav": nav})
    return out


def _max_drawdown(navs: list[float]) -> float | None:
    if len(navs) < 2:
        return None
    peak = navs[0]
    mdd = 0.0
    for v in navs:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, (peak - v) / peak)
    return mdd


def _closed_trades(store: JsonStore, sid: str) -> list[dict]:
    rows = store.get("shadows", f"trades:{sid}") or []
    return [t for t in rows if isinstance(t, dict)]


# ---- S→T 归因 ------------------------------------------------------------


def attribution(store: JsonStore | None = None) -> dict:
    """S→T：影子组合整体归因 + 每策略贡献分解（只读，永不写库）。"""
    store = store or JsonStore()
    days, n = _shadow_series(store)
    base = {
        "as_of": _now(),
        "days_of_data": n,
        "min_days": settings.evolve_min_days,
        "data_note": (
            None
            if n >= settings.evolve_min_days
            else f"影子净值仅 {n} 日，需累积至 {settings.evolve_min_days} 日才开始升降级/变异"
        ),
    }
    if not days:
        return {**base, "overall": None, "strategies": []}
    ov0, ovN = days[0]["overall_nav"], days[-1]["overall_nav"]
    total_ret = ovN / ov0 - 1 if ov0 > 0 else 0.0
    overall = {
        "start_nav": ov0,
        "end_nav": ovN,
        "return_pct": round(total_ret * 100, 2),
        "max_drawdown_pct": (
            round(_max_drawdown([d["overall_nav"] for d in days]) * 100, 2)
            if len(days) >= 2
            else None
        ),
        "strategy_count": len({sid for d in days for sid in (d.get("strategies") or {})}),
    }
    strats = store.all("strategies") or {}
    series = _per_strategy_series(days)
    per = []
    for sid, pts in series.items():
        s = strats.get(sid) or {}
        navs = [p["nav"] for p in pts]
        s_ret = navs[-1] / navs[0] - 1 if len(navs) >= 2 and navs[0] > 0 else None
        trades = _closed_trades(store, sid)
        closed = len(trades)
        wins = sum(1 for t in trades if float(t.get("ret_pct") or 0) > 0)
        cum_ret = sum(float(t.get("ret_pct") or 0) for t in trades)
        per.append(
            {
                "strategy_id": sid,
                "name": s.get("name"),
                "kind": s.get("kind"),
                "status": s.get("status"),
                "symbols": s.get("symbols"),
                "nav": navs[-1],
                "return_pct": round(s_ret * 100, 2) if s_ret is not None else None,
                "max_drawdown_pct": (
                    round(_max_drawdown(navs) * 100, 2) if len(navs) >= 2 else None
                ),
                "closed_trades": closed,
                "closed_win_rate_pct": round(wins / closed * 100, 1) if closed else None,
                "closed_cum_return_pct": round(cum_ret, 2) if closed else None,
            }
        )
    per.sort(key=lambda x: -(x["return_pct"] if x["return_pct"] is not None else -999))
    return {**base, "overall": overall, "strategies": per}


# ---- W 升降级 / 变异（T→W→H）-------------------------------------------


def _pick_variant(opts: list, cur, branch: int):
    """从候选集取一个与当前值不同的变体（branch 决定向前/向后偏移）。"""
    try:
        i = opts.index(cur)
    except ValueError:
        i = 1 if cur <= opts[0] else len(opts) - 2
    j = i + (1 if branch else -1)
    j = max(0, min(len(opts) - 1, j))
    if j == i:
        j = (i + 1) % len(opts)
    return opts[j]


def _mutate_params(kind: str, base: dict | None, branch: int) -> dict:
    """技术规则参数轻变异（小步长，保持与父策略同构）。"""
    base = dict(base or {})
    if kind == "ma_cross":
        fast_opts, slow_opts = [3, 5, 8, 13], [15, 21, 34]
        f = _pick_variant(fast_opts, int(base.get("fast", 5)), branch)
        s = _pick_variant(slow_opts, int(base.get("slow", 20)), branch)
        if f >= s:
            s = min(s + 8, 34)
        return {"fast": f, "slow": s}
    if kind == "rsi_reversal":
        n = _pick_variant([7, 10, 14, 21], int(base.get("n", 14)), branch)
        os_ = _pick_variant([25, 30, 35], float(base.get("oversold", 30)), branch)
        ob = _pick_variant([65, 70, 75], float(base.get("overbought", 70)), branch)
        if os_ >= ob:
            ob = min(os_ + 40, 80)
        return {"n": n, "oversold": os_, "overbought": ob}
    if kind == "breakout":
        return {"n": _pick_variant([10, 20, 30, 40], int(base.get("n", 20)), branch)}
    if kind == "bollinger":
        n = _pick_variant([10, 20, 30], int(base.get("n", 20)), branch)
        k = _pick_variant([1.5, 2.0, 2.5, 3.0], float(base.get("k", 2.0)), branch)
        return {"n": n, "k": k}
    if kind == "volume_breakout":
        n = _pick_variant([10, 20, 30], int(base.get("n", 20)), branch)
        vm = _pick_variant([1.2, 1.5, 2.0, 2.5], float(base.get("vol_mult", 1.5)), branch)
        return {"n": n, "vol_mult": vm}
    return {"n": _pick_variant([5, 10, 20], int(base.get("n", 10)), branch)}


def _mutate_symbols(symbols, branch: int) -> list[str]:
    syms = [str(x) for x in (symbols or []) if str(x)]
    if not syms:
        return []
    if branch == 0 or len(syms) <= 1:
        return list(syms)
    return syms[: min(2, len(syms))]


def _child_id(parent: str, kind: str, params: dict, branch: int) -> str:
    key = f"{parent}:{kind}:{hashlib.md5(str(params).encode()).hexdigest()}:{branch}"
    return "strat-" + _str2md5(key)


def evolve(
    store: JsonStore | None = None,
    apply: bool = False,
    preview_token: str | None = None,
) -> dict:
    """T→W→H 主循环。写入只能应用已绑定当时状态的精确预案。

    规则（护栏 3 可配置）：
      - nav ≤ retire_nav          → retired（淘汰）
      - 平仓胜率 < 阈值 且 ≥3 笔平仓 → retired
      - nav ≤ demote_nav          → watch（降级观察，仍跑影子、不推荐）
      - nav ≥ promote_nav         → tier=2（升级）+ 若样本外达标且在冷却期外 → 变异回流候选
    """
    store = store or JsonStore()
    if apply:
        return _apply_preview(store, preview_token)

    with _EVOLUTION_LOCK:
        version_before = _source_version(store)
        response = _build_preview(store)
        version_after = _source_version(store)
        if version_before != version_after:
            raise EvolutionPreviewConflict("进化数据在生成预案时已变化，请重新生成后再确认")
        return _store_preview(store, response, version_after)


def _build_preview(store: JsonStore) -> dict:
    days, n = _shadow_series(store)
    resp = {
        "as_of": _now(),
        "days_of_data": n,
        "min_days": settings.evolve_min_days,
        "applied": False,
        "count": 0,
        "actions": [],
    }
    if n < settings.evolve_min_days:
        resp["status"] = "waiting_data"
        resp["data_note"] = (
            f"影子净值仅 {n} 日，需累积至 {settings.evolve_min_days} 日才执行升降级/变异；"
            f"当前可先看 /evolution/attribution 归因报告"
        )
        return resp
    resp["status"] = "ready"
    actions: list[dict] = []
    attr = attribution(store)
    strats = store.all("strategies") or {}
    now = time.time()
    cooldown = settings.evolve_mutate_cooldown_days * 86400
    for s in attr["strategies"]:
        sid = s["strategy_id"]
        rec = strats.get(sid) or {}
        if not isinstance(rec, dict) or rec.get("status") != "active":
            continue
        ev = rec.get("evolve") or {}
        nav = s["nav"]
        winr = s["closed_win_rate_pct"]
        closed = s["closed_trades"] or 0
        # 1) 淘汰（净值跌破淘汰线）
        if nav is not None and nav <= settings.evolve_retire_nav and ev.get("state") != "retired":
            actions.append(
                {
                    "type": "retire",
                    "sid": sid,
                    "from": ev.get("state") or "active",
                    "to": "retired",
                    "reason": f"影子净值 {nav:.4f} ≤ 淘汰线 {settings.evolve_retire_nav}",
                }
            )
            continue
        # 2) 淘汰（平仓胜率过低，样本量充足）
        if (
            winr is not None
            and winr < settings.evolve_retire_closed_win * 100
            and closed >= 3
            and ev.get("state") != "retired"
        ):
            actions.append(
                {
                    "type": "retire",
                    "sid": sid,
                    "from": ev.get("state") or "active",
                    "to": "retired",
                    "reason": (
                        f"平仓胜率 {winr:.0f}% < {settings.evolve_retire_closed_win * 100:.0f}%"
                        f"（已平 {closed} 笔），影子表现不可靠"
                    ),
                }
            )
            continue
        # 3) 降级观察
        if nav is not None and nav <= settings.evolve_demote_nav and ev.get("state") == "active":
            actions.append(
                {
                    "type": "demote",
                    "sid": sid,
                    "from": "active",
                    "to": "watch",
                    "reason": (
                        f"影子净值 {nav:.4f} ≤ 观察线 {settings.evolve_demote_nav}，"
                        f"降级为观察（停止推荐、继续跑影子）"
                    ),
                }
            )
            continue
        # 4) 升级 + 变异回流
        if nav is not None and nav >= settings.evolve_promote_nav and int(ev.get("tier") or 1) < 2:
            actions.append(
                {
                    "type": "promote",
                    "sid": sid,
                    "from": f"tier{ev.get('tier') or 1}",
                    "to": "tier2",
                    "reason": f"影子净值 {nav:.4f} ≥ 升级线 {settings.evolve_promote_nav}",
                }
            )
            oos = ((rec.get("backtest") or {}).get("out_of_sample") or {})
            oos_ok = True
            try:
                wr = oos.get("win_rate_pct")
                oos_ok = wr is None or float(wr) >= 50
            except (TypeError, ValueError):
                oos_ok = True
            last_m = ev.get("mutated_at")
            cooled = (not last_m) or (now - (_parse_ts(last_m) or now) > cooldown)
            if oos_ok and cooled:
                kind = rec.get("kind")
                for b in range(settings.evolve_mutate_branches):
                    if kind not in _MUTABLE_KINDS:
                        break
                    params = _mutate_params(kind, rec.get("params"), b)
                    nsid = _child_id(sid, kind, params, b)
                    if nsid in strats:
                        continue  # 已回流过，不重复
                    actions.append(
                        {
                            "type": "mutate",
                            "parent": sid,
                            "sid": nsid,
                            "kind": kind,
                            "direction": rec.get("direction"),
                            "symbols": _mutate_symbols(rec.get("symbols"), b),
                            "params": params,
                            "name": f"变体·{sid[:8]}·b{b + 1}",
                            "reason": (
                                f"由升级策略 {sid} 变异（{kind} 参数 {params}）→ "
                                f"candidate 回流策略池待回测验证"
                            ),
                        }
                    )
    resp["count"] = len(actions)
    resp["actions"] = actions
    return resp


def _apply_preview(store: JsonStore, preview_token: str | None) -> dict:
    if not isinstance(preview_token, str) or not preview_token:
        raise EvolutionPreviewConflict("确认应用必须携带预览令牌，请先重新生成预案")
    with _EVOLUTION_LOCK:
        record = store.get(_PREVIEW_COLLECTION, preview_token)
        if not isinstance(record, dict):
            raise EvolutionPreviewConflict("预案不存在，请重新生成")
        preview_status = record.get("preview_status")
        if preview_status != "pending":
            raise EvolutionPreviewConflict(f"预案已{preview_status or '失效'}，不能重复提交")
        current = store.get(_PREVIEW_COLLECTION, _CURRENT_PREVIEW_KEY)
        if current != preview_token:
            store.update(_PREVIEW_COLLECTION, preview_token, preview_status="superseded")
            raise EvolutionPreviewConflict("已生成更新的预案，请确认最新预案")
        if time.time() > float(record.get("_expires_at_epoch") or 0):
            store.update(_PREVIEW_COLLECTION, preview_token, preview_status="expired")
            raise EvolutionPreviewConflict("预案已过期，请重新生成")
        if record.get("state_version") != _source_version(store):
            store.update(_PREVIEW_COLLECTION, preview_token, preview_status="stale")
            raise EvolutionPreviewConflict("策略或影子证据已变化，未应用旧预案；请重新生成")

        actions = record.get("actions") or []
        store.update(_PREVIEW_COLLECTION, preview_token, preview_status="applying")
        try:
            for action in actions:
                _apply_action(store, action)
        except Exception:
            store.update(_PREVIEW_COLLECTION, preview_token, preview_status="failed")
            raise
        applied_at = _now()
        store.update(
            _PREVIEW_COLLECTION,
            preview_token,
            preview_status="applied",
            applied=True,
            applied_at=applied_at,
        )
        store.delete(_PREVIEW_COLLECTION, _CURRENT_PREVIEW_KEY)
        return {
            **_public_preview(record),
            "preview_status": "applied",
            "applied": True,
            "applied_at": applied_at,
        }


def _apply_action(store: JsonStore, a: dict) -> None:
    """把单个 action 落到 strategies 集合（写库）。"""
    ts = _now()
    if a["type"] in ("promote", "demote", "retire"):
        sid = a["sid"]
        def apply_transition(current):
            rec = dict(current or {})
            ev = dict(rec.get("evolve") or {})
            if a["type"] == "promote":
                ev.update({"tier": 2, "state": "active", "updated_at": ts, "note": a["reason"]})
            elif a["type"] == "demote":
                ev.update({"state": "watch", "updated_at": ts, "note": a["reason"]})
            else:  # retire
                ev.update({"state": "retired", "updated_at": ts, "note": a["reason"]})
                rec["status"] = "retired"
                rec["verification_status"] = "archived"
                rec["retire_reason"] = a["reason"]
            rec["evolve"] = ev
            return rec

        store.mutate("strategies", sid, apply_transition)
    elif a["type"] == "mutate":
        generation = 1

        def mark_parent(current):
            nonlocal generation
            parent = dict(current or {})
            generation = int(parent.get("generation") or 0) + 1
            pev = dict(parent.get("evolve") or {})
            pev["mutated_at"] = ts
            parent["evolve"] = pev
            return parent

        store.mutate("strategies", a["parent"], mark_parent)
        rec = {
            "id": a["sid"],
            "name": a["name"],
            "kind": a["kind"],
            "direction": a["direction"],
            "symbols": a["symbols"],
            "params": a["params"],
            "status": "candidate",
            "verification_status": "pending",
            "source": "evolution",
            "mutated_from": a["parent"],
            "generation": generation,
            "backtest": {},
            "evolve": {
                "state": "active",
                "tier": 1,
                "updated_at": ts,
                "note": f"由 {a['parent']} 变异生成，待回测验证（W→H 回流）",
            },
            "created_at": ts,
        }
        store.set("strategies", a["sid"], rec)


def status(store: JsonStore | None = None) -> dict:
    """闭环状态：数据是否就绪 + 生命周期统计。"""
    store = store or JsonStore()
    _, n = _shadow_series(store)
    strats = store.all("strategies") or {}
    counts = {
        "candidate": 0,
        "active": 0,
        "watch": 0,
        "retired": 0,
        "rejected": 0,
        "mutated": 0,
    }
    for s in strats.values():
        if not isinstance(s, dict):
            continue
        st = s.get("status")
        ev_state = (s.get("evolve") or {}).get("state")
        if s.get("source") == "evolution":
            counts["mutated"] += 1
        if st == "candidate":
            counts["candidate"] += 1
        elif st == "active":
            counts["active"] += 1
            if ev_state == "watch":
                counts["watch"] += 1
            elif ev_state == "retired":
                counts["retired"] += 1
        elif st == "retired":
            counts["retired"] += 1
        elif st == "rejected":
            counts["rejected"] += 1
    ready = n >= settings.evolve_min_days
    return {
        "as_of": _now(),
        "days_of_data": n,
        "min_days": settings.evolve_min_days,
        "ready": ready,
        "counts": counts,
        "note": (
            None
            if ready
            else f"影子净值仅 {n} 日，自进化待累积至 {settings.evolve_min_days} 日"
        ),
    }


# ---- R→S→U→K outcome 版（决策受验证/受挫 → 行为画像修正）---------------


def decision_outcome(store: JsonStore | None = None) -> dict:
    """R→S→U→K outcome 归因：用户参与（点击/反馈）或激活的策略 → 影子 outcome → outcome_delta。

    - 参与 = 近 N 小时 behavior 里带 strategy_id 的 click/feedback + 所有 active 策略（激活=决策）。
    - 只有「仍在 active」的策略参与计算（watch 算 active，retired 不参与）。
    - delta = clamp(0.08 × 参与策略平均影子收益, ±0.05)：决策被验证（盈利）→ 轻微上调行为激进度；
      决策受挫（亏损）→ 轻微下调。数据不足（<2 日影子）或无样本 → delta=0 + note。
    """
    store = store or JsonStore()
    days, n = _shadow_series(store)
    base = {
        "delta": 0.0,
        "engaged": 0,
        "samples": 0,
        "avg_return_pct": None,
        "note": f"影子净值 {n} 日，不足 2 日不做 outcome 归因",
    }
    if n < 2:
        return base
    engaged: set[str] = set()
    win = time.time() - settings.personalized_behavior_hours * 3600
    for r in store.get("behavior", "default") or []:
        if not isinstance(r, dict):
            continue
        ts = _parse_ts(r.get("ts") or r.get("server_ts"))
        if ts is None or ts < win:
            continue
        if r.get("action") not in ("click", "feedback"):
            continue
        sid = str((r.get("meta") or {}).get("strategy_id") or "").strip()
        if sid:
            engaged.add(sid)
    strats = store.all("strategies") or {}
    for s in strats.values():
        if isinstance(s, dict) and s.get("status") == "active":
            engaged.add(s.get("id"))
    series = _per_strategy_series(days)
    rets: list[float] = []
    for sid in engaged:
        s = strats.get(sid) or {}
        if not isinstance(s, dict) or s.get("status") != "active":
            continue
        seq = [p["nav"] for p in series.get(sid, []) if p.get("nav")]
        if len(seq) >= 2 and seq[0] > 0:
            rets.append(seq[-1] / seq[0] - 1)
    if not rets:
        return {
            **base,
            "engaged": len(engaged),
            "note": "参与策略无 ≥2 日影子净值，暂无 outcome 归因",
        }
    avg = sum(rets) / len(rets)
    delta = round(max(-0.05, min(0.05, 0.08 * avg)), 3)
    return {
        "delta": delta,
        "engaged": len(engaged),
        "samples": len(rets),
        "avg_return_pct": round(avg * 100, 2),
        "note": (
            f"参与 {len(engaged)} 个 active 策略影子均收益 {avg * 100:.1f}%，"
            f"outcome 修正激进度 {delta:+.3f}"
        ),
    }
