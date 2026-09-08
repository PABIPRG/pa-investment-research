# -*- coding: utf-8 -*-
"""自进化 v2 · 基因存档 gene_archive（P0.6）。

把被淘汰的基因**别删，进存档**并带上"它适应的 regime 画像"与 fitness 画像——
进化裁决只区分"环境不配合 vs 能力不行"；哪天市场 regime 切回它擅长的那一档，
可由 `revival_candidates` 召回复测（进化版"经验保留"）。P4 在淘汰动作落库时调用
`archive_record`，P4/P5 由 scheduler 用 `revival_candidates` 做召唤探测。

持久化：collection `gene_archive`，key = 策略 sid（同策略再归档覆盖为最新一代），
value 见 `archive_record`。
"""
from __future__ import annotations

import hashlib
import time
from typing import Optional

from .store import JsonStore

_GENE_ARCHIVE_COLLECTION = "gene_archive"


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def archive_record(
    store: JsonStore,
    record: dict,
    *,
    reason: str,
    regime_profile: dict | None = None,
) -> str | None:
    """把一条策略（含 gene / fitness / 归因）归档。返回存档 key（sid）或 None。

    reason：归档原因（如 "retire:nav" / "retire:stagnant" / "retire:overfit"）。
    regime_profile：存活期市场状态指纹（可先给 None，P5 具备后补）。
    """
    if not isinstance(record, dict) or not record.get("id"):
        return None
    sid = str(record["id"])
    evolve = record.get("evolve")
    evolve = evolve if isinstance(evolve, dict) else {}
    entry = {
        "sid": sid,
        "name": record.get("name"),
        "family": record.get("gene", {}).get("factor", {}).get("family")
        if isinstance(record.get("gene"), dict) else record.get("kind"),
        "kind": record.get("kind"),
        "params": record.get("params"),
        "gene": record.get("gene"),
        "symbols": record.get("symbols"),
        "direction": record.get("direction"),
        "source": record.get("source"),
        "mutated_from": record.get("mutated_from"),
        "generation": record.get("generation"),
        "direction": record.get("direction"),
        "fitness": dict(evolve.get("fitness") or {}),
        "overfit_flag": evolve.get("overfit_flag"),
        "verification_status": record.get("verification_status"),
        "regime_profile": dict(regime_profile or {}),
        "archive_reason": str(reason),
        "archived_at": _now(),
    }
    store.set(_GENE_ARCHIVE_COLLECTION, sid, entry)
    return sid


def revival_candidates(
    store: JsonStore,
    regime: str | None,
    *,
    limit: int = 3,
    exclude: list[str] | None = None,
) -> list[dict]:
    """取"擅长当前 regime"的已存档基因（gate.allow 含当前 regime），按最近归档优先。

    exclude：现有 active sid 列表，避免把仍在跑的召回复制。仅返回候选存档，不自动复活
    ——实际召回（重设为 candidate 重新回测）由调用方决定，P4/P5 实现。
    """
    if not regime or regime == "unknown":
        return []
    exclude_set = {str(s) for s in (exclude or []) if str(s)}
    matches: list[dict] = []
    for sid, rec in (store.all(_GENE_ARCHIVE_COLLECTION) or {}).items():
        if not isinstance(rec, dict):
            continue
        if sid in exclude_set or str(rec.get("sid") or sid) in exclude_set:
            continue
        gene = rec.get("gene")
        gate = (gene or {}).get("regime_gate") if isinstance(gene, dict) else None
        allow = (gate or {}).get("allow") if isinstance(gate, dict) else None
        if isinstance(allow, (list, tuple)) and regime in allow:
            matches.append(rec)
    matches.sort(key=lambda r: str(r.get("archived_at") or ""), reverse=True)
    return matches[: max(1, int(limit))]


def all_archived(store: JsonStore) -> list[dict]:
    rows = [r for r in (store.all(_GENE_ARCHIVE_COLLECTION) or {}).values() if isinstance(r, dict)]
    rows.sort(key=lambda r: str(r.get("archived_at") or ""), reverse=True)
    return rows


def reactivate_archived(
    store: JsonStore,
    regime: str | None,
    *,
    limit: int = 3,
    revive_reason: str = "regime_recall",
) -> list[str]:
    """当 regime 切回擅长档时，把存档基因复活为 candidate 回流重测（P4/P5 召回）。

    - 排除仍在 active/watch/candidate 的 sid（不复制正在评估的）。
    - 原 sid 往往还是 retired 老记录 → 复活写**新** candidate sid（source=revival,
      mutated_from=原 sid，generation+1），交给 Step C 首测。
    - 返回新建 candidate sid 列表；空 → 无可召回。
    """
    if not regime or regime == "unknown":
        return []
    existing = store.all("strategies") or {}
    running = {
        str(sid) for sid, rec in existing.items()
        if isinstance(rec, dict) and str(rec.get("status")) in ("active", "watch", "candidate")
    }
    matches = revival_candidates(
        store, regime, limit=limit, exclude=sorted(running),
    )
    ts = _now()
    created: list[str] = []
    for m in matches:
        orig_sid = str(m.get("sid") or m.get("id") or "")
        if not orig_sid:
            continue
        name = str(m.get("name") or orig_sid)
        kind = str(m.get("kind") or "")
        symbols = [str(x) for x in (m.get("symbols") or []) if str(x)]
        direction = m.get("direction")
        params = dict(m.get("params") or {})
        gene = m.get("gene") if isinstance(m.get("gene"), dict) else None
        if gene is None:
            from . import genome  # noqa: PLC0415
            gene = genome.gene_for(kind, params, symbols, direction)
        gen = int(m.get("generation") or 0) + 1
        digest = hashlib.md5(
            f"{orig_sid}:{regime}:{ts}".encode("utf-8")
        ).hexdigest()[:10]
        new_sid = f"revive-{digest}"
        if new_sid in existing:
            continue
        rec = {
            "id": new_sid,
            "name": f"复活·{name[:20]}",
            "kind": kind,
            "direction": direction,
            "symbols": symbols,
            "params": params,
            "gene": gene,
            "status": "candidate",
            "verification_status": "insufficient",
            "source": "revival",
            "revive_reason": str(revive_reason),
            "mutated_from": orig_sid,
            "generation": gen,
            "backtest": {},
            "evolve": {
                "state": "active", "tier": 1, "updated_at": ts,
                "note": f"存档复活（regime={regime} 切回擅长档，待回测验证）",
            },
            "created_at": ts,
        }
        store.set("strategies", new_sid, rec)
        created.append(new_sid)
    return created


__all__ = [
    "archive_record",
    "revival_candidates",
    "all_archived",
    "reactivate_archived",
    "_GENE_ARCHIVE_COLLECTION",
]
