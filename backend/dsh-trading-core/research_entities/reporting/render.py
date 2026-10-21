# -*- coding: utf-8 -*-
"""把结构化报告渲染为 Markdown，供人工阅读或导出。"""

from __future__ import annotations

from ..models import ReportDraft, ReportTable

_KIND_LABELS = {
    "fact": "事实",
    "analysis": "分析",
    "assumption": "假设",
    "risk": "风险",
}


def _cell(value) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _table(table: ReportTable) -> list[str]:
    if not table.columns:
        return []
    lines = [f"**{table.title}**", ""]
    lines.append("| " + " | ".join(_cell(column) for column in table.columns) + " |")
    lines.append("| " + " | ".join("---" for _ in table.columns) + " |")
    for row in table.rows:
        lines.append(
            "| "
            + " | ".join(_cell(row.get(column, "")) for column in table.columns)
            + " |"
        )
    lines.append("")
    return lines


def render_markdown(report: ReportDraft) -> str:
    lines: list[str] = [f"# {report.title}", ""]
    lines.append(
        f"> request_id: `{report.request_id}` · 模式: `{report.mode}` · "
        f"生成时间: {report.created_at.isoformat()}"
    )
    lines.append("")
    if report.summary:
        lines.extend([report.summary, ""])

    for section in report.sections:
        lines.extend([f"## {section.title}", ""])
        for paragraph in section.paragraphs:
            lines.extend([paragraph, ""])
        for claim in section.claims:
            refs = "".join(f"[{ref}]" for ref in claim.evidence_refs)
            suffix = f" {refs}" if refs else ""
            label = _KIND_LABELS.get(claim.kind, claim.kind)
            lines.append(f"- （{label}）{claim.text}{suffix}")
        if section.claims:
            lines.append("")
        for table in section.tables:
            lines.extend(_table(table))

    if report.citations:
        lines.extend(["## 参考证据", ""])
        for citation in report.citations:
            lines.append(
                f"- [{citation.citation_id}] `{citation.tool_id}` · "
                f"{citation.source or '未标注来源'} · {citation.fetched_at.isoformat()} · "
                f"状态 {citation.status} · 记录数 {citation.record_count}"
            )
        lines.append("")

    if report.gaps:
        lines.extend(["## 数据缺口", ""])
        for gap in report.gaps:
            lines.append(
                f"- `{gap.get('tool_id')}` · {gap.get('status')}："
                f"{gap.get('reason') or '未提供原因'}"
            )
        lines.append("")

    if report.warnings:
        lines.extend(["## 生成提示", ""])
        for warning in report.warnings:
            lines.append(f"- {warning}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
