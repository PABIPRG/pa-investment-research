# -*- coding: utf-8 -*-
"""market-watch 配置的进程环境优先级契约。"""

import importlib.util
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DIRECT_CONNECTION_DOMAINS = (
    "eastmoney.com",
    "push2.eastmoney.com",
    "82.push2.eastmoney.com",
)


def load_config_from_temporary_project(env_file: str):
    """将真实配置复制到临时项目，从受控环境加载它。"""
    temporary_project = tempfile.TemporaryDirectory()
    root = Path(temporary_project.name)
    package = root / "market_watch"
    package.mkdir()
    shutil.copy2(PACKAGE_ROOT / "market_watch" / "config.py", package / "config.py")
    (root / ".env").write_text(env_file, encoding="utf-8")

    module_name = f"market_watch_config_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, package / "config.py")
    if spec is None or spec.loader is None:
        temporary_project.cleanup()
        raise RuntimeError("无法加载临时 market-watch 配置模块")
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

    def test_missing_host_no_proxy_receives_market_direct_connection_defaults(self):
        """防止没有部署方 NO_PROXY 时行情请求意外走系统代理。"""
        with patch.dict(os.environ, clear=True):
            _, temporary_project = load_config_from_temporary_project(
                "DEEPSEEK_API_KEY=dotenv-key\n"
            )
            self.addCleanup(temporary_project.cleanup)

            no_proxy = os.environ["NO_PROXY"]
            for domain in DIRECT_CONNECTION_DOMAINS:
                self.assertIn(domain, no_proxy)

    def test_host_no_proxy_is_not_replaced_by_project_dotenv_value(self):
        """防止项目 .env 覆盖部署方明确配置的 NO_PROXY。"""
        with patch.dict(os.environ, {"NO_PROXY": "corp.internal"}, clear=True):
            _, temporary_project = load_config_from_temporary_project(
                "NO_PROXY=dotenv.internal\n"
            )
            self.addCleanup(temporary_project.cleanup)

            self.assertEqual(os.environ["NO_PROXY"], "corp.internal")


if __name__ == "__main__":
    unittest.main()
