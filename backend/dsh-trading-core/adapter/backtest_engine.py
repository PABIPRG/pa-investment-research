# -*- coding: utf-8 -*-
"""回测引擎：基于历史投资决策的前瞻收益评估（纯逻辑，无 I/O、无 LLM）。

移植 ZhuLinsen/daily_stock_analysis 的 BacktestEngine 核心，并针对本项目
两处增强：
  1. 决策数据源：优先用适配器落盘的结构化 action（买入/持有/卖出），
     历史 full_states_log 纯文本走关键词推断兜底（infer_decision_from_text）。
  2. 聚合指标：在方向准确率/胜率/平均收益之上，追加年化 Sharpe 与最大回撤
     （为 ATLAS 自进化 Phase 1「Sharpe 作为 loss」铺路）。

行情数据依赖：evaluate_decision 接收前复权日线 list[{"date","open","high",
"low","close"}]（来自 holdings_runner._bs_hist，经共享 _bs_lock 串行拉取）。
"""

import math
import re
from typing import Any, Optional

# ---- 关键词表（来自 daily-stock-analysis BacktestEngine，含中英文 + 否定逻辑）----

BULLISH_KEYWORDS = (
    "买入", "加仓", "强烈买入", "增持", "建仓",
    "strong buy", "buy", "add",
)
BEARISH_KEYWORDS = (
    "卖出", "减仓", "强烈卖出", "清仓",
    "strong sell", "sell", "reduce",
)
HOLD_KEYWORDS = (
    "持有", "震荡观望", "洗盘观察", "持有观察",
    "hold", "range-bound watch", "shakeout watch", "hold and watch",
)
WAIT_KEYWORDS = (
    "观望", "等待", "wait",
)

NEGATION_PATTERNS = (
    "not", "don't", "do not", "no", "never", "avoid",  # English
    "不要", "不", "别", "勿", "没有",  # Chinese
)

NEGATION_CONNECTOR_WORDS = (
    "建议", "应", "应当", "宜", "先", "再", "暂", "不必", "必须", "无需",
)

# 结构化 action → 前瞻方向 / 仓位（回测主路径）
ACTION_DIRECTION = {
    "买入": ("up", "long"),
    "卖出": ("down", "cash"),
    "持有": ("not_down", "long"),
    "观望": ("flat", "cash"),
}


def _normalize_text(value: Optional[str]) -> str:
    return str(value or "").strip().lower()


def _is_negated(prefix: str, keyword: str) -> bool:
    """判断候选关键词是否被前缀文本否定（移植参考项目 _is_negated）。"""
    stripped = prefix.rstrip()
    target = (keyword or "").lower().strip()
    if not target:
        return False

    if any(stripped.endswith(neg) for neg in NEGATION_PATTERNS):
        return True

    lookback = stripped[-12:]
    for neg in NEGATION_PATTERNS:
        if not neg:
            continue
        neg_idx = lookback.rfind(neg)
        if neg_idx < 0:
            continue

        suffix_gap = lookback[neg_idx + len(neg):].strip()
        if not suffix_gap:
            return True
        if any(ch in suffix_gap for ch in "，,。；;:!?！？"):
            continue
        if _contains_keyword(suffix_gap, target):
            return True
        # 英文短间隙：否定词 + 连接词（如 "not to sell"）
        if not any("一" <= ch <= "鿿" for ch in suffix_gap):
            if len(suffix_gap) <= 6:
                return True
            continue
        if _is_negation_connector_gap(suffix_gap):
            return True

    return False


def _contains_keyword(text: str, keyword: str) -> bool:
    if not text or not keyword:
        return False
    if bool(re.search(r"[a-z]", keyword)):
        return bool(
            re.search(
                rf"(?<![a-zA-Z0-9_]){re.escape(keyword)}(?![a-zA-Z0-9_])", text
            )
        )
    return keyword in text


def _is_negation_connector_gap(gap: str) -> bool:
    compact = re.sub(r"[\s,，。；;:!?！？]", "", gap).strip()
    if not compact:
        return True
    return compact in NEGATION_CONNECTOR_WORDS


