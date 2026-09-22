"""仅测试使用：真实公开投影与临时合成账户，不启动业务 lifespan。"""
import json
import os
from pathlib import Path
import socket
import signal
import tempfile

from fastapi import FastAPI
import uvicorn

from adapter.public_observatory import AccountSnapshotInput, record_account_snapshot, register_public_observatory_routes
from adapter.portfolio_performance import record_holdings_snapshot
from adapter.store import JsonStore
from adapter.schemas import TradeItem
from adapter.trades_store import apply_import as import_trades
from datetime import datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch
from adapter.data_transfer import export_snapshot, preview_import, prepare_import, prepare_reset, commit_import, rollback_import, finalize_import, register_data_transfer_routes
from adapter.holdings_operation_index import rebuild as rebuild_operation_index

with tempfile.TemporaryDirectory(prefix="observatory-http-fixture-") as temporary:
    store = JsonStore(Path(temporary))
    # 时钟是唯一替换边界：种子资料发生在公开许可起点之前。
    seed_clock = patch("adapter.holdings_mutation_history._now", return_value="2026-09-20T15:00:00+08:00")
    seed_clock.start()
    timestamp = datetime(2026, 9, 20, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    holdings = record_holdings_snapshot(store, [{"ticker": "600519", "quantity": 1, "cost_price": 100}], "manual", timestamp)
    snapshot = record_account_snapshot(store, AccountSnapshotInput(
        effective_at=timestamp, source="manual_calibration", initial_capital="100000.00",
        cash="102280.00", market_value="200.00", total_equity="102480.00",
        positions=[{"ticker": "600519", "name": "合成测试样本", "quantity": "1", "cost_price": "100",
                    "market_price": "200", "market_value": "200.00", "profit_loss": "100.00", "return_rate": "1"}],
        holdings_snapshot_id=holdings["snapshot_id"], price_as_of=timestamp,
        stale_reason="TEST-PRIVATE-ERROR /private/fixture",
    ))
    store.set("holdings", "manual_trades", [{
        "request_id": "TEST-PRIVATE-TRADE", "ticker": "600519", "side": "buy",
        "traded_at": "2026-09-20T10:00:00+08:00",
    }])
    seed_clock.stop()
    os.environ["DSH_PUBLIC_OBSERVATORY_WRITE_TOKEN"] = "test-only-unused-writer-token"
    os.environ["DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS"] = json.dumps([snapshot["snapshot_id"]])
    if os.environ.get("OBSERVATORY_TEST_OPERATIONS") == "1":
        coordinator = Path(os.environ.get("OBSERVATORY_TEST_EXPORT_COORDINATOR", str(Path(temporary) / "coordinator")))
        coordinator.mkdir(parents=True, exist_ok=True)
        os.environ["DSH_DATA_TRANSFER_COORDINATOR_DIR"] = str(coordinator)
        os.environ["DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE"] = "2026-09-21T00:00:00+08:00"
        with patch("adapter.holdings_mutation_history._now", return_value="2026-09-21T09:00:00+08:00"):
            record_holdings_snapshot(store, [{"ticker": "600519", "quantity": 3, "cost_price": 100}],
                                     "manual", datetime.fromisoformat("2026-09-21T09:00:00+08:00"))
        with patch("adapter.holdings_mutation_history._now", return_value="2026-09-21T09:05:00+08:00"):
            import_trades(store, incoming=[TradeItem(ticker="600519", name="TEST-PRIVATE-NAME", side="buy",
                          quantity=1, price=100, amount=100, account_mode="real",
                          traded_at="2026-09-20T10:00:00+08:00", trade_id="TEST-PRIVATE-TRADE")],
                          source="fixture", account_mode="real", root="TEST-PRIVATE-ROOT", fetched=1)
        for index, kind in enumerate(("import", "rollback", "reset"), start=1):
            identity = f"{index:08d}-1111-4111-8111-111111111111"
            with patch("adapter.data_transfer._operation_time", return_value=f"2026-09-21T{index + 9:02d}:00:00+08:00"):
                incoming = export_snapshot(store, ["holdings"])
                revision = preview_import(store, incoming)["currentRevision"]
                if kind == "import":
                    incoming["categories"]["holdings"]["collections"]["holdings"]["default"][0]["quantity"] = 2
                    prepare_import(store, identity, incoming, revision, {"holdings": "use_import"})
                else:
                    prepare_reset(store, identity, ["holdings"], revision)
                commit_import(store, identity)
                if kind == "rollback":
                    rollback_import(store, identity)
                else:
                    (coordinator / f"{identity}.json").write_text(json.dumps({
                        "schemaVersion": 1, "transactionId": identity, "phase": "committed", "targets": ["trading-core"],
                    }))
                finalize_import(store, identity)
        os.environ["DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS"] = "[]"
        for number in range(min(100, int(os.environ.get("OBSERVATORY_TEST_HISTORY_SIZE", "0")))):
            with patch("adapter.holdings_mutation_history._now", return_value=f"2026-09-21T12:10:00.{number:06d}+08:00"):
                store.set("trades", "entries", [{"private": "TEST-PRIVATE", "test_sequence": number}])
        if hasattr(signal, "SIGUSR2"):
            signal.signal(signal.SIGUSR2, lambda *_: os.environ.__setitem__("DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE", ""))
    if hasattr(signal, "SIGUSR1"):
        signal.signal(signal.SIGUSR1, (lambda *_: rebuild_operation_index(store)) if os.environ.get("OBSERVATORY_TEST_OPERATIONS") == "1" else lambda *_: os.environ.__setitem__(
            "DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS",
            json.dumps([snapshot["snapshot_id"]]) if os.environ["DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS"] == "[]" else "[]",
        ))
    app = FastAPI()
    register_public_observatory_routes(app, store_factory=lambda: store)
    if os.environ.get("OBSERVATORY_TEST_EXPORT_COORDINATOR"):
        register_data_transfer_routes(app, store_factory=lambda: store, token="fixture-private-export-token")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    print(json.dumps({"baseUrl": f"http://127.0.0.1:{listener.getsockname()[1]}",
                      "storePath": str(Path(temporary) / "holdings.json"),
                      "snapshotId": snapshot["snapshot_id"]}), flush=True)
    uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[listener])
