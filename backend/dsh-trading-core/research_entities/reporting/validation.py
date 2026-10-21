# -*- coding: utf-8 -*-
"""报告校验：模型可以自由写分析，但不能引用不存在的证据或伪造数字。"""

from __future__ import annotations

import json
import re

from ..models import EvidenceBundle, ReportClaim, ReportDraft

_GAP_STATUSES = ("unavailable", "error", "needs_authorization")
_NUMBER_RE = re.compile(r"\d+(?:,\d{3})*(?:\.\d+)?%?")
_REF_RE = re.compile(r"E\d+")


def normalize_refs(refs: list[str]) -> list[str]:
    """把 ``[E1]`` / ``E1`` 统一成 ``E1``，并按首次出现去重。"""

    values: list[str] = []
    for ref in refs:
        for match in _REF_RE.findall(str(ref)):
            if match not in values:
                values.append(match)
    return values


def _corpus(bundle: EvidenceBundle, evidence_ids: list[str]) -> str:
    by_id = {item.evidence_id: item for item in bundle.items}
    chunks: list[str] = []
    for evidence_id in evidence_ids:
        item = by_id.get(evidence_id)
        if item is None:
            continue
        chunks.append(
            json.dumps(
                {
                    "tool_id": item.tool_id,
                    "source": item.source,
                    "fetched_at": item.fetched_at.isoformat(),
                    "record_count": item.record_count,
                    "data": item.data,
                },
                ensure_ascii=False,
                default=str,
            )
        )
    return "\n".join(chunks)


def _numbers(text: str) -> list[str]:
    return _NUMBER_RE.findall(text)


def _grounded(token: str, corpus: str) -> bool:
    normalized = token.rstrip("%").replace(",", "")
    if normalized in corpus.replace(",", ""):
        return True
    try:
        wanted = float(normalized)
    except ValueError:
        return True
    for match in _NUMBER_RE.finditer(corpus):
        raw = match.group().rstrip("%").replace(",", "")
        try:
            value = float(raw)
        except ValueError:
            continue
        if value == wanted:
            return True
        if value and abs(value - wanted) <= abs(value) * 0.005:
            return True
    return False


def ungrounded_numbers(
    text: str,
    bundle: EvidenceBundle,
    evidence_ids: list[str] | None = None,
) -> list[str]:
    """返回在给定证据中找不到依据的数字，用于摘要等无脚注文本。"""

    ids = (
        evidence_ids
        if evidence_ids is not None
        else [item.evidence_id for item in bundle.items]
    )
    corpus = _corpus(bundle, ids)
    return [token for token in _numbers(text) if not _grounded(token, corpus)]


def validate_claim(
    claim: ReportClaim,
    *,
    bundle: EvidenceBundle,
    citation_ids: set[str],
    evidence_by_id: dict,
) -> list[dict]:
    issues: list[dict] = []

    def add(severity: str, code: str, message: str) -> None:
        issues.append(
            {
                "severity": severity,
                "code": code,
                "claim_id": claim.claim_id,
                "message": message,
            }
        )

    evidence_ids = list(dict.fromkeys(claim.evidence_ids))
    for evidence_id in evidence_ids:
        if evidence_id not in evidence_by_id:
            add("error", "unknown_evidence", f"引用了不存在的证据: {evidence_id}")
    for ref in claim.evidence_refs:
        if ref not in citation_ids:
            add("error", "unknown_citation", f"引用了不存在的脚注: {ref}")

    if claim.kind == "fact":
        if not evidence_ids and not claim.evidence_refs:
            add("error", "fact_without_evidence", "事实性判断必须带证据引用")
        for evidence_id in evidence_ids:
            item = evidence_by_id.get(evidence_id)
            if item is None:
                continue
            if item.status in _GAP_STATUSES:
                add(
                    "error",
                    "fact_from_gap",
                    f"不能把 {item.status} 的证据当作事实依据: {evidence_id}",
                )
            elif item.status == "empty":
                add(
                    "warning",
                    "fact_from_empty",
                    f"证据为空，事实性判断可能过度: {evidence_id}",
                )
        text = claim.text
        corpus = _corpus(bundle, evidence_ids)
        for token in _numbers(text):
            if not _grounded(token, corpus):
                add(
                    "error",
                    "number_not_grounded",
                    f"数字 {token} 未在引用证据中找到",
                )

    if len(claim.text.strip()) < 2:
        add("error", "empty_claim", "判断内容为空")
    return issues


def validate_report(report: ReportDraft, bundle: EvidenceBundle) -> list[dict]:
    """返回全部问题；``error`` 级问题应导致对应判断被丢弃。"""

    issues: list[dict] = []
    citation_ids = {item.citation_id for item in report.citations}
    if len(citation_ids) != len(report.citations):
        issues.append(
            {
                "severity": "error",
                "code": "duplicate_citation",
                "claim_id": None,
                "message": "报告存在重复的脚注编号",
            }
        )
    evidence_by_id = {item.evidence_id: item for item in bundle.items}
    cited_evidence_ids = {item.evidence_id for item in report.citations}
    for evidence_id in cited_evidence_ids:
        if evidence_id not in evidence_by_id:
            issues.append(
                {
                    "severity": "error",
                    "code": "citation_not_in_bundle",
                    "claim_id": None,
                    "message": f"脚注指向不属于本请求的证据: {evidence_id}",
                }
            )
    for section in report.sections:
        for claim in section.claims:
            issues.extend(
                validate_claim(
                    claim,
                    bundle=bundle,
                    citation_ids=citation_ids,
                    evidence_by_id=evidence_by_id,
                )
            )
    return issues
