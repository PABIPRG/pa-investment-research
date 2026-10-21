# -*- coding: utf-8 -*-
"""模型辅助报告：模型只写分析文字，引用与数字必须通过校验。"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Callable

from ..models import (
    EvidenceBundle,
    ReportClaim,
    ReportDraft,
    ReportSection,
    ResearchScope,
)
from .builder import build_deterministic_report, citations_from_bundle
from .validation import normalize_refs, ungrounded_numbers, validate_claim

_MAX_ITEM_CHARS = 2500
_ALLOWED_KINDS = ("fact", "analysis", "assumption", "risk")

_SYSTEM = (
    "你是严谨的证券研究助理。你只能使用提供的证据，不得编造数据、事件或来源。"
    "事实性判断必须标注证据编号；分析、假设和风险也要尽量标注依据。"
    "数字必须原样出现在引用证据中，不要自行计算未给出的数字。"
    "如果证据不足，请直接写明数据缺口，不要猜测。"
)


class LLMReportUnavailable(RuntimeError):
    """模型不可用或输出无法解析。"""


def _default_llm_call(system: str, user: str) -> dict:
    try:
        from adapter.llm import chat_json
    except Exception as exc:  # pragma: no cover - 环境相关
        raise LLMReportUnavailable(f"LLM 适配器不可用: {exc}") from exc
    return chat_json(system, user, max_tokens=3000)


def _evidence_digest(bundle: EvidenceBundle, citations) -> list[dict]:
    refs = {item.evidence_id: item.citation_id for item in citations}
    digest: list[dict] = []
    for item in bundle.items:
        text = json.dumps(
            {
                "tool_id": item.tool_id,
                "status": item.status,
                "source": item.source,
                "fetched_at": item.fetched_at.isoformat(),
                "record_count": item.record_count,
                "data": item.data,
                "warnings": item.warnings,
                "error": item.error,
            },
            ensure_ascii=False,
            default=str,
        )
        if len(text) > _MAX_ITEM_CHARS:
            text = text[: _MAX_ITEM_CHARS - 1] + "…"
        digest.append(
            {
                "ref": refs[item.evidence_id],
                "evidence_id": item.evidence_id,
                "tool_id": item.tool_id,
                "status": item.status,
                "source": item.source,
                "fetched_at": item.fetched_at.isoformat(),
                "record_count": item.record_count,
                "content": text,
            }
        )
    return digest


def _prompt(bundle: EvidenceBundle, scope: ResearchScope | None, citations) -> str:
    payload = {
        "question": scope.raw_query if scope is not None else bundle.request_id,
        "intents": (
            [item.intent_code for item in scope.intent_list]
            if scope is not None
            else []
        ),
        "evidence": _evidence_digest(bundle, citations),
        "output_schema": {
            "summary": "3 句以内的总体判断，必须说明数据是否充分",
            "sections": [
                {
                    "title": "章节标题",
                    "claims": [
                        {
                            "text": "判断正文",
                            "kind": "fact | analysis | assumption | risk",
                            "evidence_refs": ["E1", "E2"],
                        }
                    ],
                }
            ],
        },
        "rules": [
            "只能引用 evidence 列表里的 ref（如 E1）",
            "kind=fact 的判断必须带 evidence_refs，且不能引用状态为 unavailable/error 的证据",
            "数字只能来自被引用证据，不要做未展示的计算",
            "至少输出 2 个章节；没有证据支持的维度写进“数据缺口”",
        ],
    }
    return json.dumps(payload, ensure_ascii=False)


def _parse_claims(
    payload: dict,
    *,
    bundle: EvidenceBundle,
    citations,
    citation_ids: set[str],
    evidence_by_id: dict,
    warnings: list[str],
) -> list[ReportSection]:
    sections: list[ReportSection] = []
    counter = 0
    raw_sections = payload.get("sections")
    if not isinstance(raw_sections, list):
        return sections
    for raw_section in raw_sections:
        if not isinstance(raw_section, dict):
            continue
        title = str(raw_section.get("title") or "").strip()
        if not title:
            continue
        claims: list[ReportClaim] = []
        raw_claims = raw_section.get("claims")
        if not isinstance(raw_claims, list):
            continue
        for raw_claim in raw_claims:
            if not isinstance(raw_claim, dict):
                continue
            text = str(raw_claim.get("text") or "").strip()
            if not text:
                continue
            counter += 1
            kind = str(raw_claim.get("kind") or "analysis")
            if kind not in _ALLOWED_KINDS:
                kind = "analysis"
            refs = normalize_refs(
                [str(value) for value in raw_claim.get("evidence_refs") or []]
            )
            raw_ids = [
                str(value) for value in raw_claim.get("evidence_ids") or []
            ]
            by_ref = {item.citation_id: item.evidence_id for item in citations}
            evidence_ids = [by_ref[ref] for ref in refs if ref in by_ref]
            for evidence_id in raw_ids:
                if evidence_id not in evidence_ids:
                    evidence_ids.append(evidence_id)
            claim = ReportClaim(
                claim_id=f"C{counter}",
                text=text,
                kind=kind,
                evidence_ids=evidence_ids,
                evidence_refs=refs,
            )
            issues = validate_claim(
                claim,
                bundle=bundle,
                citation_ids=citation_ids,
                evidence_by_id=evidence_by_id,
            )
            errors = [item for item in issues if item["severity"] == "error"]
            for issue in issues:
                warnings.append(
                    f"{claim.claim_id} · {issue['code']}：{issue['message']}"
                )
            if errors:
                # 宁可丢掉一条判断，也不把未校验的内容写进报告。
                continue
            claims.append(claim)
        if claims:
            sections.append(
                ReportSection(
                    section_id=f"analysis_{len(sections) + 1}",
                    title=title,
                    claims=claims,
                )
            )
    return sections


def build_llm_report(
    bundle: EvidenceBundle,
    scope: ResearchScope | None = None,
    *,
    llm_call: Callable[[str, str], dict] | None = None,
    report_id: str | None = None,
    created_at: datetime | None = None,
) -> ReportDraft:
    """生成模型辅助报告；模型失败时降级为确定性报告。"""

    citations = citations_from_bundle(bundle)
    base = build_deterministic_report(
        bundle, scope, report_id=report_id, created_at=created_at
    )
    warnings = list(base.warnings)
    try:
        payload = (llm_call or _default_llm_call)(
            _SYSTEM, _prompt(bundle, scope, citations)
        )
        if not isinstance(payload, dict):
            raise LLMReportUnavailable("模型返回的不是 JSON 对象")
    except Exception as exc:  # noqa: BLE001 - 模型边界降级
        base.warnings = [*warnings, f"模型不可用，已降级为确定性报告：{exc}"]
        return base

    citation_ids = {item.citation_id for item in citations}
    evidence_by_id = {item.evidence_id: item for item in bundle.items}
    analysis_sections = _parse_claims(
        payload,
        bundle=bundle,
        citations=citations,
        citation_ids=citation_ids,
        evidence_by_id=evidence_by_id,
        warnings=warnings,
    )

    if not analysis_sections:
        base.warnings = [*warnings, "模型没有产出通过校验的分析判断，已保留确定性证据汇总。"]
        return base

    summary = str(payload.get("summary") or "").strip() or base.summary
    fabricated = ungrounded_numbers(summary, bundle)
    if fabricated:
        warnings.append(
            "摘要中的数字未在任何证据中找到，已回退为确定性摘要："
            + "、".join(fabricated)
        )
        summary = base.summary
    sections = list(base.sections)
    # 分析章节紧跟研究范围，证据明细仍然由代码生成并留在报告里。
    sections[1:1] = analysis_sections
    sections[-1] = ReportSection(
        section_id="conclusion",
        title="结论",
        paragraphs=[
            "以上分析仅基于本次请求落库的证据；带 [E#] 的引用可在证据清单中回查，"
            "数据缺口未被用于确定性结论。"
        ],
    )
    return base.model_copy(
        update={
            "mode": "llm_assisted",
            "summary": summary,
            "sections": sections,
            "warnings": warnings,
        }
    )
