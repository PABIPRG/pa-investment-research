# -*- coding: utf-8 -*-
"""KYC：风险偏好问卷（推断画像）+ 手动微调 + 语音/文本解析。

与现有风险偏好体系的关系（见 docs/风险偏好分析框架.md）：
  - 下游唯一事实源仍是 preferences.risk_profile（引擎基调/护栏/持仓预算/简报过滤都用它）。
  - KYC 只负责"如何推断并写入"：问卷计分 → 推断画像写入 risk_profile；
    滑块微调 → 在推断画像基础上漂移后再次写入 risk_profile。
  - 原始记录（答案/得分/推断画像/微调）单独存 preferences.kyc，
    其中 inferred_profile 不被手动调整污染，用于 UI 展示「推断 X，当前生效 Y」。

计分核心均为纯函数（无 I/O），可单测。
"""

import json
import re

from .config import settings

# ---- 题组 ----------------------------------------------------------------
# 每题 5 个选项，score 1-5（越高越进取）。quick 为 3 题速测，full 为 8 题完整问卷。
# 维度脱胎于 CSRC 投资者适当性七问，重排为更贴合产品语义的产品化维度。

_QUICK_QIDS = ("horizon", "loss_tolerance", "goal")

QUESTION_BANK = {
    "horizon": {
        "qid": "horizon",
        "title": "你计划持有这笔资金多久？",
        "options": [
            {"label": "3个月以内", "score": 1},
            {"label": "半年到1年", "score": 2},
            {"label": "1-3年", "score": 3},
            {"label": "3-5年", "score": 4},
            {"label": "5年以上", "score": 5},
        ],
    },
    "loss_tolerance": {
        "qid": "loss_tolerance",
        "title": "你能接受的最大亏损幅度？",
        "options": [
            {"label": "不能接受亏损，保本第一", "score": 1},
            {"label": "5%以内", "score": 2},
            {"label": "10%左右", "score": 3},
            {"label": "20%左右", "score": 4},
            {"label": "30%以上也能接受", "score": 5},
        ],
    },
    "goal": {
        "qid": "goal",
        "title": "你的主要投资目标是什么？",
        "options": [
            {"label": "本金安全，稳定跑赢存款", "score": 1},
            {"label": "稳健增值，跑赢通胀即可", "score": 2},
            {"label": "长期增值，追求市场平均回报", "score": 3},
            {"label": "积极增长，博取超额收益", "score": 4},
            {"label": "高回报优先，接受大幅波动", "score": 5},
        ],
    },
    "income_stability": {
        "qid": "income_stability",
        "title": "你的收入稳定性 / 可投资金情况？",
        "options": [
            {"label": "收入不稳定，积蓄有限", "score": 1},
            {"label": "收入一般，有一定积蓄", "score": 2},
            {"label": "收入稳定，有应急储备", "score": 3},
            {"label": "收入较高，闲钱充裕", "score": 4},
            {"label": "高收入/高净值，可承受较大损失", "score": 5},
        ],
    },
    "experience": {
        "qid": "experience",
        "title": "你有多少投资经验？",
        "options": [
            {"label": "没有经验", "score": 1},
            {"label": "1年以内", "score": 2},
            {"label": "1-3年", "score": 3},
            {"label": "3-5年", "score": 4},
            {"label": "5年以上或专业背景", "score": 5},
        ],
    },
    "drawdown_reaction": {
        "qid": "drawdown_reaction",
        "title": "持仓出现明显亏损时，你的第一反应是？",
        "options": [
            {"label": "无法承受，立即止损离场", "score": 1},
            {"label": "非常焦虑，考虑退出", "score": 2},
            {"label": "虽有波动，但能坚持持有", "score": 3},
            {"label": "视为正常波动，冷静应对", "score": 4},
            {"label": "逆势加仓，视其为机会", "score": 5},
        ],
    },
    "knowledge": {
        "qid": "knowledge",
        "title": "你对股票、基金的风险收益特征了解多少？",
        "options": [
            {"label": "完全不了解", "score": 1},
            {"label": "了解一些基本概念", "score": 2},
            {"label": "了解主要产品的风险特征", "score": 3},
            {"label": "较熟悉，能分析产品结构", "score": 4},
            {"label": "专业投资者，深入理解", "score": 5},
        ],
    },
    "product_pref": {
        "qid": "product_pref",
        "title": "你更偏好哪类投资品种？",
        "options": [
            {"label": "存款/货币基金等保本产品", "score": 1},
            {"label": "债券/固收类为主", "score": 2},
            {"label": "股债混合/均衡配置", "score": 3},
            {"label": "股票型基金/个股为主", "score": 4},
            {"label": "高波动品种/杠杆/衍生品", "score": 5},
        ],
    },
}