def _first_intent_position(text: str, keywords: tuple[str, ...]) -> Optional[int]:
    """返回关键词在文本中的最早非否定匹配位置，无则 None。"""
    if not text:
        return None
    best_pos: Optional[int] = None
    for kw in keywords:
        if not kw:
            continue
        if text == kw:
            return 0
        keyword = kw.lower().strip()
        if not keyword:
            continue
        # ASCII 关键词：词边界匹配（避免 "watch" 匹配 "wait"）
        if bool(re.search(r"[a-z]", keyword)):
            for match in re.finditer(
                rf"(?<![a-zA-Z0-9_]){re.escape(keyword)}(?![a-zA-Z0-9_])", text
            ):
                if not _is_negated(text[: match.start()], keyword):
                    pos = match.start()
                    if best_pos is None or pos < best_pos:
                        best_pos = pos
                    break
            continue
        # 中文：子串匹配（保留 "建议买入" 生效）
        if re.search(r"[一-鿿]", keyword):
            start = 0
            while True:
                idx = text.find(keyword, start)
                if idx < 0:
                    break
                if not _is_negated(text[:idx], keyword):
                    if best_pos is None or idx < best_pos:
                        best_pos = idx
                    break
                start = idx + len(keyword)
            continue
    return best_pos


def _matches_intent(text: str, keywords: tuple[str, ...]) -> bool:
    return _first_intent_position(text, keywords) is not None


# ---- 文本兜底：关键词方向/仓位推断（移植 infer_direction_expected 等）----

def infer_direction_expected(text: Optional[str]) -> str:
    """从操作建议文本推断预期方向：up / down / not_down / flat。"""
    text = _normalize_text(text)
    if _matches_intent(text, BEARISH_KEYWORDS):
        return "down"
    wait_pos = _first_intent_position(text, WAIT_KEYWORDS)
    if wait_pos is not None:
        bullish_pos = _first_intent_position(text, BULLISH_KEYWORDS)
        hold_pos = _first_intent_position(text, HOLD_KEYWORDS)
        if (bullish_pos is None or wait_pos < bullish_pos) and (
            hold_pos is None or wait_pos < hold_pos
        ):
            return "flat"
    if _matches_intent(text, BULLISH_KEYWORDS):
        return "up"
    if _matches_intent(text, HOLD_KEYWORDS):
        return "not_down"
    if _matches_intent(text, WAIT_KEYWORDS):
        return "flat"
    return "flat"


def infer_position_recommendation(text: Optional[str]) -> str:
    """从操作建议文本推断仓位：long / cash（long-only 系统）。"""
    text = _normalize_text(text)
    if _matches_intent(text, BEARISH_KEYWORDS):
        return "cash"
    wait_pos = _first_intent_position(text, WAIT_KEYWORDS)
    if wait_pos is not None:
        bullish_pos = _first_intent_position(text, BULLISH_KEYWORDS)
        hold_pos = _first_intent_position(text, HOLD_KEYWORDS)
        if (bullish_pos is None or wait_pos < bullish_pos) and (
            hold_pos is None or wait_pos < hold_pos
        ):
            return "cash"
    if _matches_intent(text, BULLISH_KEYWORDS) or _matches_intent(text, HOLD_KEYWORDS):
        return "long"
    if _matches_intent(text, WAIT_KEYWORDS):
        return "cash"
    return "cash"


# 价格提取模式（移植 signal_processing._extract_simple_decision 的增强模式）
_PRICE_PATTERNS = (
    r"目标价[位格]?[：:]?\s*[¥\$]?(\d+(?:\.\d+)?)",
    r"\*\*目标价[位格]?\*\*[：:]?\s*[¥\$]?(\d+(?:\.\d+)?)",
    r"目标[：:]?\s*[¥\$]?(\d+(?:\.\d+)?)",
    r"价格[：:]?\s*[¥\$]?(\d+(?:\.\d+)?)",
    r"[¥\$](\d+(?:\.\d+)?)",
    r"(\d+(?:\.\d+)?)元",
)


