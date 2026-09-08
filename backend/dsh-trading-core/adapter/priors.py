# -*- coding: utf-8 -*-
"""自进化 v2 · P6 假设生成先验（纯函数聚合层 + 轻量 store 扫描）。

第 6 点：让"假设生成"也进化。定期统计"哪类 方向×因子族 的策略更容易过样本外"，产出统计
先验（源 = 策略扩展证据/回测的 verification 结论 + gene 生态位），把先验注入
`generate_hypotheses` 的 LLM 系统提示，让上游假设生成倾向与下游筛选协同进化。

口径：以**策略回测 OOS 过验结论**为信号源（`verification_status==passed`，或退
`backtest.out_of_sample.win_rate_pct ≥ 50`）。按 `方向×因子族` 分桶累计 trial/pass，
只报样本 ≥ EVOLVE_PRIOR_MIN_TRIALS 的桶（少样本不作硬约束，只作倾向提示）。

全部纯函数可单测；`build_hint(store)` 是唯一碰 store 的入口，供 scheduler 注入前调用。
"""
from __future__ import annotations

from . import genome

__all__ = [
    "oos_passed",
    "bucket_of",
    "aggregate",
    "render",
    "build_hint",
]


def oos_passed(record: dict) -> bool | None:
    """该策略是否"过样本外"（None=无结论，不计样本）。"""
    if not isinstance(record, dict):
        return None
    vs = record.get("verification_status")
    if isinstance(vs, str) and vs:
        if vs == "passed":
            return True
        if vs in ("not_passed", "rejected"):
            return False
        # insufficient/其它：退到 backtest.oos 胜率
    bt = record.get("backtest")
    oos = (bt or {}).get("out_of_sample") if isinstance(bt, dict) else None
    wr = (oos or {}).get("win_rate_pct") if isinstance(oos, dict) else None
    try:
        if wr is None:
            return None
        return float(wr) >= 50
    except (TypeError, ValueError):
        return None


def bucket_of(record: dict) -> tuple[str, str]:
    """先验桶键：方向 × 因子族（族内换 kind 视为同族，`ma_cross` 单例回落自身）。"""
    kind = str(record.get("kind") or "")
    family = genome.family_of(kind) or kind or "unknown"
    direction = str(record.get("direction") or "")
    if direction not in ("利好", "利空"):
        direction = "未知"
    return (direction, family)


def aggregate(records: list[dict]) -> dict[str, dict]:
    """records（含 kind/direction + oos 结论）→ {key: {trials, passed, pass_rate_pct}}。"""
    acc: dict[str, dict] = {}
    for r in records or []:
        verdict = oos_passed(r)
        if verdict is None:
            continue
        key = "·".join(bucket_of(r))
        cell = acc.setdefault(key, {"trials": 0, "passed": 0, "pass_rate_pct": None})
        cell["trials"] += 1
        if verdict:
            cell["passed"] += 1
    for cell in acc.values():
        cell["pass_rate_pct"] = round(cell["passed"] / cell["trials"] * 100.0, 1)
    return acc


def render(
    table: dict[str, dict],
    *,
    min_trials: int = 3,
    max_lines: int = 8,
) -> list[str]:
    """把聚合表渲染成先验提示行（只报样本达标桶，按过验率升序便于暴露"慎用"）。"""
    eligible = [(k, c) for k, c in table.items() if c["trials"] >= max(1, int(min_trials))]
    eligible.sort(key=lambda kv: kv[1]["pass_rate_pct"])
    lines = []
    for k, c in eligible[-max(1, int(max_lines)):]:
        mark = "优" if c["pass_rate_pct"] >= 60 else ("慎" if c["pass_rate_pct"] <= 40 else "平")
        lines.append(
            f"· {k}：过样本外 {c['passed']}/{c['trials']}（{c['pass_rate_pct']}%，标记={mark}）"
        )
    return lines


def _event_type_of(record: dict) -> str | None:
    gene = record.get("gene")
    if isinstance(gene, dict):
        scope = gene.get("scope") if isinstance(gene.get("scope"), dict) else None
        pool = (scope or {}).get("pool_ref") if isinstance(scope, dict) else None
        if isinstance(pool, dict) and pool.get("event_type"):
            return str(pool["event_type"])
    return None


def build_hint(
    store,
    *,
    min_trials: int | None = None,
    max_lines: int | None = None,
) -> str:
    """扫描 strategies 的回测结论 → 先验提示文本（空=无可报，调用方按无先验处理）。

    min_trials/max_lines 缺省读 settings（EVOLVE_PRIOR_MIN_TRIALS / EVOLVE_PRIOR_MAX_LINES）。
    """
    from .config import settings  # noqa: PLC0415

    mt = int(min_trials if min_trials is not None else getattr(
        settings, "evolve_prior_min_trials", 3))
    ml = int(max_lines if max_lines is not None else getattr(
        settings, "evolve_prior_max_lines", 8))
    strategies = (store.all("strategies") or {}) if store else {}
    rows = [
        rec for rec in strategies.values()
        if isinstance(rec, dict)
    ]
    table = aggregate(rows)
    lines = render(table, min_trials=mt, max_lines=ml)
    if not lines:
        return ""
    header = (
        f"[历史先验·样本外过验统计（每桶样本 ≥ {mt}，越靠后越该谨慎）：]"
    )
    return header + "\n" + "\n".join(lines)
