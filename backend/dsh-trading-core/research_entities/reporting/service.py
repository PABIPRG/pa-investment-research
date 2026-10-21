# -*- coding: utf-8 -*-
"""报告服务：从已落库证据生成、保存与读取结构化报告。"""

from __future__ import annotations

from ..errors import ReportError
from ..models import ReportDraft
from ..toolbox.evidence import build_bundle
from .builder import build_deterministic_report
from .llm_report import build_llm_report


class ReportService:
    def __init__(self, repository, *, llm_call=None) -> None:
        self.repository = repository
        self.llm_call = llm_call

    def build(
        self,
        request_id: str,
        *,
        mode: str = "deterministic",
        persist: bool = True,
    ) -> ReportDraft:
        items = self.repository.list_evidence(request_id)
        if not items:
            raise ReportError(f"请求 {request_id} 没有已落库的工具证据，无法生成报告")
        bundle = build_bundle(request_id, items)
        scope = self.repository.get_scope(request_id)

        if mode in ("llm", "llm_assisted"):
            report = build_llm_report(
                bundle, scope, llm_call=self.llm_call
            )
        elif mode == "deterministic":
            report = build_deterministic_report(bundle, scope)
        else:
            raise ReportError(f"未知报告模式: {mode!r}，可选 deterministic|llm")

        if persist:
            self.repository.save_report(report)
        return report

    def get(self, report_id: str) -> ReportDraft:
        report = self.repository.get_report(report_id)
        if report is None:
            raise ReportError(f"报告不存在: {report_id}")
        return report

    def latest(self, request_id: str) -> ReportDraft:
        reports = self.repository.list_reports(request_id)
        if not reports:
            raise ReportError(f"请求 {request_id} 还没有生成过报告")
        return reports[-1]

    def list(self, request_id: str) -> list[ReportDraft]:
        return self.repository.list_reports(request_id)
