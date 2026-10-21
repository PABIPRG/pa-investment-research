# -*- coding: utf-8 -*-
"""研究委托核心 HTTP API（Slice 2）。

启动（本机回环，默认 :8301，待与 :8300 研究实体服务合并部署）::

    ./env/Scripts/python.exe -m uvicorn --factory research_partner.api:create_app \
        --host 127.0.0.1 --port 8301

身份边界：当前仅由 ``X-Principal-Id`` / ``X-Instance-Id`` 头构造请求上下文，
只允许在回环或受信反向代理后使用；接入 Electron 时必须替换为服端认证。
"""

from __future__ import annotations

import argparse
import contextlib
import os
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, FastAPI, Header, Query
from fastapi.responses import JSONResponse

from .commands import (
    MandateCreateRequest,
    MandateReviseRequest,
    MandateStatusRequest,
    NotificationPreferencesRequest,
    RequirementResolutionRequest,
    SnoozeCreateRequest,
)
from .context import RequestContext
from .errors import (
    Conflict,
    InvalidRequest,
    NotFound,
    ResearchPartnerError,
    StorageUnavailable,
    Unauthorized,
)
from .dispatcher import NotificationCenterDispatcher
from .factory import build_service
from .hooks import hook_catalog
from .models import EventEnvelope
from .notifications import NotificationSettingsService
from .pipeline import PartnerPipeline
from .service import MandateService
from .transfer import (
    TransferError,
    commit_import,
    export_snapshot,
    preview_import,
)

_DEFAULT_PRINCIPAL = os.getenv("RESEARCH_PARTNER_PRINCIPAL", "local-user")
_DEFAULT_INSTANCE = os.getenv("RESEARCH_PARTNER_INSTANCE", "local-instance")


def _context(principal_id: str | None, instance_id: str | None) -> RequestContext:
    return RequestContext(
        instance_id=(instance_id or _DEFAULT_INSTANCE).strip(),
        principal_id=(principal_id or _DEFAULT_PRINCIPAL).strip(),
        capabilities=frozenset(
            {"mandate:read", "mandate:write", "notification:read", "notification:write"}
        ),
    )


