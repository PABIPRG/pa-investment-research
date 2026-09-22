"""从本地持仓传输归档投影已授权的操作；不公开文件、账户标识或自由文本。"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

ARCHIVE_NAME = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json")
SHANGHAI = ZoneInfo("Asia/Shanghai")


def _timestamp(value: object) -> datetime:
    if not isinstance(value, str) or len(value) > 64:
        raise RuntimeError("操作归档时间无效")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError("操作归档时间无效") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise RuntimeError("操作归档时间缺少时区")
    return result.astimezone(SHANGHAI)


def _number(value: object) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)) or len(str(value)) > 40:
        raise RuntimeError("操作归档数值无效")
    try:
        number = Decimal(str(value))
    except InvalidOperation as exc:
        raise RuntimeError("操作归档数值无效") from exc
    # 既有手工成交的加权成本以 float 保存，可能有 16 位尾数；保留事实而非拒绝整条记录。
    places = 20 if isinstance(value, float) else 8
    if not number.is_finite() or number <= 0 or number >= Decimal("1e16") or number.as_tuple().exponent < -places:
        raise RuntimeError("操作归档数值超限")
    return format(number.normalize(), "f")


def _positions(image: object, *, reset_empty: bool = False) -> dict | None:
    if not isinstance(image, dict) or not isinstance(image.get("holdings"), dict):
        raise RuntimeError("操作归档持仓无效")
    document = image["holdings"]
    if reset_empty and document == {}:
        return {}
    if "default" not in document:
        return None  # 旧资料未保存持仓字段，不推断为零持仓。
    raw = document["default"]
    if not isinstance(raw, list) or len(raw) > 1000:
        raise RuntimeError("操作归档持仓超限或无效")
    result = {}
    for item in raw:
        if not isinstance(item, dict):
            raise RuntimeError("操作归档持仓行无效")
        ticker = item.get("ticker")
        if not isinstance(ticker, str) or re.fullmatch(r"[0-9]{6}", ticker) is None or ticker in result:
            raise RuntimeError("操作归档证券代码无效或重复")
        result[ticker] = (_number(item.get("quantity")), _number(item.get("cost_price")))
    return result


def _position_changes(before: dict | None, after: dict | None) -> list | None:
    return None if before is None or after is None else [
        {"ticker": ticker, "before_quantity": before.get(ticker, ("0", None))[0],
         "after_quantity": after.get(ticker, ("0", None))[0],
         "before_cost_price": before.get(ticker, (None, None))[1],
         "after_cost_price": after.get(ticker, (None, None))[1]}
        for ticker in sorted(before.keys() | after.keys()) if before.get(ticker) != after.get(ticker)
    ]


def _project_mutation(record: dict, identity: str, started: datetime) -> dict:
    if record.get("confirmation") != "local_atomic_replace":
        raise RuntimeError("普通操作缺少落盘确认")
    observed = _timestamp(record.get("observedAt"))
    if observed < started:
        raise RuntimeError("普通操作时间顺序无效")
    changes = record.get("changes")
    allowed = {"default", "manual_trades", "snapshots", "history_start_override"} if record["kind"] == "holdings_update" else {"entries"}
    if not isinstance(changes, dict) or not changes or not set(changes) <= allowed:
        raise RuntimeError("普通操作差异无效")
    title = "持仓数据更新" if "default" in changes else "持仓历史记录更新"
    summary = "持仓资料已保存。数据调整不代表买卖成交、资金进出或投资盈亏；时间为记录时间。"
    for field in ("manual_trades", "entries"):
        if field not in changes:
            continue
        delta = changes[field]
        if not isinstance(delta, dict):
            raise RuntimeError("成交差异无效")
        title = "手工成交记录更新" if field == "manual_trades" else "成交记录更新"
        counts = "历史字段不完整，无法核对条数。"
        if delta.get("unclassified") is not True:
            if any(not isinstance(delta.get(key), list) or len(delta[key]) > 10000 for key in ("added", "removed")):
                raise RuntimeError("成交差异条数超限或无效")
            counts = f"新增 {len(delta['added'])} 条，移除 {len(delta['removed'])} 条。"
        summary = counts + "这是成交资料的记录变化，不表示此刻执行了交易或发生资金进出；时间为记录时间。"
    row = {
        "public_id": hashlib.blake2s(f"holdings-mutation:{identity}".encode(), digest_size=12).hexdigest(),
        "category": "operation", "status": "completed", "occurred_at": observed.isoformat(timespec="microseconds"),
        "title": f"完成 · {title}", "summary": summary, "related_snapshot_id": None,
    }
    if "default" in changes:
        delta = changes["default"]
        if not isinstance(delta, dict) or any(type(delta.get(key)) is not bool for key in ("beforePresent", "afterPresent")):
            raise RuntimeError("持仓差异无效")
        positions = [_positions({"holdings": {"default": delta.get(side)} if delta[f"{side}Present"] else {}})
                     for side in ("before", "after")]
        row["holdings_changes"] = _position_changes(*positions)
    return row


def _project(record: object, identity: str, since: datetime) -> dict | None:
    if not isinstance(record, dict) or record.get("schemaVersion") != 1 or record.get("transactionId") != identity:
        raise RuntimeError("操作归档身份无效")
    if record.get("kind") not in {"import", "reset", "holdings_update", "trades_update", "export"}:
        raise RuntimeError("操作归档类型无效")
    if record.get("startedAt") is None:
        return None  # 无法证明在批准起点之后开始的旧操作不自动公开。
    started = _timestamp(record["startedAt"])
    if started < since:
        return None
    if record["kind"] == "export":
        from .holdings_export_history import validate_record
        validate_record(record)
        action = {"manual": "持仓数据导出", "pre-import": "导入前持仓备份", "pre-reset": "重置前持仓备份"}[record["reason"]]
        return {
            "public_id": hashlib.blake2s(f"holdings-export:{identity}".encode(), digest_size=12).hexdigest(),
            "category": "operation", "status": "completed",
            "occurred_at": _timestamp(record["observedAt"]).isoformat(timespec="microseconds"),
            "title": f"完成 · {action}",
            "summary": "备份文件已生成并校验通过，不表示已下载至浏览器。持仓与资金未因本次导出改变；时间为文件校验时间。",
            "related_snapshot_id": None,
        }
    if record["kind"] in {"holdings_update", "trades_update"}:
        return _project_mutation(record, identity, started)
    completed = (record.get("terminalState"), record.get("confirmation")) == ("committed", "host_committed")
    rolled_back = (record.get("terminalState"), record.get("confirmation")) == ("rolled_back", "rolled_back")
    if not completed and not rolled_back:
        return None
    observed = _timestamp(record.get("observedAt"))
    terminal = _timestamp(record.get("committedAt" if completed else "rolledBackAt"))
    if not started <= terminal <= observed:
        raise RuntimeError("操作归档时间顺序无效")
    if rolled_back and record.get("before") != record.get("after"):
        raise RuntimeError("回滚归档前后不一致")
    before = _positions(record.get("before"))
    after = _positions(record.get("after"), reset_empty=completed and record["kind"] == "reset")
    changes = _position_changes(before, after)
    action = "导入" if record["kind"] == "import" else "重置"
    return {
        "public_id": hashlib.blake2s(f"holdings-transfer:{identity}".encode(), digest_size=12).hexdigest(),
        "category": "operation", "status": "completed" if completed else "failed",
        "occurred_at": observed.isoformat(timespec="seconds"),
        "title": f"{'完成' if completed else '已回滚'} · 持仓数据{action}",
        "summary": (f"持仓数据{action}已确认。" if completed else f"持仓数据{action}已回滚，本地持仓恢复至操作前。")
                   + "数据调整不代表买卖成交、资金进出或投资盈亏；时间为归档记录时间。",
        "related_snapshot_id": None, "holdings_changes": changes,
    }
