"""真实 spawn 测试源：只依赖标准库，绝不导入应用或访问行情网络。"""
import os
import time
from pathlib import Path


def _prepare(name):
    root = Path(os.environ["PRICE_FIXTURE_CONTROL_DIR"])
    (root / f"{name}.pid").write_text(str(os.getpid()))
    if os.environ.get("PRICE_FIXTURE_WARM_MODE") == "stalled":
        while True:
            time.sleep(0.05)


def prepare_bs():
    _prepare("bs")


def prepare_http():
    _prepare("http")


def prepare_sina():
    _prepare("sina")


def prices(ticker, start, end, *_):
    if (Path(os.environ["PRICE_FIXTURE_CONTROL_DIR"]) / "failure").exists():
        while True:
            time.sleep(0.05)
    number = int(ticker.split(".")[-1]) - 1
    return [{"date": day, "close": 10 + number + offset}
            for offset, day in enumerate(("2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"))
            if start <= day <= end]