def extract_target_price(text: Optional[str]) -> Optional[float]:
    """从决策文本提取目标价；无则 None。"""
    if not text:
        return None
    for pattern in _PRICE_PATTERNS:
        m = re.search(pattern, text)
        if m:
            try:
                return float(m.group(1))
            except (TypeError, ValueError):
                continue
    return None


def infer_decision_from_text(text: Optional[str]) -> dict:
    """文本兜底：解析出一条完整决策。confidence 置 None（文本推断无置信度）。

    返回 {"action", "direction_expected", "position_recommendation",
          "target_price", "confidence"}。action 取值 买入/卖出/持有/观望。
    """
    t = str(text or "")
    direction = infer_direction_expected(t)
    position = infer_position_recommendation(t)
    if _matches_intent(_normalize_text(t), BEARISH_KEYWORDS):
        action = "卖出"
    elif _matches_intent(_normalize_text(t), BULLISH_KEYWORDS):
        action = "买入"
    elif _matches_intent(_normalize_text(t), HOLD_KEYWORDS):
        action = "持有"
    elif _matches_intent(_normalize_text(t), WAIT_KEYWORDS):
        action = "观望"
    else:
        action = "观望"
    return {
        "action": action,
        "direction_expected": direction,
        "position_recommendation": position,
        "target_price": extract_target_price(t),
        "confidence": None,
    }


def structured_decision(action: str) -> dict:
    """结构化 action → 评估所需方向/仓位。未知 action 兜底观望/flat/cash。"""
    direction, position = ACTION_DIRECTION.get(action, ACTION_DIRECTION["观望"])
    return {"direction_expected": direction, "position_recommendation": position}


# ---- 结果分类（移植 _classify_outcome）----

def classify_outcome(
    stock_return_pct: Optional[float],
    direction_expected: str,
    neutral_band_pct: float = 2.0,
) -> tuple[Optional[str], Optional[bool]]:
    """(outcome win/loss/neutral, direction_correct True/False/None)。"""
    if stock_return_pct is None:
        return None, None
    band = abs(float(neutral_band_pct))
    r = float(stock_return_pct)

    if direction_expected == "up":
        if r >= band:
            return "win", True
        if r <= -band:
            return "loss", False
        return "neutral", None
    if direction_expected == "down":
        if r <= -band:
            return "win", True
        if r >= band:
            return "loss", False
        return "neutral", None
    if direction_expected == "not_down":
        if r >= 0:
            return "win", True
        if r <= -band:
            return "loss", False
        return "neutral", None
    # flat
    if abs(r) <= band:
        return "win", True
    return "loss", False


def evaluate_targets(
    forward_bars: list[dict],
    entry_price: float,
    stop_loss: float,
    take_profit: float,
) -> dict:
    """止损/止盈命中判定。forward_bars 为入场后的前景日线（含 open/high/low/close）。

    返回 {hit_sl, hit_tp, first_hit, first_hit_date, first_hit_days,
          exit_price, exit_reason}。exit_reason: stop_loss|take_profit|
          ambiguous|end；同一根 bar 双命中按止损退出。
    """
    has_any = stop_loss is not None or take_profit is not None
    if not has_any:
        return {
            "hit_sl": None, "hit_tp": None, "first_hit": "neither",
            "first_hit_date": None, "first_hit_days": None,
            "exit_price": (forward_bars[-1] or {}).get("close"),
            "exit_reason": "window_end",
        }

    hit_sl: Optional[bool] = None if stop_loss is None else False
    hit_tp: Optional[bool] = None if take_profit is None else False
    first_hit = "neither"
    first_hit_date: Optional[str] = None
    first_hit_days: Optional[int] = None
    exit_price: Optional[float] = (forward_bars[-1] or {}).get("close")
    exit_reason = "window_end"

    for idx, bar in enumerate(forward_bars, start=1):
        low = bar.get("low")
        high = bar.get("high")
        stop_hit = stop_loss is not None and low is not None and low <= stop_loss
        tp_hit = take_profit is not None and high is not None and high >= take_profit
        if stop_hit:
            hit_sl = True
        if tp_hit:
            hit_tp = True
        if not stop_hit and not tp_hit:
            continue

        first_hit_date = bar.get("date")
        first_hit_days = idx
        if stop_hit and tp_hit:
            first_hit = "ambiguous"
            exit_price = stop_loss
            exit_reason = "ambiguous"
            break
        if stop_hit:
            first_hit = "stop_loss"
            exit_price = stop_loss
            exit_reason = "stop_loss"
            break
        first_hit = "take_profit"
        exit_price = take_profit
        exit_reason = "take_profit"
        break

    return {
        "hit_sl": hit_sl, "hit_tp": hit_tp, "first_hit": first_hit,
        "first_hit_date": first_hit_date, "first_hit_days": first_hit_days,
        "exit_price": exit_price, "exit_reason": exit_reason,
    }


