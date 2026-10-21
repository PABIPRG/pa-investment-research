# -*- coding: utf-8 -*-
"""跨领域产品数据包（V1.3 §9.4）。

数据管理服务统一组织导入导出，各领域仍通过自己的接口提供数据：这里只定义
清单、完整性、跨域预览与提交顺序，不直接读写任何业务库。

清单包含格式与各领域 schema 版本、创建时间、导出范围、各领域一致性版本、
记录数量、附件清单与校验值、原标识与关联映射。跨领域不假设存在统一事务：
先逐域暂存，记录每步提交进度，失败时保留已完成域的进度并隔离未完成批次；
只有全部域提交且关联核对通过，批次才标记为完成。重试同一批次只补做未完成
的域，不重复导入。

已知缺口（导出时显式标记，不静默）：某域导出失败或没有注册适配器时，
``missing`` 会列出该域且 ``complete`` 为假——不能把不完整包宣称为完整备份。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

FORMAT = "pa-product-data-package"
FORMAT_VERSION = 1
SUPPORTED_FORMAT_MAJOR = 1
BATCH_ID = re.compile(r"^IMP_[A-Za-z0-9_-]{8,128}$")
_ATTACHMENT_NAME = re.compile(r"^[^/\\\x00]{1,255}$")


class PackageError(ValueError):
    """数据包不符合受支持的确定性契约。"""


class PackageIntegrityError(PackageError):
    """数据包内容与清单校验值不一致。"""


class BatchConflict(RuntimeError):
    """同一批次标识被用于不同的数据包。"""


class PackageImportError(RuntimeError):
    """某个领域提交失败；已完成领域保留进度，可用同一批次重试。"""

    def __init__(
        self,
        batch_id: str,
        domain: str,
        reason: str,
        *,
        committed: Iterable[str] = (),
    ) -> None:
        super().__init__(f"领域 {domain} 导入失败：{reason}")
        self.batch_id = batch_id
        self.domain = domain
        self.reason = reason
        self.committed = tuple(committed)


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _iso(value: datetime | None = None) -> str:
    return (value or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


def _major(version: Any) -> str:
    return str(version or "").split(".")[0]


def _check_attachment_name(name: Any) -> str:
    if not isinstance(name, str) or _ATTACHMENT_NAME.fullmatch(name) is None:
        raise PackageError(f"附件名不合法：{name!r}")
    return name


class DomainAdapter:
    """领域适配器契约；各域自行决定内部存储与导入幂等实现。"""

    name = ""
    # 声明兼容的领域 schema 主版本；None 表示由领域自己校验。
    supported_schema_major: str | None = None

    def export_domain(self) -> dict[str, Any]:
        """返回 ``payload``、``schemaVersion``、``consistencyVersion``、``counts``。"""

        raise NotImplementedError

    def preview(self, payload: dict[str, Any]) -> dict[str, Any]:
        """返回 ``counts``（new/duplicate/conflict）与可选 ``expectedRevision``。"""

        raise NotImplementedError

    def commit(
        self,
        payload: dict[str, Any],
        *,
        batch_id: str,
        resolutions: Mapping[str, Any],
        expected_revision: str | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def verify(self, payload: dict[str, Any]) -> dict[str, Any]:
        """关联核对；默认视为通过。返回 ``{"ok": bool, ...}``。"""

        return {"ok": True, "counts": self.export_domain()["counts"]}

    def is_empty(self) -> bool:
        """迁移演练只允许写入空目标，避免覆盖已有数据。"""

        return True


def _attachment_entry(name: Any, path: Any) -> dict[str, Any]:
    name = _check_attachment_name(name)
    file_path = Path(path)
    if not file_path.is_file():
        raise PackageError(f"附件 {name} 不存在：{file_path}")
    digest = hashlib.sha256()
    size = 0
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return {"name": name, "size": size, "sha256": digest.hexdigest()}


def _package_digest(package: Mapping[str, Any]) -> str:
    body = {key: value for key, value in package.items() if key != "integrity"}
    return _digest(body)


def build_package(
    adapters: Mapping[str, DomainAdapter],
    *,
    scope: Iterable[str] | None = None,
    created_at: datetime | None = None,
    attachments: Iterable[Mapping[str, Any]] = (),
    allow_incomplete: bool = False,
) -> dict[str, Any]:
    """按导出范围组合各领域快照；任何领域缺失都显式记录。"""

    selected = tuple(scope) if scope is not None else tuple(sorted(adapters))
    if not selected:
        raise PackageError("至少选择一个领域")
    if len(set(selected)) != len(selected):
        raise PackageError("导出范围包含重复领域")

    domains: dict[str, Any] = {}
    missing: list[dict[str, str]] = []
    for name in selected:
        adapter = adapters.get(name)
        if adapter is None:
            reason = "未注册领域适配器"
        else:
            try:
                exported = adapter.export_domain()
                payload = exported["payload"]
                if not isinstance(payload, dict):
                    raise PackageError("领域快照必须是对象")
            except Exception as exc:  # noqa: BLE001 — 统一转成显式缺失
                reason = f"导出失败：{exc}"
            else:
                domains[name] = {
                    "schemaVersion": str(exported["schemaVersion"]),
                    "consistencyVersion": str(exported["consistencyVersion"]),
                    "counts": dict(exported.get("counts") or {}),
                    "checksum": {"algorithm": "sha256", "value": _digest(payload)},
                    "payload": payload,
                }
                continue
        if not allow_incomplete:
            raise PackageError(f"领域 {name} 无法导出：{reason}")
        missing.append({"domain": name, "reason": reason})

    attachment_entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in attachments:
        name = _check_attachment_name(item.get("name"))
        if name in seen:
            raise PackageError(f"附件名重复：{name}")
        seen.add(name)
        attachment_entries.append(_attachment_entry(name, item.get("path")))

    package: dict[str, Any] = {
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "createdAt": _iso(created_at),
        "exportScope": {
            "domains": list(selected),
            "attachments": sorted(seen),
        },
        "domains": domains,
        "missing": missing,
        "complete": not missing,
        "attachments": attachment_entries,
    }
    package["integrity"] = {"algorithm": "sha256", "value": _package_digest(package)}
    return package


def validate_package(
    package: Any,
    *,
    adapters: Mapping[str, DomainAdapter] | None = None,
    attachments_dir: str | Path | None = None,
    require_complete: bool = False,
) -> dict[str, Any]:
    """校验格式、版本、完整性、领域 schema 与附件；返回规范化结果。"""

    if not isinstance(package, dict):
        raise PackageError("数据包必须是对象")
    if package.get("format") != FORMAT:
        raise PackageError("不是产品数据包")
    if package.get("formatVersion") != FORMAT_VERSION:
        raise PackageError(f"不支持的数据包格式版本：{package.get('formatVersion')}")
    scope = package.get("exportScope")
    if not isinstance(scope, dict) or not isinstance(scope.get("domains"), list):
        raise PackageError("数据包缺少导出范围")
    selected = scope["domains"]
    if not selected or len(set(selected)) != len(selected):
        raise PackageError("导出范围为空或包含重复领域")
    domains_raw = package.get("domains")
    if not isinstance(domains_raw, dict):
        raise PackageError("数据包缺少领域内容")
    extra = set(domains_raw) - set(selected)
    if extra:
        raise PackageError(f"数据包包含导出范围之外的领域：{', '.join(sorted(extra))}")
    missing = package.get("missing") or []
    if not isinstance(missing, list):
        raise PackageError("missing 必须是列表")
    missing_names = {item.get("domain") for item in missing if isinstance(item, dict)}
    if missing_names - set(selected):
        raise PackageError("missing 引用了导出范围之外的领域")
    if bool(package.get("complete")) != (not missing):
        raise PackageError("complete 与缺失领域不一致")
    if require_complete and missing:
        raise PackageError("数据包不完整，不能作为完整备份导入")

    integrity = package.get("integrity") or {}
    if integrity.get("algorithm") != "sha256" or not integrity.get("value"):
        raise PackageError("数据包缺少完整性校验值")
    if _package_digest(package) != integrity.get("value"):
        raise PackageIntegrityError("数据包完整性校验失败，文件可能已损坏或被修改")

    domains: dict[str, Any] = {}
    for name in selected:
        if name in missing_names:
            continue
        record = domains_raw.get(name)
        if not isinstance(record, dict):
            raise PackageError(f"领域 {name} 缺少内容，但未标记缺失")
        payload = record.get("payload")
        if not isinstance(payload, dict):
            raise PackageError(f"领域 {name} 的快照必须是对象")
        checksum = record.get("checksum") or {}
        if checksum.get("algorithm") != "sha256" or _digest(payload) != checksum.get("value"):
            raise PackageIntegrityError(f"领域 {name} 的内容校验失败")
        schema_version = str(record.get("schemaVersion") or "")
        if not schema_version:
            raise PackageError(f"领域 {name} 缺少 schema 版本")
        adapter = adapters.get(name) if adapters else None
        if adapter is not None and adapter.supported_schema_major is not None:
            if _major(schema_version) != adapter.supported_schema_major:
                raise PackageError(
                    f"领域 {name} 的 schema 版本 {schema_version} 不受支持"
                )
        domains[name] = {
            "schemaVersion": schema_version,
            "consistencyVersion": str(record.get("consistencyVersion") or ""),
            "counts": dict(record.get("counts") or {}),
            "payload": payload,
        }

    attachments = package.get("attachments") or []
    if not isinstance(attachments, list):
        raise PackageError("attachments 必须是列表")
    declared = [item.get("name") for item in attachments if isinstance(item, dict)]
    if declared != scope.get("attachments", declared):
        raise PackageError("附件清单与导出范围不一致")
    if len(set(declared)) != len(declared):
        raise PackageError("附件清单包含重复名称")
    missing_attachments: list[dict[str, str]] = []
    root = Path(attachments_dir) if attachments_dir is not None else None
    for item in attachments:
        if not isinstance(item, dict):
            raise PackageError("附件记录必须是对象")
        name = _check_attachment_name(item.get("name"))
        if root is None:
            continue
        path = root / name
        if not path.is_file():
            missing_attachments.append({"name": name, "reason": "missing"})
            continue
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        if size != item.get("size") or digest.hexdigest() != item.get("sha256"):
            raise PackageIntegrityError(f"附件 {name} 与清单校验值不一致")

    return {
        "package": package,
        "scope": list(selected),
        "domains": domains,
        "missing": missing,
        "missingAttachments": missing_attachments,
        "createdAt": package.get("createdAt"),
    }


def preview_package_import(
    package: Any,
    adapters: Mapping[str, DomainAdapter],
    *,
    attachments_dir: str | Path | None = None,
) -> dict[str, Any]:
    """逐域预览；不写入任何状态。"""

    validated = validate_package(
        package, adapters=adapters, attachments_dir=attachments_dir
    )
    results: dict[str, Any] = {}
    warnings: list[str] = []
    totals = {"new": 0, "duplicate": 0, "conflict": 0}
    for name in validated["scope"]:
        adapter = adapters.get(name)
        domain = validated["domains"].get(name)
        if domain is None:
            warnings.append(f"领域 {name} 在数据包中缺失，导入时跳过")
            results[name] = {"state": "missing"}
            continue
        if adapter is None:
            warnings.append(f"领域 {name} 没有可用适配器，导入时跳过")
            results[name] = {"state": "unavailable"}
            continue
        preview = adapter.preview(domain["payload"])
        counts = {key: int(preview.get("counts", {}).get(key) or 0) for key in totals}
        for key in totals:
            totals[key] += counts[key]
        results[name] = {
            "state": "ready",
            "counts": counts,
            "expectedRevision": preview.get("expectedRevision"),
            "details": preview,
        }
    for item in validated["missingAttachments"]:
        warnings.append(f"缺少附件：{item['name']}")
    return {
        "domains": results,
        "totals": totals,
        "warnings": warnings,
        "missingAttachments": validated["missingAttachments"],
    }


class PackageJournal:
    """导入批次日志：记录每域提交进度，支撑幂等重试与故障隔离。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        with self._connection:
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS package_imports (
                    batch_id TEXT PRIMARY KEY,
                    package_digest TEXT NOT NULL,
                    state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    error TEXT,
                    result TEXT
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS package_import_domains (
                    batch_id TEXT NOT NULL,
                    domain TEXT NOT NULL,
                    state TEXT NOT NULL,
                    result TEXT,
                    error TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (batch_id, domain),
                    FOREIGN KEY (batch_id) REFERENCES package_imports(batch_id)
                        ON DELETE CASCADE
                )
                """
            )

    def close(self) -> None:
        self._connection.close()

    def get(self, batch_id: str) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT * FROM package_imports WHERE batch_id = ?", (batch_id,)
        ).fetchone()
        if row is None:
            return None
        domains = {}
        for item in self._connection.execute(
            "SELECT * FROM package_import_domains WHERE batch_id = ? ORDER BY domain",
            (batch_id,),
        ):
            domains[item["domain"]] = {
                "state": item["state"],
                "result": json.loads(item["result"]) if item["result"] else None,
                "error": item["error"],
            }
        return {
            "batchId": row["batch_id"],
            "packageDigest": row["package_digest"],
            "state": row["state"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "error": row["error"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "domains": domains,
        }

    def begin(self, batch_id: str, package_digest: str, at: str) -> None:
        existing = self.get(batch_id)
        if existing is not None:
            if existing["packageDigest"] != package_digest:
                raise BatchConflict("同一批次标识不能用于不同的数据包")
            if existing["state"] == "committed":
                return
            with self._connection:
                self._connection.execute(
                    "UPDATE package_imports SET state = 'in_progress', error = NULL, updated_at = ? WHERE batch_id = ?",
                    (at, batch_id),
                )
            return
        with self._connection:
            self._connection.execute(
                "INSERT INTO package_imports (batch_id, package_digest, state, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)",
                (batch_id, package_digest, at, at),
            )

    def mark_domain(
        self,
        batch_id: str,
        domain: str,
        state: str,
        *,
        result: Any = None,
        error: str | None = None,
        at: str,
    ) -> None:
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO package_import_domains (batch_id, domain, state, result, error, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(batch_id, domain) DO UPDATE SET
                    state = excluded.state,
                    result = excluded.result,
                    error = excluded.error,
                    updated_at = excluded.updated_at
                """,
                (
                    batch_id,
                    domain,
                    state,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error,
                    at,
                ),
            )

    def finish(
        self,
        batch_id: str,
        state: str,
        *,
        result: Any = None,
        error: str | None = None,
        at: str,
    ) -> None:
        with self._connection:
            self._connection.execute(
                "UPDATE package_imports SET state = ?, result = ?, error = ?, updated_at = ? WHERE batch_id = ?",
                (
                    state,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error,
                    at,
                    batch_id,
                ),
            )

    def incomplete(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT batch_id, state, error, updated_at FROM package_imports "
            "WHERE state != 'committed' ORDER BY created_at"
        )
        return [dict(row) for row in rows]


