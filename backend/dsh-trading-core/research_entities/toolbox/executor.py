# -*- coding: utf-8 -*-
"""工具执行器：鉴权、实体加载、异常归一化与审计。"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Iterable, Sequence

from ..audit import make_event
from ..errors import SourceUnavailable, StorageUnavailable
from ..models import EntityInstance, EvidenceBundle, ResearchScope
from ..registry.entity_types import get_entity_type
from ..registry.tools import TOOL_REGISTRY
from .cache import TTLCache, cache_key, is_cacheable, ttl_for
from .contracts import ToolCall, ToolRequest, ToolResult
from .context import ToolContext, ToolUnavailable
from .evidence import build_bundle, evidence_from_result
from .registry import EXPLICIT_UNAVAILABLE, get_handler

# 进程级共享缓存：API/CLI 每次请求都会新建 Executor，缓存必须跨实例复用。
_DEFAULT_CACHE = TTLCache()

_TIME_RANGE_DAYS = {
    "近一天": 1,
    "近一周": 7,
    "近一个月": 30,
    "近三个月": 90,
    "近六个月": 180,
    "近一年": 365,
    "近两年": 730,
    "近三年": 1095,
    "今年以来": 300,
    "去年": 365,
}


class ToolExecutor:
    def __init__(
        self,
        context: ToolContext,
        *,
        audit: bool = True,
        persist_evidence: bool = True,
        cache: TTLCache | None = None,
        use_cache: bool = True,
        max_workers: int = 4,
    ) -> None:
        self.context = context
        self.audit = audit
        self.persist_evidence = persist_evidence
        self.cache = cache if cache is not None else _DEFAULT_CACHE
        self.use_cache = use_cache
        self.max_workers = max(1, int(max_workers))

    # ── 单次执行 ────────────────────────────────────────────────────
    def execute(self, request: ToolRequest) -> ToolResult:
        started = time.monotonic()
        definition = TOOL_REGISTRY.get(request.tool_id)
        if definition is None:
            return self._finish(
                request,
                ToolResult(
                    tool_id=request.tool_id,
                    status="error",
                    entity_ids=list(request.entity_ids),
                    error=f"未注册的逻辑工具: {request.tool_id}",
                ),
                started,
            )

        if definition.requires_authorization and not request.authorized:
            return self._finish(
                request,
                ToolResult(
                    tool_id=request.tool_id,
                    status="needs_authorization",
                    entity_ids=list(request.entity_ids),
                    data={"records": [], "count": 0},
                    warnings=[f"{definition.name}需要用户明确授权后才能执行。"],
                    error="needs_authorization",
                    authorization="unauthorized",
                ),
                started,
            )

        cacheable = (
            self.use_cache
            and not definition.requires_authorization
            and is_cacheable(request.tool_id)
        )
        key = cache_key(request)
        if cacheable:
            cached = self.cache.get(key)
            if cached is not None and cached.status in ("ok", "empty"):
                fetched = cached.fetched_at.isoformat()
                return self._finish(
                    request,
                    cached.model_copy(
                        update={
                            "cache_hit": True,
                            "warnings": [
                                *cached.warnings,
                                f"命中本地缓存，原始抓取时间 {fetched}。",
                            ],
                        }
                    ),
                    started,
                )

        handler = get_handler(request.tool_id)
        if handler is None:
            reason = definition.description or "当前没有该工具的实现。"
            return self._finish(
                request,
                ToolResult(
                    tool_id=request.tool_id,
                    status="unavailable",
                    entity_ids=list(request.entity_ids),
                    data={"records": [], "count": 0, "reason": reason},
                    warnings=[reason],
                    error=reason,
                ),
                started,
            )

        entities: list[EntityInstance] = []
        if request.entity_ids:
            try:
                entities = self.context.repository.get_many(request.entity_ids)
            except StorageUnavailable as exc:
                return self._finish(
                    request,
                    ToolResult(
                        tool_id=request.tool_id,
                        status="unavailable",
                        entity_ids=list(request.entity_ids),
                        data={"records": [], "count": 0},
                        error=f"实体库不可用: {exc}",
                    ),
                    started,
                )

        call = ToolCall(request=request, entities=entities, ctx=self.context)
        try:
            result = handler(call)
        except (ToolUnavailable, SourceUnavailable) as exc:
            result = ToolResult(
                tool_id=request.tool_id,
                status="unavailable",
                entity_ids=list(request.entity_ids),
                data={"records": [], "count": 0, "reason": str(exc)},
                error=str(exc),
                warnings=[str(exc)],
            )
        except StorageUnavailable as exc:
            result = ToolResult(
                tool_id=request.tool_id,
                status="unavailable",
                entity_ids=list(request.entity_ids),
                data={"records": [], "count": 0, "reason": f"实体库不可用: {exc}"},
                error=str(exc),
            )
        except Exception as exc:  # noqa: BLE001 - 工具边界必须归一化
            result = ToolResult(
                tool_id=request.tool_id,
                status="error",
                entity_ids=list(request.entity_ids),
                data={"records": [], "count": 0},
                error=f"{type(exc).__name__}: {exc}",
            )
        if not isinstance(result, ToolResult):
            result = ToolResult(
                tool_id=request.tool_id,
                status="error",
                entity_ids=list(request.entity_ids),
                error=f"处理器返回了非法结果: {type(result).__name__}",
            )
        if cacheable and result.status in ("ok", "empty"):
            self.cache.put(key, result, ttl_for(request.tool_id, result.status))
        return self._finish(request, result, started)

    def execute_tool(
        self,
        tool_id: str,
        *,
        entity_ids: Sequence[str] | None = None,
        params: dict | None = None,
        request_id: str | None = None,
        authorized: bool = False,
    ) -> ToolResult:
        return self.execute(
            ToolRequest(
                tool_id=tool_id,
                entity_ids=list(entity_ids or []),
                params=dict(params or {}),
                request_id=request_id,
                authorized=authorized,
            )
        )

    def execute_many(
        self,
        requests: Iterable[ToolRequest],
        *,
        max_workers: int | None = None,
    ) -> list[ToolResult]:
        """并发执行一批独立工具，返回顺序与请求顺序一致。

        单个工具内部已有超时保护；这里只做有界并发，避免某次研究把外部
        数据源同时打满。``max_workers=1`` 时退回串行执行。
        """

        items = list(requests)
        workers = min(
            self.max_workers if max_workers is None else max(1, int(max_workers)),
            len(items),
        )
        if workers <= 1:
            return [self.execute(request) for request in items]
        with ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix="tool"
        ) as pool:
            return list(pool.map(self.execute, items))

    # ── 按实体 / Scope 编排 ─────────────────────────────────────────
    def requests_for_entity(
        self,
        entity: EntityInstance,
        *,
        tool_ids: Sequence[str] | None = None,
        params: dict | None = None,
        authorized: bool = False,
        max_tools: int | None = None,
    ) -> list[ToolRequest]:
        if tool_ids is None:
            definition = get_entity_type(entity.entity_type_code)
            tool_ids = definition.default_tool_ids
        if max_tools is not None:
            tool_ids = list(tool_ids)[:max_tools]
        return [
            ToolRequest(
                tool_id=tool_id,
                entity_ids=[entity.entity_id],
                params=dict(params or {}),
                authorized=authorized,
            )
            for tool_id in tool_ids
            if tool_id in TOOL_REGISTRY
        ]

    def execute_for_entities(
        self,
        entity_ids: Sequence[str],
        *,
        tool_ids: Sequence[str] | None = None,
        params: dict | None = None,
        authorized: bool = False,
        max_tools_per_entity: int | None = None,
        request_id: str | None = None,
    ) -> list[ToolResult]:
        entities = self.context.repository.get_many(list(entity_ids))
        requests: list[ToolRequest] = []
        for entity in entities:
            for request in self.requests_for_entity(
                entity,
                tool_ids=tool_ids,
                params=params,
                authorized=authorized,
                max_tools=max_tools_per_entity,
            ):
                request.request_id = request_id
                requests.append(request)
        return self.execute_many(requests)

    def execute_for_scope(
        self,
        scope: ResearchScope,
        *,
        max_tools_per_entity: int | None = None,
    ) -> list[ToolResult]:
        """执行 Scope 中预挂载的工具。

        预挂载工具是 Scope 阶段按实体类型/意图算出的计划；这里只执行已配置
        且可执行的工具，不判断研究结论。只有 Scope 没有预挂载计划时，才退回
        按实体类型执行默认工具，避免双重执行。
        """

        params = self._params_from_scope(scope)
        authorized = self._collection_authorized("USER_PORTFOLIO") or self._collection_authorized(
            "USER_WATCHLIST"
        )
        requests: list[ToolRequest] = []
        seen: set[tuple[str, tuple[str, ...]]] = set()

        for tool in scope.preload_tools:
            if tool.status != "configured":
                # 未配置或由外部服务提供的工具不伪造执行结果。
                continue
            entity_ids = [entity_id for entity_id in tool.entity_ids if entity_id]
            key = (tool.tool_id, tuple(entity_ids))
            if key in seen:
                continue
            seen.add(key)
            requests.append(
                ToolRequest(
                    tool_id=tool.tool_id,
                    entity_ids=entity_ids,
                    params=params,
                    request_id=scope.request_id,
                    authorized=authorized,
                )
            )

        if not requests:
            # 兼容手工构造、未经过预挂载的 Scope。
            for scope_entity in scope.entity_list:
                if not scope_entity.entity_id:
                    continue
                entity = self.context.get_entity(scope_entity.entity_id)
                if entity is None:
                    continue
                for request in self.requests_for_entity(
                    entity,
                    params=params,
                    authorized=authorized,
                    max_tools=max_tools_per_entity,
                ):
                    key = (request.tool_id, tuple(request.entity_ids))
                    if key in seen:
                        continue
                    seen.add(key)
                    request.request_id = scope.request_id
                    requests.append(request)

        # 动态集合：只在已授权时执行用户事实工具。
        for collection_type, tool_id in (
            ("USER_PORTFOLIO", "portfolio_lookup"),
            ("USER_PORTFOLIO", "portfolio_risk_analysis"),
            ("USER_WATCHLIST", "watchlist_lookup"),
        ):
            if not self._collection_authorized(collection_type):
                continue
            if tool_id in scope.preload_tool_ids or any(
                collection_type == item
                for item in self._scope_collection_types(scope)
            ):
                key = (tool_id, ())
                if key in seen:
                    continue
                seen.add(key)
                requests.append(
                    ToolRequest(
                        tool_id=tool_id,
                        params=params,
                        request_id=scope.request_id,
                        authorized=True,
                    )
                )

        return self.execute_many(requests)

    # ── 内部 ────────────────────────────────────────────────────────
    def _collection_authorized(self, collection_type: str) -> bool:
        collection = self.context.collection(collection_type)
        return collection is not None and collection.authorization_status == "authorized"

    @staticmethod
    def _scope_collection_types(scope: ResearchScope) -> list[str]:
        items: list[str] = []
        for constraint in scope.constraints.other_constraints:
            if "用户持仓" in constraint:
                items.append("USER_PORTFOLIO")
            if "用户自选" in constraint:
                items.append("USER_WATCHLIST")
        return items

    @staticmethod
    def _params_from_scope(scope: ResearchScope) -> dict:
        time_range = scope.constraints.time_range
        days = _TIME_RANGE_DAYS.get(str(time_range)) if time_range else None
        return {"days": days} if days else {}

    def _finish(self, request: ToolRequest, result: ToolResult, started: float) -> ToolResult:
        duration_ms = int((time.monotonic() - started) * 1000)
        result = result.model_copy(update={"duration_ms": duration_ms})
        if self.audit and request.request_id:
            try:
                self.context.repository.append_audit(
                    make_event(
                        request_id=request.request_id,
                        stage="tool",
                        payload={
                            "tool_id": request.tool_id,
                            "status": result.status,
                            "entity_ids": request.entity_ids,
                            "source": result.source,
                            "record_count": result.record_count,
                            "duration_ms": duration_ms,
                            "error": result.error,
                        },
                    )
                )
            except StorageUnavailable:
                # 审计失败不应让研究结果丢失；错误已包含在结果里。
                result = result.model_copy(
                    update={"warnings": [*result.warnings, "工具审计写入失败：实体库不可用。"]}
                )
        if self.persist_evidence and request.request_id:
            try:
                self.context.repository.save_evidence(
                    evidence_from_result(request.request_id, result)
                )
            except (StorageUnavailable, TypeError, ValueError):
                # 证据写入是旁路记录，失败不能吞掉已经拿到的研究结果。
                result = result.model_copy(
                    update={"warnings": [*result.warnings, "证据写入失败：实体库或序列化不可用。"]}
                )
        return result

    def evidence_bundle(self, request_id: str) -> EvidenceBundle:
        """读取某次研究请求的全部证据与数据缺口。"""

        items = self.context.repository.list_evidence(request_id)
        return build_bundle(request_id, list(items))


def summarize_results(results: Iterable[ToolResult]) -> dict:
    """按状态汇总，供 CLI 和上层展示。"""

    items = list(results)
    by_status: dict[str, int] = {}
    for result in items:
        by_status[result.status] = by_status.get(result.status, 0) + 1
    return {
        "total": len(items),
        "by_status": by_status,
        "ok": sum(1 for item in items if item.status == "ok"),
        "empty": sum(1 for item in items if item.status == "empty"),
        "unavailable": sum(1 for item in items if item.status == "unavailable"),
        "error": sum(1 for item in items if item.status == "error"),
        "needs_authorization": sum(
            1 for item in items if item.status == "needs_authorization"
        ),
    }
