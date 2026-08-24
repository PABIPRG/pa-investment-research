# -*- coding: utf-8 -*-
"""Packaged dsh-trading-core 必须把所有运行时写入移出只读源码树。"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path(sys.executable)


def _source_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _make_read_only(root: Path) -> None:
    for path in root.rglob("*"):
        path.chmod(0o555 if path.is_dir() else 0o444)
    root.chmod(0o555)


class StateDirectoryTests(unittest.TestCase):
    def test_packaged_runtime_writes_only_beneath_state_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            temp_root = Path(temporary)
            resources = temp_root / "只读 Resources"
            shutil.copytree(
                PACKAGE_ROOT,
                resources,
                ignore=shutil.ignore_patterns(
                    "env", ".env", "__pycache__", "*.pyc", ".pytest_cache",
                    "data", "logs", "results", "eval_results",
                ),
            )
            before = _source_digest(resources)
            _make_read_only(resources)

            state_root = temp_root / "可写 state root"
            work_dir = temp_root / "unrelated cwd"
            work_dir.mkdir()
            script = r'''
import logging
from pathlib import Path

from adapter.config import settings
from adapter.store import JsonStore
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.config.config_manager import config_manager
from tradingagents.graph.trading_graph import eval_results_directory
from tradingagents.dataflows.providers.hk.improved_hk import ImprovedHKStockProvider
from tradingagents.utils.logging_manager import setup_logging
from adapter.backtest_runner import backtest_eval_results_root

state = Path(settings.state_root)
assert state.is_absolute()
assert settings.data_dir == state / "data"
assert settings.cache_dir == state / "cache"
assert settings.logs_dir == state / "logs"
assert settings.state_dir == state / "state"
assert settings.user_config_dir == state / "user-config"

store = JsonStore()
store.set("probe", "ok", True)
assert store.base_dir == state / "data"

assert Path(DEFAULT_CONFIG["data_dir"]) == state / "data"
assert Path(DEFAULT_CONFIG["data_cache_dir"]) == state / "cache"
assert Path(DEFAULT_CONFIG["results_dir"]) == state / "state" / "results"
assert Path(config_manager.config_dir) == state / "user-config"
assert backtest_eval_results_root() == state / "state" / "eval_results"
assert eval_results_directory(DEFAULT_CONFIG, "000001") == (
    state / "state" / "eval_results" / "000001" / "TradingAgentsStrategy_logs"
)
hk_provider = ImprovedHKStockProvider()
assert Path(hk_provider.cache_file) == state / "cache" / "hk" / "hk_stock_cache.json"
hk_provider.cache = {"probe": True}
hk_provider._save_cache()

setup_logging()
logging.getLogger("state-dir-test").warning("probe")
for handler in logging.getLogger().handlers:
    handler.flush()
'''
            env = os.environ.copy()
            env.update({
                "DSH_INVESTMENT_STATE_DIR": str(state_root),
                "PYTHONPATH": str(resources),
                "PYTHONDONTWRITEBYTECODE": "1",
                "USE_MONGODB_STORAGE": "false",
            })
            completed = subprocess.run(
                [str(PYTHON), "-c", script],
                cwd=work_dir,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(_source_digest(resources), before)
            self.assertEqual(list(work_dir.iterdir()), [])
            self.assertTrue((state_root / "data" / "probe.json").is_file())
            self.assertTrue((state_root / "logs" / "tradingagents.log").is_file())
            self.assertTrue((state_root / "user-config" / "settings.json").is_file())

    def test_missing_state_root_preserves_source_defaults(self):
        env = os.environ.copy()
        env.pop("DSH_INVESTMENT_STATE_DIR", None)
        env.update({
            "PYTHONPATH": str(PACKAGE_ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        script = r'''
from pathlib import Path
from adapter.config import settings
from adapter.store import JsonStore
from tradingagents.default_config import DEFAULT_CONFIG

root = Path(settings.root)
assert settings.state_root is None
assert JsonStore().base_dir == root / "data" / "adapter"
assert Path(DEFAULT_CONFIG["data_dir"]) == root / "data"
assert Path(DEFAULT_CONFIG["data_cache_dir"]) == root / "tradingagents" / "dataflows" / "data_cache"
assert Path(DEFAULT_CONFIG["results_dir"]) == root / "results"
'''
        with tempfile.TemporaryDirectory() as cwd:
            completed = subprocess.run(
                [str(PYTHON), "-c", script], cwd=cwd, env=env,
                capture_output=True, text=True, check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_relative_state_root_is_rejected(self):
        env = os.environ.copy()
        env.update({
            "DSH_INVESTMENT_STATE_DIR": "relative-state",
            "PYTHONPATH": str(PACKAGE_ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        completed = subprocess.run(
            [str(PYTHON), "-c", "import adapter.config"],
            env=env, capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("DSH_INVESTMENT_STATE_DIR", completed.stderr)


if __name__ == "__main__":
    unittest.main()