# ---- 单条决策评估 ----


def _insufficient_item(cand: dict, reason: str) -> dict:
    """数据不足/失败条目：只填基础字段 + eval_status。"""
    return {
        "key": cand.get("key"),
        "ticker": cand.get("ticker"),
        "trade_date": cand.get("trade_date"),
        "company_name": cand.get("company_name"),
        "decision_source": cand.get("decision_source"),
        "action": cand.get("action"),
        "confidence": cand.get("confidence"),
        "target_price": cand.get("target_price"),
        "direction_expected": cand.get("direction_expected"),
        "position_recommendation": cand.get("position_recommendation"),
        "n_forward_bars": 0,
        "eval_status": "insufficient_data",
        "eval_error": reason,
    }


def evaluate_decision(
    cand: dict,
    hist: list[dict],
    eval_window_days: int,
    stop_loss_pct: float,
    take_profit_pct: float,
    neutral_band_pct: float,
) -> dict:
    """评估一条决策：取 trade_date 起的前景日线，计算收益/方向/止损止盈。

    cand 必需字段：ticker, trade_date, action, direction_expected,
    position_recommendation, key, decision_source。
    前景窗口 = 入场日（首个 date>=trade_date 且 close 有效的 bar）之后的
    前 eval_window_days 个交易日（T+1）。不足窗口 → insufficient_data。
    """
    trade_date = str(cand.get("trade_date") or "")
    entry_idx = None
    for i, bar in enumerate(hist):
        if bar.get("date", "") >= trade_date and bar.get("close") is not None:
            entry_idx = i
            break
    if entry_idx is None:
        item = _insufficient_item(cand, f"无 {trade_date} 之后的行情")
        item["key"] = cand.get("key")
        return item

    entry_price = float(hist[entry_idx]["close"])
    forward_bars = [
        b for b in hist[entry_idx + 1:] if b.get("close") is not None
    ][:eval_window_days]

    base = {
        "key": cand.get("key"),
        "ticker": cand.get("ticker"),
        "trade_date": trade_date,
        "company_name": cand.get("company_name"),
        "decision_source": cand.get("decision_source"),
        "action": cand.get("action"),
        "confidence": cand.get("confidence"),
        "target_price": cand.get("target_price"),
        "direction_expected": cand.get("direction_expected"),
        "position_recommendation": cand.get("position_recommendation"),
        "start_bar_date": hist[entry_idx].get("date"),
    }

    if len(forward_bars) < eval_window_days:
        item = _insufficient_item(cand, f"前景交易日不足（{len(forward_bars)}/{eval_window_days}）")
        item["n_forward_bars"] = len(forward_bars)
        item["start_bar_date"] = hist[entry_idx].get("date")
        return item

    end_close = float(forward_bars[-1]["close"])
    stock_return_pct = (end_close - entry_price) / entry_price * 100
    outcome, direction_correct = classify_outcome(
        stock_return_pct, cand.get("direction_expected") or "flat", neutral_band_pct
    )

    item = {
        **base,
        "end_bar_date": forward_bars[-1].get("date"),
        "n_forward_bars": len(forward_bars),
        "entry_price": entry_price,
        "end_close": end_close,
        "stock_return_pct": round(stock_return_pct, 4),
        "outcome": outcome,
        "direction_correct": direction_correct,
        "eval_status": "evaluated",
        "eval_error": None,
    }

    if cand.get("position_recommendation") != "long":
        item.update({
            "stop_loss": None, "take_profit": None,
            "hit_sl": None, "hit_tp": None, "first_hit": "not_applicable",
            "first_hit_date": None, "first_hit_days": None,
            "exit_price": entry_price, "exit_reason": "cash",
            "simulated_return_pct": 0.0,
        })
        return item

    stop = entry_price * (1 - stop_loss_pct / 100)
    tp = entry_price * (1 + take_profit_pct / 100)
    targets = evaluate_targets(forward_bars, entry_price, stop, tp)
    exit_price = targets["exit_price"] if targets["exit_price"] is not None else end_close
    simulated_return_pct = (exit_price - entry_price) / entry_price * 100

    item.update({
        "stop_loss": round(stop, 4),
        "take_profit": round(tp, 4),
        "hit_sl": targets["hit_sl"],
        "hit_tp": targets["hit_tp"],
        "first_hit": targets["first_hit"],
        "first_hit_date": targets["first_hit_date"],
        "first_hit_days": targets["first_hit_days"],
        "exit_price": exit_price,
        "exit_reason": targets["exit_reason"],
        "simulated_return_pct": round(simulated_return_pct, 4),
    })
    return item


