# -*- coding: utf-8 -*-
"""把新闻、行情异动与持仓风险发布为统一事件，交给研究委托核心复核。

V1.3 §5.6：现有新闻、异动、风险模块作为事件产生方接入，不能保留绕过委托
核心直接发送同一类提醒的出口。启用 ``MW_RESEARCH_PARTNER`` 后，本模块把
已归一化的事实转成统一信封投递到 ``POST /research/events``；是否联系用户由
委托核心决定，这里只负责“发生了什么”。

事件标识由来源事实确定：同一条快讯、同一个规则命中、同一次风险命中重复
投递时复用同一 ``event_id``，核心按标识幂等接收。
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import requests

from .config import settings
from .store import JsonStore

logger = logging.getLogger("market_watch.partner_publisher")

# 结构化事件类型 → Hook。类型不明确时按新闻条目处理，由核心按实体与主题路由。
_HOOK_BY_TYPE = {
    "公告": "company.event_available",
    "业绩": "company.event_available",
    "评级": "company.event_available",
    "合作": "company.event_available",
    "价格异动": "market.condition_changed",
    "政策": "industry.event_available",
    "产业": "industry.event_available",
    "宏观": "industry.event_available",
}

_DELIVERED_KEY = "partner_event_ids"


def partner_enabled() -> bool:
    """配置了委托核心地址才能投递。"""

    return bool(settings.research_partner_url)


def partner_takeover() -> bool:
    """接管判定：显式声明 partner 模式，或已经配置了委托核心地址。

    返回 True 时不得再走旧通知出口，否则同一类提醒会出现两条链路。
    """

    return settings.notification_mode == "partner" or partner_enabled()


def _tz() -> ZoneInfo:
    return ZoneInfo(settings.timezone)


def _iso(value: Any, *, default: datetime | None = None) -> str:
    """把来源时间归一化为带时区的 ISO 字符串；无法解析时用当前时刻。"""

    tz = _tz()
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=tz)
    elif isinstance(value, str) and value.strip():
        text = value.strip().replace("Z", "+00:00")
        moment = None
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
                try:
                    moment = datetime.strptime(text, pattern)
                    break
                except ValueError:
                    continue
        if moment is None:
            moment = default or datetime.now(tz)
        elif moment.tzinfo is None:
            moment = moment.replace(tzinfo=tz)
    else:
        moment = default or datetime.now(tz)
    return moment.astimezone(tz).isoformat(timespec="seconds")


def _content_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _envelope(
    *,
    event_id: str,
    hook_type: str,
    occurred_at: Any,
    subject_ids: list[str],
    payload: dict[str, Any],
    source_version: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    return {
        "event_id": event_id[:200],
        "hook_type": hook_type,
        "schema_version": "1",
        "producer": "market-watch",
        "occurred_at": _iso(occurred_at),
        "observed_at": datetime.now(_tz()).isoformat(timespec="seconds"),
        "subject_ids": [item for item in subject_ids if item][:200],
        "source_version": source_version,
        "content_hash": _content_hash(payload),
        "correlation_id": correlation_id,
        "causation_id": None,
        "origin_run_id": None,
        "payload": payload,
    }


def _subject_ids(*, codes: Iterable[str] = (), names: Iterable[str] = (), industries: Iterable[str] = ()) -> list[str]:
    """公司用代码标识；没有代码的未上市公司用名称作为稳定标识。"""

    subjects: list[str] = []
    seen_codes = set()
    for code in codes:
        code = str(code or "").strip()
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        subjects.extend([f"company:{code}", f"security:{code}"])
    seen_names = set()
    for name in names:
        name = str(name or "").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        subjects.append(f"company:{name}")
    seen_industries = set()
    for industry in industries:
        industry = str(industry or "").strip()
        if not industry or industry in seen_industries:
            continue
        seen_industries.add(industry)
        subjects.append(f"industry:{industry}")
    return subjects


def news_hook_type(event_type: str | None) -> str:
    return _HOOK_BY_TYPE.get(str(event_type or "").strip(), "news.item_available")


def news_envelope(event: dict[str, Any]) -> dict[str, Any]:
    """快讯的结构化事件 → 统一信封。"""

    event_type = str(event.get("type") or "其他")
    tickers = [item for item in event.get("tickers") or [] if isinstance(item, dict)]
    payload = {
        "event_type": event_type,
        "summary": str(event.get("summary") or event.get("title") or "")[:2000],
        "title": str(event.get("title") or "")[:500],
        "direction": str(event.get("direction") or "中性"),
        "source": str(event.get("source") or "")[:200],
        "url": str(event.get("url") or "")[:1000],
        "industries": [str(item) for item in event.get("industries") or []][:50],
        "tickers": [
            {
                "code": str(item.get("code") or ""),
                "name": str(item.get("name") or ""),
            }
            for item in tickers[:50]
        ],
        "item_id": str(event.get("item_id") or ""),
        "time": str(event.get("time") or ""),
    }
    return _envelope(
        event_id=f"news:{event.get('id') or event.get('item_id')}",
        hook_type=news_hook_type(event_type),
        occurred_at=event.get("time"),
        subject_ids=_subject_ids(
            codes=[item.get("code") for item in tickers],
            names=[item.get("name") for item in tickers if not item.get("code")],
            industries=event.get("industries") or [],
        ),
        payload=payload,
        source_version=f"market-watch/{event.get('source') or 'unknown'}/{event.get('item_id') or ''}",
    )


def price_alert_envelope(trigger: dict[str, Any]) -> dict[str, Any]:
    """盯盘规则命中 → ``market.condition_changed``。"""

    code = str(trigger.get("code") or "")
    return _envelope(
        event_id=f"price-alert:{trigger.get('rule_id')}:{code}:{trigger.get('ts')}",
        hook_type="market.condition_changed",
        occurred_at=trigger.get("ts"),
        subject_ids=_subject_ids(codes=[code]),
        payload={
            "event_type": "price_alert",
            "rule_id": str(trigger.get("rule_id") or ""),
            "rule_name": str(trigger.get("rule_name") or "")[:200],
            "condition": str(trigger.get("condition_text") or "")[:500],
            "price": trigger.get("price"),
            "value": trigger.get("value"),
            "security_name": str(trigger.get("name") or "")[:100],
            "ts": str(trigger.get("ts") or ""),
        },
        source_version=f"market-watch/rule/{trigger.get('rule_id')}",
        correlation_id=str(trigger.get("rule_id") or "") or None,
    )


def risk_envelope(event: dict[str, Any]) -> dict[str, Any]:
    """持仓风险命中 → ``risk.condition_changed``。只报告已确认的新鲜行情命中。"""

    code = str(event.get("ticker") or "")
    return _envelope(
        event_id=f"risk:{event.get('event_id')}",
        hook_type="risk.condition_changed",
        occurred_at=event.get("observed_at"),
        subject_ids=_subject_ids(codes=[code]),
        payload={
            "event_type": "position_risk_hit",
            "rule_id": str(event.get("rule_id") or ""),
            "kind": str(event.get("kind") or ""),
            "price": event.get("price"),
            "observed_at": str(event.get("observed_at") or ""),
            "quote_source": str(event.get("quote_source") or "unknown"),
            "freshness": str(event.get("freshness") or "unknown"),
            "config_version": event.get("config_version"),
            "generation": event.get("generation"),
        },
        source_version=f"market-watch/position-risk/{event.get('rule_id')}/{event.get('config_version')}",
        correlation_id=str(event.get("rule_id") or "") or None,
    )


def publish_event(envelope: dict[str, Any]) -> dict[str, Any]:
    """投递到委托核心；失败只记录，不回滚已经登记的业务事实。"""

    if not partner_enabled():
        return {"ok": False, "skipped": True, "reason": "partner_disabled"}
    try:
        response = requests.post(
            f"{settings.research_partner_url.rstrip('/')}/research/events",
            json=envelope,
            timeout=settings.research_partner_timeout,
        )
        response.raise_for_status()
        body = response.json() if response.content else {}
        return {"ok": True, "duplicate": bool(body.get("duplicate"))}
    except Exception as exc:  # noqa: BLE001 — 事件投递失败不能影响盯盘主流程
        logger.warning("委托事件投递失败 %s: %s", envelope.get("event_id"), exc)
        return {"ok": False, "error": str(exc)[:300]}


def _delivered() -> set[str]:
    try:
        return set(JsonStore().get("notifications", _DELIVERED_KEY) or [])
    except Exception:  # noqa: BLE001 - 状态不可用时退化为不额外去重（核心仍按 event_id 幂等）
        return set()


def _mark_delivered(event_ids: Iterable[str]) -> None:
    ids = [item for item in event_ids if item]
    if not ids:
        return
    try:
        JsonStore().mutate(
            "notifications",
            _DELIVERED_KEY,
            lambda current: sorted(set(current or []) | set(ids))[-2000:],
            [],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("委托事件去重游标写入失败: %s", exc)


def publish_news_events(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """发布本轮结构化事件；本地游标避免同一事件每轮重复投递。"""

    if not partner_enabled():
        return {"published": 0, "skipped": True}
    delivered = _delivered()
    published = 0
    duplicates = 0
    failed = 0
    newly: list[str] = []
    for event in events:
        envelope = news_envelope(event)
        event_id = envelope["event_id"]
        if event_id in delivered:
            continue
        result = publish_event(envelope)
        if result.get("ok"):
            published += 1
            duplicates += 1 if result.get("duplicate") else 0
            newly.append(event_id)
        elif not result.get("skipped"):
            failed += 1
    _mark_delivered(newly)
    return {"published": published, "duplicates": duplicates, "failed": failed}


def publish_news_events_async(events: Iterable[dict[str, Any]]) -> None:
    """事件层不能等待逐条 HTTP；后台线程投递，失败由核心幂等接收兜底。"""

    if not partner_enabled():
        return
    batch = list(events)

    def run() -> None:
        try:
            publish_news_events(batch)
        except Exception as exc:  # noqa: BLE001
            logger.warning("委托事件批量投递失败: %s", exc)

    threading.Thread(target=run, name="partner-news-publish", daemon=True).start()


def publish_risk_event(event: dict[str, Any]) -> dict[str, Any]:
    return publish_event(risk_envelope(event))


def publish_price_alerts(triggers: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"event_id": envelope["event_id"], **publish_event(envelope)}
        for trigger in triggers
        if (envelope := price_alert_envelope(trigger))
    ]
