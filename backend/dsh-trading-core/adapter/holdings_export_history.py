"""接收同实例 Host 的持久校验回执；不接受请求方提供的路径或成功文案。"""

from __future__ import annotations

import json
import os
import re
import stat
import uuid
from pathlib import Path

from . import holdings_mutation_history as audit
from .public_holdings_operations import _timestamp


class ExportReceiptError(ValueError):
    """无路径、无私密内容的调用方安全错误。"""


def validate_record(record: dict) -> None:
    """校验 WAL 中最小且固定的已验证事件，不从导出事件写任何业务字段。"""
    if (not isinstance(record, dict) or set(record) != {
            "schemaVersion", "transactionId", "kind", "startedAt", "observedAt", "confirmation", "reason", "size", "sha256"}
            or record.get("schemaVersion") != 1 or record.get("kind") != "export"
            or record.get("confirmation") != "host_verified_archive"
            or record.get("reason") not in {"manual", "pre-import", "pre-reset"}
            or type(record.get("size")) is not int or not 1 <= record["size"] <= 64 * 1024 * 1024
            or not isinstance(record.get("sha256"), str) or re.fullmatch(r"[0-9a-f]{64}", record["sha256"]) is None
            or not isinstance(record.get("transactionId"), str)
            or str(uuid.UUID(record["transactionId"], version=4)) != record["transactionId"]
            or _timestamp(record.get("startedAt")) > _timestamp(record.get("observedAt"))):
        raise ExportReceiptError("备份留痕回执无效")


def record_completed_export(store, payload: dict) -> dict:
    """在账户根锁内确认持久不可变归档及索引，成功后 Host 才能删除回执。"""
    try:
        identity = payload.get("operation_id")
        if set(payload) != {"operation_id"} or not isinstance(identity, str) or str(uuid.UUID(identity, version=4)) != identity:
            raise ValueError()
        coordinator = os.getenv("DSH_DATA_TRANSFER_COORDINATOR_DIR")
        if not coordinator or not Path(coordinator).is_absolute():
            raise ValueError()
        directory = Path(coordinator) / "export-receipts"
        if directory.is_symlink():
            raise ValueError()
        path = directory / f"{identity}.json"
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= 16 * 1024:
            raise ValueError()
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, before.st_size):
                raise ValueError()
            content = stream.read(16 * 1024 + 1)
            after = os.fstat(stream.fileno())
            if len(content) != opened.st_size or (after.st_size, after.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns):
                raise ValueError()
        receipt = json.loads(content)
        categories = receipt.get("categories")
        if (receipt.get("schemaVersion") != 1 or receipt.get("operationId") != identity or receipt.get("phase") != "verified"
                or not isinstance(categories, list) or not categories or len(categories) > 6
                or any(not isinstance(category, str) for category in categories)
                or len(set(categories)) != len(categories) or "holdings" not in categories
                or not set(categories) <= {"holdings", "strategies", "watchlist", "research", "preferences", "notifications"}):
            raise ValueError()
        record = {"schemaVersion": 1, "transactionId": identity, "kind": "export",
                  "startedAt": receipt.get("startedAt"), "observedAt": receipt.get("verifiedAt"),
                  "confirmation": "host_verified_archive", "reason": receipt.get("reason"),
                  "size": receipt.get("size"), "sha256": receipt.get("sha256")}
        validate_record(record)
    except (ValueError, TypeError, AttributeError, OSError, RuntimeError) as exc:
        raise ExportReceiptError("备份留痕回执无效或尚未校验") from exc
    with store.transaction():
        audit.recover(store)
        path = store.base_dir / "_holdings_operation_history" / f"{identity}.json"
        if path.exists() or path.is_symlink():
            if path.is_symlink() or path.read_text(encoding="utf-8") != audit._encode(record):
                raise ExportReceiptError("备份留痕编号冲突，历史不能覆盖")
        intent = {"schemaVersion": 1, "collection": None, "record": record}
        audit.write_intent(store, intent)
        audit.complete(store, intent)
    return {"status": "recorded", "operation_id": identity}