# ---- 聚合 ----


def _avg(values: list[Optional[float]]) -> Optional[float]:
    items = [float(v) for v in values if v is not None]
    if not items:
        return None
    return round(sum(items) / len(items), 4)


def _sample_std(values: list[float]) -> Optional[float]:
    """样本标准差（numpy 无关，聚合条目少）。"""
    n = len(values)
    if n < 2:
        return None
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return math.sqrt(var) if var > 0 else None


def _annualized_sharpe(sim_rets_pct: list[float]) -> Optional[float]:
    """年化 Sharpe：mean/sample_std * sqrt(252)。<2 笔或 std<=0 → None。"""
    if len(sim_rets_pct) < 2:
        return None
    std = _sample_std(sim_rets_pct)
    if std is None or std <= 0:
        return None
    mean = sum(sim_rets_pct) / len(sim_rets_pct)
    return round(mean / std * math.sqrt(252), 4)


def _max_drawdown_pct(sim_rets_pct: list[float]) -> float:
    """逐笔收益序列的峰谷最大回撤（负 %）；空序列 → 0.0。"""
    if not sim_rets_pct:
        return 0.0
    peak = 1.0
    max_dd = 0.0
    equity = 1.0
    for r in sim_rets_pct:
        equity *= 1 + r / 100
        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd
    return round(max_dd * 100, 4)


