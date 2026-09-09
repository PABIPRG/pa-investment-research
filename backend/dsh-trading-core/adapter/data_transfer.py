# -*- coding: utf-8 -*-
"""可迁移投研数据的确定性快照、预览、增量合并与重置。"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from .store import JsonStore, JsonStoreTransferBusyError
from .schemas import HoldingItem


SCHEMA_VERSION = 2
SUPPORTED_SCHEMA_VERSIONS = {1, SCHEMA_VERSION}
LEGACY_CATEGORY_COLLECTIONS: dict[str, tuple[str, ...]] = {
    "strategies": (
        "strategies",
        "strategy_backtests",
        "shadows",
        "shadow_equity",
        "shadow_tasks",
        "shadow_task_results",
    ),
    "holdings": ("holdings",),
    "watchlist": ("watchlist",),
    "research": ("backtests", "decisions", "reports", "briefs", "research_chat_contexts"),
    "preferences": ("preferences", "behavior"),
}
CATEGORY_COLLECTIONS: dict[str, tuple[str, ...]] = {
    "strategies": (
        "strategies",
        "strategy_backtests",
        "shadows",
        "shadow_equity",
        "shadow_tasks",
        "shadow_task_results",
        "evolution_previews",
        "gene_archive",
        "events_ledger",
    ),
    "holdings": ("holdings",),
    "watchlist": ("watchlist",),
    "research": ("backtests", "decisions", "reports", "briefs", "research_chat_contexts"),
    "preferences": ("preferences", "behavior"),
}
DEFAULT_RULES = {
    "strategies": "keep_both",
    "holdings": "keep_local",
    "watchlist": "merge",
    "research": "keep_both",
    "preferences": "keep_local",
}
ALLOWED_RULES = {"keep_both", "keep_local", "use_import", "merge"}
TRANSACTION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
STRATEGY_REFERENCE_KEYS = {
    "id",
    "sid",
    "strategy_id",
    "strategyId",
    "parent",
    "parent_id",
    "source_strategy_id",
}


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


def _portable_document(collection: str, document: dict) -> dict:
    if collection in {"strategy_backtests", "shadow_tasks"}:
        return {
            key: _clone(value)
            for key, value in document.items()
            if not isinstance(value, dict)
            or value.get("status") not in {"pending", "running", "queued"}
        }
    if collection == "evolution_previews":
        portable: dict[str, Any] = {}
        runtime = document.get("_closed_loop_runtime")
        if isinstance(runtime, dict):
            portable["_closed_loop_runtime"] = {
                key: _clone(value)
                for key, value in runtime.items()
                if key in {"recent_run_at", "status", "action_count"}
            }
        for value in document.values():
            if not isinstance(value, dict) or value.get("preview_status") != "applied":
                continue
            audit = {
                key: _clone(item)
                for key, item in value.items()
                if not key.startswith("_")
                and key not in {"preview_token", "state_version", "expires_at", "valid"}
            }
            encoded = json.dumps(audit, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            key = f"audit-{hashlib.blake2s(encoded.encode('utf-8'), digest_size=16).hexdigest()}"
            portable[key] = audit
        return portable
    return _clone(document)


def _snapshot_documents(store: JsonStore, categories: Iterable[str]) -> dict[str, dict[str, dict]]:
    selected = _categories(categories)
    result: dict[str, dict[str, dict]] = {}
    with store.transaction():
        for category in selected:
            result[category] = {
                collection: _portable_document(collection, store.all(collection))
                for collection in CATEGORY_COLLECTIONS[category]
            }
    return result


def _revision_for_documents(documents: dict[str, dict[str, dict]]) -> str:
    encoded = json.dumps(documents, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def export_snapshot(store: JsonStore, categories: Iterable[str]) -> dict:
    """导出所选分类的可迁移领域快照，不包含缓存与凭据。"""
    documents = _snapshot_documents(store, categories)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "backend": "trading-core",
        "categories": {
            category: {
                "count": sum(
                    len(document.get("default"))
                    if isinstance(document.get("default"), list)
                    else len(document)
                    for document in collections.values()
                ),
                "collections": collections,
            }
            for category, collections in documents.items()
        },
        "revision": _revision_for_documents(documents),
    }


def _validate_snapshot(snapshot: Any) -> dict[str, dict[str, dict]]:
    if not isinstance(snapshot, dict):
        raise TransferValidationError("领域快照必须是对象")
    if snapshot.get("backend") != "trading-core":
        raise TransferValidationError("领域快照不属于 trading-core")
    schema_version = snapshot.get("schemaVersion")
    if schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        raise TransferValidationError("不支持的 trading-core 快照版本")
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
        collection_contract = (
            LEGACY_CATEGORY_COLLECTIONS if schema_version == 1 else CATEGORY_COLLECTIONS
        )
        expected = set(collection_contract[category])
        unknown = set(collections) - expected
        if unknown:
            raise TransferValidationError(f"{category} 包含未授权集合: {', '.join(sorted(unknown))}")
        for name, document in collections.items():
            if not isinstance(document, dict):
                raise TransferValidationError(f"集合 {name} 必须是对象")
        result[category] = {name: _clone(document) for name, document in collections.items()}
    evolution_audit = result.get("strategies", {}).get("evolution_previews", {})
    for key, record in evolution_audit.items():
        if key == "_closed_loop_runtime":
            if not isinstance(record, dict) or set(record) - {"recent_run_at", "status", "action_count"}:
                raise TransferValidationError("自进化运行摘要格式无效")
            continue
        if (
            re.fullmatch(r"audit-[0-9a-f]{32}", key) is None
            or not isinstance(record, dict)
            or record.get("preview_status") != "applied"
            or any(field.startswith("_") or field in {"preview_token", "state_version", "expires_at", "valid"} for field in record)
        ):
            raise TransferValidationError("自进化审计记录格式无效")
    holdings = result.get("holdings", {}).get("holdings", {})
    if holdings:
        rows = holdings.get("default", [])
        if not isinstance(rows, list):
            raise TransferValidationError("持仓必须是列表")
        try:
            validated = [HoldingItem.model_validate(row).model_dump() for row in rows]
        except Exception as exc:  # noqa: BLE001 — Pydantic 细节不穿透传输边界
            raise TransferValidationError("持仓记录格式无效") from exc
        tickers = [row["ticker"] for row in validated]
        if len(tickers) != len(set(tickers)):
            raise TransferValidationError("持仓包含重复证券代码")
        override = holdings.get("history_start_override")
        if override is not None:
            required = {
                "effective_date",
                "original_effective_date",
                "source",
                "corrected_at",
            }
            if not isinstance(override, dict) or set(override) != required:
                raise TransferValidationError("持仓历史起点校正格式无效")
            try:
                date.fromisoformat(str(override["effective_date"]))
                date.fromisoformat(str(override["original_effective_date"]))
                corrected = datetime.fromisoformat(str(override["corrected_at"]))
            except (TypeError, ValueError) as exc:
                raise TransferValidationError("持仓历史起点校正格式无效") from exc
            if override.get("source") != "user_corrected" or corrected.tzinfo is None:
                raise TransferValidationError("持仓历史起点校正格式无效")
    watchlist = result.get("watchlist", {}).get("watchlist", {})
    if watchlist:
        rows = watchlist.get("default", [])
        if not isinstance(rows, list) or any(not isinstance(value, str) or not value for value in rows):
            raise TransferValidationError("自选记录格式无效")
    return result


def _rules(values: dict[str, str] | None, categories: Iterable[str]) -> dict[str, str]:
    result = {category: DEFAULT_RULES[category] for category in categories}
    if values is None:
        return result
    for category, rule in values.items():
        if category not in result:
            raise TransferValidationError(f"规则引用了未选择分类: {category}")
        if rule not in ALLOWED_RULES:
            raise TransferValidationError(f"不支持的冲突规则: {rule}")
        result[category] = rule
    return result


def _items_by_key(items: Any, key: str) -> dict[str, Any]:
    if not isinstance(items, list):
        return {}
    result: dict[str, Any] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        identity = item.get(key)
        if isinstance(identity, str) and identity:
            result[identity] = item
    return result


def _preview_category(category: str, local: dict[str, dict], incoming: dict[str, dict]) -> tuple[int, int]:
    if category == "holdings":
        local_items = _items_by_key(local.get("holdings", {}).get("default"), "ticker")
        incoming_items = _items_by_key(incoming.get("holdings", {}).get("default"), "ticker")
        return (
            sum(1 for key in incoming_items if key not in local_items),
            sum(1 for key, value in incoming_items.items() if key in local_items and local_items[key] != value),
        )
    if category == "watchlist":
        local_items = set(local.get("watchlist", {}).get("default") or [])
        incoming_items = set(incoming.get("watchlist", {}).get("default") or [])
        return len(incoming_items - local_items), 0
    added = 0
    conflicts = 0
    for collection, incoming_document in incoming.items():
        local_document = local.get(collection, {})
        added += sum(1 for key in incoming_document if key not in local_document)
        conflicts += sum(
            1 for key, value in incoming_document.items()
            if key in local_document and local_document[key] != value
        )
    return added, conflicts


def preview_import(
    store: JsonStore,
    snapshot: Any,
    rules: dict[str, str] | None = None,
) -> dict:
    """校验并预览增量导入，不写入任何当前数据。"""
    incoming = _validate_snapshot(snapshot)
    selected = tuple(incoming)
    local = _snapshot_documents(store, selected)
    resolved_rules = _rules(rules, selected)
    categories = {}
    for category in selected:
        added, conflicts = _preview_category(category, local[category], incoming[category])
        categories[category] = {
            "added": added,
            "conflicts": conflicts,
            "defaultRule": resolved_rules[category],
        }
    return {
        "currentRevision": _revision_for_documents(local),
        "categories": categories,
    }


def _next_imported_id(base: str, occupied: set[str]) -> str:
    candidate = f"{base}-imported"
    suffix = 2
    while candidate in occupied:
        candidate = f"{base}-imported-{suffix}"
        suffix += 1
    occupied.add(candidate)
    return candidate


def _remap_value(value: Any, mapping: dict[str, str], key: str | None = None) -> Any:
    if isinstance(value, list):
        return [_remap_value(item, mapping) for item in value]
    if isinstance(value, dict):
        return {
            item_key: _remap_value(item_value, mapping, item_key)
            for item_key, item_value in value.items()
        }
    if isinstance(value, str) and key in STRATEGY_REFERENCE_KEYS:
        return mapping.get(value, value)
    return value


def _remap_collection_key(key: str, mapping: dict[str, str]) -> str:
    if key in mapping:
        return mapping[key]
    parts = key.split(":")
    return ":".join(mapping.get(part, part) for part in parts)


def _merge_document(local: dict, incoming: dict, rule: str, suffix: str = "imported") -> dict:
    result = _clone(local)
    occupied = set(result)
    for key, value in incoming.items():
        if key not in result or result[key] == value:
            result[key] = _clone(value)
        elif rule == "use_import":
            result[key] = _clone(value)
        elif rule == "keep_both":
            candidate = f"{key}-{suffix}"
            index = 2
            while candidate in occupied:
                candidate = f"{key}-{suffix}-{index}"
                index += 1
            occupied.add(candidate)
            result[candidate] = _clone(value)
    return result


def _merge_holdings(local: dict, incoming: dict, rule: str) -> dict:
    result = _clone(local)
    local_rows = list(result.get("default") or [])
    by_ticker = _items_by_key(local_rows, "ticker")
    order = [row.get("ticker") for row in local_rows if isinstance(row, dict) and isinstance(row.get("ticker"), str)]
    for ticker, item in _items_by_key(incoming.get("default"), "ticker").items():
        if ticker not in by_ticker:
            order.append(ticker)
            by_ticker[ticker] = _clone(item)
        elif by_ticker[ticker] != item and rule == "use_import":
            by_ticker[ticker] = _clone(item)
    result["default"] = [by_ticker[ticker] for ticker in order]
    local_snapshots = [
        _clone(item)
        for item in (result.get("snapshots") or [])
        if isinstance(item, dict) and isinstance(item.get("snapshot_id"), str)
    ]
    imported_snapshots = [
        _clone(item)
        for item in (incoming.get("snapshots") or [])
        if isinstance(item, dict) and isinstance(item.get("snapshot_id"), str)
    ]
    by_snapshot_id = {item["snapshot_id"]: item for item in local_snapshots}
    remapped_ids: dict[str, str] = {}
    occupied = set(by_snapshot_id)
    prepared: list[dict] = []
    for item in imported_snapshots:
        snapshot_id = item["snapshot_id"]
        existing = by_snapshot_id.get(snapshot_id)
        if existing is not None and existing != item and rule in {"keep_both", "merge"}:
            canonical = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            candidate = hashlib.blake2s(canonical.encode("utf-8"), digest_size=16).hexdigest()
            salt = 2
            while candidate in occupied:
                candidate = hashlib.blake2s(
                    f"{canonical}:{salt}".encode("utf-8"), digest_size=16
                ).hexdigest()
                salt += 1
            remapped_ids[snapshot_id] = candidate
            item["snapshot_id"] = candidate
            occupied.add(candidate)
        prepared.append(item)
    for item in prepared:
        previous = item.get("previous_snapshot_id")
        if isinstance(previous, str) and previous in remapped_ids:
            item["previous_snapshot_id"] = remapped_ids[previous]
        snapshot_id = item["snapshot_id"]
        existing = by_snapshot_id.get(snapshot_id)
        if existing is None or existing == item or rule == "use_import":
            by_snapshot_id[snapshot_id] = item
        elif rule in {"keep_both", "merge"}:
            by_snapshot_id[snapshot_id] = item
    merged_snapshots = sorted(
        by_snapshot_id.values(),
        key=lambda item: (str(item.get("effective_at", "")), item["snapshot_id"]),
    )
    current_positions = [
        _clone(item) for item in result["default"] if isinstance(item, dict)
    ]
    comparable_current_positions = sorted(
        current_positions,
        key=lambda item: str(item.get("ticker", "")),
    )
    latest_positions = sorted(
        [
            _clone(item)
            for item in ((merged_snapshots[-1].get("positions") or []) if merged_snapshots else [])
            if isinstance(item, dict)
        ],
        key=lambda item: str(item.get("ticker", "")),
    )
    if rule != "use_import" and comparable_current_positions != latest_positions:
        effective_at = datetime.now().astimezone()
        if merged_snapshots:
            try:
                latest_at = datetime.fromisoformat(str(merged_snapshots[-1].get("effective_at", "")))
                if latest_at.tzinfo is None:
                    latest_at = latest_at.astimezone()
                if latest_at >= effective_at:
                    effective_at = latest_at + timedelta(seconds=1)
            except (TypeError, ValueError):
                pass
        timestamp = effective_at.isoformat(timespec="seconds")
        encoded = json.dumps(
            {"effective_at": timestamp, "positions": current_positions},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        merged_snapshots.append({
            "snapshot_id": hashlib.blake2s(encoded.encode("utf-8"), digest_size=16).hexdigest(),
            "effective_at": timestamp,
            "source": "bulk_import",
            "positions": current_positions,
            "previous_snapshot_id": (
                merged_snapshots[-1]["snapshot_id"] if merged_snapshots else None
            ),
        })
    result["snapshots"] = merged_snapshots
    imported_override = incoming.get("history_start_override")
    if rule == "use_import":
        if isinstance(imported_override, dict):
            result["history_start_override"] = _clone(imported_override)
        else:
            result.pop("history_start_override", None)
    elif (
        not local_snapshots
        and "history_start_override" not in result
        and isinstance(imported_override, dict)
    ):
        result["history_start_override"] = _clone(imported_override)
    return result


def _merge_watchlist(local: dict, incoming: dict, rule: str) -> dict:
    result = _clone(local)
    local_rows = [value for value in (result.get("default") or []) if isinstance(value, str)]
    incoming_rows = [value for value in (incoming.get("default") or []) if isinstance(value, str)]
    if rule == "use_import":
        result["default"] = list(dict.fromkeys(incoming_rows))
    elif rule == "keep_local":
        result["default"] = list(dict.fromkeys(local_rows))
    else:
        result["default"] = list(dict.fromkeys([*local_rows, *incoming_rows]))
    return result


def _merge_strategies(local: dict[str, dict], incoming: dict[str, dict], rule: str) -> dict[str, dict]:
    incoming_copy = _clone(incoming)
    local_strategies = local.get("strategies", {})
    imported_strategies = incoming_copy.get("strategies", {})
    mapping: dict[str, str] = {}
    occupied = set(local_strategies) | set(imported_strategies)
    if rule == "keep_both":
        for strategy_id, value in imported_strategies.items():
            if strategy_id in local_strategies and local_strategies[strategy_id] != value:
                mapping[strategy_id] = _next_imported_id(strategy_id, occupied)
    remapped: dict[str, dict] = {}
    for collection, document in incoming_copy.items():
        remapped[collection] = {
            _remap_collection_key(key, mapping): _remap_value(value, mapping)
            for key, value in document.items()
        }
    return {
        collection: _merge_document(local.get(collection, {}), document, rule)
        for collection, document in remapped.items()
    }


def _merged_documents(
    local: dict[str, dict[str, dict]],
    incoming: dict[str, dict[str, dict]],
    rules: dict[str, str],
) -> dict[str, dict]:
    writes: dict[str, dict] = {}
    for category, collections in incoming.items():
        rule = rules[category]
        if category == "strategies":
            writes.update(_merge_strategies(local[category], collections, rule))
            continue
        for collection, document in collections.items():
            current = local[category].get(collection, {})
            if category == "holdings":
                writes[collection] = _merge_holdings(current, document, rule)
            elif category == "watchlist":
                writes[collection] = _merge_watchlist(current, document, rule)
            else:
                writes[collection] = _merge_document(current, document, rule)
    return writes


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
    path = _transaction_path(store, transaction_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
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
    """校验版本并持久化精确前镜像与目标镜像，但暂不修改业务数据。"""
    transaction_id = _validate_transaction_id(transaction_id)
    incoming = _validate_snapshot(snapshot)
    selected = tuple(incoming)
    resolved_rules = _rules(rules, selected)
    with store.transaction(transaction_id):
        path = _transaction_path(store, transaction_id)
        if path.exists():
            transaction = _load_transaction(store, transaction_id)
            return {"status": transaction["state"], "categories": transaction["categories"]}
        local = _snapshot_documents(store, selected)
        if _revision_for_documents(local) != expected_revision:
            raise TransferRevisionConflict("当前数据已更新，请重新预览")
        writes = _merged_documents(local, incoming, resolved_rules)
        transaction = {
            "schemaVersion": 1,
            "transactionId": transaction_id,
            "kind": "import",
            "state": "prepared",
            "categories": list(selected),
            "before": _flatten_documents(local),
            "after": writes,
        }
        _write_transaction(store, transaction)
        store.reserve_transfer(transaction_id)
    return {"status": "prepared", "categories": list(selected)}


def prepare_reset(
    store: JsonStore,
    transaction_id: str,
    categories: Iterable[str],
    expected_revision: str,
) -> dict:
    """持久化重置事务；只准备所选可迁移集合，不触碰备份。"""
    transaction_id = _validate_transaction_id(transaction_id)
    selected = _categories(categories)
    with store.transaction(transaction_id):
        path = _transaction_path(store, transaction_id)
        if path.exists():
            transaction = _load_transaction(store, transaction_id)
            return {"status": transaction["state"], "categories": transaction["categories"]}
        local = _snapshot_documents(store, selected)
        if _revision_for_documents(local) != expected_revision:
            raise TransferRevisionConflict("当前数据已更新，请重新预览")
        after = {
            collection: {}
            for category in selected
            for collection in CATEGORY_COLLECTIONS[category]
        }
        transaction = {
            "schemaVersion": 1,
            "transactionId": transaction_id,
            "kind": "reset",
            "state": "prepared",
            "categories": list(selected),
            "before": _flatten_documents(local),
            "after": after,
        }
        _write_transaction(store, transaction)
        store.reserve_transfer(transaction_id)
    return {"status": "prepared", "categories": list(selected)}


def commit_import(store: JsonStore, transaction_id: str) -> dict:
    """幂等提交已准备事务；事务日志在 finalize 前始终保留精确前镜像。"""
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
    """幂等恢复事务准备时的精确前镜像，并解除写入预留。"""
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
    """完成已提交或已回滚事务并移除领域日志。"""
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
        return invoke(lambda: preview_import(
            store_factory(),
            payload["snapshot"],
            payload.get("rules"),
        ))

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