TIERS = {
    "quick": list(_QUICK_QIDS),
    "full": list(QUESTION_BANK.keys()),
}

# 满分：quick=15，full=40。阈值按比例等价（满 40 时 18/29 为档界）。
SCORE_BANDS = {
    "conservative": {"label": "保守型", "desc": "以保本为先，低波动，严格控回撤"},
    "balanced": {"label": "稳健型", "desc": "价值与成长均衡，风险收益兼顾"},
    "aggressive": {"label": "进取型", "desc": "追求高收益，接受较大波动与回撤"},
}
_BAND_MAXES = {"quick": 15, "full": 40}


def _bands_for(tier: str) -> dict:
    """档位区间（min-max），按 tier 满分等比折算，保证相邻档无缝衔接。

    full：保守 1-18 / 稳健 19-29 / 进取 30-40；quick（×0.375）：1-7 / 8-11 / 12-15。
    """
    max_score = _BAND_MAXES[tier]
    ratio = max_score / 40.0
    cons_max = round(18 * ratio)
    bal_max = round(29 * ratio)
    return {
        "conservative": {"min": 1, "max": cons_max, **SCORE_BANDS["conservative"]},
        "balanced": {"min": cons_max + 1, "max": bal_max, **SCORE_BANDS["balanced"]},
        "aggressive": {"min": bal_max + 1, "max": max_score, **SCORE_BANDS["aggressive"]},
    }


def profile_for_score(score: int, tier: str) -> str:
    """总分 → 画像：<=18×ratio 保守，<=29×ratio 稳健，其余进取。"""
    if score <= round(18 * _BAND_MAXES[tier] / 40.0):
        return "conservative"
    if score <= round(29 * _BAND_MAXES[tier] / 40.0):
        return "balanced"
    return "aggressive"


def score_questionnaire(answers: list[dict], tier: str) -> dict:
    """纯函数计分：answers=[{qid,label,score}] → {score, profile, mapping}。

    tier 必须为 quick/full；answers 必须覆盖该档全部题目，选项分须在 1-5。
    校验失败抛 ValueError（上层转 422）。
    """
    if tier not in TIERS:
        raise ValueError(f"非法问卷档位: {tier}（应为 quick/full）")
    qids = TIERS[tier]
    by_qid = {a.get("qid"): a for a in answers if a}
    missing = [q for q in qids if q not in by_qid]
    if missing:
        raise ValueError(f"问卷缺少题目: {', '.join(missing)}")
    invalid = []
    for qid in qids:
        a = by_qid[qid]
        try:
            score = int(a.get("score"))
        except (TypeError, ValueError):
            invalid.append(f"{qid}: 分数非法")
            continue
        if not 1 <= score <= 5:
            invalid.append(f"{qid}: 分数 {score} 超出 1-5")
        # 选项须属于该题题组（label 兜底校验，防伪造分）
        if qid in QUESTION_BANK:
            valid_labels = [o["label"] for o in QUESTION_BANK[qid]["options"]]
            if a.get("label") not in valid_labels:
                invalid.append(f"{qid}: 选项「{a.get('label')}」不在题组内")
    if invalid:
        raise ValueError("；".join(invalid))
    total = sum(int(by_qid[q]["score"]) for q in qids)
    profile_key = profile_for_score(total, tier)
    return {
        "score": total,
        "profile": profile_key,
        "mapping": _bands_for(tier),
    }


# ---- 手动微调 ------------------------------------------------------------

PROFILE_ORDER = ["conservative", "balanced", "aggressive"]


