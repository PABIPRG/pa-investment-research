# -*- coding: utf-8 -*-
"""数据包导出与导入（V1.3 §9.4）。

数据包只包含委托领域的状态：委托、不可变版本、主体、待补充项、追踪依赖与
到期日程。任务租约、在途投递、outbox/inbox、联系决定历史和执行凭据不进入
数据包——它们属于运行时状态，导入后不得恢复，也不得因此重新发送旧通知。

导入流程固定为：解析校验 → 预览重复与冲突 → 用户选定处理方式 → 提交 →
数量核对。每次导入有稳定批次标识，重试同一批次返回原结果，不重复写入。
导入的委托一律保持“暂停”或“已归档”，启用必须再走当前版本的恢复命令；
包内的 owner 字段不能授予权限，导入内容归属当前可信主体。
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Sequence

from pydantic import ValidationError

from .models import (
    IdempotentResponse,
    Mandate,
    MandateRequirement,
    MandateRevision,
    MandateSchedule,
    MandateSubject,
    TrackingDependency,
)
from .ports import BusinessStore

FORMAT = "research-partner-data-package"
FORMAT_VERSION = 1
DOMAIN = "research-partner"
IMPORT_OPERATION = "data.import"
_SUPPORTED_SCHEMA_MAJOR = "1"
_RESOLUTIONS = {"skip", "replace"}


class TransferError(ValueError):
    """数据包不符合受支持的确定性契约。"""


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def _model_list(items: Iterable[dict[str, Any]], model, *, label: str) -> list[Any]:
    parsed = []
    for index, item in enumerate(items):
        try:
            parsed.append(model.model_validate(item))
        except (ValidationError, TypeError) as exc:
            raise TransferError(f"{label} 第 {index + 1} 项不合法：{exc}") from exc
    return parsed


def _entry_fingerprint(entry: dict[str, Any]) -> str:
    """委托条目的内容指纹；用于识别重复导入与同标识异内容冲突。"""

    normalized = json.loads(_canonical(entry))
    mandate = normalized.get("mandate") or {}
    mandate.pop("principal_id", None)
    mandate.pop("instance_id", None)
    # 导入总会把委托置为暂停/归档，状态不参与内容比较，避免重复导入被误判为冲突。
    mandate.pop("status", None)
    normalized["mandate"] = mandate
    return _digest(normalized)


def export_snapshot(
    store: BusinessStore,
    *,
    principal_id: str,
    instance_id: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    """导出一致快照；同一主体、同一实例的委托及其完整修订链。"""

    mandates: list[Mandate] = []
    cursor: str | None = None
    while True:
        page, cursor = store.list_mandates(
            principal_id,
            instance_id=instance_id,
            limit=limit,
            cursor=cursor,
        )
        mandates.extend(page)
        if cursor is None:
            break
    entries: list[dict[str, Any]] = []
    revision_count = 0
    schedule_count = 0
    for mandate in sorted(mandates, key=lambda item: item.mandate_id):
        revisions = []
        for number in range(1, mandate.current_revision + 1):
            revision = store.get_revision(mandate.mandate_id, number)
            if revision is None:
                raise TransferError(
                    f"委托 {mandate.mandate_id} 缺少版本 {number}，不能导出为完整备份"
                )
            revisions.append(
                {
                    "revision": revision.model_dump(mode="json"),
                    "subjects": [
                        item.model_dump(mode="json")
                        for item in store.list_subjects(mandate.mandate_id, number)
                    ],
                    "requirements": [
                        item.model_dump(mode="json")
                        for item in store.list_requirements(
                            mandate.mandate_id, revision=number
                        )
                    ],
                    "dependencies": [
                        item.model_dump(mode="json")
                        for item in store.list_dependencies(
                            mandate.mandate_id, revision=number, active_only=False
                        )
                    ],
                }
            )
        schedules = [
            item.model_dump(mode="json")
            for item in store.list_schedules(mandate.mandate_id, active_only=False)
        ]
        revision_count += len(revisions)
        schedule_count += len(schedules)
        entries.append(
            {
                "mandate": mandate.model_dump(mode="json"),
                "revisions": revisions,
                "schedules": schedules,
            }
        )
    snapshot = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "domain": DOMAIN,
        "schema_version": store.schema_version(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": {"principal_id": principal_id, "instance_id": instance_id},
        "counts": {
            "mandates": len(entries),
            "revisions": revision_count,
            "schedules": schedule_count,
        },
        "mandates": entries,
    }
    snapshot["integrity"] = {"algorithm": "sha256", "value": _digest(entries)}
    return snapshot


def validate_snapshot(snapshot: Any) -> list[dict[str, Any]]:
    """校验格式、版本、完整性与记录结构；返回按原顺序的条目。"""

    if not isinstance(snapshot, dict):
        raise TransferError("数据包必须是对象")
    if snapshot.get("format") != FORMAT or snapshot.get("domain") != DOMAIN:
        raise TransferError("不是研究委托数据包")
    if snapshot.get("format_version") != FORMAT_VERSION:
        raise TransferError(
            f"不支持的数据包格式版本：{snapshot.get('format_version')}"
        )
    schema_version = str(snapshot.get("schema_version") or "")
    if not schema_version.startswith(_SUPPORTED_SCHEMA_MAJOR + "."):
        raise TransferError(f"不支持的业务库 schema 版本：{schema_version or '缺失'}")
    entries = snapshot.get("mandates")
    if not isinstance(entries, list):
        raise TransferError("数据包缺少 mandates 列表")
    integrity = snapshot.get("integrity") or {}
    if integrity.get("algorithm") != "sha256" or not integrity.get("value"):
        raise TransferError("数据包缺少完整性校验值")
    if _digest(entries) != integrity.get("value"):
        raise TransferError("数据包完整性校验失败，文件可能已损坏或被修改")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise TransferError(f"第 {index + 1} 条委托记录不是对象")
        mandate_raw = entry.get("mandate")
        if not isinstance(mandate_raw, dict):
            raise TransferError(f"第 {index + 1} 条委托记录缺少 mandate")
        try:
            mandate = Mandate.model_validate(mandate_raw)
        except (ValidationError, TypeError) as exc:
            raise TransferError(f"第 {index + 1} 条委托记录不合法：{exc}") from exc
        if mandate.mandate_id in seen:
            raise TransferError(f"数据包重复包含委托 {mandate.mandate_id}")
        seen.add(mandate.mandate_id)
        revisions_raw = entry.get("revisions")
        schedules_raw = entry.get("schedules") or []
        if not isinstance(revisions_raw, list) or not revisions_raw:
            raise TransferError(f"委托 {mandate.mandate_id} 缺少版本记录")
        revisions: list[MandateRevision] = []
        subjects: list[MandateSubject] = []
        requirements: list[MandateRequirement] = []
        dependencies: list[TrackingDependency] = []
        for item in revisions_raw:
            if not isinstance(item, dict) or "revision" not in item:
                raise TransferError(f"委托 {mandate.mandate_id} 的版本记录不合法")
            revisions.extend(_model_list([item["revision"]], MandateRevision, label="版本"))
            subjects.extend(
                _model_list(item.get("subjects") or [], MandateSubject, label="主体")
            )
            requirements.extend(
                _model_list(
                    item.get("requirements") or [], MandateRequirement, label="待补充项"
                )
            )
            dependencies.extend(
                _model_list(
                    item.get("dependencies") or [],
                    TrackingDependency,
                    label="追踪依赖",
                )
            )
        revisions.sort(key=lambda value: value.revision)
        if [item.revision for item in revisions] != list(
            range(1, mandate.current_revision + 1)
        ):
            raise TransferError(f"委托 {mandate.mandate_id} 的版本链不连续")
        normalized.append(
            {
                "mandate": mandate,
                "revisions": revisions,
                "subjects": subjects,
                "requirements": requirements,
                "dependencies": dependencies,
                "schedules": _model_list(
                    schedules_raw, MandateSchedule, label="日程"
                ),
                "fingerprint": _entry_fingerprint(entry),
            }
        )
    return normalized


def _local_fingerprint(store: BusinessStore, mandate: Mandate) -> str | None:
    """按导出格式重算本地同标识委托的指纹，用于判断重复还是冲突。"""

    revisions = []
    for number in range(1, mandate.current_revision + 1):
        revision = store.get_revision(mandate.mandate_id, number)
        if revision is None:
            return None
        revisions.append(
            {
                "revision": revision.model_dump(mode="json"),
                "subjects": [
                    item.model_dump(mode="json")
                    for item in store.list_subjects(mandate.mandate_id, number)
                ],
                "requirements": [
                    item.model_dump(mode="json")
                    for item in store.list_requirements(
                        mandate.mandate_id, revision=number
                    )
                ],
                "dependencies": [
                    item.model_dump(mode="json")
                    for item in store.list_dependencies(
                        mandate.mandate_id, revision=number, active_only=False
                    )
                ],
            }
        )
    entry = {
        "mandate": mandate.model_dump(mode="json"),
        "revisions": revisions,
        "schedules": [
            item.model_dump(mode="json")
            for item in store.list_schedules(mandate.mandate_id, active_only=False)
        ],
    }
    return _entry_fingerprint(entry)


def preview_import(
    store: BusinessStore,
    snapshot: Any,
    *,
    principal_id: str,
) -> dict[str, Any]:
    """预览会新增、跳过与冲突的委托；不写入任何状态。"""

    entries = validate_snapshot(snapshot)
    items = []
    for entry in entries:
        mandate: Mandate = entry["mandate"]
        existing = store.get_mandate_internal(mandate.mandate_id)
        if existing is None:
            action = "import"
            reason = "new"
        elif _local_fingerprint(store, existing) == entry["fingerprint"]:
            action = "skip"
            reason = "unchanged"
        else:
            action = "conflict"
            reason = "same_id_different_content"
        items.append(
            {
                "mandate_id": mandate.mandate_id,
                "goal": entry["revisions"][-1].goal,
                "action": action,
                "reason": reason,
                "imported_status": "ended" if mandate.status == "ended" else "paused",
            }
        )
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "schema_version": snapshot.get("schema_version"),
        "integrity": (snapshot.get("integrity") or {}).get("value"),
        "counts": {
            "mandates": len(items),
            "import": sum(1 for item in items if item["action"] == "import"),
            "skip": sum(1 for item in items if item["action"] == "skip"),
            "conflict": sum(1 for item in items if item["action"] == "conflict"),
        },
        "items": items,
        "warnings": [
            "导入的委托保持暂停或已归档，启用需再走恢复命令",
            "旧通知、任务租约和在途投递不会随数据包恢复",
        ],
    }


def _prepare(
    store: BusinessStore,
    entries: Sequence[dict[str, Any]],
    *,
    principal_id: str,
    instance_id: str,
    resolutions: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    to_write: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    warnings: list[str] = []
    for entry in entries:
        mandate: Mandate = entry["mandate"]
        resolved = resolutions.get(mandate.mandate_id)
        if resolved is not None and resolved not in _RESOLUTIONS:
            raise TransferError(
                f"委托 {mandate.mandate_id} 的处理方式必须是 skip 或 replace"
            )
        existing = store.get_mandate_internal(mandate.mandate_id)
        if existing is not None:
            unchanged = _local_fingerprint(store, existing) == entry["fingerprint"]
            if unchanged or resolved in (None, "skip"):
                skipped.append(
                    {
                        "mandate_id": mandate.mandate_id,
                        "reason": "unchanged" if unchanged else "conflict_skipped",
                    }
                )
                if not unchanged:
                    warnings.append(
                        f"委托 {mandate.mandate_id} 标识相同但内容不同，按选择跳过"
                    )
                continue
            # replace：显式覆盖，旧版本、日程与联系历史一并删除。
            to_write.append({**entry, "replace": True})
            warnings.append(f"委托 {mandate.mandate_id} 将被覆盖，原记录不可恢复")
            continue
        to_write.append({**entry, "replace": False})
    return to_write, skipped, warnings


def commit_import(
    store: BusinessStore,
    snapshot: Any,
    *,
    principal_id: str,
    instance_id: str,
    batch_id: str | None = None,
    resolutions: dict[str, str] | None = None,
    now: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    """暂存并提交一次导入；同一批次标识重试返回原回执。"""

    batch = (batch_id or "IMP_" + secrets.token_hex(16)).strip()
    if not batch.startswith("IMP_") or len(batch) < 12:
        raise TransferError("导入批次标识必须以 IMP_ 开头且长度足够")
    previous = store.get_idempotent_response(
        principal_id, IMPORT_OPERATION, batch
    )
    if previous is not None:
        return {**previous.response, "replayed": True}
    entries = validate_snapshot(snapshot)
    resolutions = dict(resolutions or {})
    to_write, skipped, warnings = _prepare(
        store,
        entries,
        principal_id=principal_id,
        instance_id=instance_id,
        resolutions=resolutions,
    )
    at = (now or (lambda: datetime.now(timezone.utc)))()
    external = {item["mandate"].mandate_id for item in entries}
    unknown = sorted(set(resolutions) - external)
    if unknown:
        raise TransferError(f"处理方式引用了数据包中不存在的委托：{', '.join(unknown)}")

    imported = 0
    for entry in to_write:
        original: Mandate = entry["mandate"]
        status = "ended" if original.status == "ended" else "paused"
        mandate = original.model_copy(
            update={
                "principal_id": principal_id,
                "instance_id": instance_id,
                "status": status,
            }
        )
        if entry.get("replace"):
            store.delete_mandate(mandate.mandate_id)
        try:
            store.import_mandate(
                mandate,
                entry["revisions"],
                subjects=entry["subjects"],
                requirements=entry["requirements"],
                dependencies=entry["dependencies"],
                schedules=entry["schedules"],
            )
        except ValidationError as exc:
            raise TransferError(
                f"委托 {mandate.mandate_id} 导入失败：{exc}"
            ) from exc
        imported += 1

    result = {
        "batch_id": batch,
        "committed_at": at.isoformat(),
        "counts": {
            "mandates": len(entries),
            "imported": imported,
            "skipped": len(skipped),
        },
        "skipped": skipped,
        "warnings": warnings,
        "replayed": False,
    }
    store.save_idempotent_response(
        IdempotentResponse(
            principal_id=principal_id,
            operation=IMPORT_OPERATION,
            idempotency_key=batch,
            request_hash=_digest(snapshot.get("integrity") or snapshot.get("mandates")),
            response=result,
            created_at=at,
        )
    )
    return result
