# -*- coding: utf-8 -*-
"""时间事件：委托日程、到期实例与漏执行补偿（V1.3 §5.6.1）。

- 日程按版本编译；修改联系约定产生新的日程，旧版本日程停用。
- 每次到期产生确定的实例标识，重复扫描不会重复触发。
- 超过 ``catchup_seconds`` 的错过实例不再当作当前提醒补发，只计为跳过；
  窗口内的错过实例按约补发。
- 扫描只覆盖仍处于 tracking 的委托；暂停期间不产生到期事件。恢复后只补发仍在
  补偿窗口内的实例，更早的实例计为跳过，不当作积压提醒补发。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Protocol, runtime_checkable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import EventEnvelope, MandateSchedule
from .ports import BusinessStore

_MAX_CATCHUP_SECONDS = 30 * 24 * 3600
_MAX_INSTANCES_PER_SCAN = 10

_CRON_FIELDS = (
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day_of_month", 1, 31),
    ("month", 1, 12),
    ("day_of_week", 0, 7),
)


class ScheduleError(ValueError):
    """日程定义不合法；保存时拒绝，扫描时停用而不是反复报错。"""


@runtime_checkable
class TradingCalendar(Protocol):
    """交易日历端口；由研究实体服务的日历适配器注入。"""

    def is_trading_day(self, day: date) -> bool: ...


class WeekdayCalendar:
    """没有日历数据源时的近似：周一至周五视为交易日，并在文档中标注降级。"""

    def is_trading_day(self, day: date) -> bool:
        return day.weekday() < 5


@dataclass(frozen=True)
class ScheduleSpec:
    cron: str
    timezone: str
    catchup_seconds: int
    trading_days_only: bool
    minute: frozenset[int]
    hour: frozenset[int]
    day_of_month: frozenset[int]
    month: frozenset[int]
    day_of_week: frozenset[int]
    dom_restricted: bool
    dow_restricted: bool

    @classmethod
    def parse(
        cls, value: Mapping[str, Any], *, default_timezone: str = "Asia/Shanghai"
    ) -> "ScheduleSpec":
        if not isinstance(value, Mapping):
            raise ScheduleError("schedule 必须是对象")
        cron = value.get("cron")
        if not isinstance(cron, str) or not cron.strip():
            raise ScheduleError("schedule.cron 必须是非空字符串")
        timezone_name = value.get("timezone") or default_timezone
        if not isinstance(timezone_name, str) or not timezone_name.strip():
            raise ScheduleError("schedule.timezone 必须是非空字符串")
        try:
            ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise ScheduleError(f"未知时区 {timezone_name!r}") from None
        catchup = value.get("catchup_seconds", 86400)
        if not isinstance(catchup, int) or isinstance(catchup, bool) or catchup < 0:
            raise ScheduleError("schedule.catchup_seconds 必须是非负整数")
        if catchup > _MAX_CATCHUP_SECONDS:
            raise ScheduleError("schedule.catchup_seconds 不能超过 30 天")
        trading_days_only = value.get("trading_days_only", False)
        if not isinstance(trading_days_only, bool):
            raise ScheduleError("schedule.trading_days_only 必须是布尔值")

        parts = cron.split()
        if len(parts) != 5:
            raise ScheduleError("cron 必须是 5 段：分 时 日 月 周")
        values: dict[str, frozenset[int]] = {}
        for text, (name, low, high) in zip(parts, _CRON_FIELDS):
            values[name] = _parse_field(text, low, high, name)
        if 7 in values["day_of_week"]:
            values["day_of_week"] = frozenset(
                0 if item == 7 else item for item in values["day_of_week"]
            )
        return cls(
            cron=cron.strip(),
            timezone=timezone_name,
            catchup_seconds=catchup,
            trading_days_only=trading_days_only,
            minute=values["minute"],
            hour=values["hour"],
            day_of_month=values["day_of_month"],
            month=values["month"],
            day_of_week=values["day_of_week"],
            dom_restricted=parts[2] != "*",
            dow_restricted=parts[4] != "*",
        )

    def matches(self, local: datetime) -> bool:
        if local.minute not in self.minute:
            return False
        if local.hour not in self.hour:
            return False
        if local.month not in self.month:
            return False
        dom_match = local.day in self.day_of_month
        # cron 周 0/7=周日，Python weekday 周一=0。
        dow_match = ((local.weekday() + 1) % 7) in self.day_of_week
        if self.dom_restricted and self.dow_restricted:
            return dom_match or dow_match
        if self.dom_restricted:
            return dom_match
        if self.dow_restricted:
            return dow_match
        return True

    def next_after(self, after: datetime) -> datetime | None:
        zone = ZoneInfo(self.timezone)
        local = after.astimezone(zone).replace(second=0, microsecond=0)
        local += timedelta(minutes=1)
        limit = local + timedelta(days=366)
        while local <= limit:
            if self.matches(local):
                return local.astimezone(timezone.utc)
            local += timedelta(minutes=1)
        return None

    def instance_key(self, at: datetime) -> str:
        return at.astimezone(ZoneInfo(self.timezone)).strftime("%Y%m%dT%H%M%z")


def schedule_id_for(
    mandate_id: str, revision: int, *, mode: str, spec: ScheduleSpec
) -> str:
    raw = "|".join(
        [
            mandate_id,
            str(revision),
            mode,
            spec.cron,
            spec.timezone,
            str(spec.catchup_seconds),
            "trading" if spec.trading_days_only else "all",
        ]
    )
    return "SCH_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _next_instance(
    spec: ScheduleSpec,
    after: datetime,
    *,
    trading_only: bool,
    calendar: TradingCalendar | None = None,
) -> datetime | None:
    """下一次真正会触发的到期时间；只看交易日的日程跳过休市日。"""

    calendar = calendar or WeekdayCalendar()
    nxt = spec.next_after(after)
    if not trading_only:
        return nxt
    guard = 0
    while nxt is not None and guard < 400:
        local_day = nxt.astimezone(ZoneInfo(spec.timezone)).date()
        if calendar.is_trading_day(local_day):
            return nxt
        nxt = spec.next_after(nxt)
        guard += 1
    return nxt


def compile_schedules(
    mandate_id: str,
    revision: int,
    policy,
    *,
    now: datetime,
    default_timezone: str = "Asia/Shanghai",
    calendar: TradingCalendar | None = None,
) -> list[MandateSchedule]:
    """从联系约定编译本版本的日程；没有 schedule 时返回空列表。"""

    if policy.schedule is None:
        return []
    spec = ScheduleSpec.parse(policy.schedule, default_timezone=default_timezone)
    next_due = _next_instance(
        spec, now, trading_only=spec.trading_days_only, calendar=calendar
    )
    if next_due is None:
        raise ScheduleError("cron 在未来一年内没有可执行的到期时间")
    return [
        MandateSchedule(
            schedule_id=schedule_id_for(
                mandate_id, revision, mode=policy.mode, spec=spec
            ),
            mandate_id=mandate_id,
            revision=revision,
            mode=policy.mode,
            cron=spec.cron,
            timezone=spec.timezone,
            catchup_seconds=spec.catchup_seconds,
            trading_days_only=spec.trading_days_only,
            next_due_at=next_due,
            created_at=now,
            updated_at=now,
        )
    ]


class ScheduleService:
    """把到期的委托日程转成 ``schedule.due`` 事件。"""

    def __init__(
        self,
        store: BusinessStore,
        *,
        now=None,
        calendar: TradingCalendar | None = None,
        max_instances_per_scan: int = _MAX_INSTANCES_PER_SCAN,
    ) -> None:
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.calendar = calendar or WeekdayCalendar()
        self.max_instances_per_scan = max_instances_per_scan

    def scan(self, limit: int = 50) -> int:
        now = self._now()
        emitted = 0
        for schedule in self.store.list_due_schedules(now=now, limit=limit):
            emitted += self._scan_one(schedule, now)
        return emitted

    def _scan_one(self, schedule: MandateSchedule, now: datetime) -> int:
        try:
            spec = ScheduleSpec.parse(
                {
                    "cron": schedule.cron,
                    "timezone": schedule.timezone,
                    "catchup_seconds": schedule.catchup_seconds,
                    "trading_days_only": schedule.trading_days_only,
                }
            )
        except ScheduleError:
            # 坏日程直接停用，避免扫描反复失败；用户重新保存委托即可修复。
            self.store.advance_schedule(
                schedule.schedule_id,
                next_due_at=schedule.next_due_at,
                enabled=False,
                now=now,
            )
            return 0

        instance = schedule.next_due_at
        emitted = 0
        skipped = 0
        last_key = schedule.last_instance_key
        processed = 0
        while instance <= now and processed < self.max_instances_per_scan:
            processed += 1
            key = spec.instance_key(instance)
            local_day = instance.astimezone(ZoneInfo(spec.timezone)).date()
            if schedule.trading_days_only and not self._is_trading_day(local_day):
                # 休市日没有这个实例：不提醒，也不计入漏执行。
                pass
            elif now - instance <= timedelta(seconds=schedule.catchup_seconds):
                if self._emit(schedule, key, instance, now):
                    emitted += 1
            else:
                skipped += 1
            last_key = key
            next_due = _next_instance(
                spec,
                instance,
                trading_only=schedule.trading_days_only,
                calendar=self.calendar,
            )
            if next_due is None:
                self.store.advance_schedule(
                    schedule.schedule_id,
                    next_due_at=instance,
                    last_instance_key=last_key,
                    skipped_missed=skipped,
                    enabled=False,
                    now=now,
                )
                return emitted
            instance = next_due

        self.store.advance_schedule(
            schedule.schedule_id,
            next_due_at=instance,
            last_instance_key=last_key,
            skipped_missed=skipped,
            enabled=True,
            now=now,
        )
        return emitted

    def _is_trading_day(self, day: date) -> bool:
        try:
            return bool(self.calendar.is_trading_day(day))
        except Exception:
            # 日历不可用时宁可照常提醒，也不静默丢掉用户约定的到期提醒。
            return True

    def _emit(
        self, schedule: MandateSchedule, key: str, instance: datetime, now: datetime
    ) -> bool:
        envelope = EventEnvelope(
            event_id=f"{schedule.schedule_id}:{key}",
            hook_type="schedule.due",
            producer="research-partner-scheduler",
            occurred_at=instance,
            observed_at=now,
            subject_ids=[
                item.entity_id
                for item in self.store.list_subjects(
                    schedule.mandate_id, schedule.revision
                )
            ],
            correlation_id=schedule.schedule_id,
            payload={
                "schedule_id": schedule.schedule_id,
                "instance_key": key,
                "scheduled_at": instance.isoformat(),
                "mode": schedule.mode,
                "mandate_id": schedule.mandate_id,
                "revision": schedule.revision,
            },
        )
        return self.store.record_event(envelope)


def _parse_field(text: str, low: int, high: int, name: str) -> frozenset[int]:
    values: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        if not part:
            raise ScheduleError(f"cron {name} 段为空")
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            try:
                step = int(step_text)
            except ValueError:
                raise ScheduleError(f"cron {name} 步长无效") from None
            if step <= 0:
                raise ScheduleError(f"cron {name} 步长必须为正")
        if part == "*":
            start, end = low, high
        elif "-" in part:
            start_text, end_text = part.split("-", 1)
            try:
                start, end = int(start_text), int(end_text)
            except ValueError:
                raise ScheduleError(f"cron {name} 范围无效") from None
        else:
            try:
                start = end = int(part)
            except ValueError:
                raise ScheduleError(f"cron {name} 取值无效") from None
        if not (low <= start <= high and low <= end <= high):
            raise ScheduleError(f"cron {name} 超出 {low}-{high}")
        if start > end:
            raise ScheduleError(f"cron {name} 范围起点大于终点")
        values.update(range(start, end + 1, step))
    if not values:
        raise ScheduleError(f"cron {name} 没有有效取值")
    return frozenset(values)
