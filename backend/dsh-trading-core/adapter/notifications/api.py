# -*- coding: utf-8 -*-
"""统一通知中心 HTTP 路由。"""

from __future__ import annotations

import hmac
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .models import NotificationEvent, NotificationValidationError
from .channel_settings import RuntimeNotificationChannels, validate_snapshot
from .repository import NotificationConflictError, NotificationNotFoundError
from .service import CATEGORIES, CHANNELS, SEVERITIES, NotificationService


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail="通知或投递任务不存在")


def _validate_browser_subscription(subscription: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(subscription, dict):
        raise HTTPException(status_code=422, detail="subscription 必须是对象")
    endpoint = str(subscription.get("endpoint") or "").strip()
    parsed = urlparse(endpoint)
    keys = subscription.get("keys")
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(status_code=422, detail="浏览器推送 endpoint 必须使用 HTTPS")
    if not isinstance(keys, dict) or not str(keys.get("p256dh") or "").strip() or not str(keys.get("auth") or "").strip():
        raise HTTPException(status_code=422, detail="浏览器推送订阅缺少 p256dh 或 auth")
    return endpoint, subscription


def register_notification_routes(
    app: FastAPI,
    service: NotificationService,
    *,
    internal_token: str,
    vapid_public_key: str = "",
    runtime_channels: RuntimeNotificationChannels | None = None,
    delivery_enabled: bool = True,
) -> None:
    """注册站内信、偏好、订阅及内部事件入口。"""

    def require_internal_token(candidate: str | None) -> None:
        if not internal_token:
            raise HTTPException(status_code=503, detail="内部通知入口未启用")
        if not candidate or not hmac.compare_digest(candidate, internal_token):
            raise HTTPException(status_code=401, detail="内部通知令牌无效")

    @app.post("/internal/notification-channels/{operation}", response_model=dict)
    def notification_channels(
        operation: str, payload: dict[str, Any],
        x_notification_token: str | None = Header(default=None),
    ):
        require_internal_token(x_notification_token)
        if runtime_channels is None:
            raise HTTPException(status_code=409, detail="此后台不接受应用托管配置")
        try:
            if operation == "validate":
                validate_snapshot(payload)
            elif operation == "apply":
                runtime_channels.apply(payload)
            elif operation == "test":
                if not delivery_enabled:
                    raise ValueError("后台投递服务已停用")
                return runtime_channels.test(payload.get("channel"), payload.get("requestId"), payload.get("revision"))
            else:
                raise HTTPException(status_code=404, detail="不支持的渠道操作")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        return {"applied": runtime_channels.ready, "deliveryEnabled": delivery_enabled}

    @app.middleware("http")
    async def protect_notification_inbox(request: Request, call_next):
        """通知正文只允许经 Host 代理访问，避免任意网页读取 localhost 数据。"""
        if request.url.path.startswith("/notifications"):
            candidate = request.headers.get("X-Notification-Token")
            if not internal_token:
                return JSONResponse(status_code=503, content={"detail": "通知中心未启用"})
            if not candidate or not hmac.compare_digest(candidate, internal_token):
                return JSONResponse(status_code=401, content={"detail": "通知中心需要 Host 授权"})
        return await call_next(request)

    @app.post("/internal/notification-events", response_model=dict)
    async def publish_notification_event(
        payload: dict[str, Any],
        x_notification_token: str | None = Header(default=None),
    ):
        require_internal_token(x_notification_token)
        try:
            return service.publish(NotificationEvent.from_mapping(payload))
        except NotificationValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/internal/notification-deliveries/claim", response_model=dict)
    async def claim_native_notification_deliveries(
        payload: dict[str, Any],
        x_notification_token: str | None = Header(default=None),
    ):
        require_internal_token(x_notification_token)
        if payload.get("channel") != "macos":
            raise HTTPException(status_code=422, detail="原生领取入口仅支持 macOS 系统通知")
        limit = payload.get("limit", 10)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 20:
            raise HTTPException(status_code=422, detail="limit 必须是 1 到 20 的整数")
        jobs = service.repository.claim_delivery_jobs(
            channels={"macos"}, now=service.now(), lease_seconds=60, limit=limit,
        )
        return {"items": jobs}

    @app.post("/internal/notification-deliveries/{job_id}/ack", response_model=dict)
    async def acknowledge_native_notification_delivery(
        job_id: str,
        payload: dict[str, Any],
        x_notification_token: str | None = Header(default=None),
    ):
        require_internal_token(x_notification_token)
        lease_token = str(payload.get("leaseToken") or "")
        if not lease_token:
            raise HTTPException(status_code=422, detail="leaseToken 不能为空")
        try:
            return service.repository.complete_delivery_job(job_id, lease_token, service.now())
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc
        except NotificationConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/notification-deliveries/{job_id}/nack", response_model=dict)
    async def reject_native_notification_delivery(
        job_id: str,
        payload: dict[str, Any],
        x_notification_token: str | None = Header(default=None),
    ):
        require_internal_token(x_notification_token)
        lease_token = str(payload.get("leaseToken") or "")
        if not lease_token:
            raise HTTPException(status_code=422, detail="leaseToken 不能为空")
        try:
            return service.repository.fail_delivery_job(
                job_id, lease_token, now=service.now(),
                error_code="native_notification_failed",
                error_message="macOS 系统通知显示失败",
                retryable=True, outcome_uncertain=False, max_attempts=5,
            )
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc
        except NotificationConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/notifications", response_model=dict)
    async def list_notifications(
        view: str = Query(default="all"),
        archived: bool = Query(default=False),
        category: str | None = Query(default=None),
        severity: str | None = Query(default=None),
        delivery: str | None = Query(default=None),
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None),
    ):
        if category is not None and category not in CATEGORIES:
            raise HTTPException(status_code=422, detail="不支持的通知分类")
        if severity is not None and severity not in SEVERITIES:
            raise HTTPException(status_code=422, detail="不支持的通知级别")
        try:
            return service.list_notifications(
                view=view,
                archived=archived,
                category=category,
                severity=severity,
                delivery=delivery,
                limit=limit,
                cursor=cursor,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/notifications/preferences", response_model=dict)
    async def notification_preferences():
        return service.preferences()

    @app.put("/notifications/preferences", response_model=dict)
    async def update_notification_preference(payload: dict[str, Any]):
        try:
            service.set_preference(
                str(payload.get("category") or ""),
                str(payload.get("channel") or ""),
                payload.get("enabled") if isinstance(payload.get("enabled"), bool) else _raise_enabled(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return service.preferences()

    @app.get("/notifications/capabilities", response_model=dict)
    async def notification_capabilities():
        return {
            "browserPush": {"available": bool(vapid_public_key), "vapidPublicKey": vapid_public_key},
            "channels": sorted(CHANNELS),
        }

    @app.post("/notifications/read-all", response_model=dict)
    async def mark_all_notifications_read():
        ids = service.mark_all_read()
        return {"notificationIds": ids, "count": len(ids)}

    @app.post("/notifications/bulk-read", response_model=dict)
    async def bulk_read_notifications(payload: dict[str, Any]):
        ids = payload.get("notificationIds")
        read = payload.get("read")
        if not isinstance(ids, list) or not all(isinstance(value, str) and value for value in ids):
            raise HTTPException(status_code=422, detail="notificationIds 必须是非空字符串数组")
        if not isinstance(read, bool):
            raise HTTPException(status_code=422, detail="read 必须是布尔值")
        selected = service.bulk_set_read(ids, read)
        return {"notificationIds": selected, "count": len(selected)}

    @app.get("/notifications/{notification_id}", response_model=dict)
    async def get_notification(notification_id: str):
        try:
            return service.get(notification_id)
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc

    @app.patch("/notifications/{notification_id}/read", response_model=dict)
    async def set_notification_read(notification_id: str, payload: dict[str, Any]):
        if not isinstance(payload.get("read"), bool):
            raise HTTPException(status_code=422, detail="read 必须是布尔值")
        try:
            return service.set_read(notification_id, payload["read"])
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc

    @app.patch("/notifications/{notification_id}/archive", response_model=dict)
    async def set_notification_archived(notification_id: str, payload: dict[str, Any]):
        if not isinstance(payload.get("archived"), bool):
            raise HTTPException(status_code=422, detail="archived 必须是布尔值")
        try:
            return service.set_archived(notification_id, payload["archived"])
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc

    @app.post("/notifications/{notification_id}/deliveries/{channel}/retry", response_model=dict)
    async def retry_notification_delivery(notification_id: str, channel: str):
        try:
            return service.retry_delivery(notification_id, channel)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc
        except NotificationConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/notifications/subscriptions", response_model=dict)
    async def save_notification_subscription(payload: dict[str, Any]):
        channel = str(payload.get("channel") or "")
        device_id = str(payload.get("deviceId") or "").strip()
        if not device_id:
            raise HTTPException(status_code=422, detail="deviceId 不能为空")
        subscription = payload.get("subscription")
        if channel == "browser":
            endpoint, subscription = _validate_browser_subscription(subscription)
        elif channel == "macos":
            if not isinstance(subscription, dict):
                raise HTTPException(status_code=422, detail="subscription 必须是对象")
            endpoint = str(subscription.get("endpoint") or f"macos://{device_id}")
        else:
            raise HTTPException(status_code=422, detail="只有浏览器和系统通知可以注册设备")
        try:
            return service.save_subscription(
                channel=channel,
                device_id=device_id,
                endpoint=endpoint,
                subscription=subscription,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.delete("/notifications/subscriptions/{channel}/{device_id}", response_model=dict)
    async def deactivate_notification_subscription(channel: str, device_id: str):
        try:
            return service.deactivate_subscription(channel, device_id)
        except NotificationNotFoundError as exc:
            raise _not_found(exc) from exc


def _raise_enabled() -> bool:
    raise ValueError("enabled 必须是布尔值")
