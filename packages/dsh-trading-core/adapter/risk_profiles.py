# -*- coding: utf-8 -*-
"""风险偏好画像（风险偏好驱动分析框架的单一事实源）。

三档：conservative 保守 / balanced 稳健 / aggressive 进取。
每档包含：
  - label / desc：展示文案
  - risk_budget：组合级风险预算上限（持仓分析用）
  - risk_bands：逐股风险分分级阈值（低/中/高）
  - guardrail：个股决策确定性护栏（保守：买入超风险分降级持有；进取：弱卖出信号不触发卖出）
  - brief_max_risk：简报机会点最大展示风险等级

风险偏好约束块文本由引擎侧 tradingagents/agents/managers/risk_manager.py 持有
（引擎不可反向 import adapter）；适配器只透传 risk_profile 键名。

get_risk_profile(params)：params.risk_profile → 兜底 store.preferences.risk_profile → "balanced"
"""

import os

from .store import JsonStore

RISK_PROFILES = {
    "conservative": {
        "label": "保守型",
        "desc": "以保本为先，低波动，严格控回撤，宁错过不套牢",
        "risk_budget": {
            "portfolio_vol_max": 0.12,
            "hhi_max": 0.20,
            "single_stock_weight_max": 0.15,
            "beta_max": 0.80,
        },
        "risk_bands": {"high": 0.35, "medium": 0.20},
        "guardrail": {"buy_risk_score_max": 0.50},
        "brief_max_risk": "medium",
    },
    "balanced": {
        "label": "稳健型",
        "desc": "价值与成长均衡，控制波动与回撤，风险收益兼顾",
        "risk_budget": {
            "portfolio_vol_max": 0.18,
            "hhi_max": 0.30,
            "single_stock_weight_max": 0.25,
            "beta_max": 1.00,
        },
        "risk_bands": {"high": 0.50, "medium": 0.30},
        "guardrail": {"buy_risk_score_max": 0.65},
        "brief_max_risk": "high",
    },
    "aggressive": {
        "label": "进取型",
        "desc": "追求高收益，接受较大波动与回撤，把握成长与题材机会",
        "risk_budget": {
            "portfolio_vol_max": 0.30,
            "hhi_max": 0.50,
            "single_stock_weight_max": 0.40,
            "beta_max": 1.50,
        },
        "risk_bands": {"high": 0.70, "medium": 0.45},
        "guardrail": {"sell_risk_score_min": 0.30},
        "brief_max_risk": "high",
    },
}

DEFAULT_PROFILE = "balanced"
VALID_PROFILES = tuple(RISK_PROFILES.keys())
RISK_LEVEL_ORDER = {"低": 0, "中": 1, "高": 2}


def get_risk_profile(params: dict | None = None) -> str:
    """解析风险偏好：调用参数优先 → store 持久化 → .env RISK_PROFILE 兜底 → 默认 balanced。"""
    if params:
        raw = params.get("risk_profile")
        if isinstance(raw, str) and raw in RISK_PROFILES:
            return raw
    try:
        saved = JsonStore().get("preferences", "risk_profile", None)
        if saved in RISK_PROFILES:
            return saved
    except Exception:
        pass
    env_val = os.getenv("RISK_PROFILE", "")
    if env_val in RISK_PROFILES:
        return env_val
    return DEFAULT_PROFILE


def profile(key: str) -> dict:
    return RISK_PROFILES.get(key, RISK_PROFILES[DEFAULT_PROFILE])


def risk_level_for(score, profile_key: str) -> str:
    """逐股风险分 → 低/中/高（按画像 bands）。"""
    if score is None:
        return "—"
    s = float(score)
    bands = profile(profile_key)["risk_bands"]
    if s >= bands["high"]:
        return "高"
    if s >= bands["medium"]:
        return "中"
    return "低"


def calibrate_stock_decision(signal: dict, profile_key: str) -> tuple[dict, bool, str | None]:
    """个股决策确定性护栏：在引擎输出基础上按画像做轻量修正，防止 LLM 漂移。

    返回 (signal, calibrated, note)。仅在明确冲突时覆盖，否则保持引擎决策原样。
    """
    action = signal.get("action")
    risk_score = signal.get("risk_score")
    try:
        risk = float(risk_score) if risk_score is not None else None
    except (TypeError, ValueError):
        risk = None
    guard = profile(profile_key)["guardrail"]

    calibrated = False
    note = None

    if risk is not None and action == "买入" and "buy_risk_score_max" in guard:
        if risk > guard["buy_risk_score_max"]:
            signal["action"] = "持有"
            calibrated = True
            note = (
                f"风险偏好护栏：{profile(profile_key)['label']}画像下，买入决策的风险分 "
                f"（{risk:.2f}）超过上限 {guard['buy_risk_score_max']:.2f}，已降级为「持有」。"
            )
    elif risk is not None and action == "卖出" and "sell_risk_score_min" in guard:
        if risk < guard["sell_risk_score_min"]:
            signal["action"] = "持有"
            calibrated = True
            note = (
                f"风险偏好护栏：{profile(profile_key)['label']}画像下，卖出决策的风险分 "
                f"（{risk:.2f}）低于下限 {guard['sell_risk_score_min']:.2f}，属弱卖出信号，已降级为「持有」。"
            )

    if note and signal.get("reasoning"):
        signal["reasoning"] = signal["reasoning"] + "\n\n" + note
    elif note:
        signal["reasoning"] = note

    return signal, calibrated, note
