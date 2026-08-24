# -*- coding: utf-8 -*-
"""dsh-trading-core 配置的进程环境优先级契约。"""

import importlib.util
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def load_config_from_temporary_project(env_file: str):
    """将真实配置复制到临时项目，从受控环境加载它。"""
    temporary_project = tempfile.TemporaryDirectory()
    root = Path(temporary_project.name)
    package = root / "adapter"
    package.mkdir()
    shutil.copy2(PACKAGE_ROOT / "adapter" / "config.py", package / "config.py")
    (root / ".env").write_text(env_file, encoding="utf-8")

    module_name = f"trading_core_config_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, package / "config.py")
    if spec is None or spec.loader is None:
        temporary_project.cleanup()
        raise RuntimeError("无法加载临时 trading-core 配置模块")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, temporary_project


class ConfigPrecedenceTests(unittest.TestCase):
    def test_host_api_key_wins_over_project_dotenv_value(self):
        """防止 dotenv 覆盖 Profile 注入给子进程的凭据。"""
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "host-key"}, clear=True):
            config, temporary_project = load_config_from_temporary_project(
                "DEEPSEEK_API_KEY=dotenv-key\n"
            )
            self.addCleanup(temporary_project.cleanup)

            self.assertEqual(config.settings.deepseek_api_key, "host-key")


if __name__ == "__main__":
    unittest.main()
