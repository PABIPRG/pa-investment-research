# -*- coding: utf-8 -*-
"""本地学习事实、治理与确定性偏好复盘。

本模块只处理经过白名单约束的产品交互。行为证据描述研究兴趣，不参与风险
承受能力、风险预算、预警严重度或策略生命周期决策。
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .config import settings

SCHEMA_VERSION = 1
RULE_VERSION = "local-preference-v1"
DEFAULT_RETENTION_DAYS = 90
DEFAULT_EVENT_CAP = 2_000
MAX_BATCH_SIZE = 50

ALLOWED_ACTIONS = frozenset({
    "page_view", "impression", "open", "analyze", "follow", "unfollow",
})
ALLOWED_SURFACES = frozenset({
    "dashboard", "search", "opportunity", "stock_detail", "portfolio",
    "strategy", "evolution", "industry", "reports", "assistant",
})
ALLOWED_TARGET_TYPES = frozenset({
    "page", "event", "risk", "strategy", "security", "portfolio",
    "industry", "report",
})
ALLOWED_CONTEXT_KEYS = frozenset({
    "ticker", "industries", "strategy_id", "direction", "bucket",
    "event_type", "risk_source", "risk_severity", "analysis_kind",
    "position", "reason_codes",
})

_LIST_CONTEXT_KEYS = frozenset({"industries", "reason_codes"})
_STRING_CONTEXT_KEYS = ALLOWED_CONTEXT_KEYS - _LIST_CONTEXT_KEYS - {"position"}
_SAFE_TEXT = re.compile(r"^[^\x00-\x1f\x7f]{1,120}$")
_OPAQUE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$")
_TICKER_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$")
_EVENT_ID = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")
_CONTEXT_ENUMS = {
    "direction": frozenset({"利好", "利空", "中性"}),
    "bucket": frozenset({"holdings", "watchlist", "strategy", "fresh", "all"}),
    "event_type": frozenset({
        "公告", "业绩", "价格异动", "政策", "产业", "合作", "评级", "宏观", "相关", "其他",
    }),
    "risk_source": frozenset({"portfolio", "shadow", "event", "profile"}),
    "risk_severity": frozenset({"高", "中", "低"}),
    "analysis_kind": frozenset({
        "stock", "portfolio", "watch", "strategy", "shadow", "evolution",
        "reports", "industry", "prompt",
    }),
}
_ACTION_LABELS = {
    "page_view": "访问",
    "impression": "看到",
    "open": "打开",
    "analyze": "带入分析",
    "follow": "关注",
    "unfollow": "取消关注",
    "feedback:useful": "标记值得关注",
    "feedback:useless": "标记减少此类",
}
_TARGET_LABELS = {
    "page": "页面", "event": "事件", "risk": "风险", "strategy": "策略",
    "security": "证券", "portfolio": "组合", "industry": "行业", "report": "报告",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _format_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_ts(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            return datetime.fromisoformat(raw[:-1] + "+00:00").astimezone(timezone.utc)
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        try:
            return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _clean_string(value: Any, *, field: str, max_length: int = 120) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > max_length or not _SAFE_TEXT.fullmatch(cleaned):
        raise ValueError(f"{field} 必须是 1-{max_length} 个不含控制字符的字符")
    return cleaned


def _clean_identifier(value: Any, *, field: str, ticker: bool = False) -> str:
    cleaned = _clean_string(value, field=field, max_length=32 if ticker else 120)
    pattern = _TICKER_IDENTIFIER if ticker else _OPAQUE_IDENTIFIER
    if not pattern.fullmatch(cleaned):
        raise ValueError(f"{field} 必须是结构化标识，不能是自由文本")
    return cleaned


def sanitize_context(context: dict | None) -> dict:
    """严格投影事件上下文；未知字段直接拒绝，避免自由元数据泄漏。"""
    if context is None:
        return {}
    if not isinstance(context, dict):
        raise ValueError("context 必须是对象")
    unknown = sorted(set(context) - ALLOWED_CONTEXT_KEYS)
    if unknown:
        raise ValueError(f"context 包含未允许字段: {', '.join(unknown)}")

    out: dict[str, Any] = {}
    for key, value in context.items():
        if value is None:
            continue
        if key == "ticker":
            out[key] = _clean_identifier(value, field="context.ticker", ticker=True)
            continue
        if key == "strategy_id":
            out[key] = _clean_identifier(value, field="context.strategy_id")
            continue
        if key in _CONTEXT_ENUMS:
            cleaned = _clean_string(value, field=f"context.{key}", max_length=24)
            if cleaned not in _CONTEXT_ENUMS[key]:
                raise ValueError(f"context.{key} 不在允许范围")
            out[key] = cleaned
            continue
        if key in _LIST_CONTEXT_KEYS:
            if not isinstance(value, list) or len(value) > 10:
                raise ValueError(f"context.{key} 必须是最多 10 项的数组")
            if key == "reason_codes":
                cleaned = [_clean_identifier(item, field="context.reason_codes") for item in value]
            else:
                cleaned = [
                    _clean_string(item, field="context.industries", max_length=40)
                    for item in value
                ]
            out[key] = list(dict.fromkeys(cleaned))
            continue
        if key == "position":
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000:
                raise ValueError("context.position 必须是 0-1000 的整数")
            out[key] = value
    return out


def _settings(store) -> dict:
    saved = store.get("preferences", "local_learning") or {}
    enabled = saved.get("enabled", True)
    return {
        "enabled": enabled if isinstance(enabled, bool) else True,
        "retention_days": int(getattr(settings, "local_learning_retention_days", DEFAULT_RETENTION_DAYS)),
        "event_cap": int(getattr(settings, "local_learning_event_cap", DEFAULT_EVENT_CAP)),
    }


def _normalize_event(raw: dict, occurred_at: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("事件必须是对象")
    allowed = {
        "event_id", "schema_version", "action", "surface", "target_type",
        "target_id", "session_id", "context",
    }
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise ValueError(f"事件包含未允许字段: {', '.join(unknown)}")
    event_id = _clean_string(raw.get("event_id"), field="event_id", max_length=80)
    session_id = _clean_string(raw.get("session_id"), field="session_id", max_length=80)
    if not _EVENT_ID.fullmatch(event_id):
        raise ValueError("event_id 格式非法")
    if not _EVENT_ID.fullmatch(session_id):
        raise ValueError("session_id 格式非法")
    if raw.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"schema_version 必须为 {SCHEMA_VERSION}")
    action = raw.get("action")
    surface = raw.get("surface")
    target_type = raw.get("target_type")
    if action not in ALLOWED_ACTIONS:
        raise ValueError("action 不在允许范围")
    if surface not in ALLOWED_SURFACES:
        raise ValueError("surface 不在允许范围")
    if target_type not in ALLOWED_TARGET_TYPES:
        raise ValueError("target_type 不在允许范围")
    return {
        "event_id": event_id,
        "schema_version": SCHEMA_VERSION,
        "action": action,
        "surface": surface,
        "target_type": target_type,
        "target_id": _clean_identifier(raw.get("target_id"), field="target_id"),
        "session_id": session_id,
        "context": sanitize_context(raw.get("context")),
        "occurred_at": occurred_at,
    }


def _within_retention(rows: list, cutoff: datetime) -> list[dict]:
    retained: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ts = _parse_ts(row.get("occurred_at") or row.get("server_ts") or row.get("ts"))
        if ts is not None and ts >= cutoff:
            retained.append(row)
    return retained


def _prune_behavior_document(document: dict, cutoff: datetime, cap: int) -> dict:
    """跨新事件与兼容记录执行同一个时间窗口和总量上限。"""
    data = dict(document or {})
    tagged: list[tuple[datetime, int, str, dict]] = []
    order = 0
    for key in ("events", "default"):
        for row in _within_retention(list(data.get(key) or []), cutoff):
            ts = _parse_ts(row.get("occurred_at") or row.get("server_ts") or row.get("ts"))
            if ts is None:
                continue
            tagged.append((ts, order, key, row))
            order += 1
    tagged.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    kept = tagged[:max(0, cap)]
    data["events"] = [row for _, _, key, row in kept if key == "events"]
    data["default"] = [row for _, _, key, row in kept if key == "default"]
    return data


def record_events(store, events: list[dict], *, now: Callable[[], datetime] = _utc_now) -> dict:
    """批量写入事件，使用服务端时间、事件幂等和双重保留。"""
    if not isinstance(events, list) or not 1 <= len(events) <= MAX_BATCH_SIZE:
        raise ValueError(f"events 必须包含 1-{MAX_BATCH_SIZE} 条记录")
    state = _settings(store)
    if not state["enabled"]:
        return {"ok": True, "stored": 0, "duplicates": 0, "ignored": len(events), "reason": "paused"}

    current_time = now().astimezone(timezone.utc)
    server_ts = _format_ts(current_time)
    normalized = [_normalize_event(event, server_ts) for event in events]
    counts = {"stored": 0, "duplicates": 0}
    cutoff = current_time - timedelta(days=state["retention_days"])

    def transform(document):
        data = _prune_behavior_document(document, cutoff, state["event_cap"])
        existing = list(data.get("events") or [])
        known = {str(row.get("event_id")) for row in existing if row.get("event_id")}
        fresh = []
        for event in normalized:
            if event["event_id"] in known:
                counts["duplicates"] += 1
                continue
            known.add(event["event_id"])
            fresh.append(event)
        counts["stored"] = len(fresh)
        data["events"] = fresh + existing
        return _prune_behavior_document(data, cutoff, state["event_cap"])

    stored_document = store.mutate_document("behavior", transform)
    return {
        "ok": True,
        "stored": counts["stored"],
        "duplicates": counts["duplicates"],
        "ignored": 0,
        "record_count": len(stored_document.get("events") or [])
        + len(stored_document.get("default") or []),
        "server_ts": server_ts,
    }


def record_legacy_interaction(
    store,
    card_id: str,
    action: str,
    meta: dict | None = None,
    *,
    now: Callable[[], datetime] = _utc_now,
) -> dict:
    """兼容旧 view/click 接口；服务端时间和同一治理规则仍然生效。"""
    if action not in {"view", "click"}:
        raise ValueError("action 必须是 view 或 click")
    state = _settings(store)
    clean_id = _clean_identifier(card_id, field="card_id")
    if not state["enabled"]:
        return {"ok": True, "stored": False, "reason": "paused", "action": action, "card_id": clean_id}
    current_time = now().astimezone(timezone.utc)
    timestamp = _format_ts(current_time)
    rec = {
        "card_id": clean_id,
        "action": action,
        "ts": timestamp,
        "server_ts": timestamp,
        "meta": sanitize_context(meta),
    }
    cutoff = current_time - timedelta(days=state["retention_days"])
    def transform(document):
        data = _prune_behavior_document(document, cutoff, state["event_cap"])
        data["default"] = [rec] + list(data.get("default") or [])
        return _prune_behavior_document(data, cutoff, state["event_cap"])

    store.mutate_document("behavior", transform)
    return {"ok": True, "stored": True, "action": action, "card_id": rec["card_id"]}


def record_feedback(
    store,
    card_id: str,
    sentiment: str,
    meta: dict | None = None,
    *,
    now: Callable[[], datetime] = _utc_now,
) -> dict:
    """记录当前显式反馈；同一对象最后值覆盖，避免纠正被重复计权。"""
    if sentiment not in {"useful", "useless"}:
        raise ValueError("sentiment 必须是 useful 或 useless")
    state = _settings(store)
    clean_id = _clean_identifier(card_id, field="card_id")
    if not state["enabled"]:
        return {"ok": True, "stored": False, "reason": "paused", "sentiment": sentiment, "card_id": clean_id}
    current_time = now().astimezone(timezone.utc)
    timestamp = _format_ts(current_time)
    rec = {
        "card_id": clean_id,
        "action": "feedback",
        "sentiment": sentiment,
        "ts": timestamp,
        "server_ts": timestamp,
        "meta": sanitize_context(meta),
    }
    cutoff = current_time - timedelta(days=state["retention_days"])
    replaced = False

    def transform(document):
        nonlocal replaced
        data = _prune_behavior_document(document, cutoff, state["event_cap"])
        rows = list(data.get("default") or [])
        kept = []
        for row in rows:
            if row.get("action") == "feedback" and str(row.get("card_id") or "") == clean_id:
                replaced = True
                continue
            kept.append(row)
        data["default"] = [rec] + kept
        return _prune_behavior_document(data, cutoff, state["event_cap"])

    store.mutate_document("behavior", transform)
    return {
        "ok": True,
        "stored": True,
        "replaced": replaced,
        "sentiment": sentiment,
        "card_id": clean_id,
    }


def local_learning_status(store, *, now: Callable[[], datetime] = _utc_now) -> dict:
    state = _settings(store)
    current_time = now().astimezone(timezone.utc)
    cutoff = current_time - timedelta(days=state["retention_days"])
    document = store.mutate_document(
        "behavior",
        lambda value: _prune_behavior_document(value, cutoff, state["event_cap"]),
    )
    events = [row for row in (document.get("events") or []) if isinstance(row, dict)]
    feedback = [
        row for row in (document.get("default") or [])
        if isinstance(row, dict) and row.get("action") == "feedback"
    ]
    interactions = [
        row for row in (document.get("default") or [])
        if isinstance(row, dict) and row.get("action") in {"view", "click"}
    ]
    return {
        "enabled": state["enabled"],
        "storage": "local",
        "schema_version": SCHEMA_VERSION,
        "rule_version": RULE_VERSION,
        "retention_days": state["retention_days"],
        "event_cap": state["event_cap"],
        "event_count": len(events),
        "interaction_count": len(interactions),
        "feedback_count": len(feedback),
        "record_count": len(events) + len(interactions) + len(feedback),
    }


def update_local_learning(store, enabled: bool, *, now: Callable[[], datetime] = _utc_now) -> dict:
    if not isinstance(enabled, bool):
        raise ValueError("enabled 必须是布尔值")
    current_time = now().astimezone(timezone.utc)
    current = store.get("preferences", "local_learning") or {}
    value = {
        **(current if isinstance(current, dict) else {}),
        "enabled": enabled,
        "updated_at": _format_ts(current_time),
    }
    store.set("preferences", "local_learning", value)
    return local_learning_status(store, now=lambda: current_time)


def clear_local_learning(store) -> dict:
    counts = {"events": 0, "interactions": 0, "feedback": 0}

    def transform(document):
        data = dict(document or {})
        events = list(data.get("events") or [])
        legacy = list(data.get("default") or [])
        counts["events"] = len(events)
        counts["feedback"] = sum(
            1 for row in legacy if isinstance(row, dict) and row.get("action") == "feedback"
        )
        counts["interactions"] = len(legacy) - counts["feedback"]
        data["events"] = []
        data["default"] = []
        return data

    store.mutate_document("behavior", transform)
    return {
        "ok": True,
        "deleted": counts,
        "deleted_total": sum(counts.values()),
    }


def _valid_feedback(rows: list, cutoff: datetime) -> list[dict]:
    """旧数据也按服务端时间使用同对象最后值，不依赖历史列表顺序。"""
    candidates: list[dict] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("action") != "feedback":
            continue
        ts = _parse_ts(row.get("server_ts") or row.get("ts"))
        if ts is None or ts < cutoff:
            continue
        card_id = str(row.get("card_id") or "").strip()
        if not card_id or row.get("sentiment") not in {"useful", "useless"}:
            continue
        try:
            safe_meta = sanitize_context(row.get("meta") or {})
        except ValueError:
            safe_meta = {}
        candidates.append({**row, "meta": safe_meta, "_parsed_ts": ts})
    candidates.sort(key=lambda row: row["_parsed_ts"], reverse=True)

    out: list[dict] = []
    seen: set[str] = set()
    for row in candidates:
        card_id = str(row.get("card_id") or "").strip()
        if card_id in seen:
            continue
        seen.add(card_id)
        out.append(row)
    return out


def _valid_events(rows: list, cutoff: datetime) -> list[dict]:
    out = []
    for row in rows:
        if not isinstance(row, dict) or row.get("action") not in ALLOWED_ACTIONS:
            continue
        ts = _parse_ts(row.get("occurred_at"))
        if ts is None or ts < cutoff:
            continue
        try:
            context = sanitize_context(row.get("context") or {})
        except ValueError:
            context = {}
        if row.get("surface") not in ALLOWED_SURFACES or row.get("target_type") not in ALLOWED_TARGET_TYPES:
            continue
        out.append({**row, "context": context, "_parsed_ts": ts})
    return out


def _legacy_events(rows: list, cutoff: datetime) -> list[dict]:
    out = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or row.get("action") not in {"view", "click"}:
            continue
        ts = _parse_ts(row.get("server_ts") or row.get("ts"))
        if ts is None or ts < cutoff:
            continue
        try:
            context = sanitize_context(row.get("meta") or {})
        except ValueError:
            context = {}
        out.append({
            "event_id": f"legacy-{index}",
            "schema_version": 0,
            "action": "impression" if row.get("action") == "view" else "open",
            "surface": "dashboard",
            "target_type": "event",
            "target_id": str(row.get("card_id") or "unknown")[:120],
            "session_id": "legacy",
            "context": context,
            "occurred_at": _format_ts(ts),
            "_parsed_ts": ts,
        })
    return out


def _confidence(signal_count: int, active_days: int) -> str:
    if signal_count >= 12 and active_days >= 4:
        return "高"
    if signal_count >= 6 and active_days >= 3:
        return "中"
    return "低"


def _entity_rows(scores: Counter, evidence: Counter, active_dates: dict[str, set[str]], label: str) -> list[dict]:
    rows = []
    for key, score in scores.items():
        if score <= 0:
            continue
        rows.append({
            label: key,
            "score": score,
            "evidence_count": evidence[key],
            "active_days": len(active_dates[key]),
        })
    rows.sort(key=lambda row: (-row["score"], -row["evidence_count"], str(row[label])))
    return rows[:5]


def build_preference_review(
    store,
    days: int = 7,
    *,
    now: Callable[[], datetime] = _utc_now,
) -> dict:
    """构建用户可见的确定性偏好复盘，不产生风险偏好推断。"""
    if days not in {7, 30, 90}:
        raise ValueError("days 必须是 7、30 或 90")
    current_time = now().astimezone(timezone.utc)
    status = local_learning_status(store, now=lambda: current_time)
    cutoff = current_time - timedelta(days=days)
    raw_legacy = list(store.get("behavior", "default") or [])
    events = _valid_events(list(store.get("behavior", "events") or []), cutoff)
    events += _legacy_events(raw_legacy, cutoff)
    feedback = _valid_feedback(raw_legacy, cutoff)
    events.sort(key=lambda row: row["_parsed_ts"], reverse=True)
    feedback.sort(key=lambda row: row["_parsed_ts"], reverse=True)

    action_counts: Counter = Counter(event["action"] for event in events)
    action_counts["feedback"] = len(feedback)
    signal_events = [event for event in events if event["action"] in {"open", "analyze", "follow", "unfollow"}]
    signal_count = len(signal_events) + len(feedback)
    active_dates = {
        row["_parsed_ts"].date().isoformat() for row in [*signal_events, *feedback]
    }
    enough_data = signal_count >= 3 and len(active_dates) >= 2
    confidence = _confidence(signal_count, len(active_dates))

    entity_scores = {"ticker": Counter(), "industry": Counter(), "strategy_id": Counter()}
    entity_evidence = {"ticker": Counter(), "industry": Counter(), "strategy_id": Counter()}
    entity_days: dict[str, dict[str, set[str]]] = {
        kind: defaultdict(set) for kind in entity_scores
    }

    def add_entities(context: dict, weight: int, date: str) -> None:
        values = {
            "ticker": [context.get("ticker")] if context.get("ticker") else [],
            "industry": list(context.get("industries") or []),
            "strategy_id": [context.get("strategy_id")] if context.get("strategy_id") else [],
        }
        for kind, items in values.items():
            for item in items:
                key = str(item or "").strip()
                if not key:
                    continue
                entity_scores[kind][key] += weight
                entity_evidence[kind][key] += 1
                entity_days[kind][key].add(date)

    event_weights = {"open": 1, "analyze": 2, "follow": 3, "unfollow": -3}
    for event in signal_events:
        add_entities(event.get("context") or {}, event_weights[event["action"]], event["_parsed_ts"].date().isoformat())
    for row in feedback:
        add_entities(row.get("meta") or {}, 3 if row.get("sentiment") == "useful" else -3, row["_parsed_ts"].date().isoformat())

    top_tickers = _entity_rows(entity_scores["ticker"], entity_evidence["ticker"], entity_days["ticker"], "ticker") if enough_data else []
    top_industries = _entity_rows(entity_scores["industry"], entity_evidence["industry"], entity_days["industry"], "industry") if enough_data else []
    top_strategies = _entity_rows(entity_scores["strategy_id"], entity_evidence["strategy_id"], entity_days["strategy_id"], "strategy_id") if enough_data else []

    insights = []
    for category, rows, key, noun in (
        ("security", top_tickers, "ticker", "证券"),
        ("industry", top_industries, "industry", "行业"),
        ("strategy", top_strategies, "strategy_id", "策略"),
    ):
        if not rows:
            continue
        row = rows[0]
        insights.append({
            "id": f"{category}:{row[key]}",
            "category": category,
            "title": f"近期更常研究{noun} {row[key]}",
            "evidence_count": row["evidence_count"],
            "active_days": row["active_days"],
            "confidence": confidence,
            "explanation": f"近 {days} 天的打开、带入分析和显式反馈按固定规则聚合。",
            "safety_note": "仅表示研究兴趣，不改变风险承受能力或投资适当性。",
        })

    denominator = action_counts["impression"]
    funnel = {
        "impressions": denominator,
        "opens": action_counts["open"],
        "analyses": action_counts["analyze"],
        "feedback": action_counts["feedback"],
        "open_rate": round(action_counts["open"] / denominator, 3) if denominator >= 3 else None,
        "analysis_rate": round(action_counts["analyze"] / action_counts["open"], 3)
        if action_counts["open"] >= 3 else None,
    }

    recent = []
    combined = [
        (event["_parsed_ts"], event["action"], event["target_type"], event["target_id"])
        for event in events
    ] + [
        (row["_parsed_ts"], f"feedback:{row['sentiment']}", "event", str(row.get("card_id")))
        for row in feedback
    ]
    for ts, action, target_type, target_id in sorted(combined, reverse=True)[:12]:
        recent.append({
            "occurred_at": _format_ts(ts),
            "action": action,
            "label": f"{_ACTION_LABELS.get(action, action)}{_TARGET_LABELS.get(target_type, '对象')} {target_id}",
            "target_type": target_type,
            "target_id": target_id,
        })

    snapshot_rows = [
        {
            "event_id": event.get("event_id"), "action": event.get("action"),
            "target_type": event.get("target_type"), "target_id": event.get("target_id"),
            "context": event.get("context"), "occurred_at": event.get("occurred_at"),
        }
        for event in events
    ] + [
        {
            "card_id": row.get("card_id"), "sentiment": row.get("sentiment"),
            "meta": row.get("meta"), "occurred_at": _format_ts(row["_parsed_ts"]),
        }
        for row in feedback
    ]
    snapshot_payload = json.dumps(
        {"rule": RULE_VERSION, "days": days, "rows": snapshot_rows},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    snapshot_id = hashlib.sha256(snapshot_payload.encode("utf-8")).hexdigest()[:20]

    from .risk_profiles import DEFAULT_PROFILE, RISK_PROFILES, profile

    profile_key = store.get("preferences", "risk_profile") or DEFAULT_PROFILE
    if profile_key not in RISK_PROFILES:
        profile_key = DEFAULT_PROFILE
    explicit = profile(profile_key)

    return {
        "as_of": _format_ts(current_time),
        "window_days": days,
        "rule_version": RULE_VERSION,
        "snapshot_id": snapshot_id,
        "status": status,
        "enough_data": enough_data,
        "data_note": None if enough_data else "数据不足，继续正常使用即可；至少需要跨 2 天的 3 个有效信号。",
        "overview": {
            "signal_count": signal_count,
            "active_days": len(active_dates),
            "opens": action_counts["open"],
            "analyses": action_counts["analyze"],
            "feedback": action_counts["feedback"],
            "confidence": confidence if enough_data else "数据不足",
        },
        "funnel": funnel,
        "insights": insights,
        "top_tickers": top_tickers,
        "top_industries": top_industries,
        "top_strategies": top_strategies,
        "recent_activity": recent,
        "explicit_risk_profile": {
            "key": profile_key,
            "label": explicit["label"],
            "source": "explicit",
            "behavior_adjustment": 0,
            "note": "风险承受能力来自显式设置，本地行为不会修改该值。",
        },
    }


def preference_snapshot_id(store, days: int = 30) -> str:
    return build_preference_review(store, days=days)["snapshot_id"]
