"""隔离临时数据与随机回环端口的持仓留痕 HTTP 验收，不启动业务 lifespan。"""

import json
import os
import socket
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import uvicorn
from fastapi import FastAPI

from adapter.data_transfer import register_data_transfer_routes, recover_incomplete_transactions
from adapter.public_observatory import register_public_observatory_routes
from adapter.store import JsonStore


def main():
    with tempfile.TemporaryDirectory(prefix="holdings-audit-http-") as directory:
        root = Path(directory)
        store = JsonStore(root / "data")
        coordinator = root / "coordinator"
        coordinator.mkdir()
        with patch.dict(os.environ, {
            "DSH_DATA_TRANSFER_COORDINATOR_DIR": str(coordinator),
            "DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS": "[]",
        }):
            store.set("holdings", "default", [{"ticker": "600519", "quantity": 100, "cost_price": 1500}])
            app = FastAPI()
            register_data_transfer_routes(app, lambda: store, token="isolated-http-test-token")
            register_public_observatory_routes(app, store_factory=lambda: store)
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(16)
                port = listener.getsockname()[1]
                server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
                thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
                thread.start()
                # 回环测试不能经过开发机器配置的外部 HTTP 代理。
                opener = build_opener(ProxyHandler({}))

                def request(path, payload=None, *, authenticated=True):
                    headers = {"Content-Type": "application/json"}
                    if authenticated:
                        headers["Authorization"] = "Bearer isolated-http-test-token"
                    body = None if payload is None else json.dumps(payload).encode()
                    try:
                        with opener.open(Request(f"http://127.0.0.1:{port}{path}", data=body, headers=headers), timeout=5) as response:
                            return response.status, json.load(response)
                    except HTTPError as error:
                        return error.code, json.load(error)

                try:
                    deadline = time.monotonic() + 5
                    while not server.started and time.monotonic() < deadline:
                        time.sleep(0.01)
                    assert server.started
                    identity = "55555555-5555-4555-8555-555555555555"
                    payload = {"transaction_id": identity}
                    assert request("/data-transfer/finalize", payload, authenticated=False)[0] == 401
                    status, snapshot = request("/data-transfer/export?categories=holdings")
                    assert status == 200
                    snapshot["categories"]["holdings"]["collections"]["holdings"]["default"][0]["quantity"] = 150
                    rules = {"holdings": "use_import"}
                    status, preview = request("/data-transfer/preview", {"snapshot": snapshot, "rules": rules})
                    assert status == 200
                    assert request("/data-transfer/prepare", {
                        **payload, "snapshot": snapshot, "expected_revision": preview["currentRevision"], "rules": rules,
                    })[0] == 200
                    assert request("/data-transfer/commit", payload)[0] == 200
                    assert request("/data-transfer/finalize", payload)[0] == 422
                    assert store.active_transfer_id() == identity
                    (coordinator / f"{identity}.json").write_text(json.dumps({
                        "schemaVersion": 1, "transactionId": identity, "phase": "committed", "targets": ["trading-core"],
                    }))
                    assert request("/data-transfer/finalize", payload)[0] == 200
                    archive_path = store.base_dir / "_holdings_operation_history" / f"{identity}.json"
                    original = archive_path.read_bytes()
                    archive = json.loads(original)
                    assert archive["before"]["holdings"]["default"][0]["quantity"] == 100
                    assert archive["after"]["holdings"]["default"][0]["quantity"] == 150
                    assert archive["confirmation"] == "host_committed"
                    status, public = request("/public/performance/v1/activities?as_of=2026-09-21", authenticated=False)
                    assert status == 200 and public["items"] == []
                    assert request(f"/_holdings_operation_history/{identity}.json", authenticated=False)[0] == 404
                    recover_incomplete_transactions(JsonStore(store.base_dir), str(coordinator))
                    assert archive_path.read_bytes() == original
                    assert store.get("holdings", "default")[0]["quantity"] == 150
                    print("passed: HTTP 鉴权、Host 决定门控、精确前后镜像、私有归档隔离、幂等恢复；仅临时合成账户。")
                finally:
                    server.should_exit = True
                    thread.join(timeout=5)
                    assert not thread.is_alive(), "HTTP 验收服务未退出"


if __name__ == "__main__":
    main()
