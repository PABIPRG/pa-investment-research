# -*- coding: utf-8 -*-
"""运行恢复（V1.3 §5.6.2 ``runtime.recovered``）。

恢复不是重跑所有委托，而是按类型做有界补偿：

- 过期任务租约：预算内重新排队，超出预算记为失败并保留 ``lease_expired``；
- 卡在 processing 的收件记录：放回待处理，路由/任务去重键保证不重复建任务；
- 失败的 outbox 记录：未超过预算的重新待发，事件 ID 不变；
- 到期日程：由 ``ScheduleService`` 在 tick 内按 ``catchup_seconds`` 处理，
  这里只报告本次扫描结果，不制造“补发全部历史”的假象。

调用时机：进程启动、长时间休眠/断网后恢复、以及周期性巡检。重复调用安全。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable

from .ports import BusinessStore


class RecoveryService:
    def __init__(
        self,
        store: BusinessStore,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))

    def recover(
        self,
        *,
        lease_limit: int = 50,
        inbox_limit: int = 100,
        outbox_limit: int = 50,
        inbox_stale_seconds: int = 300,
        retry_delay_seconds: int = 30,
    ) -> dict:
        at = self._now()
        if inbox_stale_seconds < 0:
            raise ValueError("inbox_stale_seconds 不能为负")
        reclaimed = self.store.reclaim_expired_leases(
            now=at,
            limit=lease_limit,
            retry_delay_seconds=retry_delay_seconds,
        )
        requeued = self.store.requeue_abandoned_inbox(
            older_than=at - timedelta(seconds=inbox_stale_seconds),
            limit=inbox_limit,
        )
        retried = self.store.retry_failed_outbox(now=at, limit=outbox_limit)
        return {
            "recovered_at": at.isoformat(),
            "leases_reclaimed": len(reclaimed),
            "jobs_requeued": sum(1 for job in reclaimed if job.status == "pending"),
            "jobs_failed": [
                job.job_id for job in reclaimed if job.status == "failed"
            ],
            "events_requeued": requeued,
            "outbox_retried": retried,
        }
