# -*- coding: utf-8 -*-
"""盯盘规则：条件评估 + 涨跌停判定。

规则结构（schemas.py 同构）：
  {id, name, ticker(可空=全部自选), enabled, time_frame(trading/anytime),
   combine(or/and), conditions[{field, operator, value}], cooldown_min, daily_cap, created_at}
field ∈ price / pct_change / volume_ratio / amount(亿元) / turnover
amount 统一按"亿元"；pct_change / turnover 按"%"数值。
"""

from __future__ import annotations

import logging

from . import quotes

logger = logging.getLogger("market_watch.rules")

FIELD_LABELS = {
    "price": "现价(元)",
    "pct_change": "涨跌幅%",
    "volume_ratio": "量比",
    "amount": "成交额(亿)",
    "turnover": "换手率%",
}
OP_LABELS = {">": "高于", ">=": "不低于", "<": "低于", "<=": "不高于"}


def _board(code: str) -> str:
    if code.startswith("30"):
        return "创业板"
    if code.startswith("688"):
        return "科创板"
    if code.startswith(("8", "4", "92")):
        return "北交所"
    return "主板"


def _is_st(name: str) -> bool:
    s = str(name or "").strip().upper()
    return s.startswith("ST") or s.startswith("*ST") or s.startswith("退")


def limit_pct(code: str, name: str) -> float:
    """按板块返回涨跌停幅度（%）。"""
    if code.startswith(("8", "4", "92")):
        return 30.0
    if code.startswith(("30", "688")):
        return 20.0
    if _is_st(name):
        return 5.0
    return 10.0


def is_limit_up(quote: dict) -> bool:
    pct = quote.get("pct_change")
    if pct is None:
        return False
    return pct >= limit_pct(quote["code"], quote["name"]) - 0.05


def is_limit_down(quote: dict) -> bool:
    pct = quote.get("pct_change")
    if pct is None:
        return False
    return pct <= -(limit_pct(quote["code"], quote["name"]) - 0.05)


def field_value(quote: dict, field: str) -> float | None:
    """从 normalized quote row 取条件字段值。"""
    if field == "price":
        return quote.get("price")
    if field == "pct_change":
        return quote.get("pct_change")
    if field == "volume_ratio":
        return quote.get("volume_ratio")
    if field == "amount":
        return quote.get("amount_yi")
    if field == "turnover":
        return quote.get("turnover")
    return None


def describe_condition(cond: dict) -> str:
    return f"{FIELD_LABELS.get(cond['field'], cond['field'])} {OP_LABELS.get(cond['operator'], cond['operator'])} {cond['value']}"


def describe_rule(rule: dict) -> str:
    parts = [describe_condition(c) for c in (rule.get("conditions") or [])]
    joiner = " 且 " if rule.get("combine") == "and" else " 或 "
    return joiner.join(parts)


def eval_condition(cond: dict, quote: dict) -> dict | None:
    """单条件评估；行情缺该字段返回 None（本轮跳过）。"""
    v = field_value(quote, cond["field"])
    if v is None:
        return None
    op = cond["operator"]
    val = cond["value"]
    ok = {
        "<": v < val,
        "<=": v <= val,
        ">": v > val,
        ">=": v >= val,
    }[op]
    return {"ok": bool(ok), "field": cond["field"], "operator": op,
            "value": round(float(v), 3), "threshold": float(val),
            "text": describe_condition(cond)}


def eval_rule(rule: dict, quote: dict) -> dict:
    """规则对单只股票的评估结果。"""
    conds = rule.get("conditions") or []
    results = [eval_condition(c, quote) for c in conds]
    available = [r for r in results if r is not None]
    if not available:
        return {"triggered": False, "near": False, "results": results}
    if rule.get("combine") == "and":
        triggered = all(r["ok"] for r in available)
    else:
        triggered = any(r["ok"] for r in available)

    # "逼近"启发式：未命中但任一条件达到阈值 90%（>类）/ 110%（<类）
    near = False
    if not triggered:
        for r in available:
            if r["ok"]:
                continue
            op, v, t = r["operator"], r["value"], r["threshold"]
            if t == 0:
                continue
            if op in (">", ">=") and v >= t * 0.9:
                near = True
                break
            if op in ("<", "<=") and v <= t * 1.1:
                near = True
                break
    return {"triggered": bool(triggered), "near": bool(near), "results": results}


def matching_alerts(alerts: list[dict], quote: dict) -> tuple[list[dict], list[dict]]:
    """命中/逼近该股票的启用规则。返回 (hit, near)。"""
    hit, near = [], []
    for rule in alerts:
        tk = rule.get("ticker") or ""
        if tk and tk != quote["code"]:
            continue
        res = eval_rule(rule, quote)
        brief = {
            "id": rule.get("id"),
            "name": rule.get("name") or "",
            "condition_text": describe_rule(rule),
        }
        if res["triggered"]:
            brief["results"] = [r for r in res["results"] if r]
            hit.append(brief)
        elif res["near"]:
            brief["results"] = [r for r in res["results"] if r]
            near.append(brief)
    return hit, near
