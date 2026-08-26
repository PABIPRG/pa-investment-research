# -*- coding: utf-8 -*-
"""Packaged industry-chain 必须把种子数据写入宿主状态目录。"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path(sys.executable)


class StateDirectoryTests(unittest.TestCase):
    def test_packaged_runtime_uses_writable_state_seed_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            state_root = Path(temporary) / "可写 state root"
            env = os.environ.copy()
            env.update({
                "DSH_INVESTMENT_STATE_DIR": str(state_root),
                "IC_DATA_DIR": str(Path(temporary) / "must-not-win"),
                "PYTHONPATH": str(PACKAGE_ROOT),
                "PYTHONDONTWRITEBYTECODE": "1",
            })
            script = r'''
from industry_chain.config import settings
assert settings.state_root.is_absolute()
assert settings.data_dir == settings.state_root / "data" / "seed"
'''
            completed = subprocess.run(
                [str(PYTHON), "-c", script], env=env,
                capture_output=True, text=True, check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_source_mode_preserves_project_seed_default(self):
        env = os.environ.copy()
        env.pop("DSH_INVESTMENT_STATE_DIR", None)
        env.pop("IC_DATA_DIR", None)
        env.update({"PYTHONPATH": str(PACKAGE_ROOT), "PYTHONDONTWRITEBYTECODE": "1"})
        script = r'''
from industry_chain.config import settings
assert settings.state_root is None
assert settings.data_dir == settings.root / "data" / "seed"
'''
        completed = subprocess.run(
            [str(PYTHON), "-c", script], env=env,
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
            [str(PYTHON), "-c", "import industry_chain.config"], env=env,
            capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("DSH_INVESTMENT_STATE_DIR", completed.stderr)


if __name__ == "__main__":
    unittest.main()
