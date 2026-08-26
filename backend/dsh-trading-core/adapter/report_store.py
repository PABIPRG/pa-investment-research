# -*- coding: utf-8 -*-
"""任务报告的稳定磁盘存储与查询契约。

报告与 ``TaskManager`` 的进程内任务状态分离：任务状态仍用于实时进度，
而包含非空正文的成功结果会以 ``task_id`` 为主键写入 JsonStore。这样服务
重启后仍可列出和查看已经生成的报告。
"""

import json
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional

from .store import JsonStore


REPORT_TASK_TYPES = frozenset(
    {"stock", "holdings", "brief", "backtest", "strategy", "shadow"}
)
REPORT_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
MAX_REPORT_LIST_LIMIT = 200

_TASK_TITLES = {
    "stock": "个股分析报告",
    "holdings": "持仓分析报告",
    "brief": "市场简报",
    "backtest": "策略回测报告",
    "strategy": "策略研究报告",
    "shadow": "影子验证报告",
}
_BRIEF_PERIOD_LABELS = {
    "pre_market": "盘前",
    "post_market": "盘后",
    "now": "盘中",
}
_PERSISTED_FIELDS = (
    "id",
    "task_type",
    "title",
    "subject",
    "reference",
    "created_at",
    "section_keys",
    "signal",
    "reports",
)
_SUMMARY_FIELDS = (
    "id",
    "task_type",
    "title",
    "subject",
    "reference",
    "created_at",
    "section_keys",
)


class ReportValidationError(ValueError):
    """报告写入参数或查询参数不符合公开契约。"""