def compute_summary(results: list[dict], **ctx: Any) -> dict:
    """聚合回测结果：方向准确率/胜率/平均收益/止损止盈/Sharpe/回撤。

    ctx 透传上下文（engine_version / eval_window_days / min_age_days /
    n_decisions_total / n_candidates_evaluated）。results 含 evaluated 与
    insufficient_data 两类条目。
    """
    completed = [r for r in results if (r.get("eval_status") or "") == "evaluated"]
    insufficient_count = sum(
        1 for r in results if (r.get("eval_status") or "") == "insufficient_data"
    )
    fetch_failed_count = sum(
        1 for r in results if (r.get("eval_status") or "") == "fetch_failed"
    )

    win_count = sum(1 for r in completed if r.get("outcome") == "win")
    loss_count = sum(1 for r in completed if r.get("outcome") == "loss")
    neutral_count = sum(1 for r in completed if r.get("outcome") == "neutral")

    dir_denom = sum(1 for r in completed if r.get("direction_correct") is not None)
    dir_num = sum(1 for r in completed if r.get("direction_correct") is True)

    long_count = sum(1 for r in completed if r.get("position_recommendation") == "long")
    cash_count = len(completed) - long_count

    sim_rets = [float(r["simulated_return_pct"]) for r in completed
                if r.get("simulated_return_pct") is not None]

    # 触发器标记字段：evaluate_decision 落的是 hit_sl/hit_tp（evaluate_targets 原样透传）
    stop_applicable = [r for r in completed if r.get("hit_sl") is not None]
    tp_applicable = [r for r in completed if r.get("hit_tp") is not None]
    target_applicable = [
        r for r in completed
        if r.get("hit_sl") is not None or r.get("hit_tp") is not None
    ]
    hit_days = [
        float(r["first_hit_days"]) for r in target_applicable
        if r.get("first_hit_days") is not None
        and r.get("first_hit") in ("stop_loss", "take_profit", "ambiguous")
    ]

    breakdown = _advice_breakdown(completed)
    diagnostics = {
        "eval_status": _count_by(results, "eval_status"),
        "first_hit": _count_by(completed, "first_hit"),
    }

    return {
        "engine_version": ctx.get("engine_version", "v1"),
        "eval_window_days": int(ctx.get("eval_window_days", 10)),
        "min_age_days": ctx.get("min_age_days"),
        "n_decisions_total": int(ctx.get("n_decisions_total", len(results))),
        "n_candidates_evaluated": int(ctx.get("n_candidates_evaluated", 0)),
        "n_evaluated": len(completed),
        "n_insufficient_data": insufficient_count,
        "n_fetch_failed": fetch_failed_count,
        "long_count": long_count,
        "cash_count": cash_count,
        "win_count": win_count,
        "loss_count": loss_count,
        "neutral_count": neutral_count,
        "direction_accuracy_pct": (
            round(dir_num / dir_denom * 100, 2) if dir_denom else None
        ),
        "win_rate_pct": (
            round(win_count / (win_count + loss_count) * 100, 2)
            if (win_count + loss_count) else None
        ),
        "avg_stock_return_pct": _avg([r.get("stock_return_pct") for r in completed]),
        "avg_simulated_return_pct": _avg(sim_rets),
        "sharpe_annualized": _annualized_sharpe(sim_rets),
        "max_drawdown_pct": _max_drawdown_pct(sim_rets),
        "stop_loss_trigger_rate": (
            round(
                sum(1 for r in stop_applicable if r.get("hit_sl") is True)
                / len(stop_applicable) * 100, 2
            ) if stop_applicable else None
        ),
        "take_profit_trigger_rate": (
            round(
                sum(1 for r in tp_applicable if r.get("hit_tp") is True)
                / len(tp_applicable) * 100, 2
            ) if tp_applicable else None
        ),
        "ambiguous_rate": (
            round(
                sum(1 for r in target_applicable if r.get("first_hit") == "ambiguous")
                / len(target_applicable) * 100, 2
            ) if target_applicable else None
        ),
        "avg_days_to_first_hit": _avg(hit_days),
        "advice_breakdown": breakdown,
        "diagnostics": diagnostics,
    }


def _advice_breakdown(completed: list[dict]) -> dict:
    breakdown: dict[str, dict] = {}
    for row in completed:
        advice = str(row.get("action") or "未知")
        bucket = breakdown.setdefault(advice, {"total": 0, "win": 0, "loss": 0, "neutral": 0, "win_rate_pct": None})
        bucket["total"] += 1
        outcome = row.get("outcome")
        if outcome in ("win", "loss", "neutral"):
            bucket[outcome] += 1
    for bucket in breakdown.values():
        denom = bucket["win"] + bucket["loss"]
        bucket["win_rate_pct"] = round(bucket["win"] / denom * 100, 2) if denom else None
    return breakdown


def _count_by(items: list[dict], field: str) -> dict:
    counts: dict[str, int] = {}
    for row in items:
        key = str(row.get(field) or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return counts
