# -*- coding: utf-8 -*-
"""策略自进化能力作为委托执行器。

旧策略不会自动变成委托；只有用户显式创建、且触发器写明了
``strategy.condition_changed`` 或 ``strategy.evolution_completed`` 的委托，
才会在收到事件后进入这里。执行器只读取自进化状态、归因与待确认预案，
**不应用任何写动作**：升级/降级/淘汰/变异仍由用户在 trading-core 侧确认，
或由已授权的闭环调度完成。
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Protocol, runtime_checkable

from .models import EventEnvelope, ResearchJob, ResearchJobResult
from .ports import BusinessStore
from .worker import ResearchRunner

STRATEGY_HOOKS = frozenset(
    {"strategy.condition_changed", "strategy.evolution_completed"}
)

_ACTION_LABELS = {
    "promote": "升级",
    "demote": "降级",
    "retire": "淘汰",
    "mutate": "变异",
}


@runtime_checkable
class StrategyEvolutionPort(Protocol):
    """自进化只读能力；实现方负责把不可用如实转成异常。"""

    def status(
        self, *, strategy_id: str | None = None, include_history: bool = False
    ) -> dict[str, Any]: ...

    def attribution(self, *, strategy_id: str | None = None) -> dict[str, Any]: ...

    def preview(self, *, strategy_id: str | None = None) -> dict[str, Any]: ...


def _strategy_id_from(envelope: EventEnvelope | None) -> str | None:
    if envelope is None:
        return None
    payload_id = envelope.payload.get("strategy_id")
    if isinstance(payload_id, str) and payload_id:
        return payload_id
    for subject in envelope.subject_ids:
        # 策略池主体是 ``strategy_pool:default``，不会被 ``strategy:`` 前缀命中。
        if subject.startswith("strategy:"):
            candidate = subject.split(":", 1)[1]
            if candidate:
                return candidate
    return None


def _summarize_status(payload: Mapping[str, Any], strategy_id: str | None) -> dict[str, Any]:
    """只保留判定所需字段；原始 per_strategy 列表已由 status 自身裁剪。"""

    summary = {
        "ready": bool(payload.get("ready")),
        "days_of_data": payload.get("days_of_data"),
        "min_days": payload.get("min_days"),
        "counts": payload.get("counts") or {},
        "note": payload.get("note"),
        "recent_run_at": payload.get("recent_run_at"),
    }
    if strategy_id is not None:
        entries = [
            item
            for item in payload.get("per_strategy") or []
            if isinstance(item, Mapping) and item.get("strategy_id") == strategy_id
        ]
        summary["strategy"] = [dict(item) for item in entries][:3]
    else:
        summary["strategy"] = [
            dict(item) for item in (payload.get("per_strategy") or [])[:10]
            if isinstance(item, Mapping)
        ]
    return summary


def _summarize_attribution(payload: Mapping[str, Any], strategy_id: str | None) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "days_of_data": payload.get("days_of_data"),
        "min_days": payload.get("min_days"),
        "data_note": payload.get("data_note"),
        "overall": payload.get("overall"),
    }
    if strategy_id is not None:
        entries = [
            item
            for item in payload.get("strategies") or []
            if isinstance(item, Mapping) and item.get("strategy_id") == strategy_id
        ]
        summary["strategy"] = [dict(item) for item in entries][:3]
    else:
        summary["strategy"] = [
            dict(item) for item in (payload.get("strategies") or [])[:10]
            if isinstance(item, Mapping)
        ]
    return summary


def _summarize_preview(payload: Mapping[str, Any]) -> dict[str, Any]:
    actions = [item for item in payload.get("actions") or [] if isinstance(item, Mapping)]
    return {
        "preview_status": payload.get("preview_status") or "none",
        "valid": payload.get("valid"),
        "count": len(actions),
        "actions": [
            {
                "type": item.get("type"),
                "sid": item.get("sid"),
                "reason": item.get("reason"),
            }
            for item in actions
        ][:20],
    }


def _metric(value: Any, *, unit: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"value": value}
    if unit is not None:
        payload["unit"] = unit
    return payload


class StrategyEvolutionRunner:
    """``ResearchRunner``：策略事件 → 一次只读复核。

    非策略事件交给 ``fallback``（默认没有），保持原有研究链路不变。
    """

    def __init__(
        self,
        store: BusinessStore,
        port: StrategyEvolutionPort,
        *,
        fallback: ResearchRunner | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.port = port
        self.fallback = fallback
        self._now = now or (lambda: datetime.now(timezone.utc))

    def run(self, job: ResearchJob) -> ResearchJobResult:
        envelope = self._trigger_event(job)
        if envelope is None or envelope.hook_type not in STRATEGY_HOOKS:
            if self.fallback is not None:
                return self.fallback.run(job)
            return self._result(
                job,
                outcome="unavailable",
                structured={"capability": "strategy_evolution", "reason": "no_runner"},
                summary="没有可用于该事件的研究执行器",
                contact=False,
            )
        return self._review(job, envelope)

    def _trigger_event(self, job: ResearchJob) -> EventEnvelope | None:
        if not job.trigger_event_id:
            return None
        return self.store.get_event(job.trigger_event_id)

    def _review(self, job: ResearchJob, envelope: EventEnvelope) -> ResearchJobResult:
        strategy_id = _strategy_id_from(envelope)
        status_payload = self.port.status(
            strategy_id=strategy_id, include_history=False
        )
        attribution_payload = self.port.attribution(strategy_id=strategy_id)
        preview_payload = self.port.preview(strategy_id=strategy_id)

        status = _summarize_status(status_payload, strategy_id)
        attribution = _summarize_attribution(attribution_payload, strategy_id)
        preview = _summarize_preview(preview_payload)

        payload = envelope.payload
        stage_change = None
        if envelope.hook_type == "strategy.condition_changed":
            stage_change = {
                "type": payload.get("event_type"),
                "strategy_id": strategy_id,
                "from": payload.get("from_stage"),
                "to": payload.get("to_stage"),
                "reason": payload.get("reason") or "",
            }

        run_id = payload.get("run_id") or envelope.event_id
        gaps: list[dict[str, Any]] = []
        if not status.get("ready"):
            gaps.append(
                {
                    "code": "shadow_data_insufficient",
                    "detail": status.get("note")
                    or f"影子数据 {status.get('days_of_data')} 日，未达到 {status.get('min_days')} 日",
                }
            )

        metrics = {
            "shadow_days": _metric(status.get("days_of_data"), unit="day"),
            "evolution_min_days": _metric(status.get("min_days"), unit="day"),
            "evolution_action_count": _metric(
                int(payload.get("action_count") or 0), unit="count"
            ),
            "stage_changed": _metric(1 if stage_change else 0, unit="bool"),
            "preview_action_count": _metric(preview["count"], unit="count"),
        }
        overall = attribution.get("overall")
        return_pct = overall.get("return_pct") if isinstance(overall, Mapping) else None
        if isinstance(return_pct, (int, float)):
            metrics["shadow_return_pct"] = _metric(return_pct, unit="pct")

        summary = self._change_summary(
            envelope,
            strategy_id=strategy_id,
            stage_change=stage_change,
            status=status,
            attribution=attribution,
            preview=preview,
        )
        structured = {
            "capability": "strategy_evolution",
            "hook_type": envelope.hook_type,
            "run_id": run_id,
            "strategy_id": strategy_id,
            "stage_change": stage_change,
            "status": status,
            "attribution": attribution,
            "preview": preview,
            "action_count": int(payload.get("action_count") or 0),
            "metrics": metrics,
            "limitations": [
                "只读复核：升级/降级/淘汰/变异必须由用户确认预案或由已授权的闭环调度执行",
                "结论不改变用户风险参数与委托条件",
            ],
        }
        should_contact = self._should_contact(
            envelope, stage_change=stage_change, attribution=attribution, preview=preview
        )
        return self._result(
            job,
            outcome="completed",
            structured=structured,
            summary=summary,
            contact=should_contact,
            gaps=gaps,
        )

    def _change_summary(
        self,
        envelope: EventEnvelope,
        *,
        strategy_id: str | None,
        stage_change: Mapping[str, Any] | None,
        status: Mapping[str, Any],
        attribution: Mapping[str, Any],
        preview: Mapping[str, Any],
    ) -> str:
        days = status.get("days_of_data")
        min_days = status.get("min_days")
        data_note = status.get("note") or attribution.get("data_note")
        overall = attribution.get("overall")
        return_text = ""
        if isinstance(overall, Mapping) and overall.get("return_pct") is not None:
            return_text = (
                f"影子组合累计收益 {overall['return_pct']}%，"
                f"最大回撤 {overall.get('max_drawdown_pct')}%；"
            )
        if stage_change is not None:
            label = _ACTION_LABELS.get(str(stage_change.get("type")), str(stage_change.get("type")))
            head = (
                f"策略 {strategy_id or '（未知）'} {label}："
                f"{stage_change.get('from')} → {stage_change.get('to')}"
            )
            if stage_change.get("reason"):
                head += f"（{stage_change['reason']}）"
        else:
            count = int(envelope.payload.get("action_count") or 0)
            head = f"自进化闭环完成：{count} 项升级/降级/淘汰/变异动作"
        tail = (
            f"影子数据 {days}/{min_days} 日；{return_text}"
            f"待确认预案 {preview.get('preview_status')}（{preview.get('count')} 项）"
        )
        summary = f"{head}。{tail}"
        if data_note:
            summary += f"。{data_note}"
        return summary[:4000]

    @staticmethod
    def _should_contact(
        envelope: EventEnvelope,
        *,
        stage_change: Mapping[str, Any] | None,
        attribution: Mapping[str, Any],
        preview: Mapping[str, Any],
    ) -> bool:
        """只有真正的阶段变化或已就绪且有待确认预案时才建议联系。

        “本轮完成但没有动作、数据仍不足”只留档，不打扰用户。
        """

        if stage_change is not None:
            return True
        if preview.get("valid") and preview.get("count"):
            return True
        overall = attribution.get("overall")
        return isinstance(overall, Mapping) and overall.get("return_pct") is not None

    def _result(
        self,
        job: ResearchJob,
        *,
        outcome: str,
        structured: dict[str, Any],
        summary: str,
        contact: bool,
        gaps: list[dict[str, Any]] | None = None,
    ) -> ResearchJobResult:
        now = self._now()
        digest = hashlib.sha256(
            f"{job.job_id}|{outcome}|{job.action}".encode("utf-8")
        ).hexdigest()[:32]
        return ResearchJobResult(
            result_id=f"RES_{digest}",
            job_id=job.job_id,
            run_id=f"evolution-{job.job_id}",
            outcome=outcome,
            structured_result=structured,
            evidence_batch_id=None,
            gaps=list(gaps or []),
            change_summary=summary,
            contact_suggestion={
                "should_contact": contact,
                "reason": summary,
            },
            received_at=now,
        )