def create_router(
    service: MandateService,
    pipeline: PartnerPipeline,
    notifications: NotificationSettingsService,
) -> APIRouter:
    router = APIRouter(prefix="/research", tags=["research-partner"])

    @router.get("/partners/health")
    def health() -> dict:
        return {
            "status": "ok",
            "service": "research-partner",
            "schema_version": service.store.schema_version(),
            "time": datetime.now(timezone.utc).isoformat(),
        }

    @router.post("/events", status_code=202)
    def ingest_event(envelope: EventEnvelope) -> dict:
        """外部事件接入；重复 event_id 幂等接收。"""
        accepted = service.store.record_event(envelope)
        return {"accepted": True, "duplicate": not accepted}

    @router.post("/partners/tick")
    def tick(
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        """本机联调用的同步闭环；生产由独立 worker 定时调用同一编排。"""
        _context(x_principal_id, x_instance_id).require("mandate:write")
        return pipeline.tick()

    @router.post("/runtime/recovered")
    def runtime_recovered(
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        """启动、休眠或断网恢复后的有界补偿；重复调用安全。"""
        _context(x_principal_id, x_instance_id).require("mandate:write")
        return pipeline.recover()

    @router.get("/hooks")
    def hooks(active_only: bool = False) -> dict:
        """Hook 目录：产生方、核心处理与触发边界。"""
        return {"hooks": hook_catalog(active_only=active_only)}

    @router.get("/jobs/{job_id}")
    def get_job(
        job_id: str,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        _context(x_principal_id, x_instance_id).require("mandate:read")
        job = service.store.get_job(job_id)
        if job is None:
            raise NotFound("任务不存在")
        return {
            "job": job.model_dump(mode="json"),
            "results": [
                item.model_dump(mode="json")
                for item in service.store.list_job_results(job_id)
            ],
        }

    @router.post("/mandates", status_code=201)
    def create_mandate(
        request: MandateCreateRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.create(_context(x_principal_id, x_instance_id), request)

    @router.get("/mandates")
    def list_mandates(
        status: Literal["pending_requirements", "tracking", "paused", "ended"] | None = None,
        limit: int = Query(default=50, ge=1, le=200),
        cursor: str | None = None,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.list(
            _context(x_principal_id, x_instance_id),
            status=status,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/mandates/{mandate_id}")
    def get_mandate(
        mandate_id: str,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.get(_context(x_principal_id, x_instance_id), mandate_id)

    @router.post("/mandates/{mandate_id}/revisions")
    def revise_mandate(
        mandate_id: str,
        request: MandateReviseRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.revise(_context(x_principal_id, x_instance_id), mandate_id, request)

    @router.post("/mandates/{mandate_id}/pause")
    def pause_mandate(
        mandate_id: str,
        request: MandateStatusRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.pause(_context(x_principal_id, x_instance_id), mandate_id, request)

    @router.post("/mandates/{mandate_id}/resume")
    def resume_mandate(
        mandate_id: str,
        request: MandateStatusRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.resume(_context(x_principal_id, x_instance_id), mandate_id, request)

    @router.post("/mandates/{mandate_id}/end")
    def end_mandate(
        mandate_id: str,
        request: MandateStatusRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.end(_context(x_principal_id, x_instance_id), mandate_id, request)

    @router.post(
        "/mandates/{mandate_id}/requirements/{requirement_id}/resolve"
    )
    def resolve_requirement(
        mandate_id: str,
        requirement_id: str,
        request: RequirementResolutionRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return service.resolve_requirement(
            _context(x_principal_id, x_instance_id),
            mandate_id,
            requirement_id,
            request,
        )

    @router.get("/mandates/{mandate_id}/decisions")
    def list_decisions(
        mandate_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        context = _context(x_principal_id, x_instance_id)
        context.require("mandate:read")
        # 先验证归属，避免跨主体枚举决定。
        service.get(context, mandate_id)
        decisions = service.store.list_contact_decisions(mandate_id, limit=limit)
        return {
            "items": [item.model_dump(mode="json") for item in decisions],
            "next_cursor": None,
        }

    @router.get("/mandates/{mandate_id}/schedules")
    def list_schedules(
        mandate_id: str,
        active_only: bool = Query(default=True),
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        context = _context(x_principal_id, x_instance_id)
        context.require("mandate:read")
        # 先验证归属，避免跨主体读取日程。
        service.get(context, mandate_id)
        schedules = service.store.list_schedules(
            mandate_id, active_only=active_only
        )
        return {"items": [item.model_dump(mode="json") for item in schedules]}

    @router.get("/data/package")
    def export_data_package(
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        """导出当前实例的委托领域数据包；不含任务、投递与凭据。"""
        context = _context(x_principal_id, x_instance_id)
        context.require("mandate:read")
        return export_snapshot(
            service.store,
            principal_id=context.principal_id,
            instance_id=context.instance_id,
        )

    @router.post("/data/import/preview")
    def preview_data_import(
        payload: dict,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        context = _context(x_principal_id, x_instance_id)
        context.require("mandate:write")
        return preview_import(
            service.store,
            payload.get("package"),
            principal_id=context.principal_id,
        )

    @router.post("/data/import")
    def import_data_package(
        payload: dict,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        context = _context(x_principal_id, x_instance_id)
        context.require("mandate:write")
        resolutions = payload.get("resolutions")
        return commit_import(
            service.store,
            payload.get("package"),
            principal_id=context.principal_id,
            instance_id=context.instance_id,
            batch_id=payload.get("batch_id"),
            resolutions=resolutions if isinstance(resolutions, dict) else {},
        )

    @router.get("/notification/preferences")
    def get_notification_preferences(
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return notifications.get_preferences(
            _context(x_principal_id, x_instance_id)
        )

    @router.put("/notification/preferences")
    def save_notification_preferences(
        request: NotificationPreferencesRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return notifications.save_preferences(
            _context(x_principal_id, x_instance_id), request
        )

    @router.get("/notification/snoozes")
    def list_notification_snoozes(
        active_only: bool = Query(default=True),
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return notifications.list_snoozes(
            _context(x_principal_id, x_instance_id), active_only=active_only
        )

    @router.post("/notification/snoozes", status_code=201)
    def create_notification_snooze(
        request: SnoozeCreateRequest,
        x_principal_id: str | None = Header(default=None),
        x_instance_id: str | None = Header(default=None),
    ) -> dict:
        return notifications.create_snooze(
            _context(x_principal_id, x_instance_id), request
        )

    return router


def _default_dispatcher() -> NotificationCenterDispatcher | None:
    """配置了通知中心地址与内部令牌才启用真实投递。"""

    endpoint = os.getenv("RESEARCH_NOTIFICATION_URL", "").strip()
    token = os.getenv("NOTIFICATION_INTERNAL_TOKEN", "").strip()
    if not endpoint or not token:
        return None
    return NotificationCenterDispatcher(
        endpoint,
        token,
        timeout=float(os.getenv("RESEARCH_NOTIFICATION_TIMEOUT", "3")),
    )


def _default_calendar():
    """``RESEARCH_TRADING_CALENDAR=akshare`` 时使用真实交易日历。"""

    if os.getenv("RESEARCH_TRADING_CALENDAR", "").strip().lower() != "akshare":
        return None
    from .calendar import AkshareTradingCalendar

    return AkshareTradingCalendar()


def create_app(
    *, store_path=None, now=None, runner=None, dispatcher=None, calendar=None
) -> FastAPI:
    if calendar is None:
        calendar = _default_calendar()
    store, service = build_service(store_path, now=now, calendar=calendar)
    if runner is None:
        # 策略自进化能力默认接入；装配失败时 build_runner 返回原 stub。
        from .factory import build_runner

        runner = build_runner(store, now=now)
    if dispatcher is None:
        dispatcher = _default_dispatcher()
    notifications = NotificationSettingsService(store, now=now)
    pipeline = PartnerPipeline(
        store, runner=runner, dispatcher=dispatcher, calendar=calendar, now=now
    )

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
            store.close()

    app = FastAPI(
        title="Research Partner API",
        version="0.2.0-slice2",
        description="持续委托、版本、任务与联系决定核心。",
        lifespan=lifespan,
    )
    app.state.partner_store = store
    app.state.partner_service = service
    app.state.partner_notifications = notifications
    app.state.partner_pipeline = pipeline

    @app.exception_handler(Conflict)
    def _conflict(_request, exc: Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(NotFound)
    def _not_found(_request, exc: NotFound):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(InvalidRequest)
    def _invalid(_request, exc: InvalidRequest):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(TransferError)
    def _transfer_invalid(_request, exc: TransferError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(Unauthorized)
    def _unauthorized(_request, exc: Unauthorized):
        return JSONResponse(status_code=401, content={"detail": str(exc)})

    @app.exception_handler(StorageUnavailable)
    def _unavailable(_request, exc: StorageUnavailable):
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(ResearchPartnerError)
    def _domain(_request, exc: ResearchPartnerError):  # pragma: no cover - 兜底
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    app.include_router(create_router(service, pipeline, notifications))
    return app


def main() -> None:  # pragma: no cover - 启动入口
    import uvicorn

    from .runtime import InstanceLock

    parser = argparse.ArgumentParser(description="研究委托核心 API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8301)
    parser.add_argument("--lock", default=os.getenv("RESEARCH_PARTNER_LOCK") or None)
    args = parser.parse_args()
    # 前台/容器/计划任务只负责拉起进程；权威性由单实例锁保证。
    with InstanceLock(args.lock):
        uvicorn.run(
            create_app(), host=args.host, port=args.port, log_level="info"
        )


if __name__ == "__main__":  # pragma: no cover
    main()