def apply_manual_adjust(current_kyc: dict | None, adjust: dict) -> str:
    """滑块微调 → 新画像（确定性逻辑）。

    adjust.risk_tolerance ∈ [0,1]：0=保守 / 0.5=稳健 / 1=进取（round(2x) 取档）。
    adjust.horizon_years 作辅助约束：期限 <2 年最多到稳健，≥5 年至少稳健。
    返回新画像 key；inferred_profile 由调用方负责保留（本函数不写 kyc）。
    """
    idx = round(2 * float(adjust.get("risk_tolerance", 0.5)))
    idx = max(0, min(2, idx))
    horizon = int(adjust.get("horizon_years") or 3)
    if horizon < 2:
        idx = min(idx, 1)  # 短期限：不进取
    elif horizon >= 5:
        idx = max(idx, 1)  # 长期限：不保守
    return PROFILE_ORDER[idx]


# ---- 自然语言 / 语音转写 → 结构化答案 --------------------------------------

_KYC_SYSTEM_PROMPT = """你是证券风险偏好问卷助手。把用户的一段自然语言描述，映射为结构化问卷答案。
只输出 JSON 对象，不要多余文字。格式：{"qid": "选项label"}。
qid 取值范围：horizon, loss_tolerance, goal, income_stability, experience, drawdown_reaction, knowledge, product_pref。
选项必须原样使用下方题组中给出的 label，无法从文本判断的题目省略不输出。"""


def _llm_parse(text: str) -> list[dict] | None:
    """LLM 路径：返回 answers 列表，失败/不可用返回 None。"""
    if not settings.llm_available():
        return None
    from .llm import summarize

    bank = "\n".join(
        f"{qid}：{' | '.join(o['label'] for o in q['options'])}"
        for qid, q in QUESTION_BANK.items()
    )
    try:
        raw = summarize(
            system=_KYC_SYSTEM_PROMPT,
            user=f"题组：\n{bank}\n\n用户的描述：\n{text}",
            max_tokens=600,
            response_format="json_object",
        )
        raw = raw.strip()
        # 容错：去掉 markdown 代码围栏
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
        obj = json.loads(raw)
        if not isinstance(obj, dict):
            return None
        return [_resolve_option(qid, label) for qid, label in obj.items()]
    except Exception:
        return None


def _resolve_option(qid: str, label: str) -> dict | None:
    """label → 题组选项；命中返回 {qid,label,score}，未命中/非法返回 None。"""
    q = QUESTION_BANK.get(qid)
    if not q:
        return None
    for o in q["options"]:
        if o["label"] == label:
            return {"qid": qid, "label": label, "score": o["score"]}
    return None


