# -*- coding: utf-8 -*-
"""Packaged market-watch 必须把持久化写入移出只读源码树。"""

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


class StateDirectoryTests(unittest.TestCase):
    def test_packaged_runtime_writes_only_beneath_state_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            temp_root = Path(temporary)
            resources = temp_root / "只读 Resources"
            shutil.copytree(
                PACKAGE_ROOT / "market_watch",
                resources / "market_watch",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
            before = _source_digest(resources)
            for path in resources.rglob("*"):
                path.chmod(0o555 if path.is_dir() else 0o444)
            resources.chmod(0o555)

            state_root = temp_root / "可写 state root"
            work_dir = temp_root / "unrelated cwd"
            work_dir.mkdir()
            script = r'''
from pathlib import Path
from market_watch.config import settings
from market_watch.store import JsonStore

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
'''
            env = os.environ.copy()
            env.update({
                "DSH_INVESTMENT_STATE_DIR": str(state_root),
                "PYTHONPATH": str(resources),
                "PYTHONDONTWRITEBYTECODE": "1",
            })
            completed = subprocess.run(
                [str(PYTHON), "-c", script], cwd=work_dir, env=env,
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(_source_digest(resources), before)
            self.assertEqual(list(work_dir.iterdir()), [])
            self.assertTrue((state_root / "data" / "probe.json").is_file())

    def test_missing_state_root_preserves_source_default(self):
        env = os.environ.copy()
        env.pop("DSH_INVESTMENT_STATE_DIR", None)
        env.update({
            "PYTHONPATH": str(PACKAGE_ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        script = r'''
from pathlib import Path
from market_watch.config import settings
from market_watch.store import JsonStore
assert settings.state_root is None
assert JsonStore().base_dir == Path(settings.root) / "data"
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
            [str(PYTHON), "-c", "import market_watch.config"],
            env=env, capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("DSH_INVESTMENT_STATE_DIR", completed.stderr)


if __name__ == "__main__":
    unittest.main()
