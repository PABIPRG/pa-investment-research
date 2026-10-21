# -*- coding: utf-8 -*-
"""研究实体报告层：确定性证据汇总 + 可校验的模型分析。"""

from .builder import build_deterministic_report, citations_from_bundle
from .llm_report import LLMReportUnavailable, build_llm_report
from .render import render_markdown
from .service import ReportService
from .validation import normalize_refs, validate_report

__all__ = [
    "LLMReportUnavailable",
    "ReportService",
    "build_deterministic_report",
    "build_llm_report",
    "citations_from_bundle",
    "normalize_refs",
    "render_markdown",
    "validate_report",
]
