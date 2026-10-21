# -*- coding: utf-8 -*-
"""研究实体 HTTP API（独立服务，默认 :8300）。

只暴露研究实体层已有能力：Scope 解析、工具执行、证据回放、报告生成。
不绕过工具层直接访问外部数据源。

启动::

    ./env/Scripts/python.exe -m uvicorn research_entities.api:app \
        --host 127.0.0.1 --port 8300
"""

from __future__ import annotations

import contextlib
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from .errors import ReportError, ResearchEntityError, StorageUnavailable
from .extractor import Gazetteer
from .factory import (
    build_collection_provider,
    build_refresher,
    build_repository,
    default_gazetteer_path,
    refresh_enabled,
)
from .refresh import RefreshScheduler, refresh_interval_seconds
from .models import EvidenceBundle, ResearchScope
from .registry.entity_types import (
    DYNAMIC_COLLECTION_DEFINITIONS,
    ENTITY_TYPE_REGISTRY,
    PARENT_CATEGORIES,
)
from .registry.tools import TOOL_REGISTRY
from .reporting import ReportService, render_markdown
from .service import ResearchEntityService
from .toolbox import ToolContext, ToolExecutor, summarize_results
from .toolbox.contracts import ToolResult
from .toolbox.registry import HANDLERS


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ScopeRequest(_Request):
    query: str = Field(min_length=1)
    request_id: str | None = None
    persist: bool = True


class ToolRunRequest(_Request):
    tool_id: str = Field(min_length=1)
    entity_ids: list[str] = Field(default_factory=list)
    params: dict = Field(default_factory=dict)
    request_id: str | None = None
    authorized: bool = False


class ResearchRunRequest(_Request):
    query: str = Field(min_length=1)
    request_id: str | None = None


class ReportBuildRequest(_Request):
    request_id: str = Field(min_length=1)
    mode: Literal["deterministic", "llm"] = "deterministic"
    persist: bool = True


def _tool_payload(result: ToolResult) -> dict:
    payload = result.model_dump()
    payload.pop("data", None)
    return payload


def _bundle_payload(bundle: EvidenceBundle, *, include_data: bool) -> dict:
    payload = bundle.model_dump()
    if not include_data:
        for item in payload["items"]:
            item["data"] = {}
    return payload


def _tool_usage() -> dict[str, list[str]]:
    """工具被哪些实体类型/动态集合默认挂载。"""

    usage: dict[str, list[str]] = {tool_id: [] for tool_id in TOOL_REGISTRY}
    for type_code, definition in ENTITY_TYPE_REGISTRY.items():
        for tool_id in definition.default_tool_ids:
            usage.setdefault(tool_id, []).append(type_code)
    for collection_type, definition in DYNAMIC_COLLECTION_DEFINITIONS.items():
        for tool_id in definition.get("default_tool_ids", []):  # type: ignore[union-attr]
            usage.setdefault(str(tool_id), []).append(collection_type)
    return usage


def _tool_catalog_entry(tool_id: str, usage: dict[str, list[str]]) -> dict:
    definition = TOOL_REGISTRY[tool_id]
    return {
        "tool_id": definition.tool_id,
        "name": definition.name,
        "category": definition.category,
        "availability": definition.availability,
        "requires_authorization": definition.requires_authorization,
        "executable": definition.availability == "configured"
        and tool_id in HANDLERS,
        "description": definition.description,
        "supported_entity_types": list(definition.supported_entity_types),
        "used_by": list(usage.get(tool_id, [])),
    }


def _report_summary(report) -> dict:
    return {
        "report_id": report.report_id,
        "request_id": report.request_id,
        "mode": report.mode,
        "created_at": report.created_at.isoformat(),
        "title": report.title,
        "sections": len(report.sections),
        "warnings": len(report.warnings),
        "gaps": len(report.gaps),
    }


