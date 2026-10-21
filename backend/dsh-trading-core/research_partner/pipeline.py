# -*- coding: utf-8 -*-
"""进程内闭环编排：扫描日程 → 发布 outbox → 路由收件箱 → 执行任务 → 联系评估。

生产部署可由独立 worker 按同一顺序调用；``tick`` 只用于本机联调与测试。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from .contact import ContactDecisionService, ContactDispatcher
from .ports import BusinessStore
from .publisher import OutboxPublisher
from .recovery import RecoveryService
from .router import EventRouter
from .schedules import ScheduleService
from .worker import ResearchJobWorker, ResearchRunner, StubResearchRunner


class PartnerPipeline:
    def __init__(
        self,
        store: BusinessStore,
        *,
        runner: ResearchRunner | None = None,
        dispatcher: ContactDispatcher | None = None,
        calendar=None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        now = now or (lambda: datetime.now(timezone.utc))
        self.publisher = OutboxPublisher(store, now=now)
        self.schedules = ScheduleService(store, now=now, calendar=calendar)
        self.router = EventRouter(store, now=now)
        self.contact = ContactDecisionService(store, dispatcher=dispatcher, now=now)
        self.worker = ResearchJobWorker(
            store, runner or StubResearchRunner(now=now), self.contact, now=now
        )
        self.recovery = RecoveryService(store, now=now)
        self._now = now

    def recover(self, **options) -> dict:
        """启动或恢复后先做有界补偿，再进入正常 tick。"""

        return self.recovery.recover(**options)

    def tick(
        self,
        *,
        outbox_limit: int = 50,
        inbox_limit: int = 100,
        job_limit: int = 5,
        lease_seconds: int = 60,
    ) -> dict:
        schedules_due = self.schedules.scan(limit=outbox_limit)
        published = self.publisher.publish(limit=outbox_limit)
        jobs_created = self.router.route(limit=inbox_limit)
        jobs_completed = self.worker.run_once(
            limit=job_limit, lease_seconds=lease_seconds
        )
        return {
            "schedules_due": schedules_due,
            "published": published,
            "jobs_created": jobs_created,
            "jobs_completed": jobs_completed,
        }