def commit_package_import(
    package: Any,
    adapters: Mapping[str, DomainAdapter],
    journal: PackageJournal,
    *,
    batch_id: str,
    resolutions: Mapping[str, Any] | None = None,
    expected_revisions: Mapping[str, str] | None = None,
    attachments_dir: str | Path | None = None,
    allow_missing_attachments: bool = False,
    require_complete: bool = False,
    now: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    """暂存并逐域提交；同一批次只补做未完成领域。"""

    if not isinstance(batch_id, str) or BATCH_ID.fullmatch(batch_id) is None:
        raise PackageError("导入批次标识必须以 IMP_ 开头且长度足够")
    validated = validate_package(
        package,
        adapters=adapters,
        attachments_dir=attachments_dir,
        require_complete=require_complete,
    )
    if validated["missingAttachments"] and not allow_missing_attachments:
        names = "、".join(item["name"] for item in validated["missingAttachments"])
        raise PackageError(f"数据包缺少附件：{names}")

    clock = now or (lambda: datetime.now(timezone.utc))
    at = _iso(clock())
    digest = _digest(package)
    journal.begin(batch_id, digest, at)

    existing = journal.get(batch_id) or {}
    if existing.get("state") == "committed":
        return existing.get("result") or {}

    resolutions = dict(resolutions or {})
    expected_revisions = dict(expected_revisions or {})
    domains: dict[str, Any] = {}
    warnings: list[str] = []
    committed: list[str] = []

    for name in validated["scope"]:
        recorded = (existing.get("domains") or {}).get(name) or {}
        if recorded.get("state") == "committed" and recorded.get("result") is not None:
            domains[name] = {"state": "committed", "result": recorded["result"]}
            committed.append(name)
            continue
        domain = validated["domains"].get(name)
        if domain is None:
            domains[name] = {"state": "missing"}
            warnings.append(f"领域 {name} 在数据包中缺失，未导入")
            journal.mark_domain(batch_id, name, "missing", at=at)
            continue
        adapter = adapters.get(name)
        if adapter is None:
            domains[name] = {"state": "unavailable"}
            warnings.append(f"领域 {name} 没有可用适配器，未导入")
            journal.mark_domain(batch_id, name, "unavailable", at=at)
            continue
        try:
            result = adapter.commit(
                domain["payload"],
                batch_id=batch_id,
                resolutions=resolutions.get(name) or {},
                expected_revision=expected_revisions.get(name),
            )
        except Exception as exc:  # noqa: BLE001 — 逐域隔离，保留已完成进度
            journal.mark_domain(batch_id, name, "failed", error=str(exc), at=at)
            journal.finish(batch_id, "failed", error=str(exc), at=at)
            raise PackageImportError(
                batch_id, name, str(exc), committed=committed
            ) from exc
        journal.mark_domain(batch_id, name, "committed", result=result, at=at)
        domains[name] = {"state": "committed", "result": result}
        committed.append(name)

    verification: dict[str, Any] = {}
    verified = True
    for name in committed:
        adapter = adapters[name]
        try:
            check = adapter.verify(validated["domains"][name]["payload"])
        except Exception as exc:  # noqa: BLE001
            check = {"ok": False, "error": str(exc)}
        verification[name] = check
        if not check.get("ok"):
            verified = False

    gaps = [name for name, item in domains.items() if item["state"] != "committed"]
    if not verified:
        state = "verification_failed"
    elif gaps:
        state = "committed_with_gaps"
    else:
        state = "committed"
    if gaps:
        warnings.append("数据包未覆盖全部导出范围，未完成领域可在补齐后重试同一批次")

    receipt = {
        "batchId": batch_id,
        "state": state,
        "packageDigest": digest,
        "createdAt": existing.get("createdAt") or at,
        "updatedAt": at,
        "domains": domains,
        "verification": verification,
        "warnings": warnings,
    }
    journal.finish(
        batch_id,
        state,
        result=receipt,
        error=None if state == "committed" else "关联核对未通过" if not verified else "存在未导入领域",
        at=at,
    )
    return receipt


def default_journal_path() -> Path:
    """批次日志与业务数据同根；可用 ``DSH_PRODUCT_PACKAGE_JOURNAL`` 覆盖。"""

    import os

    explicit = os.getenv("DSH_PRODUCT_PACKAGE_JOURNAL", "").strip()
    if explicit:
        return Path(explicit)
    from .config import settings

    return Path(settings.data_dir) / "_product_package" / "journal.sqlite3"


def register_product_package_routes(
    app: Any,
    adapters: Mapping[str, DomainAdapter],
    journal_path: str | Path,
    *,
    token: str | None = None,
    attachments_dir: str | Path | None = None,
) -> None:
    """注册跨领域数据包端点；批次日志按请求短连接打开，跨线程安全。"""

    import hmac
    import os

    from fastapi import Header, HTTPException, Query

    expected_token = token if token is not None else os.getenv("DSH_PRODUCT_PACKAGE_TOKEN")

    def authorize(authorization: str | None) -> None:
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not expected_token or not hmac.compare_digest(supplied, expected_token):
            raise HTTPException(status_code=401, detail="数据包端点需要 Host 授权")

    def invoke(operation: Any) -> Any:
        journal = PackageJournal(journal_path)
        try:
            return operation(journal)
        except BatchConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except PackageImportError as exc:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": str(exc),
                    "batchId": exc.batch_id,
                    "domain": exc.domain,
                    "committed": list(exc.committed),
                },
            ) from exc
        except PackageError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        finally:
            journal.close()

    @app.get("/product-data/package")
    def product_package_export(
        domains: str | None = Query(default=None),
        authorization: str | None = Header(default=None),
    ) -> dict:
        authorize(authorization)
        scope = (
            [value.strip() for value in domains.split(",") if value.strip()]
            if domains
            else None
        )
        return invoke(lambda _journal: build_package(adapters, scope=scope))

    @app.post("/product-data/import/preview")
    def product_package_preview(
        payload: dict, authorization: str | None = Header(default=None)
    ) -> dict:
        authorize(authorization)
        return invoke(
            lambda _journal: preview_package_import(
                payload.get("package"),
                adapters,
                attachments_dir=attachments_dir,
            )
        )

    @app.post("/product-data/import")
    def product_package_commit(
        payload: dict, authorization: str | None = Header(default=None)
    ) -> dict:
        authorize(authorization)
        return invoke(
            lambda journal: commit_package_import(
                payload.get("package"),
                adapters,
                journal,
                batch_id=str(payload.get("batch_id") or ""),
                resolutions=payload.get("resolutions"),
                expected_revisions=payload.get("expected_revisions"),
                attachments_dir=attachments_dir,
                allow_missing_attachments=bool(
                    payload.get("allow_missing_attachments")
                ),
            )
        )

    @app.get("/product-data/imports/{batch_id}")
    def product_package_batch(
        batch_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        authorize(authorization)
        return invoke(
            lambda journal: journal.get(batch_id)
            or _raise_missing_batch(batch_id)
        )

    @app.get("/product-data/imports")
    def product_package_incomplete(
        authorization: str | None = Header(default=None),
    ) -> dict:
        authorize(authorization)
        return invoke(lambda journal: {"items": journal.incomplete()})


def _raise_missing_batch(batch_id: str) -> Any:  # pragma: no cover - 端点内抛错
    from fastapi import HTTPException

    raise HTTPException(status_code=404, detail=f"导入批次不存在：{batch_id}")


class ResearchPartnerDomain(DomainAdapter):
    """委托领域适配器；导入保持暂停/归档，批次幂等由领域自己保证。"""

    name = "research-partner"
    supported_schema_major = "1"

    def __init__(self, store: Any, *, principal_id: str, instance_id: str | None = None):
        self.store = store
        self.principal_id = principal_id
        self.instance_id = instance_id

    def export_domain(self) -> dict[str, Any]:
        from research_partner.transfer import export_snapshot

        snapshot = export_snapshot(
            self.store,
            principal_id=self.principal_id,
            instance_id=self.instance_id,
        )
        return {
            "payload": snapshot,
            "schemaVersion": str(snapshot["schema_version"]),
            "consistencyVersion": snapshot["integrity"]["value"],
            "counts": dict(snapshot["counts"]),
        }

    def preview(self, payload: dict[str, Any]) -> dict[str, Any]:
        from research_partner.transfer import preview_import

        preview = preview_import(
            self.store, payload, principal_id=self.principal_id
        )
        counts = preview["counts"]
        return {
            "counts": {
                "new": int(counts.get("import") or 0),
                "duplicate": int(counts.get("skip") or 0),
                "conflict": int(counts.get("conflict") or 0),
            },
            "details": preview,
        }

    def commit(
        self,
        payload: dict[str, Any],
        *,
        batch_id: str,
        resolutions: Mapping[str, Any],
        expected_revision: str | None = None,
    ) -> dict[str, Any]:
        from research_partner.transfer import commit_import

        result = commit_import(
            self.store,
            payload,
            principal_id=self.principal_id,
            instance_id=self.instance_id or "local-instance",
            batch_id=batch_id,
            resolutions=dict(resolutions),
        )
        return {
            "status": "replayed" if result.get("replayed") else "applied",
            "counts": dict(result.get("counts") or {}),
            "warnings": list(result.get("warnings") or []),
        }

    def is_empty(self) -> bool:
        page, _cursor = self.store.list_mandates(
            self.principal_id, instance_id=self.instance_id, limit=1
        )
        return not page

    def verify(self, payload: dict[str, Any]) -> dict[str, Any]:
        from research_partner.transfer import validate_snapshot

        entries = validate_snapshot(payload)
        missing = [
            entry["mandate"].mandate_id
            for entry in entries
            if self.store.get_mandate_internal(entry["mandate"].mandate_id) is None
        ]
        return {
            "ok": not missing,
            "counts": {"mandates": len(entries), "missing": len(missing)},
            "missing": missing,
        }


class TradingCoreDomain(DomainAdapter):
    """投资记录领域适配器；复用既有预览/暂存/提交/完成四段式事务。"""

    name = "trading-core"

    def __init__(
        self,
        store_factory: Callable[[], Any],
        *,
        notification_repository: Any = None,
    ) -> None:
        self.store_factory = store_factory
        self.notification_repository = notification_repository

    def export_domain(self) -> dict[str, Any]:
        from .data_transfer import CATEGORY_COLLECTIONS, export_snapshot

        snapshot = export_snapshot(
            self.store_factory(),
            list(CATEGORY_COLLECTIONS),
            self.notification_repository,
        )
        return {
            "payload": snapshot,
            "schemaVersion": str(snapshot["schemaVersion"]),
            "consistencyVersion": snapshot["revision"],
            "counts": {
                category: int(item.get("count") or 0)
                for category, item in snapshot["categories"].items()
            },
        }

    def preview(self, payload: dict[str, Any]) -> dict[str, Any]:
        from .data_transfer import preview_import

        preview = preview_import(
            self.store_factory(), payload, notification_repository=self.notification_repository
        )
        added = sum(int(item["added"]) for item in preview["categories"].values())
        conflicts = sum(int(item["conflicts"]) for item in preview["categories"].values())
        return {
            "counts": {"new": added, "duplicate": 0, "conflict": conflicts},
            "expectedRevision": preview["currentRevision"],
            "details": preview,
        }

    def _transaction_id(self, batch_id: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"product-package:{batch_id}:trading-core"))

    def commit(
        self,
        payload: dict[str, Any],
        *,
        batch_id: str,
        resolutions: Mapping[str, Any],
        expected_revision: str | None = None,
    ) -> dict[str, Any]:
        from .data_transfer import (
            commit_import,
            finalize_import,
            prepare_import,
            preview_import,
        )

        store = self.store_factory()
        transaction_id = self._transaction_id(batch_id)
        revision = expected_revision or preview_import(
            store, payload, notification_repository=self.notification_repository
        )["currentRevision"]
        prepared = prepare_import(
            store,
            transaction_id,
            payload,
            revision,
            dict(resolutions),
            self.notification_repository,
        )
        applied = commit_import(store, transaction_id, self.notification_repository)
        finalize_import(store, transaction_id)
        return {
            "status": applied["status"],
            "categories": applied["categories"],
            "prepared": prepared["status"],
        }

    def is_empty(self) -> bool:
        from .data_transfer import CATEGORY_COLLECTIONS

        store = self.store_factory()
        if any(
            store.all(collection)
            for collections in CATEGORY_COLLECTIONS.values()
            for collection in collections
            if collection != "notification_center"
        ):
            return False
        if self.notification_repository is not None:
            portable = self.notification_repository.export_portable()
            if any(portable["tables"].values()):
                return False
        return True

    def verify(self, payload: dict[str, Any]) -> dict[str, Any]:
        from .data_transfer import export_snapshot

        snapshot = export_snapshot(
            self.store_factory(), list(payload.get("categories") or {}), self.notification_repository
        )
        return {
            "ok": bool(snapshot.get("revision")),
            "counts": {
                category: int(item.get("count") or 0)
                for category, item in snapshot["categories"].items()
            },
        }
