# -*- coding: utf-8 -*-
"""自进化 v2 · 基因组结构 + v1 向后兼容读取（P0.1）。

把进化对象从平铺的 kind+params+symbols 升级为带 regime 开关基因 / 生态位 scope /
归因 meta 的基因组。**策略记录仍是存储载体**：基因以增量 `gene` 键落到现有记录，
老记录没有 `gene` 时由 `read_gene` 回退到 v1 推导的缺省基因（默认全开、不 gate），
保证既有 active 策略行为不变。

regime 标签集合（见 regime.py）：high_vol / trend_up / trend_down / oscillation。
regime_gate.miss_mode = "on_default"：当检测不到 regime（unknown/数据不足）时，
若门控未启用则按默认照常运行（保守，见决策 §9.4；真正的触发门控 P5 才开）。
"""
from __future__ import annotations

from typing import Any, Optional

REGIMES = ("high_vol", "trend_up", "trend_down", "oscillation")


def regime_gate_default() -> dict:
    """结构落库阶段的保守默认：全开、miss 时按默认运行。"""
    return {"allow": list(REGIMES), "miss_mode": "on_default"}


def _clean_direction(direction: Any) -> str:
    return direction if str(direction or "") in ("利好", "利空") else "其他"


def gene_for(
    kind: str,
    params: dict,
    symbols: list[str],
    direction: Any,
    *,
    event_type: str | None = None,
    meta: dict | None = None,
) -> dict:
    """从一次候选/变异的既有字段构造 genome（供落库用）。"""
    return {
        "factor": {
            "family": str(kind),
            "params": dict(params or {}),
        },
        "scope": {
            "pool_ref": {
                "event_type": str(event_type or "").strip() or None,
                "direction": _clean_direction(direction),
            }
        },
        "symbols": [str(s) for s in (symbols or []) if str(s)],
        "direction": _clean_direction(direction),
        "regime_gate": regime_gate_default(),
        "meta": dict(meta or {}),
    }


def default_genome(record: dict) -> dict:
    """老记录无 `gene` 时，由平铺字段推导缺省基因（不写库，仅读取侧回退）。"""
    return gene_for(
        record.get("kind") or "",
        record.get("params") or {},
        record.get("symbols") or [],
        record.get("direction"),
        event_type=None,
    )


def read_gene(record: dict) -> dict:
    """读策略基因：有 `gene` 用，否则回退 v1 推导；并归一关键字段防脏数据。"""
    gene = record.get("gene")
    if not isinstance(gene, dict) or not isinstance(gene.get("factor"), dict):
        gene = default_genome(record)
    gate = gene.get("regime_gate")
    if not isinstance(gate, dict):
        gate = regime_gate_default()
    gene = dict(gene)
    gene["regime_gate"] = _normalize_gate(gate)
    return gene


def _normalize_gate(gate: dict) -> dict:
    allow = gate.get("allow")
    if isinstance(allow, (list, tuple)):
        allow = [str(a) for a in allow if str(a) in REGIMES]
    else:
        allow = list(REGIMES)
    if not allow:  # 空 allow 视为未显式配置 → 保守全开
        allow = list(REGIMES)
    return {
        "allow": allow,
        "miss_mode": gate.get("miss_mode") if str(gate.get("miss_mode")) == "off_default" else "on_default",
    }


def gate_enabled() -> bool:
    """门控总开关（REGIME_GATE_ENABLED）。P5 前默认 false → 永远放行。"""
    from .config import settings

    return bool(settings.regime_gate_enabled)


def regime_allowed(record: dict, regime: str | None) -> bool:
    """该策略是否允许在给定 regime 下触发信号。

    - 门控未启用 → True（保守，不改变 v1 行为）。
    - regime 为 None/unknown（数据不足）→ 按 miss_mode：on_default=True。
    - 否则看 regime 是否在 gate.allow。
    """
    if not gate_enabled():
        return True
    if not regime or regime == "unknown":
        return True  # miss_mode=on_default
    gene = read_gene(record)
    return str(regime) in gene["regime_gate"]["allow"]


def factor_family(record: dict) -> str:
    gene = read_gene(record)
    return str(gene.get("factor", {}).get("family") or record.get("kind") or "")


def pool_scope(record: dict) -> dict:
    gene = read_gene(record)
    return dict((gene.get("scope") or {}).get("pool_ref") or {})


# ---- 生态位族（P2 因子族内迁移）------------------------------------------------
# 同一族内的 kind 是可互相替换的「打法备选」：赢者上、输者下，变异子代可换到族内另一打法
# 而非只微调本 kind 参数。族按策略意图分（利空侧反弹 / 利好侧追涨）；单例 kind（无族内备选）
# 的 family_alternatives 返回 ()，表示不可族内迁移。
NICHE_FAMILIES: dict[str, tuple[str, ...]] = {
    "利空反弹": ("rsi_reversal", "bollinger"),   # 利空超跌反弹：RSI 反转 / 布林下轨回归
    "利好动量": ("momentum", "breakout"),         # 利好追涨动量：动量 / 突破
}
_KIND_TO_NICHE: dict[str, str] = {
    kind: niche for niche, kinds in NICHE_FAMILIES.items() for kind in kinds
}


def family_of(kind: str) -> str | None:
    """kind 所属生态位族名；单例（无族）返回 None。"""
    return _KIND_TO_NICHE.get(str(kind or ""))


def family_alternatives(kind: str) -> tuple[str, ...]:
    """同生态位族内、可替换的其它 kind（不含自身）。无族内备选返回 ()。"""
    niche = _KIND_TO_NICHE.get(str(kind or ""))
    if not niche:
        return ()
    return tuple(k for k in NICHE_FAMILIES[niche] if k != str(kind))


__all__ = [
    "REGIMES",
    "regime_gate_default",
    "gene_for",
    "default_genome",
    "read_gene",
    "gate_enabled",
    "regime_allowed",
    "factor_family",
    "pool_scope",
    "NICHE_FAMILIES",
    "family_of",
    "family_alternatives",
]
