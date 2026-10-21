# -*- coding: utf-8 -*-
"""联系约定解析（V1.3 §5.6.1）。

四种联系规则：

- ``condition``：条件联系，条件不满足保持安静；
- ``scheduled_delivery``：定时交付，即使没有新发现也按约交付本次成果；
- ``due_reminder``：明确到期提醒，按约定直接提醒，可跳过研究计算；
- ``periodic_check``：周期检查，无值得说的发现可以静默。

约定来自委托版本的 ``contact_policy``，是与用户达成的边界；核心只按这里
解析出的规则判断，不在运行时替用户新增阈值。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .conditions import condition_key_for

CONTACT_MODES = {"condition", "scheduled_delivery", "due_reminder", "periodic_check"}
NOTIFY_ON_VALUES = {"level", "transition", "first_entry", "reentry"}
DEFAULT_CHANNELS = ("app",)
_MAX_SECONDS = 30 * 24 * 3600


class ContactPolicyError(ValueError):
    """联系约定不合法；调用方应记录为配置错误，而不是条件未知。"""


@dataclass(frozen=True)
class ContactPolicy:
    mode: str = "condition"
    condition: dict[str, Any] | None = None
    condition_key: str = "notable_change"
    channels: tuple[str, ...] = DEFAULT_CHANNELS
    schedule: dict[str, Any] | None = None
    cooldown_seconds: int = 0
    merge_window_seconds: int = 0
    unknown_retry_seconds: int = 1800
    error_retry_seconds: int = 900
    max_retries: int = 3
    notify_on: str = "level"
    sustain_seconds: int = 0
    reentry_after_seconds: int = 0
    quiet_hours: dict[str, Any] | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def delivers_without_change(self) -> bool:
        """定时交付与到期提醒即使没有新发现也要联系。"""

        return self.mode in {"scheduled_delivery", "due_reminder"}

    @property
    def applies_cooldown(self) -> bool:
        return self.mode in {"condition", "periodic_check"}


def parse_contact_policy(
    policy: Mapping[str, Any] | None,
    *,
    default_channels: tuple[str, ...] | list[str] | None = None,
) -> ContactPolicy:
    policy = dict(policy or {})

    mode = policy.get("mode")
    if mode is None:
        if policy.get("condition") is not None:
            mode = "condition"
        elif policy.get("schedule") is not None:
            mode = "scheduled_delivery"
        else:
            mode = "condition"
    if mode not in CONTACT_MODES:
        raise ContactPolicyError(f"不支持的联系规则 {mode!r}")

    condition = policy.get("condition")
    if condition is not None and not isinstance(condition, Mapping):
        raise ContactPolicyError("condition 必须是对象")
    condition = dict(condition) if condition is not None else None
    if mode in {"condition", "periodic_check"} and condition is None:
        condition = None  # 使用默认的 notable_change 语义条件

    schedule = policy.get("schedule")
    if schedule is not None and not isinstance(schedule, Mapping):
        raise ContactPolicyError("schedule 必须是对象")

    channels = _channels(policy.get("channels"), default_channels)
    cooldown_seconds = _seconds(policy, "cooldown_seconds", default=0)
    merge_window_seconds = _seconds(policy, "merge_window_seconds", default=0)
    unknown_retry_seconds = _seconds(policy, "unknown_retry_seconds", default=1800)
    error_retry_seconds = _seconds(policy, "error_retry_seconds", default=900)
    max_retries = policy.get("max_retries", 3)
    if not isinstance(max_retries, int) or isinstance(max_retries, bool) or not 0 <= max_retries <= 10:
        raise ContactPolicyError("max_retries 必须是 0 到 10 的整数")
    notify_on = policy.get("notify_on", "level")
    if notify_on not in NOTIFY_ON_VALUES:
        raise ContactPolicyError(f"不支持的提醒时机 {notify_on!r}")
    sustain_seconds = _seconds(policy, "sustain_seconds", default=0)
    reentry_after_seconds = _seconds(policy, "reentry_after_seconds", default=0)

    quiet_hours = policy.get("quiet_hours")
    if quiet_hours is not None:
        quiet_hours = parse_quiet_hours(quiet_hours)

    return ContactPolicy(
        mode=mode,
        condition=condition,
        condition_key=condition_key_for(policy),
        channels=channels,
        schedule=dict(schedule) if schedule is not None else None,
        cooldown_seconds=cooldown_seconds,
        merge_window_seconds=merge_window_seconds,
        unknown_retry_seconds=unknown_retry_seconds,
        error_retry_seconds=error_retry_seconds,
        max_retries=max_retries,
        notify_on=notify_on,
        sustain_seconds=sustain_seconds,
        reentry_after_seconds=reentry_after_seconds,
        quiet_hours=quiet_hours,
        raw=policy,
    )


def parse_quiet_hours(value: Mapping[str, Any]) -> dict[str, Any]:
    """校验静默时段；格式为 ``{"start": "22:00", "end": "08:00"}``。

    支持可选 ``days``（0=周一 … 6=周日）；跨午夜时结束时间视为次日。
    """

    if not isinstance(value, Mapping):
        raise ContactPolicyError("quiet_hours 必须是对象")
    start = _parse_clock(value.get("start"), "quiet_hours.start")
    end = _parse_clock(value.get("end"), "quiet_hours.end")
    result: dict[str, Any] = {"start": start, "end": end}
    days = value.get("days")
    if days is not None:
        if not isinstance(days, list) or not days:
            raise ContactPolicyError("quiet_hours.days 必须是非空列表")
        normalized: list[int] = []
        for day in days:
            if not isinstance(day, int) or isinstance(day, bool) or not 0 <= day <= 6:
                raise ContactPolicyError("quiet_hours.days 只能包含 0-6")
            normalized.append(day)
        result["days"] = sorted(set(normalized))
    return result


def in_quiet_hours(quiet_hours: Mapping[str, Any], at: datetime, tz_name: str) -> bool:
    window = _resolve_quiet(quiet_hours, at, tz_name)
    return window is not None


def quiet_hours_until(
    quiet_hours: Mapping[str, Any], at: datetime, tz_name: str
) -> datetime | None:
    """返回本次静默结束的 UTC 时间；不在静默中返回 ``None``。"""

    window = _resolve_quiet(quiet_hours, at, tz_name)
    return None if window is None else window[1]


def _resolve_quiet(
    quiet_hours: Mapping[str, Any], at: datetime, tz_name: str
) -> tuple[datetime, datetime] | None:
    zone = _zone(tz_name)
    local = at.astimezone(zone)
    start = time.fromisoformat(quiet_hours["start"])
    end = time.fromisoformat(quiet_hours["end"])
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    start_today = midnight + timedelta(hours=start.hour, minutes=start.minute)
    end_today = midnight + timedelta(hours=end.hour, minutes=end.minute)
    if end_today <= start_today:
        # 跨午夜：凌晨段属于前一天开启的窗口。
        if local >= start_today:
            window = (start_today, end_today + timedelta(days=1))
        else:
            window = (start_today - timedelta(days=1), end_today)
    else:
        window = (start_today, end_today)
    if not window[0] <= local < window[1]:
        return None
    days = quiet_hours.get("days")
    if days is not None and window[0].weekday() not in set(days):
        return None
    return window[0].astimezone(timezone.utc), window[1].astimezone(timezone.utc)


def _zone(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ContactPolicyError(f"未知时区 {tz_name!r}") from None


def _parse_clock(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ContactPolicyError(f"{field_name} 必须是 HH:MM")
    try:
        parsed = time.fromisoformat(value)
    except ValueError:
        raise ContactPolicyError(f"{field_name} 必须是 HH:MM") from None
    if parsed.tzinfo is not None or parsed.second or parsed.microsecond:
        raise ContactPolicyError(f"{field_name} 必须是本地 HH:MM")
    return f"{parsed.hour:02d}:{parsed.minute:02d}"


def _channels(
    value: Any, default: tuple[str, ...] | list[str] | None
) -> tuple[str, ...]:
    if value is None:
        return tuple(default or DEFAULT_CHANNELS)
    if not isinstance(value, list) or not value:
        raise ContactPolicyError("channels 必须是非空列表")
    channels: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ContactPolicyError("channels 只能包含非空字符串")
        channels.append(item.strip())
    return tuple(dict.fromkeys(channels))


def _seconds(policy: Mapping[str, Any], field_name: str, *, default: int) -> int:
    value = policy.get(field_name, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ContactPolicyError(f"{field_name} 必须是非负整数")
    if value > _MAX_SECONDS:
        raise ContactPolicyError(f"{field_name} 不能超过 30 天")
    return value