class ReportStoreCorruptionError(RuntimeError):
    """磁盘中的报告记录不符合已声明的报告契约。"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _non_empty_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _ensure_json_compatible(value: Any, field: str) -> None:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ReportValidationError(f"{field} 必须是合法 JSON 值") from exc


def _validate_report_id(report_id: str) -> str:
    if not isinstance(report_id, str) or REPORT_ID_PATTERN.fullmatch(report_id) is None:
        raise ReportValidationError("report_id 必须是 32 位小写十六进制 task_id")
    return report_id


def _validate_task_type(task_type: str) -> str:
    if not isinstance(task_type, str) or task_type not in REPORT_TASK_TYPES:
        allowed = ", ".join(sorted(REPORT_TASK_TYPES))
        raise ReportValidationError(f"task_type 非法，可选值: {allowed}")
    return task_type


def _validate_section_key(key: Any) -> str:
    if not isinstance(key, str) or not key or key != key.strip():
        raise ReportValidationError("报告分节 key 必须是非空且无首尾空白的字符串")
    if len(key) > 80 or any(ord(char) < 32 for char in key):
        raise ReportValidationError("报告分节 key 过长或包含控制字符")
    return key


def _reference_for(task_type: str, params: Mapping[str, Any], signal: Mapping[str, Any]) -> dict:
    """从任务输入与信号提取跨页面可复用的稳定业务引用。"""
    if task_type == "stock":
        ticker = _non_empty_text(signal.get("ticker")) or _non_empty_text(
            params.get("ticker")
        )
        return {"ticker": ticker} if ticker else {}

    if task_type == "holdings":
        raw_holdings = params.get("holdings") or signal.get("holdings") or []
        tickers: list[str] = []
        if isinstance(raw_holdings, list):
            for holding in raw_holdings:
                if not isinstance(holding, Mapping):
                    continue
                ticker = _non_empty_text(holding.get("ticker"))
                if ticker and ticker not in tickers:
                    tickers.append(ticker)
        return {"tickers": tickers} if tickers else {}

    if task_type == "brief":
        reference = {}
        period = _non_empty_text(params.get("period")) or _non_empty_text(
            signal.get("period")
        )
        scope = _non_empty_text(params.get("scope"))
        if period:
            reference["period"] = period
        if scope:
            reference["scope"] = scope
        return reference

    if task_type == "backtest":
        ticker = _non_empty_text(params.get("code"))
        return {"ticker": ticker} if ticker else {}

    strategy_id = _non_empty_text(params.get("strategy_id"))
    return {"strategy_id": strategy_id} if strategy_id else {}


def _subject_for(
    task_type: str,
    reference: Mapping[str, Any],
    signal: Mapping[str, Any],
) -> str:
    if task_type == "stock":
        ticker = _non_empty_text(reference.get("ticker"))
        company_name = _non_empty_text(signal.get("company_name"))
        if company_name and ticker and company_name != ticker:
            return f"{company_name}（{ticker}）"
        return company_name or ticker or "未命名标的"

    if task_type == "holdings":
        tickers = reference.get("tickers")
        if isinstance(tickers, list) and tickers:
            return f"{len(tickers)} 只持仓"
        position_count = signal.get("n_positions")
        if isinstance(position_count, int) and position_count >= 0:
            return f"{position_count} 只持仓"
        return "当前持仓组合"

    if task_type == "brief":
        period = _non_empty_text(reference.get("period"))
        return _BRIEF_PERIOD_LABELS.get(period or "", "市场")

    if task_type == "backtest":
        return _non_empty_text(reference.get("ticker")) or "全部历史决策"

    if task_type == "strategy":
        strategy_id = _non_empty_text(reference.get("strategy_id"))
        strategy_name = _non_empty_text(signal.get("strategy_name"))
        if strategy_name and strategy_id and strategy_name != strategy_id:
            return f"{strategy_name}（{strategy_id}）"
        return strategy_name or strategy_id or "全部策略"

    if task_type == "shadow":
        strategy_id = _non_empty_text(reference.get("strategy_id"))
        strategy_name = _non_empty_text(signal.get("strategy_name"))
        if strategy_name and strategy_id and strategy_name != strategy_id:
            return f"{strategy_name}（{strategy_id}）"
        if strategy_name or strategy_id:
            return strategy_name or strategy_id or "全部策略"
        count = signal.get("strategy_count")
        trade_date = _non_empty_text(signal.get("trade_date"))
        if isinstance(count, int) and count >= 0:
            suffix = f" · {trade_date}" if trade_date else ""
            return f"{count} 个策略{suffix}"
        return "全部策略"

    return "未命名对象"


def _title_for(task_type: str, subject: str) -> str:
    if task_type == "brief":
        return f"{subject}简报"
    return f"{_TASK_TITLES[task_type]} · {subject}"


class ReportStore:
    """以 ``reports.json`` 为后端的报告仓库。"""

    def __init__(self, store: JsonStore | None = None):
        self.store = store if store is not None else JsonStore()

    def save_task_result(
        self,
        task_id: str,
        task_type: str,
        params: Mapping[str, Any],
        result: Mapping[str, Any],
    ) -> Optional[dict]:
        """持久化含非空 Markdown 正文的成功任务；无正文时返回 ``None``。"""
        _validate_report_id(task_id)
        _validate_task_type(task_type)
        if not isinstance(params, Mapping):
            raise ReportValidationError("params 必须是对象")
        if not isinstance(result, Mapping):
            raise ReportValidationError("result 必须是对象")

        raw_reports = result.get("reports")
        if raw_reports is None:
            return None
        if not isinstance(raw_reports, Mapping):
            raise ReportValidationError("reports 必须是对象")

        reports: dict[str, str] = {}
        for raw_key, raw_body in raw_reports.items():
            key = _validate_section_key(raw_key)
            if not isinstance(raw_body, str):
                raise ReportValidationError(f"reports.{key} 必须是字符串")
            if raw_body.strip():
                reports[key] = raw_body
        if not reports:
            return None

        raw_signal = result.get("signal")
        if raw_signal is None:
            signal: dict = {}
        elif isinstance(raw_signal, Mapping):
            signal = dict(raw_signal)
        else:
            raise ReportValidationError("signal 必须是对象")
        _ensure_json_compatible(signal, "signal")

        reference = _reference_for(task_type, params, signal)
        _ensure_json_compatible(reference, "reference")
        subject = _subject_for(task_type, reference, signal)
        record = {
            "id": task_id,
            "task_type": task_type,
            "title": _title_for(task_type, subject),
            "subject": subject,
            "reference": reference,
            "created_at": _utc_now(),
            "section_keys": list(reports),
            "signal": signal,
            "reports": reports,
        }
        record = self._validate_record(record, expected_id=task_id)
        self.store.set("reports", task_id, record)
        return record

    def list_reports(
        self, limit: int = 20, task_type: Optional[str] = None
    ) -> list[dict]:
        """按创建时间倒序返回轻量摘要，不携带 signal 与 Markdown 正文。"""
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise ReportValidationError("limit 必须是整数")
        if limit < 1 or limit > MAX_REPORT_LIST_LIMIT:
            raise ReportValidationError(f"limit 必须在 1 到 {MAX_REPORT_LIST_LIMIT} 之间")
        if task_type is not None:
            _validate_task_type(task_type)

        records = []
        for report_id, raw_record in self.store.all("reports").items():
            try:
                record = self._validate_record(raw_record, expected_id=report_id)
            except ReportValidationError as exc:
                raise ReportStoreCorruptionError(f"报告记录损坏: {report_id}") from exc
            if task_type is None or record["task_type"] == task_type:
                records.append(record)
        records.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
        return [
            {field: record[field] for field in _SUMMARY_FIELDS}
            for record in records[:limit]
        ]

    def get_report(self, report_id: str) -> Optional[dict]:
        """按稳定 task_id 读取完整报告；合法但不存在的 id 返回 ``None``。"""
        _validate_report_id(report_id)
        raw_record = self.store.get("reports", report_id)
        if raw_record is None:
            return None
        try:
            return self._validate_record(raw_record, expected_id=report_id)
        except ReportValidationError as exc:
            raise ReportStoreCorruptionError(f"报告记录损坏: {report_id}") from exc

    @staticmethod
    def _validate_record(raw_record: Any, expected_id: str) -> dict:
        if not isinstance(raw_record, Mapping):
            raise ReportValidationError("报告记录必须是对象")
        report_id = _validate_report_id(raw_record.get("id"))
        if report_id != expected_id:
            raise ReportValidationError("报告记录 id 与存储主键不一致")
        task_type = _validate_task_type(raw_record.get("task_type"))

        title = _non_empty_text(raw_record.get("title"))
        subject = _non_empty_text(raw_record.get("subject"))
        if title is None or subject is None:
            raise ReportValidationError("title 与 subject 必须是非空字符串")

        reference = raw_record.get("reference")
        signal = raw_record.get("signal")
        reports = raw_record.get("reports")
        section_keys = raw_record.get("section_keys")
        if not isinstance(reference, Mapping):
            raise ReportValidationError("reference 必须是对象")
        if not isinstance(signal, Mapping):
            raise ReportValidationError("signal 必须是对象")
        if not isinstance(reports, Mapping) or not reports:
            raise ReportValidationError("reports 必须是非空对象")
        if not isinstance(section_keys, list):
            raise ReportValidationError("section_keys 必须是数组")

        normalized_reports: dict[str, str] = {}
        for raw_key, raw_body in reports.items():
            key = _validate_section_key(raw_key)
            if not isinstance(raw_body, str) or not raw_body.strip():
                raise ReportValidationError(f"reports.{key} 必须是非空字符串")
            normalized_reports[key] = raw_body
        normalized_keys = [_validate_section_key(key) for key in section_keys]
        if normalized_keys != list(normalized_reports):
            raise ReportValidationError("section_keys 必须与 reports 的 key 顺序一致")

        created_at = raw_record.get("created_at")
        if not isinstance(created_at, str):
            raise ReportValidationError("created_at 必须是带时区的 ISO 时间")
        try:
            parsed_created_at = datetime.fromisoformat(created_at)
        except ValueError as exc:
            raise ReportValidationError("created_at 必须是带时区的 ISO 时间") from exc
        if parsed_created_at.tzinfo is None:
            raise ReportValidationError("created_at 必须包含时区")

        normalized = {
            "id": report_id,
            "task_type": task_type,
            "title": title,
            "subject": subject,
            "reference": dict(reference),
            "created_at": created_at,
            "section_keys": normalized_keys,
            "signal": dict(signal),
            "reports": normalized_reports,
        }
        _ensure_json_compatible(normalized, "report")
        return {field: normalized[field] for field in _PERSISTED_FIELDS}