# 关键词降级表：qid → 按优先级排列的 (关键词组, label, score)。
# 顺序即优先级：先匹配高风险/长周期等更具体的锚点，再落回通用词。
_RULE_ANSWERS: dict[str, list[tuple[tuple[str, ...], str, int]]] = {
    "horizon": [
        (("五年以上", "5年以上", "十年", "长期拿"), "5年以上", 5),
        (("三五年", "3-5年", "三年", "3年"), "3-5年", 4),
        (("一两年", "1-2年", "两年", "2年"), "1-3年", 3),
        (("半年", "一年内", "一年以内", "短期", "短线"), "半年到1年", 2),
        (("几个月", "三个月", "3个月"), "3个月以内", 1),
    ],
    "loss_tolerance": [
        (("30%", "百分之三十", "大亏", "都能接受", "不怕亏"), "30%以上也能接受", 5),
        (("20%", "百分之二十"), "20%左右", 4),
        (("10%", "百分之十", "小亏"), "10%左右", 3),
        (("5%", "百分之五"), "5%以内", 2),
        (("不能亏", "不亏", "保本", "亏不得", "一点亏", "受不了亏"), "不能接受亏损，保本第一", 1),
    ],
    "goal": [
        (("高回报", "激进", "大幅波动", "翻倍"), "高回报优先，接受大幅波动", 5),
        (("超额", "积极增长", "博取"), "积极增长，博取超额收益", 4),
        (("长期增值", "平均回报", "长期"), "长期增值，追求市场平均回报", 3),
        (("通胀", "稳健增值"), "稳健增值，跑赢通胀即可", 2),
        (("本金安全", "保本", "稳定", "存款", "安全"), "本金安全，稳定跑赢存款", 1),
    ],
    "income_stability": [
        (("高净值", "很高", "财务自由"), "高收入/高净值，可承受较大损失", 5),
        (("收入较高", "闲钱充裕", "高收入"), "收入较高，闲钱充裕", 4),
        (("收入稳定", "应急储备", "稳定收入"), "收入稳定，有应急储备", 3),
        (("收入一般", "积蓄一般", "不太高"), "收入一般，有一定积蓄", 2),
        (("收入不稳定", "没积蓄", "积蓄少", "积蓄有限"), "收入不稳定，积蓄有限", 1),
    ],
    "experience": [
        (("多年", "专业背景", "资深", "老股民"), "5年以上或专业背景", 5),
        (("五年", "5年"), "3-5年", 4),
        (("三年", "3年"), "1-3年", 3),
        (("一年", "1年"), "1年以内", 2),
        (("没经验", "没有经验", "新手", "刚接触", "刚开始"), "没有经验", 1),
    ],
    "drawdown_reaction": [
        (("加仓", "机会", "抄底"), "逆势加仓，视其为机会", 5),
        (("正常波动", "冷静", "淡定"), "视为正常波动，冷静应对", 4),
        (("坚持", "拿得住", "不卖", "持有"), "虽有波动，但能坚持持有", 3),
        (("焦虑", "紧张", "担心"), "非常焦虑，考虑退出", 2),
        (("止损", "割肉", "受不了", "立刻卖", "马上卖"), "无法承受，立即止损离场", 1),
    ],
    "knowledge": [
        (("专业投资者", "精通", "深入研究"), "专业投资者，深入理解", 5),
        (("较熟悉", "熟悉", "能分析"), "较熟悉，能分析产品结构", 4),
        (("了解主要", "懂风险", "知道风险"), "了解主要产品的风险特征", 3),
        (("基本概念", "了解一点", "知道一点"), "了解一些基本概念", 2),
        (("不了解", "没了解", "不懂"), "完全不了解", 1),
    ],
    "product_pref": [
        (("杠杆", "衍生品", "期权", "期货"), "高波动品种/杠杆/衍生品", 5),
        (("股票", "个股", "股票型"), "股票型基金/个股为主", 4),
        (("混合", "均衡", "股债"), "股债混合/均衡配置", 3),
        (("债券", "固收", "理财"), "债券/固收类为主", 2),
        (("存款", "货币基金", "货币", "保本"), "存款/货币基金等保本产品", 1),
    ],
}


def _rule_parse(text: str) -> list[dict]:
    """关键词降级：逐题命中则产出答案；未命中的题目省略（前端补答）。"""
    answers: list[dict] = []
    for qid, groups in _RULE_ANSWERS.items():
        for keywords, label, score in groups:
            if any(kw in text for kw in keywords):
                answers.append({"qid": qid, "label": label, "score": score})
                break
    return answers


def parse_preferences_to_answers(text: str) -> tuple[list[dict], str]:
    """整段自然语言 → 结构化 answers。双路径保证始终可用。

    返回 (answers, source)，source ∈ {"llm", "rules"}。
    LLM 不可用或解析失败 → 关键词规则降级。
    """
    text = (text or "").strip()
    llm_answers = _llm_parse(text) if text else None
    if llm_answers:
        llm_answers = [a for a in llm_answers if a]
        if llm_answers:
            return llm_answers, "llm"
    return _rule_parse(text), "rules"


# ---- 视图组装 ------------------------------------------------------------


def build_kyc_view(store) -> dict:
    """GET /kyc/profile 响应：现状 + 题组 schema + 阈值（前端唯一事实源）。"""
    from .risk_profiles import RISK_PROFILES, get_risk_profile, profile

    kyc = store.get("preferences", "kyc") or {}
    effective = get_risk_profile()
    return {
        "status": kyc.get("status", "not_started"),
        "inferred_profile": kyc.get("inferred_profile"),
        "effective_profile": effective,
        "effective_label": profile(effective)["label"],
        "score": kyc.get("score"),
        "answers": kyc.get("answers", []),
        "manual_adjust": kyc.get("manual_adjust"),
        "completed_at": kyc.get("completed_at"),
        "method": kyc.get("method"),
        "voice_source": kyc.get("voice_source"),
        "last_profile": store.get("preferences", "last_profile"),
        "tiers": {k: list(v) for k, v in TIERS.items()},
        "question_bank": QUESTION_BANK,
        "bands": _bands_for("full"),
        "profile_labels": {k: profile(k)["label"] for k in PROFILE_ORDER},
        # 各档画像详情（护栏/预算），前端据此渲染「该画像下生效的护栏」卡
        "profiles_detail": RISK_PROFILES,
    }
