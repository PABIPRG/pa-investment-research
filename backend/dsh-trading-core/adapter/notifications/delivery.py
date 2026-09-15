# -*- coding: utf-8 -*-
"""通知投递 worker 与渠道错误分类。"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Callable, Mapping, Protocol

from .repository import NotificationRepository


logger = logging.getLogger("adapter.notifications.delivery")


class DeliveryAdapter(Protocol):
    def send(self, job: dict) -> None:
        """发送一条已领取的任务；失败时抛出 DeliveryError。"""


class DeliveryError(RuntimeError):
    """渠道适配器提供的可重试性和结果确定性。"""

    def __init__(
        self,
        code: str,
        *,
        retryable: bool,
        outcome_uncertain: bool,
        message: str | None = None,
    ):
        super().__init__(message or code)
        self.code = code
        self.retryable = retryable
        self.outcome_uncertain = outcome_uncertain


class DeliverySuppressed(RuntimeError):
    """渠道未配置、未授权或没有可用接收目标。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class NotificationDeliveryWorker:
    """按租约领取任务并隔离每个渠道的发送结果。"""

    def __init__(
        self,
        repository: NotificationRepository,
        adapters: Mapping[str, DeliveryAdapter],
        *,
        now: Callable[[], datetime] | None = None,
        lease_seconds: int = 60,
        max_attempts: int = 5,
        batch_size: int = 20,
    ):
        self.repository = repository
        self.adapters = dict(adapters)
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts
        self.batch_size = batch_size

    def run_once(self) -> dict[str, int]:
        result = {"claimed": 0, "sent": 0, "failed": 0}
        jobs = self.repository.claim_delivery_jobs(
            channels=set(self.adapters),
            now=self.now(),
            lease_seconds=self.lease_seconds,
            limit=self.batch_size,
        )
        result["claimed"] = len(jobs)
        for job in jobs:
            adapter = self.adapters[job["channel"]]
            try:
                adapter.send(job)
            except DeliverySuppressed as exc:
                self.repository.suppress_delivery_job(
                    job["id"], job["leaseToken"], now=self.now(),
                    reason_code=exc.code, reason=str(exc),
                )
                result["failed"] += 1
            except DeliveryError as exc:
                self.repository.fail_delivery_job(
                    job["id"], job["leaseToken"], now=self.now(),
                    error_code=exc.code, error_message=str(exc),
                    retryable=exc.retryable, outcome_uncertain=exc.outcome_uncertain,
                    max_attempts=self.max_attempts,
                )
                result["failed"] += 1
            except Exception as exc:  # noqa: BLE001 — 单个渠道异常不阻断其他任务
                logger.exception("通知渠道未分类异常 channel=%s job=%s", job["channel"], job["id"])
                self.repository.fail_delivery_job(
                    job["id"], job["leaseToken"], now=self.now(),
                    error_code="adapter_error", error_message=str(exc),
                    retryable=True, outcome_uncertain=True,
                    max_attempts=self.max_attempts,
                )
                result["failed"] += 1
            else:
                self.repository.complete_delivery_job(job["id"], job["leaseToken"], self.now())
                result["sent"] += 1
        return result
