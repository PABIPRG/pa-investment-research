# -*- coding: utf-8 -*-
"""主数据新鲜度：判断导入来源是否过期，并给出可读的过期标记。

新鲜度只依据 ``source_imports`` 的真实导入记录，不猜测、不伪造时间。
没有导入记录的来源明确标记为 ``never_imported``，而不是当作新鲜。
"""

from __future__ import annotations

from datetime import datetime, timezone

# 各来源的默认刷新阈值（小时）。akshare 证券名录变化较快，按周刷新；
# 本地词典与证券池是随代码发布的静态资源，放宽到月/季度。
SOURCE_MAX_AGE_HOURS: dict[str, float] = {
    "gazetteer_json": 90 * 24,
    "universe_json": 30 * 24,
    "akshare_security": 7 * 24,
}
DEFAULT_MAX_AGE_HOURS = 7 * 24

STATE_LABELS = {
    "fresh": "新鲜",
    "stale": "已过期",
    "never_imported": "从未导入",
    "failed": "刷新失败",
}


def _source_family(source: str | None) -> str | None:
    """实体的 source 形如 ``akshare_security:<version>``，取来源 ID。"""

    if not source:
        return None
    return source.split(":", 1)[0] or None


def _latest(records, *, status: str | None = None):
    candidates = [
        record
        for record in records
        if status is None or record.status == status
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda item: item.imported_at)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def source_freshness(
    repository,
    *,
    now: datetime | None = None,
    max_age_hours: float | None = None,
    limit: int = 500,
) -> list[dict]:
    """按来源汇总最近一次成功/尝试导入，返回新鲜度列表。

    ``max_age_hours`` 非空时覆盖所有来源的默认阈值；否则按来源取
    ``SOURCE_MAX_AGE_HOURS``，未登记的来源使用 ``DEFAULT_MAX_AGE_HOURS``。
    """

    now = _as_utc(now or datetime.now(timezone.utc))
    records = repository.list_source_imports(limit=limit)
    grouped: dict[str, list] = {}
    for record in records:
        grouped.setdefault(record.source_id, []).append(record)

    source_ids = list(dict.fromkeys([*SOURCE_MAX_AGE_HOURS, *grouped]))
    result: list[dict] = []
    for source_id in source_ids:
        items = grouped.get(source_id, [])
        last_attempt = _latest(items)
        last_success = _latest(items, status="success")
        threshold = (
            float(max_age_hours)
            if max_age_hours is not None
            else SOURCE_MAX_AGE_HOURS.get(source_id, DEFAULT_MAX_AGE_HOURS)
        )
        age_hours: float | None = None
        if last_success is None:
            state = "failed" if last_attempt is not None else "never_imported"
        else:
            age_hours = max(
                0.0,
                (now - _as_utc(last_success.imported_at)).total_seconds() / 3600.0,
            )
            if age_hours <= threshold:
                state = "fresh"
            elif last_attempt is not None and last_attempt.status == "failed":
                # 数据已过期且最近一次刷新失败：优先告诉用户刷新失败。
                state = "failed"
            else:
                state = "stale"
        result.append(
            {
                "source_id": source_id,
                "state": state,
                "state_label": STATE_LABELS[state],
                "needs_refresh": state != "fresh",
                "last_success_at": (
                    last_success.imported_at.isoformat() if last_success else None
                ),
                "last_attempt_at": (
                    last_attempt.imported_at.isoformat() if last_attempt else None
                ),
                "last_status": last_attempt.status if last_attempt else None,
                "last_error": (last_attempt.error if last_attempt else None),
                "source_version": last_success.source_version if last_success else "",
                "imported_count": last_success.imported_count if last_success else 0,
                "age_hours": round(age_hours, 2) if age_hours is not None else None,
                "max_age_hours": threshold,
                "warnings": list(last_attempt.warnings) if last_attempt else [],
            }
        )
    return result


def stale_source_warnings(
    repository,
    entity_sources: dict[str, str | None],
    *,
    now: datetime | None = None,
    max_age_hours: float | None = None,
) -> list[str]:
    """为已解析实体所依赖的来源生成过期标记；读取失败时不阻断研究。"""

    families = {
        family
        for family in (_source_family(source) for source in entity_sources.values())
        if family
    }
    if not families:
        return []
    try:
        freshness = {
            item["source_id"]: item
            for item in source_freshness(
                repository, now=now, max_age_hours=max_age_hours
            )
        }
    except Exception:  # 新鲜度只是辅助信息，不能拖垮 Scope
        return []

    warnings: list[str] = []
    for family in sorted(families):
        item = freshness.get(family)
        if item is None or not item["needs_refresh"]:
            continue
        if item["state"] == "stale":
            days = (item["age_hours"] or 0) / 24.0
            warnings.append(
                f"主数据 {family} 已 {days:.1f} 天未刷新"
                f"（阈值 {item['max_age_hours']:.0f} 小时），相关实体信息可能过期。"
            )
        elif item["state"] == "failed":
            detail = item["last_error"] or "；".join(item["warnings"]) or "未知原因"
            warnings.append(
                f"主数据 {family} 最近一次刷新失败（{detail}），"
                "当前使用的是上一次成功导入的数据。"
            )
        elif item["state"] == "never_imported":
            warnings.append(f"实体来源 {family} 没有导入记录，无法判断数据新鲜度。")
    return warnings
