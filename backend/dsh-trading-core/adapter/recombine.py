# -*- coding: utf-8 -*-
"""自进化 v2 · P3 有性繁殖 + 归因引导有向变异（纯函数层）。

遗传学的 recombination 探索力远超单点 mutation：本模块提供
  - crossover：把两条高 fitness 亲本的基因片段重组 → A 的因子结构(factor) × B 的标的池(symbols)，
    产出带双亲谱系 (parent_a/parent_b) 的子代。
  - 归因引导有向变异：用 per-symbol 证据把「谁在拖累 / 谁在贡献」量化成分数，
    变异朝已证有效方向走——换掉拖累票、加码胜因票，而非盲摇骰子。

全部为纯函数：不碰 store、不拉行情，便于单测。进化侧在 promote 达标后挑高 fitness 亲本配对，
并按扩展证据/影子平仓做剪枝。
"""
from __future__ import annotations

__all__ = [
    "crossover",
    "prune_losers",
    "best_symbols",
    "trade_scores",
    "evidence_scores",
]


def _dir(direction) -> str:
    return direction if str(direction or "") in ("利好", "利空") else "其他"


def crossover(
    kind_a: str,
    params_a: dict,
    symbols_b,
    direction: str,
    *,
    parent_a: str,
    parent_b: str,
    symbol_cap: int = 30,
) -> dict | None:
    """重组：取 A 的因子结构(kind+params) × B 的标的池。

    方向须一致（混 利好/利空 无意义，调用方应只在同向亲本池里配对），不一致返回 None。
    返回带双亲谱系的子代基因规格（未落库）。
    """
    syms_b = [str(x) for x in (symbols_b or []) if x and str(x)]
    syms_b = list(dict.fromkeys(syms_b))[: max(1, int(symbol_cap))]
    if not syms_b:
        return None
    return {
        "kind": str(kind_a),
        "params": dict(params_a or {}),
        "symbols": syms_b,
        "direction": _dir(direction),
        "parent_a": str(parent_a),
        "parent_b": str(parent_b),
    }


def _order_present(symbols, scores, reverse: bool) -> list[str]:
    """按 scores 给 symbols 排序（保留原顺序仅作为并列 tie-break），只排有分的。"""
    present = [s for s in symbols if s in scores]
    unknown = [s for s in symbols if s not in scores]
    present.sort(key=lambda s: scores[s], reverse=reverse)
    return present + unknown


def prune_losers(symbols, scores: dict, *, drop_worst: int = 0) -> list[str]:
    """归因剪枝：把证据最差的 drop_worst 只票从标的集里去掉（拖累票让位）。

    无证据(不在 scores)的票视为"未知"：不主动裁掉（保守，防误删有潜力但还没攒够样本的票）。
    """
    syms = list(dict.fromkeys(str(x) for x in (symbols or []) if str(x)))
    if drop_worst <= 0 or len(syms) <= drop_worst:
        return syms
    ordered = _order_present(syms, scores, reverse=False)  # 最差在前
    drop = set(ordered[:drop_worst])
    return [s for s in syms if s not in drop]


def best_symbols(scores: dict, *, keep: int) -> list[str]:
    """从证据池里挑得分最高的 keep 只票（加码胜因/选票），有分为主、无分兜底。"""
    scored = sorted(
        ((c, float(v)) for c, v in scores.items() if v is not None),
        key=lambda kv: kv[1], reverse=True,
    )
    top = [c for c, _ in scored[: max(0, int(keep))]]
    if not top:
        top = [c for c, _ in scored]
    return top


def trade_scores(trades) -> dict[str, float]:
    """把影子平仓流水聚合为 per-symbol 平均收益分（归因实源）。

    trades 元素形如 {"symbol"|"code": code, "ret_pct": float}；分 = 该票平仓 ret_pct 均值。
    """
    acc: dict[str, list[float]] = {}
    for t in trades or []:
        if not isinstance(t, dict):
            continue
        code = t.get("symbol") or t.get("code") or t.get("sid")
        r = t.get("ret_pct")
        if not code or r is None:
            continue
        try:
            r = float(r)
        except (TypeError, ValueError):
            continue
        acc.setdefault(str(code), []).append(r)
    return {c: (sum(vs) / len(vs)) for c, vs in acc.items()}


def evidence_scores(extended_per_symbol: dict) -> dict[str, float]:
    """把 extended_backtest.per_symbol（P0.4）映射为 per-symbol 得分。

    优先取样本外累计收益 out_cum_ret_pct；缺失退回胜率 out_winrate_pct；都无则跳过。
    """
    out: dict[str, float] = {}
    for code, st in (extended_per_symbol or {}).items():
        if not isinstance(st, dict):
            continue
        val = None
        for key in ("out_cum_ret_pct", "out_winrate_pct", "in_cum_ret_pct", "in_winrate_pct"):
            if st.get(key) is not None:
                val = float(st[key])
                break
        if val is not None:
            out[str(code)] = val
    return out
