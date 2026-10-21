# -*- coding: utf-8 -*-
"""确定性报告骨架：数据表、指标、脚注与缺口全部由代码生成。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from ..models import (
    EvidenceBundle,
    EvidenceItem,
    ReportCitation,
    ReportDraft,
    ReportSection,
    ReportTable,
    ResearchScope,
)

_MAX_TABLE_ROWS = 10
_MAX_COLUMNS = 10
_MAX_CELL_CHARS = 80
_MAX_JSON_CHARS = 800


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, default=str)
    else:
        text = str(value)
    return text if len(text) <= _MAX_CELL_CHARS else text[: _MAX_CELL_CHARS - 1] + "…"


def _records(item: EvidenceItem) -> list[dict]:
    records = item.data.get("records")
    if not isinstance(records, list):
        return []
    return [record for record in records if isinstance(record, dict)]


def citations_from_bundle(bundle: EvidenceBundle) -> list[ReportCitation]:
    return [
        ReportCitation(
            citation_id=f"E{index}",
            evidence_id=item.evidence_id,
            tool_id=item.tool_id,
            source=item.source,
            status=item.status,
            fetched_at=item.fetched_at,
            record_count=item.record_count,
        )
        for index, item in enumerate(bundle.items, start=1)
    ]


def _citation_by_evidence(citations: list[ReportCitation]) -> dict[str, str]:
    return {item.evidence_id: item.citation_id for item in citations}


def _scope_section(scope: ResearchScope | None) -> ReportSection:
    paragraphs: list[str] = []
    tables: list[ReportTable] = []
    if scope is None:
        paragraphs.append("未找到该请求的 Scope 记录，报告只包含工具证据。")
    else:
        intents = "、".join(
            f"{item.intent_code}（{item.confidence:.2f}）" for item in scope.intent_list
        )
        paragraphs.append(f"研究问题：{scope.raw_query}")
        if intents:
            paragraphs.append(f"识别意图：{intents}")
        paragraphs.append(f"Scope 状态：{scope.status}")
        rows = [
            {
                "实体ID": entity.entity_id or "",
                "类型": entity.entity_type_code or "",
                "名称": entity.canonical_name or entity.raw_text,
                "角色": entity.role,
                "解析状态": entity.resolution_status,
            }
            for entity in scope.entity_list
        ]
        if rows:
            tables.append(
                ReportTable(
                    title="研究实体",
                    columns=["实体ID", "类型", "名称", "角色", "解析状态"],
                    rows=rows,
                )
            )
    return ReportSection(
        section_id="scope",
        title="研究问题与范围",
        paragraphs=paragraphs,
        tables=tables,
    )


def _evidence_section(
    bundle: EvidenceBundle, citations: list[ReportCitation]
) -> ReportSection:
    rows = [
        {
            "脚注": citation.citation_id,
            "工具": item.tool_id,
            "状态": item.status,
            "来源": item.source or "",
            "抓取时间": item.fetched_at.isoformat(),
            "记录数": item.record_count,
            "数据来源": "本地缓存" if item.cache_hit else "实时抓取",
        }
        for item, citation in zip(bundle.items, citations)
    ]
    table = ReportTable(
        title="证据清单",
        columns=["脚注", "工具", "状态", "来源", "抓取时间", "记录数", "数据来源"],
        rows=rows,
    )
    paragraphs = [
        f"共执行 {len(bundle.items)} 个工具，状态汇总："
        + "、".join(f"{key} {value}" for key, value in sorted(bundle.summary.items()))
    ]
    cache_hits = sum(1 for item in bundle.items if item.cache_hit)
    if cache_hits:
        paragraphs.append(
            f"其中 {cache_hits} 条证据来自本地缓存；抓取时间保留原始时间，未重新抓取。"
        )
    refs = _citation_by_evidence(citations)
    for item in bundle.items:
        warnings = [
            warning
            for warning in item.warnings
            if "命中本地缓存" not in warning
        ]
        for warning in warnings:
            paragraphs.append(
                f"{refs.get(item.evidence_id, item.evidence_id)} · {item.tool_id} 警告：{warning}"
            )
    if bundle.items:
        latest = max(item.fetched_at for item in bundle.items)
        paragraphs.append(f"数据抓取截止：{latest.isoformat()}")
    return ReportSection(
        section_id="evidence",
        title="证据与数据时效",
        paragraphs=paragraphs,
        tables=[table],
    )


def _data_sections(
    bundle: EvidenceBundle, citations: list[ReportCitation]
) -> list[ReportSection]:
    refs = _citation_by_evidence(citations)
    sections: list[ReportSection] = []
    for item in bundle.items:
        if item.status != "ok":
            continue
        records = _records(item)
        ref = refs[item.evidence_id]
        paragraphs = [
            f"来源：{item.source or '未标注'}；抓取时间：{item.fetched_at.isoformat()}；"
            f"记录数：{item.record_count}。"
        ]
        if item.cache_hit:
            paragraphs.append("本段数据来自本地缓存，抓取时间为原始时间。")
        tables: list[ReportTable] = []
        if records:
            columns: list[str] = []
            for record in records[: _MAX_TABLE_ROWS]:
                for key in record:
                    if key not in columns and len(columns) < _MAX_COLUMNS:
                        columns.append(str(key))
            rows = [
                {column: _cell(record.get(column)) for column in columns}
                for record in records[: _MAX_TABLE_ROWS]
            ]
            title = f"{item.tool_id} 数据（{ref}）"
            if len(records) > _MAX_TABLE_ROWS:
                title += f"，仅展示前 {_MAX_TABLE_ROWS} 条"
            tables.append(
                ReportTable(
                    title=title,
                    columns=columns,
                    rows=rows,
                    evidence_id=item.evidence_id,
                )
            )
        else:
            payload = {
                key: value
                for key, value in item.data.items()
                if key not in ("records", "count")
            }
            if payload:
                text = json.dumps(payload, ensure_ascii=False, default=str)
                if len(text) > _MAX_JSON_CHARS:
                    text = text[: _MAX_JSON_CHARS - 1] + "…"
                paragraphs.append(f"结构化结果（{ref}）：{text}")
        sections.append(
            ReportSection(
                section_id=f"data_{item.tool_id}_{ref}",
                title=f"数据明细 · {item.tool_id}",
                paragraphs=paragraphs,
                tables=tables,
            )
        )
    return sections


def _gaps_section(
    bundle: EvidenceBundle, citations: list[ReportCitation]
) -> ReportSection | None:
    if not bundle.gaps:
        return None
    refs = _citation_by_evidence(citations)
    paragraphs = []
    for gap in bundle.gaps:
        evidence_id = gap.get("evidence_id", "")
        ref = refs.get(evidence_id, evidence_id)
        reason = gap.get("reason") or "未提供原因"
        paragraphs.append(
            f"{ref} · {gap.get('tool_id')} · {gap.get('status')}：{reason}"
        )
    return ReportSection(
        section_id="gaps",
        title="数据缺口",
        paragraphs=paragraphs,
    )


def _conclusion_section(mode: str) -> ReportSection:
    if mode == "deterministic":
        text = (
            "本报告为确定性证据汇总，未启用模型分析；"
            "结论性判断需结合数据缺口人工复核。"
        )
    else:
        text = "模型未产出通过校验的分析判断，本报告仅保留证据汇总。"
    return ReportSection(
        section_id="conclusion",
        title="结论",
        paragraphs=[text],
    )


def build_deterministic_report(
    bundle: EvidenceBundle,
    scope: ResearchScope | None = None,
    *,
    report_id: str | None = None,
    created_at: datetime | None = None,
    title: str | None = None,
    warnings: list[str] | None = None,
) -> ReportDraft:
    citations = citations_from_bundle(bundle)
    sections = [
        _scope_section(scope),
        _evidence_section(bundle, citations),
        *_data_sections(bundle, citations),
    ]
    gaps = _gaps_section(bundle, citations)
    if gaps is not None:
        sections.append(gaps)
    sections.append(_conclusion_section("deterministic"))

    ok_count = bundle.summary.get("ok", 0)
    summary = (
        f"本次研究共执行 {len(bundle.items)} 个工具，其中 {ok_count} 个返回数据，"
        f"{len(bundle.gaps)} 个存在数据缺口。"
    )
    query = scope.raw_query if scope is not None else ""
    return ReportDraft(
        report_id=report_id or f"RPT_{uuid4().hex}",
        request_id=bundle.request_id,
        mode="deterministic",
        title=title or (f"研究报告 · {query}" if query else "研究报告"),
        created_at=created_at or datetime.now(timezone.utc),
        raw_query=query,
        summary=summary,
        sections=sections,
        citations=citations,
        gaps=list(bundle.gaps),
        warnings=list(warnings or []),
    )
