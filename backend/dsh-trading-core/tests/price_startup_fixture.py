"""测试专用 Uvicorn 入口：真实应用 / 生命周期 / 缓存，仅替换外部行情源。"""
import os
from datetime import datetime
from zoneinfo import ZoneInfo

if os.environ.get("ADAPTER_RUNNER") != "fake" or not os.environ.get("PRICE_FIXTURE_CONTROL_DIR"):
    raise RuntimeError("该入口仅用于隔离的本地回归")

from adapter import app as adapter_app, holdings_runner, portfolio_prices
from adapter.isolated_price_worker import IsolatedPriceWorker
from adapter.portfolio_performance import record_holdings_snapshot
from adapter.store import JsonStore
from unittest.mock import patch

mode = os.environ.get("PRICE_FIXTURE_WARM_MODE", "ready")
for owner, name, initializer, timeout in (
    (holdings_runner, "_bs_worker", "prepare_bs", 1.5),
    (portfolio_prices, "_http_worker", "prepare_http", 1.5),
    (portfolio_prices, "_sina_worker", "prepare_sina", 1.0),
):
    setattr(owner, name, IsolatedPriceWorker("tests.price_fixture_source", "prices", timeout=timeout,
                                           initializer=initializer, startup_timeout=45 if mode == "stalled" else 8))

store = JsonStore()
record_holdings_snapshot(store, [
    {"ticker": f"{number:06}", "quantity": number, "cost_price": 10} for number in range(1, 6)
], "manual", datetime(2026, 1, 5, tzinfo=ZoneInfo("Asia/Shanghai")))
register_routes = adapter_app.register_public_observatory_routes


def register_with_fixture_quotes(app, **kwargs):
    register_routes(app, quote_loader=lambda codes: {code: {"name": "合成测试证券"} for code in codes}, **kwargs)


with patch.object(adapter_app, "register_public_observatory_routes", side_effect=register_with_fixture_quotes):
    app = adapter_app.create_app()