def create_app(
    *,
    repository=None,
    storage: str | None = None,
    tool_context: ToolContext | None = None,
    collection_provider=None,
    llm_call=None,
) -> FastAPI:
    repo = repository or build_repository(storage)
    provider = (
        collection_provider
        if collection_provider is not None
        else build_collection_provider()
    )
    service = ResearchEntityService(
        repo,
        collection_provider=provider,
        gazetteer=Gazetteer(default_gazetteer_path()),
    )
    context = tool_context or ToolContext(repo, provider)
    executor = ToolExecutor(context)
    report_service = ReportService(repo, llm_call=llm_call)
    refresher = build_refresher(service=service)
    scheduler = (
        RefreshScheduler(
            refresher, interval_seconds=refresh_interval_seconds()
        )
        if refresh_enabled(repo)
        else None
    )

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        if scheduler is not None:
            scheduler.start()
        try:
            yield
        finally:
            if scheduler is not None:
                scheduler.stop()

    app = FastAPI(title="Research Entities API", version="1.0", lifespan=lifespan)
    app.state.repository = repo
    app.state.service = service
    app.state.executor = executor
    app.state.report_service = report_service
    app.state.refresher = refresher
    app.state.refresh_scheduler = scheduler

    @app.exception_handler(StorageUnavailable)
    def _storage_unavailable(_request, exc: StorageUnavailable):  # pragma: no cover - 路由内
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(ReportError)
    def _report_error(_request, exc: ReportError):
        message = str(exc)
        status = (
            404
            if (
                "不存在" in message
                or "没有生成过报告" in message
                or "没有已落库" in message
            )
            else 400
        )
        return JSONResponse(status_code=status, content={"detail": message})

    @app.exception_handler(ResearchEntityError)
    def _domain_error(_request, exc: ResearchEntityError):  # pragma: no cover - 兜底
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    @app.get("/health")
    def health() -> dict:
        return {
            "status": "ok",
            "service": "research-entities",
            "time": datetime.now(timezone.utc).isoformat(),
            "cache": executor.cache.stats(),
            "max_workers": executor.max_workers,
        }

    @app.get("/research/health")
    def research_health() -> dict:
        return health()

    @app.get("/research/sources")
    def list_sources() -> dict:
        sources = service.source_freshness()
        return {
            "refresh_enabled": scheduler is not None,
            "refresh_interval_hours": round(refresh_interval_seconds() / 3600.0, 2),
            "stale_sources": [
                item["source_id"] for item in sources if item["needs_refresh"]
            ],
            "sources": sources,
        }

    @app.post("/research/sources/refresh")
    def refresh_sources(force: bool = Query(default=False)) -> dict:
        return refresher.refresh(force=force)

    @app.get("/research/tools")
    def list_tools() -> dict:
        usage = _tool_usage()
        tools = [
            _tool_catalog_entry(tool_id, usage)
            for tool_id in sorted(TOOL_REGISTRY)
        ]
        by_availability: dict[str, int] = {}
        for tool in tools:
            key = tool["availability"]
            by_availability[key] = by_availability.get(key, 0) + 1
        return {
            "total": len(tools),
            "by_availability": by_availability,
            "tools": tools,
        }

    @app.get("/research/tools/{tool_id}")
    def get_tool(tool_id: str) -> dict:
        if tool_id not in TOOL_REGISTRY:
            raise HTTPException(status_code=404, detail=f"未注册的工具: {tool_id}")
        return _tool_catalog_entry(tool_id, _tool_usage())

    @app.get("/research/entities/types")
    def list_entity_types() -> dict:
        types = []
        for type_code in sorted(ENTITY_TYPE_REGISTRY):
            definition = ENTITY_TYPE_REGISTRY[type_code]
            types.append(
                {
                    "type_code": definition.type_code,
                    "parent_code": definition.parent_code,
                    "parent_name": PARENT_CATEGORIES.get(
                        definition.parent_code, ""
                    ),
                    "type_name": definition.type_name,
                    "description": definition.description,
                    "priority": definition.priority,
                    "status": definition.status,
                    "normalization_keys": list(definition.normalization_keys),
                    "default_tool_ids": list(definition.default_tool_ids),
                }
            )
        collections = [
            {
                "collection_type": item["collection_type"],
                "name": item["name"],
                "description": item["description"],
                "default_tool_ids": list(item["default_tool_ids"]),  # type: ignore[arg-type]
                "requires_authorization": item["requires_authorization"],
            }
            for item in DYNAMIC_COLLECTION_DEFINITIONS.values()
        ]
        return {
            "total": len(types),
            "parent_categories": dict(PARENT_CATEGORIES),
            "types": types,
            "dynamic_collections": collections,
        }

    @app.get("/research/entities")
    def list_entities(
        type_code: str = Query(min_length=1),
        limit: int = Query(default=50, ge=1, le=500),
        cursor: str | None = None,
    ) -> dict:
        if type_code not in ENTITY_TYPE_REGISTRY:
            raise HTTPException(
                status_code=400, detail=f"未注册的实体类型: {type_code}"
            )
        items, next_cursor = repo.list_by_type(
            type_code, limit=limit, cursor=cursor
        )
        return {
            "type_code": type_code,
            "total": len(items),
            "next_cursor": next_cursor,
            "items": [
                {
                    "entity_id": item.entity_id,
                    "entity_type_code": item.entity_type_code,
                    "canonical_name": item.canonical_name,
                    "aliases": list(item.aliases),
                    "identifiers": dict(item.identifiers),
                    "status": item.status,
                    "source": item.source,
                    "last_verified_at": item.last_verified_at.isoformat()
                    if item.last_verified_at
                    else None,
                }
                for item in items
            ],
        }

    @app.get("/research/entities/search")
    def search_entities(
        q: str = Query(min_length=1),
        type_code: str | None = None,
        limit: int = Query(default=20, ge=1, le=100),
    ) -> dict:
        if type_code is not None and type_code not in ENTITY_TYPE_REGISTRY:
            raise HTTPException(
                status_code=400, detail=f"未注册的实体类型: {type_code}"
            )
        candidates = repo.find_by_name(
            q,
            type_codes=[type_code] if type_code else None,
            limit=limit,
        )
        return {
            "query": q,
            "total": len(candidates),
            "items": [
                {
                    "entity_id": item.entity_id,
                    "entity_type_code": item.entity_type_code,
                    "canonical_name": item.canonical_name,
                    "match_reason": list(item.match_reason),
                    "confidence": item.confidence,
                    "source": item.source,
                }
                for item in candidates
            ],
        }

    @app.post("/research/scope")
    def resolve_scope(body: ScopeRequest) -> dict:
        scope: ResearchScope = service.resolve_scope(
            body.query, request_id=body.request_id, persist=body.persist
        )
        return scope.model_dump()

    @app.post("/research/tools/run")
    def run_tool(body: ToolRunRequest) -> dict:
        result = executor.execute_tool(
            body.tool_id,
            entity_ids=body.entity_ids,
            params=body.params,
            request_id=body.request_id,
            authorized=body.authorized,
        )
        return result.model_dump()

    @app.post("/research/run")
    def run_research(body: ResearchRunRequest) -> dict:
        scope = service.resolve_scope(body.query, request_id=body.request_id)
        results = executor.execute_for_scope(scope) if scope.status == "scope_ready" else []
        bundle = executor.evidence_bundle(scope.request_id)
        return {
            "request_id": scope.request_id,
            "scope": scope.model_dump(),
            "summary": summarize_results(results),
            "results": [_tool_payload(item) for item in results],
            "evidence": {
                "items": len(bundle.items),
                "summary": bundle.summary,
                "gaps": bundle.gaps,
            },
        }

    @app.get("/research/evidence/{request_id}")
    def get_evidence(
        request_id: str,
        include_data: bool = Query(False, description="是否返回证据原始数据"),
    ) -> dict:
        bundle = executor.evidence_bundle(request_id)
        return _bundle_payload(bundle, include_data=include_data)

    @app.post("/research/reports")
    def build_report(body: ReportBuildRequest) -> dict:
        report = report_service.build(
            body.request_id, mode=body.mode, persist=body.persist
        )
        return report.model_dump()

    @app.get("/research/reports/by-id/{report_id}")
    def get_report_by_id(report_id: str) -> dict:
        return report_service.get(report_id).model_dump()

    @app.get("/research/reports/{request_id}")
    def list_reports(request_id: str) -> dict:
        return {
            "request_id": request_id,
            "reports": [
                _report_summary(item) for item in report_service.list(request_id)
            ],
        }

    @app.get("/research/reports/{request_id}/latest")
    def latest_report(
        request_id: str,
        format: Literal["json", "markdown"] = Query("json"),
    ):
        report = report_service.latest(request_id)
        if format == "markdown":
            return PlainTextResponse(
                render_markdown(report), media_type="text/markdown; charset=utf-8"
            )
        return report.model_dump()

    return app


app = create_app()


def main() -> int:  # pragma: no cover - 启动入口
    import os

    import uvicorn

    port = int(os.getenv("RESEARCH_ENTITIES_API_PORT", "8300"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
