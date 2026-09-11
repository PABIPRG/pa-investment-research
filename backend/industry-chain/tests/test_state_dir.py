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
from industry_chain import graph, merge, reports, universe
assert settings.state_root.is_absolute()
assert settings.data_root == settings.state_root / "data"
assert settings.data_dir == settings.state_root / "data" / "seed"
assert settings.reports_dir == settings.state_root / "data" / "reports"
assert reports.REPORTS_DIR == settings.reports_dir
assert merge.OVERLAY_PATH == settings.reports_dir / "overlay.json"
assert universe.UNIVERSE_PATH == settings.data_root / "a_share_universe.json"
assert graph.LLM_LINKS_PATH == settings.data_root / "a_share_llm_links.json"
merge.save_overlay({"000001": {"materials": [], "products": [], "related": [], "metrics": []}})
universe.UNIVERSE_PATH.write_text("[]", encoding="utf-8")
graph.LLM_LINKS_PATH.write_text('{"links": []}', encoding="utf-8")
(reports.REPORTS_DIR / "000001").mkdir(parents=True, exist_ok=True)
(reports.REPORTS_DIR / "000001" / "meta.json").write_text("[]", encoding="utf-8")
assert (settings.data_root / "reports" / "overlay.json").is_file()
assert (settings.data_root / "reports" / "000001" / "meta.json").is_file()
assert (settings.data_root / "a_share_universe.json").is_file()
assert (settings.data_root / "a_share_llm_links.json").is_file()
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
assert settings.data_root == settings.root / "data"
assert settings.data_dir == settings.root / "data" / "seed"
assert settings.reports_dir == settings.root / "data" / "reports"
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
