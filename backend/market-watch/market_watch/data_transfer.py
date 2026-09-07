# -*- coding: utf-8 -*-
"""可迁移盯盘数据的确定性快照、预览、增量合并与重置。"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
from typing import Any, Iterable

from .store import JsonStore, JsonStoreTransferBusyError
from .schemas import AlertRule


SCHEMA_VERSION = 1
CATEGORY_COLLECTIONS = {"watchlist": ("watchlist", "alerts")}
ALERT_IDENTITY_FIELDS = (
    "name",
    "ticker",
    "enabled",
    "time_frame",
    "combine",
    "conditions",
    "cooldown_min",
    "daily_cap",
)
ALLOWED_RULES = {"keep_both", "keep_local", "use_import", "merge"}
TRANSACTION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


class TransferValidationError(ValueError):
    """备份领域快照不符合受支持的确定性契约。"""


class TransferRevisionConflict(RuntimeError):
    """预览后本地数据发生变化，调用方必须重新预览。"""


def _clone(value: Any) -> Any:
    return copy.deepcopy(value)


def _categories(values: Iterable[str]) -> tuple[str, ...]:
    selected = tuple(dict.fromkeys(values))
    if not selected:
        raise TransferValidationError("至少选择一个数据分类")
    unknown = [value for value in selected if value not in CATEGORY_COLLECTIONS]
    if unknown:
        raise TransferValidationError(f"不支持的数据分类: {', '.join(unknown)}")
    return selected


def _snapshot_documents(store: JsonStore, categories: Iterable[str]) -> dict[str, dict[str, dict]]:
    selected = _categories(categories)
    with store.transaction():
        return {
            category: {
                collection: _clone(store.all(collection))
                for collection in CATEGORY_COLLECTIONS[category]
            }
            for category in selected
        }


def _revision(documents: dict[str, dict[str, dict]]) -> str:
    encoded = json.dumps(documents, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def export_snapshot(store: JsonStore, categories: Iterable[str]) -> dict:
    documents = _snapshot_documents(store, categories)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "backend": "market-watch",
        "categories": {
            category: {
                "count": sum(len(document.get("default") or []) for document in collections.values()),
                "collections": collections,
            }
            for category, collections in documents.items()
        },
        "revision": _revision(documents),
    }


def _validate_snapshot(snapshot: Any) -> dict[str, dict[str, dict]]:
    if not isinstance(snapshot, dict):
        raise TransferValidationError("领域快照必须是对象")
    if snapshot.get("backend") != "market-watch":
        raise TransferValidationError("领域快照不属于 market-watch")
    if snapshot.get("schemaVersion") != SCHEMA_VERSION:
        raise TransferValidationError("不支持的 market-watch 快照版本")
    raw_categories = snapshot.get("categories")
    if not isinstance(raw_categories, dict) or not raw_categories:
        raise TransferValidationError("领域快照没有数据分类")
    selected = _categories(raw_categories.keys())
    result: dict[str, dict[str, dict]] = {}
    for category in selected:
        payload = raw_categories[category]
        if not isinstance(payload, dict) or not isinstance(payload.get("collections"), dict):
            raise TransferValidationError(f"{category} 分类缺少 collections")
        collections = payload["collections"]
        unknown = set(collections) - set(CATEGORY_COLLECTIONS[category])
        if unknown:
            raise TransferValidationError(f"{category} 包含未授权集合: {', '.join(sorted(unknown))}")
        if any(not isinstance(document, dict) for document in collections.values()):
            raise TransferValidationError("集合必须是对象")
        result[category] = {name: _clone(document) for name, document in collections.items()}
    watchlist = result["watchlist"].get("watchlist", {}).get("default", [])
    if not isinstance(watchlist, list) or any(
        not isinstance(row, dict)
        or not isinstance(row.get("code"), str)
        or len(row["code"]) != 6
        for row in watchlist
    ):
        raise TransferValidationError("自选记录格式无效")
    codes = [row["code"] for row in watchlist]
    if len(codes) != len(set(codes)):
        raise TransferValidationError("自选记录包含重复证券代码")
    alerts = result["watchlist"].get("alerts", {}).get("default", [])
    if not isinstance(alerts, list):
        raise TransferValidationError("预警记录格式无效")
    try:
        for alert in alerts:
            AlertRule.model_validate(alert)
    except Exception as exc:  # noqa: BLE001 — Pydantic 细节不穿透传输边界
        raise TransferValidationError("预警记录格式无效") from exc
    return result


def _watch_rows(document: dict) -> list[dict]:
    return [row for row in (document.get("default") or []) if isinstance(row, dict) and isinstance(row.get("code"), str)]


def _alert_identity(alert: dict) -> str:
    normalized = {
        "name": alert.get("name"),
        "ticker": alert.get("ticker"),
        "enabled": alert.get("enabled", True),
        "time_frame": alert.get("time_frame", "trading"),
        "combine": alert.get("combine", "or"),
        "conditions": alert.get("conditions") or [],
        "cooldown_min": alert.get("cooldown_min", 0),
        "daily_cap": alert.get("daily_cap", 0),
    }
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _alert_rows(document: dict) -> list[dict]:
    return [row for row in (document.get("default") or []) if isinstance(row, dict)]


def preview_import(store: JsonStore, snapshot: Any, rules: dict[str, str] | None = None) -> dict:
    incoming = _validate_snapshot(snapshot)
    rule = (rules or {}).get("watchlist", "merge")
    if rule not in ALLOWED_RULES:
        raise TransferValidationError(f"不支持的冲突规则: {rule}")
    local = _snapshot_documents(store, incoming.keys())
    local_watch = {row["code"]: row for row in _watch_rows(local["watchlist"].get("watchlist", {}))}
    incoming_watch = {row["code"]: row for row in _watch_rows(incoming["watchlist"].get("watchlist", {}))}
    local_alerts = {_alert_identity(row): row for row in _alert_rows(local["watchlist"].get("alerts", {}))}
    incoming_alerts = {_alert_identity(row): row for row in _alert_rows(incoming["watchlist"].get("alerts", {}))}
    return {
        "currentRevision": _revision(local),
        "categories": {
            "watchlist": {
                "added": len(set(incoming_watch) - set(local_watch)) + len(set(incoming_alerts) - set(local_alerts)),
                "conflicts": 0,
                "defaultRule": rule,
            },
        },
    }


def _merge_documents(local: dict[str, dict], incoming: dict[str, dict], rule: str) -> dict[str, dict]:
    if rule == "keep_local":
        return {name: _clone(local.get(name, {})) for name in CATEGORY_COLLECTIONS["watchlist"]}
    if rule == "use_import":
        return {name: _clone(incoming.get(name, {})) for name in CATEGORY_COLLECTIONS["watchlist"]}
    local_watch = _watch_rows(local.get("watchlist", {}))
    watch_by_code = {row["code"]: _clone(row) for row in local_watch}
    watch_order = [row["code"] for row in local_watch]
    for row in _watch_rows(incoming.get("watchlist", {})):
        if row["code"] in watch_by_code:
            continue
        watch_order.append(row["code"])
        watch_by_code[row["code"]] = _clone(row)

    local_alerts = _alert_rows(local.get("alerts", {}))
    alerts = [_clone(row) for row in local_alerts]
    identities = {_alert_identity(row) for row in local_alerts}
    for row in _alert_rows(incoming.get("alerts", {})):
        identity = _alert_identity(row)
        if identity in identities:
            continue
        identities.add(identity)
        alerts.append(_clone(row))

    watch_document = _clone(local.get("watchlist", {}))
    watch_document["default"] = [watch_by_code[code] for code in watch_order]
    alert_document = _clone(local.get("alerts", {}))
    alert_document["default"] = alerts
    return {"watchlist": watch_document, "alerts": alert_document}


def _write_with_rollback(store: JsonStore, writes: dict[str, dict]) -> None:
    before = {collection: store.all(collection) for collection in writes}
    written: list[str] = []
    try:
        for collection, document in writes.items():
            store.mutate_document(collection, lambda _current, value=_clone(document): value)
            written.append(collection)
    except Exception:
        for collection in reversed(written):
            store.mutate_document(collection, lambda _current, value=_clone(before[collection]): value)
        raise


def _validate_transaction_id(transaction_id: Any) -> str:
    if not isinstance(transaction_id, str) or TRANSACTION_ID.fullmatch(transaction_id) is None:
        raise TransferValidationError("事务 ID 无效")
    return transaction_id.lower()


def _transaction_path(store: JsonStore, transaction_id: str):
    return store.transfer_directory / f"{transaction_id}.json"


def _write_transaction(store: JsonStore, transaction: dict) -> None:
    store._write_path(  # noqa: SLF001 — 与 JsonStore 共享同一原子落盘原语
        _transaction_path(store, transaction["transactionId"]),
        json.dumps(transaction, ensure_ascii=False, indent=2),
    )


def _load_transaction(store: JsonStore, transaction_id: str) -> dict:
    try:
        value = json.loads(_transaction_path(store, transaction_id).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise TransferValidationError("数据事务不存在或已完成") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TransferValidationError("数据事务日志损坏") from exc
    if not isinstance(value, dict) or value.get("transactionId") != transaction_id:
        raise TransferValidationError("数据事务日志无效")
    return value


def _flatten_documents(documents: dict[str, dict[str, dict]]) -> dict[str, dict]:
    return {
        collection: _clone(document)
        for collections in documents.values()
        for collection, document in collections.items()
    }


def prepare_import(
    store: JsonStore,
    transaction_id: str,
    snapshot: Any,
    expected_revision: str,
    rules: dict[str, str] | None = None,
) -> dict:
    transaction_id = _validate_transaction_id(transaction_id)
    incoming = _validate_snapshot(snapshot)
    rule = (rules or {}).get("watchlist", "merge")
    if rule not in ALLOWED_RULES:
        raise TransferValidationError(f"不支持的冲突规则: {rule}")
    with store.transaction(transaction_id):
        path = _transaction_path(store, transaction_id)
        if path.exists():
            transaction = _load_transaction(store, transaction_id)
            return {"status": transaction["state"], "categories": transaction["categories"]}
        local = _snapshot_documents(store, incoming.keys())
        if _revision(local) != expected_revision:
            raise TransferRevisionConflict("当前数据已更新，请重新预览")
        transaction = {
            "schemaVersion": 1,
            "transactionId": transaction_id,
            "kind": "import",
            "state": "prepared",
            "categories": ["watchlist"],
            "before": _flatten_documents(local),
            "after": _merge_documents(local["watchlist"], incoming["watchlist"], rule),
        }
        _write_transaction(store, transaction)
        store.reserve_transfer(transaction_id)
    return {"status": "prepared", "categories": ["watchlist"]}


def prepare_reset(
    store: JsonStore,
    transaction_id: str,
    categories: Iterable[str],
    expected_revision: str,
) -> dict:
    transaction_id = _validate_transaction_id(transaction_id)
    selected = _categories(categories)
    with store.transaction(transaction_id):
        path = _transaction_path(store, transaction_id)
        if path.exists():
            transaction = _load_transaction(store, transaction_id)
            return {"status": transaction["state"], "categories": transaction["categories"]}
        local = _snapshot_documents(store, selected)
        if _revision(local) != expected_revision:
            raise TransferRevisionConflict("当前数据已更新，请重新预览")
        transaction = {
            "schemaVersion": 1,
            "transactionId": transaction_id,
            "kind": "reset",
            "state": "prepared",
            "categories": list(selected),
            "before": _flatten_documents(local),
            "after": {collection: {} for collection in CATEGORY_COLLECTIONS["watchlist"]},
        }
        _write_transaction(store, transaction)
        store.reserve_transfer(transaction_id)
    return {"status": "prepared", "categories": list(selected)}


def commit_import(store: JsonStore, transaction_id: str) -> dict:
    transaction_id = _validate_transaction_id(transaction_id)
    with store.transaction(transaction_id):
        transaction = _load_transaction(store, transaction_id)
        if transaction.get("state") == "committed":
            status = "reset" if transaction.get("kind") == "reset" else "applied"
            return {"status": status, "categories": transaction["categories"]}
        if transaction.get("state") != "prepared":
            raise TransferValidationError("数据事务不能提交")
        _write_with_rollback(store, transaction["after"])
        transaction["state"] = "committed"
        _write_transaction(store, transaction)
        status = "reset" if transaction.get("kind") == "reset" else "applied"
        return {"status": status, "categories": transaction["categories"]}


def rollback_import(store: JsonStore, transaction_id: str) -> dict:
    transaction_id = _validate_transaction_id(transaction_id)
    with store.transaction(transaction_id):
        if not _transaction_path(store, transaction_id).exists():
            store.release_transfer(transaction_id)
            return {"status": "missing", "categories": []}
        transaction = _load_transaction(store, transaction_id)
        if transaction.get("state") != "rolled_back":
            _write_with_rollback(store, transaction["before"])
            transaction["state"] = "rolled_back"
            _write_transaction(store, transaction)
        store.release_transfer(transaction_id)
        return {"status": "rolled_back", "categories": transaction["categories"]}


def finalize_import(store: JsonStore, transaction_id: str) -> dict:
    transaction_id = _validate_transaction_id(transaction_id)
    with store.transaction(transaction_id):
        if not _transaction_path(store, transaction_id).exists():
            store.release_transfer(transaction_id)
            return {"status": "finalized", "categories": []}
        transaction = _load_transaction(store, transaction_id)
        if transaction.get("state") not in {"committed", "rolled_back"}:
            raise TransferValidationError("尚未提交的数据事务不能完成")
        store.release_transfer(transaction_id)
        try:
            _transaction_path(store, transaction_id).unlink()
        except FileNotFoundError:
            pass
        return {"status": "finalized", "categories": transaction["categories"]}


def recover_incomplete_transactions(
    store: JsonStore,
    coordinator_directory: str | None = None,
) -> None:
    """后端启动时依据 Host 的持久提交决定完成或精确回滚未完成事务。"""
    if not store.transfer_directory.exists():
        return
    coordinator_root = coordinator_directory or os.getenv("DSH_DATA_TRANSFER_COORDINATOR_DIR")
    for path in sorted(store.transfer_directory.glob("*.json")):
        transaction_id = path.stem
        if TRANSACTION_ID.fullmatch(transaction_id) is None:
            continue
        committed = False
        if coordinator_root:
            try:
                coordinator = json.loads(
                    (Path(coordinator_root) / f"{transaction_id}.json").read_text(encoding="utf-8")
                )
                committed = isinstance(coordinator, dict) and coordinator.get("phase") == "committed"
            except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError):
                committed = False
        if committed:
            finalize_import(store, transaction_id)
        else:
            rollback_import(store, transaction_id)
            finalize_import(store, transaction_id)


def register_data_transfer_routes(
    app: Any,
    store_factory: Any = JsonStore,
    token: str | None = None,
) -> None:
    """把领域传输端点注册到 FastAPI；工厂注入使测试使用隔离数据目录。"""
    from fastapi import Header, HTTPException, Query

    expected_token = token if token is not None else os.getenv("DSH_DATA_TRANSFER_TOKEN")

    def authorize(authorization: str | None) -> None:
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not expected_token or not hmac.compare_digest(supplied, expected_token):
            raise HTTPException(status_code=401, detail="数据传输端点需要 Host 授权")

    def invoke(operation: Any) -> Any:
        try:
            return operation()
        except TransferRevisionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except JsonStoreTransferBusyError as exc:
            raise HTTPException(status_code=423, detail=str(exc)) from exc
        except (TransferValidationError, KeyError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/data-transfer/export")
    def transfer_export(
        categories: str = Query(..., min_length=1),
        authorization: str | None = Header(default=None),
    ) -> dict:
        authorize(authorization)
        selected = [value.strip() for value in categories.split(",") if value.strip()]
        return invoke(lambda: export_snapshot(store_factory(), selected))

    @app.post("/data-transfer/preview")
    def transfer_preview(payload: dict, authorization: str | None = Header(default=None)) -> dict:
        authorize(authorization)
        return invoke(lambda: preview_import(store_factory(), payload["snapshot"], payload.get("rules")))

    @app.post("/data-transfer/prepare")
    def transfer_prepare(payload: dict, authorization: str | None = Header(default=None)) -> dict:
        authorize(authorization)
        return invoke(lambda: prepare_import(
            store_factory(),
            payload["transaction_id"],
            payload["snapshot"],
            payload["expected_revision"],
            payload.get("rules"),
        ))

    @app.post("/data-transfer/reset")
    def transfer_reset(payload: dict, authorization: str | None = Header(default=None)) -> dict:
        authorize(authorization)
        return invoke(lambda: prepare_reset(
            store_factory(),
            payload["transaction_id"],
            payload["categories"],
            payload["expected_revision"],
        ))

    @app.post("/data-transfer/commit")
    def transfer_commit(payload: dict, authorization: str | None = Header(default=None)) -> dict:
        authorize(authorization)
        return invoke(lambda: commit_import(store_factory(), payload["transaction_id"]))

    @app.post("/data-transfer/rollback")
    def transfer_rollback(payload: dict, authorization: str | None = Header(default=None)) -> dict:
        authorize(authorization)
        return invoke(lambda: rollback_import(store_factory(), payload["transaction_id"]))

    @app.post("/data-transfer/finalize")
    def transfer_finalize(payload: dict, authorization: str | None = Header(default=None)) -> dict:
        authorize(authorization)
        return invoke(lambda: finalize_import(store_factory(), payload["transaction_id"]))
