# -*- coding: utf-8 -*-
"""联系条件的三值评估（V1.3 §5.6）。

产品口径：

- 数值条件由程序按“已登记的规则”比较；阈值与方法依据必须来自用户约定或
  明确采用的方法依据，模型不能临时补成生效规则。
- 语义条件校验 DSH 判断、置信度与证据是否对得上，不由核心替模型下结论。
- 结论只有 met / unmet / unknown；执行或口径故障单记为 error。
- 组合条件按 all / any / not 传播：故障优先于未知，未知传播为未知。

本模块不做 IO，不读数据库，只接收一份研究结果。
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from .models import ResearchJobResult

ConditionResult = Literal["met", "unmet", "unknown", "error"]

_NUMERIC_OPERATORS = {
    ">": lambda value, threshold: value > threshold,
    ">=": lambda value, threshold: value >= threshold,
    "<": lambda value, threshold: value < threshold,
    "<=": lambda value, threshold: value <= threshold,
    "==": lambda value, threshold: value == threshold,
    "!=": lambda value, threshold: value != threshold,
}
_TRANSFORMS = {"value", "difference", "ratio"}
_SEMANTIC_VERDICTS = {"met", "unmet", "unknown"}


class ConditionDefinitionError(ValueError):
    """条件定义本身不合法（不是未知，而是配置错误）。"""


@dataclass(frozen=True)
class ConditionOutcome:
    result: ConditionResult
    detail: str = ""
    evidence_refs: tuple[str, ...] = ()

    @property
    def is_met(self) -> bool:
        return self.result == "met"


def default_condition() -> dict[str, Any]:
    """未约定具体条件时的默认口径：由 DSH 判断是否值得联系。

    这仍然是一个语义条件，只是“判断对象”换成了研究结果里的联系建议；
    建议必须带依据，核心不替模型补结论。
    """

    return {
        "type": "semantic",
        "claim": "notable_change",
        "expected": "met",
        "source": "contact_suggestion",
        "evidence_required": False,
    }


def condition_key_for(policy: Mapping[str, Any]) -> str:
    """冷却、暂缓与合并使用的稳定条件键。

    显式 ``condition_key`` 优先；否则按条件（或日程）内容做确定性摘要，
    保证同一约定在多个版本、多次执行间保持一致。
    """

    explicit = policy.get("condition_key")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    mode = policy.get("mode")
    if mode in {"scheduled_delivery", "due_reminder"}:
        return "schedule:" + _digest(policy.get("schedule") or mode)
    condition = policy.get("condition")
    if isinstance(condition, Mapping) and condition:
        return "cond:" + _digest(condition)
    return "notable_change"


def validate_condition_definition(condition: Mapping[str, Any] | None) -> None:
    """保存委托时校验条件结构；坏规则不能等到首次执行才暴露。"""

    if condition is None:
        return
    if not isinstance(condition, Mapping):
        raise ConditionDefinitionError("条件必须是对象")
    kind = condition.get("type")
    if kind == "numeric":
        _required_text(condition, "metric")
        if condition.get("operator") not in _NUMERIC_OPERATORS:
            raise ConditionDefinitionError(
                f"不支持的比较符 {condition.get('operator')!r}"
            )
        if not _is_number(condition.get("threshold")):
            raise ConditionDefinitionError("threshold 必须是数值")
        if condition.get("transform", "value") not in _TRANSFORMS:
            raise ConditionDefinitionError(
                f"不支持的比较方式 {condition.get('transform')!r}"
            )
        for field in ("unit", "method_version", "period", "basis_ref", "baseline_metric"):
            value = condition.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ConditionDefinitionError(f"{field} 必须是非空字符串")
        return
    if kind in {"percentile", "drawdown"}:
        _required_text(condition, "series")
        if condition.get("operator") not in _NUMERIC_OPERATORS:
            raise ConditionDefinitionError(
                f"不支持的比较符 {condition.get('operator')!r}"
            )
        if not _is_number(condition.get("threshold")):
            raise ConditionDefinitionError("threshold 必须是数值")
        for field, minimum in (("window", 2), ("min_samples", 2)):
            value = condition.get(field)
            if value is None:
                continue
            if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
                raise ConditionDefinitionError(f"{field} 必须是不小于 {minimum} 的整数")
        for field in ("unit", "method_version", "basis_ref", "source_ref"):
            value = condition.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ConditionDefinitionError(f"{field} 必须是非空字符串")
        return
    if kind == "semantic":
        _required_text(condition, "claim")
        if condition.get("expected", "met") not in {"met", "unmet"}:
            raise ConditionDefinitionError("expected 只能是 met 或 unmet")
        confidence = condition.get("min_confidence", 0.0)
        if not _is_number(confidence) or not 0 <= float(confidence) <= 1:
            raise ConditionDefinitionError("min_confidence 必须在 0 到 1 之间")
        if "evidence_required" in condition and not isinstance(
            condition["evidence_required"], bool
        ):
            raise ConditionDefinitionError("evidence_required 必须是布尔值")
        return
    if kind in {"all", "any"}:
        children = condition.get("conditions")
        if not isinstance(children, list) or not children:
            raise ConditionDefinitionError(f"{kind} 需要非空的 conditions 列表")
        for child in children:
            validate_condition_definition(child)
        return
    if kind == "not":
        validate_condition_definition(condition.get("condition"))
        if not isinstance(condition.get("condition"), Mapping):
            raise ConditionDefinitionError("not 缺少 condition")
        return
    raise ConditionDefinitionError(f"未知条件类型 {kind!r}")


def evaluate_condition(
    condition: Mapping[str, Any] | None,
    result: ResearchJobResult,
    *,
    basis: Mapping[str, Any] | None = None,
) -> ConditionOutcome:
    """评估单个条件；``None`` 表示使用默认口径。"""

    if condition is None:
        condition = default_condition()
    if not isinstance(condition, Mapping):
        return ConditionOutcome("error", "condition_invalid: 条件必须是对象")

    kind = condition.get("type")
    try:
        if kind == "numeric":
            return _evaluate_numeric(condition, result, basis or {})
        if kind in {"percentile", "drawdown"}:
            return _evaluate_series_position(kind, condition, result, basis or {})
        if kind == "semantic":
            return _evaluate_semantic(condition, result)
        if kind in {"all", "any"}:
            return _evaluate_composite(kind, condition, result, basis or {})
        if kind == "not":
            inner = condition.get("condition")
            if not isinstance(inner, Mapping):
                return ConditionOutcome("error", "condition_invalid: not 缺少 condition")
            outcome = evaluate_condition(inner, result, basis=basis)
            if outcome.result == "unknown":
                return outcome
            if outcome.result == "error":
                return outcome
            flipped = "unmet" if outcome.result == "met" else "met"
            return ConditionOutcome(flipped, outcome.detail, outcome.evidence_refs)
    except ConditionDefinitionError as exc:
        return ConditionOutcome("error", f"condition_invalid: {exc}")
    except (TypeError, ValueError) as exc:
        return ConditionOutcome("error", f"condition_invalid: {exc}")
    return ConditionOutcome("error", f"condition_invalid: 未知条件类型 {kind!r}")


# ── 数值条件 ───────────────────────────────────────────────────────


def _evaluate_numeric(
    condition: Mapping[str, Any],
    result: ResearchJobResult,
    basis: Mapping[str, Any],
) -> ConditionOutcome:
    metric = _required_text(condition, "metric")
    operator = condition.get("operator")
    if operator not in _NUMERIC_OPERATORS:
        raise ConditionDefinitionError(f"不支持的比较符 {operator!r}")
    threshold = condition.get("threshold")
    if not _is_number(threshold):
        raise ConditionDefinitionError("threshold 必须是数值")
    transform = condition.get("transform", "value")
    if transform not in _TRANSFORMS:
        raise ConditionDefinitionError(f"不支持的比较方式 {transform!r}")

    metrics = _metrics(result)
    entry = metrics.get(metric)
    if not isinstance(entry, Mapping):
        return ConditionOutcome("unknown", f"metric_unavailable: {metric}")
    value = entry.get("value")
    if not _is_number(value):
        return ConditionOutcome("unknown", f"metric_unavailable: {metric}")
    evidence = _evidence_refs(entry)

    unit = condition.get("unit")
    if unit is not None and entry.get("unit") is not None and entry["unit"] != unit:
        return ConditionOutcome(
            "unknown", f"unit_mismatch: {metric} 为 {entry['unit']}，约定为 {unit}", evidence
        )
    method_version = condition.get("method_version") or _basis_value(
        basis, metric, "method_version"
    )
    if (
        method_version is not None
        and entry.get("method_version") is not None
        and entry["method_version"] != method_version
    ):
        return ConditionOutcome(
            "unknown",
            f"method_version_mismatch: {metric} 为 {entry['method_version']}，约定为 {method_version}",
            evidence,
        )
    period = condition.get("period")
    if period is not None and entry.get("period") is not None and entry["period"] != period:
        return ConditionOutcome(
            "unknown", f"period_mismatch: {metric} 为 {entry['period']}，约定为 {period}", evidence
        )
    if _basis_ref(condition, basis, metric) is None:
        # 数值阈值必须有用户约定或明确的方法依据。
        return ConditionOutcome("error", f"missing_basis: {metric} 缺少阈值依据", evidence)

    comparable = float(value)
    if transform != "value":
        baseline = _baseline_value(condition, entry, metrics)
        if baseline is None:
            return ConditionOutcome("unknown", f"baseline_missing: {metric}", evidence)
        if transform == "difference":
            comparable = float(value) - float(baseline)
        else:
            if float(baseline) == 0:
                return ConditionOutcome("unknown", f"baseline_zero: {metric}", evidence)
            comparable = float(value) / float(baseline)

    matched = _NUMERIC_OPERATORS[operator](comparable, float(threshold))
    detail = (
        f"{metric}{_operator_text(transform)}={_format(comparable)} "
        f"{operator} {_format(float(threshold))} -> {'满足' if matched else '不满足'}"
    )
    return ConditionOutcome("met" if matched else "unmet", detail, evidence)


def _baseline_value(
    condition: Mapping[str, Any],
    entry: Mapping[str, Any],
    metrics: Mapping[str, Any],
) -> Any:
    baseline_metric = condition.get("baseline_metric")
    if isinstance(baseline_metric, str) and baseline_metric:
        other = metrics.get(baseline_metric)
        if not isinstance(other, Mapping):
            return None
        return other.get("value")
    baseline = entry.get("baseline")
    if isinstance(baseline, Mapping):
        return baseline.get("value")
    if _is_number(baseline):
        return baseline
    return None


# ── 历史位置条件（价格分位 / 回撤） ────────────────────────────────


def _evaluate_series_position(
    kind: str,
    condition: Mapping[str, Any],
    result: ResearchJobResult,
    basis: Mapping[str, Any],
) -> ConditionOutcome:
    """用程序从同口径历史序列计算分位或回撤，模型不参与数值。

    并列值规则：分位按“小于等于当前值”的样本占比计算，样本量一并返回。
    """

    series_name = _required_text(condition, "series")
    operator = condition.get("operator")
    if operator not in _NUMERIC_OPERATORS:
        raise ConditionDefinitionError(f"不支持的比较符 {operator!r}")
    threshold = condition.get("threshold")
    if not _is_number(threshold):
        raise ConditionDefinitionError("threshold 必须是数值")
    window = condition.get("window", 250)
    min_samples = condition.get("min_samples", 20)
    if not isinstance(window, int) or isinstance(window, bool) or window < 2:
        raise ConditionDefinitionError("window 必须是不小于 2 的整数")
    if not isinstance(min_samples, int) or isinstance(min_samples, bool) or min_samples < 2:
        raise ConditionDefinitionError("min_samples 必须是不小于 2 的整数")

    entry = _series(result, series_name)
    if entry is None:
        return ConditionOutcome("unknown", f"series_missing: {series_name}")
    evidence = _evidence_refs(entry)
    unit = condition.get("unit")
    if unit is not None and entry.get("unit") is not None and entry["unit"] != unit:
        return ConditionOutcome(
            "unknown", f"unit_mismatch: {series_name} 为 {entry['unit']}，约定为 {unit}", evidence
        )
    method_version = condition.get("method_version") or _basis_value(
        basis, series_name, "method_version"
    )
    if (
        method_version is not None
        and entry.get("method_version") is not None
        and entry["method_version"] != method_version
    ):
        return ConditionOutcome(
            "unknown",
            f"method_version_mismatch: {series_name} 为 {entry['method_version']}，约定为 {method_version}",
            evidence,
        )
    if _basis_ref(condition, basis, series_name) is None:
        return ConditionOutcome("error", f"missing_basis: {series_name} 缺少阈值依据", evidence)

    points = _series_points(entry)
    if points is None:
        return ConditionOutcome("unknown", f"series_invalid: {series_name} 含非数值点", evidence)
    if len(points) < min_samples:
        return ConditionOutcome(
            "unknown",
            f"insufficient_samples: {series_name} 仅 {len(points)} 个点，约定至少 {min_samples}",
            evidence,
        )
    window_points = points[-window:]
    current = window_points[-1][1]
    if kind == "percentile":
        matched_count = sum(1 for _, value in window_points if value <= current)
        comparable = matched_count / len(window_points) * 100
        label = "分位"
        suffix = "%"
    else:
        peak = max(value for _, value in window_points)
        comparable = (current / peak - 1) * 100 if peak else 0.0
        label = "回撤"
        suffix = "%"
    matched = _NUMERIC_OPERATORS[operator](comparable, float(threshold))
    detail = (
        f"{series_name} {label}={_format(comparable)}{suffix}（样本 {len(window_points)}）"
        f" {operator} {_format(float(threshold))} -> {'满足' if matched else '不满足'}"
    )
    return ConditionOutcome("met" if matched else "unmet", detail, evidence)


def _series(result: ResearchJobResult, name: str) -> Mapping[str, Any] | None:
    series = (result.structured_result or {}).get("series")
    if not isinstance(series, Mapping):
        return None
    entry = series.get(name)
    return entry if isinstance(entry, Mapping) else None


def _series_points(entry: Mapping[str, Any]) -> list[tuple[str | None, float]] | None:
    raw = entry.get("points")
    if not isinstance(raw, list) or not raw:
        return None
    points: list[tuple[str | None, float]] = []
    for item in raw:
        if isinstance(item, Mapping):
            value = item.get("value", item.get("close"))
            day = item.get("date")
            day = str(day) if isinstance(day, str) else None
        else:
            value = item
            day = None
        if not _is_number(value) or not math.isfinite(float(value)):
            return None
        points.append((day, float(value)))
    if all(day is not None for day, _ in points):
        # 有日期时按日期排序，避免上游乱序影响窗口；日期相同保持稳定顺序。
        points.sort(key=lambda item: item[0] or "")
    return points


# ── 语义条件 ───────────────────────────────────────────────────────


def _evaluate_semantic(
    condition: Mapping[str, Any], result: ResearchJobResult
) -> ConditionOutcome:
    claim = _required_text(condition, "claim")
    expected = condition.get("expected", "met")
    if expected not in {"met", "unmet"}:
        raise ConditionDefinitionError("expected 只能是 met 或 unmet")
    min_confidence = condition.get("min_confidence", 0.0)
    if not _is_number(min_confidence) or not 0 <= float(min_confidence) <= 1:
        raise ConditionDefinitionError("min_confidence 必须在 0 到 1 之间")
    evidence_required = condition.get("evidence_required", True)

    judgement = _judgement(result, claim, condition.get("source"))
    if judgement is None:
        return ConditionOutcome("unknown", f"judgement_missing: {claim}")

    verdict = judgement.get("judgement")
    if verdict not in _SEMANTIC_VERDICTS:
        return ConditionOutcome("error", f"invalid_judgement: {claim} 为 {verdict!r}")
    evidence = _evidence_refs(judgement)
    if verdict == "unknown":
        return ConditionOutcome("unknown", f"judgement_unknown: {claim}", evidence)

    matched = verdict == expected
    # “不满足”只是保持安静，不需要为沉默补证据；只有将触发联系的结论
    # 才必须通过置信度与证据批次校验。
    if matched:
        confidence = judgement.get("confidence")
        if confidence is not None:
            if not _is_number(confidence) or not 0 <= float(confidence) <= 1:
                return ConditionOutcome("error", f"invalid_confidence: {claim}", evidence)
            if float(confidence) < float(min_confidence):
                return ConditionOutcome("unknown", f"low_confidence: {claim}", evidence)

        if evidence_required:
            if result.evidence_batch_id is None:
                return ConditionOutcome(
                    "unknown", f"evidence_batch_missing: {claim}", evidence
                )
            if not evidence:
                return ConditionOutcome("unknown", f"evidence_missing: {claim}")
            known = _known_evidence(result)
            if known is not None and any(ref not in known for ref in evidence):
                return ConditionOutcome(
                    "unknown", f"evidence_not_in_batch: {claim}", evidence
                )

    return ConditionOutcome(
        "met" if matched else "unmet",
        f"{claim}={verdict}" + (f"（{judgement.get('reason')}）" if judgement.get("reason") else ""),
        evidence,
    )


def _judgement(
    result: ResearchJobResult, claim: str, source: str | None
) -> Mapping[str, Any] | None:
    if claim == "notable_change" and source == "contact_suggestion":
        suggestion = result.contact_suggestion or {}
        judgements = suggestion.get("judgements")
        if isinstance(judgements, Mapping) and isinstance(judgements.get(claim), Mapping):
            return judgements[claim]
        flag = suggestion.get("should_contact", suggestion.get("contact"))
        if isinstance(flag, bool):
            return {"judgement": "met" if flag else "unmet", "evidence_refs": []}
        if suggestion.get("decision") in {"send", "suppress"}:
            return {
                "judgement": "met" if suggestion["decision"] == "send" else "unmet",
                "evidence_refs": [],
            }
        return None
    for container in (result.contact_suggestion or {}, result.structured_result or {}):
        judgements = container.get("judgements")
        if isinstance(judgements, Mapping) and isinstance(judgements.get(claim), Mapping):
            return judgements[claim]
    return None


# ── 组合条件 ───────────────────────────────────────────────────────


def _evaluate_composite(
    kind: str,
    condition: Mapping[str, Any],
    result: ResearchJobResult,
    basis: Mapping[str, Any],
) -> ConditionOutcome:
    children = condition.get("conditions")
    if not isinstance(children, list) or not children:
        raise ConditionDefinitionError(f"{kind} 需要非空的 conditions 列表")
    outcomes = [
        evaluate_condition(child, result, basis=basis) for child in children
    ]
    evidence = tuple(ref for child in outcomes for ref in child.evidence_refs)
    if kind == "all":
        if any(child.result == "unmet" for child in outcomes):
            return ConditionOutcome(
                "unmet", _join_detail("all", outcomes, "unmet"), evidence
            )
    else:
        if any(child.result == "met" for child in outcomes):
            return ConditionOutcome("met", _join_detail("any", outcomes, "met"), evidence)
    if any(child.result == "error" for child in outcomes):
        return ConditionOutcome("error", _join_detail(kind, outcomes, "error"), evidence)
    if any(child.result == "unknown" for child in outcomes):
        return ConditionOutcome("unknown", _join_detail(kind, outcomes, "unknown"), evidence)
    if kind == "all":
        return ConditionOutcome("met", _join_detail("all", outcomes, "met"), evidence)
    return ConditionOutcome("unmet", _join_detail("any", outcomes, "unmet"), evidence)


def _join_detail(kind: str, outcomes: list[ConditionOutcome], tag: str) -> str:
    parts = [item.detail for item in outcomes if item.result == tag]
    return f"{kind}:{tag}(" + "; ".join(parts) + ")"


# ── 小工具 ─────────────────────────────────────────────────────────


def _metrics(result: ResearchJobResult) -> Mapping[str, Any]:
    metrics = (result.structured_result or {}).get("metrics")
    return metrics if isinstance(metrics, Mapping) else {}


def _known_evidence(result: ResearchJobResult) -> set[str] | None:
    raw = (result.structured_result or {}).get("evidence_ids")
    if isinstance(raw, list):
        return {str(item) for item in raw}
    index = (result.structured_result or {}).get("evidence_index")
    if isinstance(index, Mapping):
        return {str(key) for key in index}
    return None


def _evidence_refs(entry: Mapping[str, Any]) -> tuple[str, ...]:
    refs: list[str] = []
    source_ref = entry.get("source_ref")
    if isinstance(source_ref, str) and source_ref:
        refs.append(source_ref)
    raw = entry.get("evidence_refs")
    if isinstance(raw, list):
        refs.extend(str(item) for item in raw if isinstance(item, str) and item)
    return tuple(dict.fromkeys(refs))


def _basis_ref(
    condition: Mapping[str, Any], basis: Mapping[str, Any], metric: str
) -> str | None:
    explicit = condition.get("basis_ref")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    return _basis_value(basis, metric, "basis_ref")


def _basis_value(basis: Mapping[str, Any], metric: str, field: str) -> Any:
    metrics = basis.get("metrics")
    if isinstance(metrics, Mapping):
        entry = metrics.get(metric)
        if isinstance(entry, Mapping):
            value = entry.get(field)
            if value is not None:
                return value
    return None


def _required_text(condition: Mapping[str, Any], field: str) -> str:
    value = condition.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ConditionDefinitionError(f"{field} 必须是非空字符串")
    return value.strip()


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _operator_text(transform: str) -> str:
    return {"value": "", "difference": " 差值", "ratio": " 比值"}[transform]


def _format(value: float) -> str:
    return f"{value:.6g}"


def _digest(value: Any) -> str:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
