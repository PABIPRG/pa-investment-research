# -*- coding: utf-8 -*-
"""持仓止盈止损规则投影、确定性价格判断与可靠回调 outbox。"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Callable


RULES_COLLECTION = "position_risk_rules"
DELIVERIES_COLLECTION = "position_risk_deliveries"
KINDS = {"take_profit", "stop_loss"}


class PositionRiskRuleError(ValueError):
    """派生规则不符合内部协议。"""


def _parse_time(value: object) -> datetime | None:
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise PositionRiskRuleError("规则时间必须为 ISO-8601 格式") from exc
    if parsed.tzinfo is None:
        raise PositionRiskRuleError("规则时间必须包含时区")
    return parsed.astimezone(timezone.utc)


def _normalize(rule: dict) -> dict:
    ticker = str(rule.get("ticker") or "")
    kind = str(rule.get("kind") or "")
    expected_id = f"position-risk:{ticker}:{kind}"
    operator = rule.get("operator")
    expected_operator = ">=" if kind == "take_profit" else "<="
    if len(ticker) != 6 or not ticker.isdigit() or kind not in KINDS:
        raise PositionRiskRuleError("规则股票或目标类型无效")
    if rule.get("id") != expected_id or operator != expected_operator:
        raise PositionRiskRuleError("规则标识或比较方向无效")
    try:
        target_price = float(rule.get("target_price"))
        config_version = int(rule.get("config_version"))
        generation = int(rule.get("generation"))
    except (TypeError, ValueError) as exc:
        raise PositionRiskRuleError("规则价格或版本无效") from exc
    if target_price <= 0 or config_version < 1 or generation < 1:
        raise PositionRiskRuleError("规则价格或版本无效")
    if rule.get("config_scope") not in ("global", "override"):
        raise PositionRiskRuleError("规则配置作用域无效")
    effective_at = _parse_time(rule.get("effective_at"))
    expires_at = _parse_time(rule.get("expires_at"))
    if effective_at is not None and expires_at is not None and effective_at >= expires_at:
        raise PositionRiskRuleError("到期时间必须晚于生效时间")
    return {
        "id": expected_id,
        "ticker": ticker,
        "kind": kind,
        "operator": expected_operator,
        "target_price": target_price,
        "config_scope": rule["config_scope"],
        "config_version": config_version,
        "generation": generation,
        "effective_at": effective_at.isoformat(timespec="seconds") if effective_at else None,
        "expires_at": expires_at.isoformat(timespec="seconds") if expires_at else None,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def upsert_rule(store, rule: dict) -> dict:
    """按稳定 rule id 原子创建或替换投影。"""
    normalized = _normalize(rule)
    store.set(RULES_COLLECTION, normalized["id"], normalized)
    return normalized


def delete_rule(store, rule_id: str) -> bool:
    """幂等删除一条派生规则。"""
    removed = False

    def transform(document: dict) -> dict:
        nonlocal removed
        removed = rule_id in document
        document.pop(rule_id, None)
        return document

    store.mutate_document(RULES_COLLECTION, transform)
    return removed


def list_rules(store) -> list[dict]:
    return [rule for rule in store.all(RULES_COLLECTION).values() if isinstance(rule, dict)]


def _rule_active(rule: dict, observed_at: datetime) -> bool:
    effective_at = _parse_time(rule.get("effective_at"))
    expires_at = _parse_time(rule.get("expires_at"))
    return not (
        (effective_at is not None and observed_at < effective_at)
        or (expires_at is not None and observed_at >= expires_at)
    )


def _event(rule: dict, quote: dict) -> dict | None:
    if quote.get("freshness") != "fresh":
        return None
    try:
        price = float(quote.get("price"))
        observed_at = _parse_time(quote.get("observed_at"))
    except (TypeError, ValueError, PositionRiskRuleError):
        return None
    if price <= 0 or observed_at is None or not _rule_active(rule, observed_at):
        return None
    target = float(rule["target_price"])
    hit = price >= target if rule["operator"] == ">=" else price <= target
    if not hit:
        return None
    fingerprint = "|".join((
        rule["id"], str(rule["config_version"]), str(rule["generation"]),
        observed_at.isoformat(timespec="seconds"), f"{price:.8f}",
    ))
    event_id = "position-risk-hit:" + hashlib.sha256(fingerprint.encode()).hexdigest()[:32]
    return {
        "event_id": event_id,
        "ticker": rule["ticker"],
        "kind": rule["kind"],
        "rule_id": rule["id"],
        "config_scope": rule["config_scope"],
        "config_version": rule["config_version"],
        "generation": rule["generation"],
        "price": price,
        "observed_at": observed_at.isoformat(timespec="seconds"),
        "quote_source": str(quote.get("quote_source") or "unknown")[:80],
        "freshness": "fresh",
    }


def _persist_delivery(store, event: dict) -> None:
    def transform(document: dict) -> dict:
        document.setdefault(event["event_id"], event)
        return document

    store.mutate_document(DELIVERIES_COLLECTION, transform)


def _remove_delivery(store, event_id: str) -> None:
    store.delete(DELIVERIES_COLLECTION, event_id)


def _disable_matching_rule(store, event: dict) -> None:
    current = store.get(RULES_COLLECTION, event["rule_id"])
    if not isinstance(current, dict):
        return
    if (
        current.get("config_version") == event.get("config_version")
        and current.get("generation") == event.get("generation")
    ):
        delete_rule(store, event["rule_id"])


def deliver_to_trading_core(event: dict) -> dict:
    """使用宿主注入的共享凭证回调 trading-core。"""
    import requests

    from .config import settings

    if not settings.position_risk_token:
        raise RuntimeError("持仓计划内部认证尚未配置")
    session = requests.Session()
    session.trust_env = False
    response = session.post(
        f"{settings.trading_core_url.rstrip('/')}/internal/position-risk/price-hits",
        json=event,
        headers={"X-Position-Risk-Token": settings.position_risk_token},
        timeout=settings.position_risk_timeout,
    )
    response.raise_for_status()
    return response.json()


def evaluate_and_deliver(
    store,
    quote_rows: list[dict],
    callback: Callable[[dict], dict] = deliver_to_trading_core,
) -> dict:
    """只用 fresh 行情生成命中；outbox 先落盘，再发送并按终态确认清理。"""
    quotes_by_code = {
        str(quote.get("code") or ""): quote
        for quote in quote_rows
        if isinstance(quote, dict)
    }
    created = 0
    for rule in list_rules(store):
        quote = quotes_by_code.get(rule["ticker"])
        if quote is None:
            continue
        event = _event(rule, quote)
        if event is None:
            continue
        before = event["event_id"] in store.all(DELIVERIES_COLLECTION)
        _persist_delivery(store, event)
        created += 0 if before else 1

    delivered = 0
    failed = 0
    for event_id, event in list(store.all(DELIVERIES_COLLECTION).items()):
        if not isinstance(event, dict):
            _remove_delivery(store, event_id)
            continue
        try:
            result = callback(event)
        except Exception:  # noqa: BLE001 - outbox 留存，下一轮重试
            failed += 1
            continue
        if result.get("terminal") is True:
            _remove_delivery(store, event_id)
            _disable_matching_rule(store, event)
            delivered += 1

    return {
        "triggered": created,
        "delivered": delivered,
        "failed": failed,
        "pending": len(store.all(DELIVERIES_COLLECTION)),
    }
