# -*- coding: utf-8 -*-
"""持仓止盈止损配置、激活快照与确定性触发领域。"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Protocol


CONFIG_COLLECTION = "position_risk_config"
RUNTIME_COLLECTION = "position_risk_runtime"
TARGET_KINDS = ("take_profit", "stop_loss")
SUGGESTION_VERSION = 1
PROFILE_SUGGESTIONS = {
    "conservative": {"take_profit_pct": 0.08, "stop_loss_pct": 0.04},
    "balanced": {"take_profit_pct": 0.12, "stop_loss_pct": 0.06},
    "aggressive": {"take_profit_pct": 0.20, "stop_loss_pct": 0.10},
}


class PositionRiskValidationError(ValueError):
    """持仓风险配置或触发载荷不符合领域约束。"""


class MarketPriceRulePort(Protocol):
    """trading-core 写入可重建 market-watch 价格规则的端口。"""

    def upsert(self, rule: dict) -> None:
        """创建或替换一条稳定标识的价格规则。"""

    def disable(self, rule_id: str) -> None:
        """停用一条派生价格规则。"""


class HttpMarketPriceRulePort:
    """使用内部认证 HTTP 接口维护 market-watch 派生规则。"""

    def __init__(self, base_url: str, token: str, timeout: float = 2.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        if not self.token:
            raise RuntimeError("持仓计划内部认证尚未配置")
        return {"X-Position-Risk-Token": self.token}

    def upsert(self, rule: dict) -> None:
        import requests

        session = requests.Session()
        session.trust_env = False
        response = session.put(
            f"{self.base_url}/internal/position-risk-rules/{rule['ticker']}/{rule['kind']}",
            json=rule,
            headers=self._headers(),
            timeout=self.timeout,
        )
        response.raise_for_status()

    def disable(self, rule_id: str) -> None:
        import requests

        session = requests.Session()
        session.trust_env = False
        response = session.delete(
            f"{self.base_url}/internal/position-risk-rules/{rule_id}",
            headers=self._headers(),
            timeout=self.timeout,
        )
        response.raise_for_status()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_time(value: object) -> datetime | None:
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise PositionRiskValidationError("时间必须为 ISO-8601 格式") from exc
    if parsed.tzinfo is None:
        raise PositionRiskValidationError("时间必须包含时区")
    return parsed.astimezone(timezone.utc)


def _time_status(config: dict, now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    effective_at = _parse_time(config.get("effective_at"))
    expires_at = _parse_time(config.get("expires_at"))
    if effective_at is not None and expires_at is not None and effective_at >= expires_at:
        raise PositionRiskValidationError("到期时间必须晚于生效时间")
    if expires_at is not None and current >= expires_at:
        return "expired"
    if effective_at is not None and current < effective_at:
        return "scheduled"
    return "active"


def suggestion_for_profile(profile_key: str) -> dict:
    """返回显式风险画像对应的确定性、未确认建议。"""
    key = profile_key if profile_key in PROFILE_SUGGESTIONS else "balanced"
    return {
        "profile": key,
        "suggestion_version": SUGGESTION_VERSION,
        "confirmed": False,
        **PROFILE_SUGGESTIONS[key],
    }


def explicit_kyc_suggestion(store) -> dict | None:
    """仅在用户完成 KYC 后返回建议；普通偏好或默认画像不构成授权。"""
    kyc = store.get("preferences", "kyc") or {}
    if not isinstance(kyc, dict) or kyc.get("status") not in ("completed", "adjusted"):
        return None
    profile_key = store.get("preferences", "risk_profile") or kyc.get("inferred_profile")
    if profile_key not in PROFILE_SUGGESTIONS:
        return None
    return suggestion_for_profile(str(profile_key))


def _target(value: object, *, kind: str, global_config: bool) -> dict:
    if not isinstance(value, dict):
        raise PositionRiskValidationError(f"{kind} 配置缺失")
    enabled = value.get("enabled", True)
    if not isinstance(enabled, bool):
        raise PositionRiskValidationError(f"{kind}.enabled 必须为布尔值")
    mode = value.get("mode", "percent")
    if mode not in ("percent", "price"):
        raise PositionRiskValidationError(f"{kind}.mode 仅支持 percent 或 price")
    if global_config and mode != "percent":
        raise PositionRiskValidationError("全局止盈止损只支持百分比")
    raw = value.get("value")
    if not enabled:
        return {"enabled": False, "mode": mode, "value": None}
    try:
        amount = float(raw)
    except (TypeError, ValueError) as exc:
        raise PositionRiskValidationError(f"{kind}.value 必须为正数") from exc
    if amount <= 0:
        raise PositionRiskValidationError(f"{kind}.value 必须为正数")
    if kind == "stop_loss" and mode == "percent" and amount >= 1:
        raise PositionRiskValidationError("止损百分比必须小于 100%")
    return {"enabled": True, "mode": mode, "value": amount}


def _normalize_global(payload: dict, version: int, profile_key: str | None) -> dict:
    if payload.get("confirmed") is not True:
        raise PositionRiskValidationError("全局配置必须由用户明确确认")
    take_profit = payload.get("take_profit") or {
        "enabled": True,
        "mode": "percent",
        "value": payload.get("take_profit_pct"),
    }
    stop_loss = payload.get("stop_loss") or {
        "enabled": True,
        "mode": "percent",
        "value": payload.get("stop_loss_pct"),
    }
    normalized = {
        "version": version,
        "confirmed": True,
        "confirmed_at": _now(),
        "take_profit": _target(take_profit, kind="take_profit", global_config=True),
        "stop_loss": _target(stop_loss, kind="stop_loss", global_config=True),
        "effective_at": payload.get("effective_at"),
        "expires_at": payload.get("expires_at"),
    }
    if profile_key in PROFILE_SUGGESTIONS:
        normalized["suggestion_profile"] = profile_key
        normalized["suggestion_version"] = SUGGESTION_VERSION
    _time_status(normalized)
    return normalized


def _holding_map(store) -> dict[str, dict]:
    return {
        str(item.get("ticker") or ""): item
        for item in (store.get("holdings", "default", []) or [])
        if isinstance(item, dict) and str(item.get("ticker") or "")
    }


def _config_document(store) -> dict:
    document = store.all(CONFIG_COLLECTION) or {}
    return {
        "global": document.get("global"),
        "overrides": dict(document.get("overrides") or {}),
    }


def config_document(store) -> dict:
    """返回配置事实的只读副本，供 API 组合建议与覆盖状态。"""
    return _config_document(store)


def _selected_config(document: dict, ticker: str) -> tuple[str, dict | None]:
    override = (document.get("overrides") or {}).get(ticker)
    if isinstance(override, dict):
        return "override", override
    global_config = document.get("global")
    return "global", global_config if isinstance(global_config, dict) else None


def _config_state(config: dict | None) -> str:
    if config is None:
        return "unconfigured"
    if config.get("confirmed") is not True:
        return "unconfirmed"
    if config.get("monitoring_disabled") is True:
        return "disabled"
    return _time_status(config)


def _resolved_price(kind: str, target: dict, cost: float) -> float:
    if target["mode"] == "price":
        result = float(target["value"])
    elif kind == "take_profit":
        result = cost * (1 + float(target["value"]))
    else:
        result = cost * (1 - float(target["value"]))
    if result <= 0:
        raise PositionRiskValidationError("换算后的目标价必须为正数")
    if kind == "take_profit" and result <= cost:
        raise PositionRiskValidationError("止盈目标价必须高于激活时成本")
    if kind == "stop_loss" and result >= cost:
        raise PositionRiskValidationError("止损目标价必须低于激活时成本")
    return round(result, 4)


def _rule_id(ticker: str, kind: str) -> str:
    return f"position-risk:{ticker}:{kind}"


def _empty_runtime(document: dict | None = None) -> dict:
    current = document if isinstance(document, dict) else {}
    return {
        "activations": dict(current.get("activations") or {}),
        "triggers": dict(current.get("triggers") or {}),
    }


def reconcile(store, port: MarketPriceRulePort | None = None) -> dict:
    """按当前持仓与配置刷新最小激活状态和 market-watch 投影。"""
    holdings = _holding_map(store)
    configs = _config_document(store)
    upserts: list[dict] = []
    disables: list[str] = []

    def transform(document: dict) -> dict:
        runtime = _empty_runtime(document)
        activations = runtime["activations"]
        valid_keys: set[str] = set()
        for ticker, holding in holdings.items():
            scope, config = _selected_config(configs, ticker)
            state = _config_state(config)
            if state not in ("active", "scheduled"):
                for kind in TARGET_KINDS:
                    key = f"{ticker}:{kind}"
                    current = activations.get(key)
                    if isinstance(current, dict) and current.get("status") not in ("triggered", "invalidated"):
                        activations[key] = {**current, "status": state, "updated_at": _now()}
                        disables.append(str(current.get("rule_id") or _rule_id(ticker, kind)))
                continue
            try:
                cost = float(holding.get("cost_price"))
            except (TypeError, ValueError) as exc:
                raise PositionRiskValidationError(f"{ticker} 持仓成本无效") from exc
            for kind in TARGET_KINDS:
                key = f"{ticker}:{kind}"
                target = config.get(kind) if config else None
                current = activations.get(key)
                if not isinstance(target, dict) or target.get("enabled") is not True:
                    if isinstance(current, dict) and current.get("status") not in ("triggered", "invalidated"):
                        activations[key] = {**current, "status": "disabled", "updated_at": _now()}
                        disables.append(str(current.get("rule_id") or _rule_id(ticker, kind)))
                    continue
                valid_keys.add(key)
                same_version = bool(
                    isinstance(current, dict)
                    and current.get("config_scope") == scope
                    and current.get("config_version") == config.get("version")
                )
                if same_version:
                    activation = dict(current)
                    if state == "active" and activation.get("status") == "scheduled":
                        activation["status"] = "active"
                else:
                    activation = {
                        "ticker": ticker,
                        "kind": kind,
                        "config_scope": scope,
                        "config_version": int(config.get("version") or 0),
                        "basis_cost": cost,
                        "resolved_price": _resolved_price(kind, target, cost),
                        "generation": int((current or {}).get("generation") or 0) + 1,
                        "status": state,
                        "rule_id": _rule_id(ticker, kind),
                        "sync_status": "pending",
                        "created_at": _now(),
                    }
                activation["updated_at"] = _now()
                activations[key] = activation
                if activation.get("status") in ("active", "scheduled"):
                    upserts.append({
                        "id": activation["rule_id"],
                        "ticker": ticker,
                        "kind": kind,
                        "operator": ">=" if kind == "take_profit" else "<=",
                        "target_price": activation["resolved_price"],
                        "config_scope": scope,
                        "config_version": activation["config_version"],
                        "generation": activation["generation"],
                        "effective_at": config.get("effective_at"),
                        "expires_at": config.get("expires_at"),
                    })

        for key, current in list(activations.items()):
            if key in valid_keys or not isinstance(current, dict):
                continue
            ticker = str(current.get("ticker") or key.split(":", 1)[0])
            if ticker not in holdings and current.get("status") not in ("triggered", "invalidated"):
                activations[key] = {**current, "status": "invalidated", "updated_at": _now()}
                disables.append(str(current.get("rule_id") or _rule_id(ticker, str(current.get("kind")))))
        return runtime

    store.mutate_document(RUNTIME_COLLECTION, transform)
    errors: list[str] = []
    if port is not None:
        for rule_id in dict.fromkeys(disables):
            try:
                port.disable(rule_id)
            except Exception as exc:  # noqa: BLE001 - 错误转为显式同步状态
                errors.append(str(exc))
        for rule in upserts:
            try:
                port.upsert(rule)
            except Exception as exc:  # noqa: BLE001 - 配置事实已经提交，外部投影稍后重试
                errors.append(str(exc))

    sync_status = "error" if errors else "synced"

    def mark_sync(document: dict) -> dict:
        runtime = _empty_runtime(document)
        ids = {rule["id"] for rule in upserts}
        for key, activation in list(runtime["activations"].items()):
            if not isinstance(activation, dict) or activation.get("rule_id") not in ids:
                continue
            runtime["activations"][key] = {
                **activation,
                "sync_status": sync_status,
                "sync_error": errors[0] if errors else None,
                "updated_at": _now(),
            }
        return runtime

    if upserts:
        store.mutate_document(RUNTIME_COLLECTION, mark_sync)
    return {"sync_status": sync_status, "errors": errors, "upserted": len(upserts), "disabled": len(disables)}


def save_global_config(store, payload: dict, port: MarketPriceRulePort | None = None, profile_key: str | None = None) -> dict:
    """原子保存唯一全局配置，再协调当前持仓的派生规则。"""
    saved: dict = {}

    def transform(document: dict) -> dict:
        nonlocal saved
        current = document.get("global") if isinstance(document, dict) else None
        version = int((current or {}).get("version") or 0) + 1
        saved = _normalize_global(payload, version, profile_key)
        overrides = dict((document or {}).get("overrides") or {})
        return {"global": saved, "overrides": overrides}

    store.mutate_document(CONFIG_COLLECTION, transform)
    sync = reconcile(store, port)
    return {"config": saved, **sync}


def save_override(store, ticker: str, payload: dict, port: MarketPriceRulePort | None = None) -> dict:
    """保存一只当前持仓的完整覆盖配置。"""
    if ticker not in _holding_map(store):
        raise PositionRiskValidationError("只能为当前持仓设置单股止盈止损")
    if payload.get("confirmed") is not True:
        raise PositionRiskValidationError("单股配置必须由用户明确确认")
    disabled = payload.get("monitoring_disabled") is True
    normalized: dict
    if disabled:
        normalized = {"monitoring_disabled": True}
    else:
        normalized = {
            "monitoring_disabled": False,
            "take_profit": _target(payload.get("take_profit"), kind="take_profit", global_config=False),
            "stop_loss": _target(payload.get("stop_loss"), kind="stop_loss", global_config=False),
        }
    _time_status(payload)
    saved: dict = {}

    def transform(document: dict) -> dict:
        nonlocal saved
        current = (document.get("overrides") or {}).get(ticker) if isinstance(document, dict) else None
        saved = {
            **normalized,
            "version": int((current or {}).get("version") or 0) + 1,
            "confirmed": True,
            "confirmed_at": _now(),
            "effective_at": payload.get("effective_at"),
            "expires_at": payload.get("expires_at"),
        }
        overrides = dict((document or {}).get("overrides") or {})
        overrides[ticker] = saved
        return {"global": (document or {}).get("global"), "overrides": overrides}

    store.mutate_document(CONFIG_COLLECTION, transform)
    sync = reconcile(store, port)
    return {"config": saved, **sync}


def delete_override(store, ticker: str, port: MarketPriceRulePort | None = None) -> dict:
    """删除单股覆盖，使其重新继承全局配置。"""
    removed = False

    def transform(document: dict) -> dict:
        nonlocal removed
        overrides = dict((document or {}).get("overrides") or {})
        removed = ticker in overrides
        overrides.pop(ticker, None)
        return {"global": (document or {}).get("global"), "overrides": overrides}

    store.mutate_document(CONFIG_COLLECTION, transform)
    return {"removed": removed, **reconcile(store, port)}


def effective_plan(store, ticker: str) -> dict:
    """读取一只股票的解析配置及当前激活状态，不产生配置副本。"""
    holding = _holding_map(store).get(ticker)
    scope, config = _selected_config(_config_document(store), ticker)
    state = _config_state(config)
    if holding is None:
        return {"ticker": ticker, "holding_present": False, "source": scope, "status": "invalidated", "targets": {}}
    if state not in ("active", "scheduled"):
        return {"ticker": ticker, "holding_present": True, "source": scope, "status": state, "targets": {}}
    runtime = _empty_runtime(store.all(RUNTIME_COLLECTION))
    targets: dict[str, dict] = {}
    basis_changed = False
    for kind in TARGET_KINDS:
        activation = runtime["activations"].get(f"{ticker}:{kind}")
        if not isinstance(activation, dict):
            continue
        targets[kind] = dict(activation)
        try:
            basis_changed = basis_changed or float(activation.get("basis_cost")) != float(holding.get("cost_price"))
        except (TypeError, ValueError):
            basis_changed = True
    statuses = {target.get("status") for target in targets.values()}
    effective_status = "triggered" if statuses and statuses == {"triggered"} else state
    if any(target.get("sync_status") == "error" for target in targets.values()):
        effective_status = "sync_error"
    return {
        "ticker": ticker,
        "holding_present": True,
        "source": scope,
        "config": config,
        "status": effective_status,
        "basis_changed": basis_changed,
        "targets": targets,
    }


def effective_plans(store) -> list[dict]:
    """按当前持仓顺序返回所有解析计划。"""
    return [effective_plan(store, ticker) for ticker in _holding_map(store)]


def rearm(store, ticker: str, kind: str, port: MarketPriceRulePort | None = None) -> dict:
    """在不复制配置的前提下，为一个已触发目标创建新的激活代次。"""
    if kind not in TARGET_KINDS:
        raise PositionRiskValidationError("目标类型无效")
    holding = _holding_map(store).get(ticker)
    if holding is None:
        raise PositionRiskValidationError("只能重新启用当前持仓的目标")
    scope, config = _selected_config(_config_document(store), ticker)
    if _config_state(config) != "active":
        raise PositionRiskValidationError("当前有效配置不能重新启用")
    target = config.get(kind) if config else None
    if not isinstance(target, dict) or target.get("enabled") is not True:
        raise PositionRiskValidationError("该目标当前未启用")
    cost = float(holding["cost_price"])
    key = f"{ticker}:{kind}"
    activation: dict = {}

    def transform(document: dict) -> dict:
        nonlocal activation
        runtime = _empty_runtime(document)
        current = runtime["activations"].get(key)
        activation = {
            "ticker": ticker,
            "kind": kind,
            "config_scope": scope,
            "config_version": int(config.get("version") or 0),
            "basis_cost": cost,
            "resolved_price": _resolved_price(kind, target, cost),
            "generation": int((current or {}).get("generation") or 0) + 1,
            "status": "active",
            "rule_id": _rule_id(ticker, kind),
            "sync_status": "pending",
            "created_at": _now(),
            "updated_at": _now(),
        }
        runtime["activations"][key] = activation
        return runtime

    store.mutate_document(RUNTIME_COLLECTION, transform)
    rule = {
        "id": activation["rule_id"],
        "ticker": ticker,
        "kind": kind,
        "operator": ">=" if kind == "take_profit" else "<=",
        "target_price": activation["resolved_price"],
        "config_scope": scope,
        "config_version": activation["config_version"],
        "generation": activation["generation"],
        "effective_at": config.get("effective_at"),
        "expires_at": config.get("expires_at"),
    }
    error = None
    if port is not None:
        try:
            port.upsert(rule)
        except Exception as exc:  # noqa: BLE001 - 用户配置不因投影失败而回滚
            error = str(exc)

    def mark(document: dict) -> dict:
        runtime = _empty_runtime(document)
        current = runtime["activations"].get(key)
        if isinstance(current, dict) and current.get("generation") == activation["generation"]:
            runtime["activations"][key] = {
                **current,
                "sync_status": "error" if error else "synced",
                "sync_error": error,
                "updated_at": _now(),
            }
        return runtime

    store.mutate_document(RUNTIME_COLLECTION, mark)
    return {"activation": effective_plan(store, ticker)["targets"].get(kind), "sync_status": "error" if error else "synced", "errors": [error] if error else []}


def accept_price_hit(store, event: dict) -> dict:
    """校验新鲜行情命中并原子记录一次性触发。"""
    event_id = str(event.get("event_id") or "").strip()
    ticker = str(event.get("ticker") or "").strip()
    kind = str(event.get("kind") or "").strip()
    if not event_id or kind not in TARGET_KINDS or len(ticker) != 6 or not ticker.isdigit():
        raise PositionRiskValidationError("价格命中标识、股票或目标类型无效")
    if event.get("freshness") != "fresh":
        return {"accepted": False, "duplicate": False, "terminal": True, "reason": "stale_quote"}
    observed_at = _parse_time(event.get("observed_at"))
    if observed_at is None:
        raise PositionRiskValidationError("价格命中必须包含行情时间")
    try:
        price = float(event.get("price"))
    except (TypeError, ValueError) as exc:
        raise PositionRiskValidationError("命中价格无效") from exc
    if price <= 0:
        raise PositionRiskValidationError("命中价格必须为正数")

    with store.transaction():
        if ticker not in _holding_map(store):
            return {"accepted": False, "duplicate": False, "terminal": True, "reason": "holding_missing"}
        scope, config = _selected_config(_config_document(store), ticker)
        if _config_state(config) != "active":
            return {"accepted": False, "duplicate": False, "terminal": True, "reason": "config_inactive"}
        effective_at = _parse_time(config.get("effective_at")) if config else None
        expires_at = _parse_time(config.get("expires_at")) if config else None
        if (effective_at is not None and observed_at < effective_at) or (
            expires_at is not None and observed_at >= expires_at
        ):
            return {"accepted": False, "duplicate": False, "terminal": True, "reason": "outside_window"}
        outcome: dict = {}

        def transform(document: dict) -> dict:
            runtime = _empty_runtime(document)
            nonlocal outcome
            if event_id in runtime["triggers"]:
                outcome = {"accepted": True, "duplicate": True, "terminal": True, "reason": "duplicate"}
                return runtime
            key = f"{ticker}:{kind}"
            activation = runtime["activations"].get(key)
            if not isinstance(activation, dict):
                outcome = {"accepted": False, "duplicate": False, "terminal": True, "reason": "activation_missing"}
                return runtime
            if activation.get("status") == "scheduled":
                activation = {**activation, "status": "active", "updated_at": _now()}
            checks = (
                activation.get("status") == "active",
                activation.get("rule_id") == event.get("rule_id"),
                activation.get("config_scope") == event.get("config_scope") == scope,
                activation.get("config_version") == event.get("config_version") == config.get("version"),
                activation.get("generation") == event.get("generation"),
            )
            if not all(checks):
                outcome = {"accepted": False, "duplicate": False, "terminal": True, "reason": "stale_activation"}
                return runtime
            threshold = float(activation["resolved_price"])
            hit = price >= threshold if kind == "take_profit" else price <= threshold
            if not hit:
                outcome = {"accepted": False, "duplicate": False, "terminal": True, "reason": "price_not_hit"}
                return runtime
            trigger = {
                "id": event_id,
                "ticker": ticker,
                "kind": kind,
                "price": price,
                "target_price": threshold,
                "observed_at": observed_at.isoformat(timespec="seconds"),
                "quote_source": str(event.get("quote_source") or "unknown")[:80],
                "config_scope": scope,
                "config_version": activation["config_version"],
                "generation": activation["generation"],
                "basis_cost": activation["basis_cost"],
                "created_at": _now(),
            }
            runtime["triggers"][event_id] = trigger
            runtime["activations"][key] = {**activation, "status": "triggered", "trigger_id": event_id, "updated_at": _now()}
            outcome = {"accepted": True, "duplicate": False, "terminal": True, "reason": "accepted", "trigger": trigger}
            return runtime

        store.mutate_document(RUNTIME_COLLECTION, transform)
        return outcome


def trigger_alert_items(store) -> list[dict]:
    """把已接受触发投影为统一风险通知条目。"""
    runtime = _empty_runtime(store.all(RUNTIME_COLLECTION))
    items = []
    for trigger in runtime["triggers"].values():
        if not isinstance(trigger, dict):
            continue
        kind = trigger.get("kind")
        label = "止盈" if kind == "take_profit" else "止损"
        ticker = str(trigger.get("ticker") or "")
        items.append({
            "id": "risk-" + hashlib.md5(f"position-risk:{trigger.get('id')}".encode()).hexdigest(),
            "source": "position_plan",
            "severity": "中" if kind == "take_profit" else "高",
            "title": f"{ticker} {label}目标已触发",
            "detail": f"行情价 {trigger.get('price')} 已触达{label}目标 {trigger.get('target_price')}；仅提醒，不会执行交易。",
            "codes": [ticker],
            "strategy_id": None,
            "ts": trigger.get("observed_at") or trigger.get("created_at"),
            "position_risk": trigger,
        })
    return items
