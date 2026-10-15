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


def load_config_from_temporary_project(env_file: str, user_env_file: str | None = None):
    """将真实配置复制到临时项目，从受控环境加载它。"""
    temporary_project = tempfile.TemporaryDirectory()
    root = Path(temporary_project.name)
    package = root / "adapter"
    package.mkdir()
    shutil.copy2(PACKAGE_ROOT / "adapter" / "config.py", package / "config.py")
    (root / ".env").write_text(env_file, encoding="utf-8")
    if user_env_file is not None:
        state_root = os.getenv("DSH_INVESTMENT_STATE_DIR")
        user_config_dir = Path(state_root) / "user-config" if state_root else root / "config"
        user_config_dir.mkdir(parents=True, exist_ok=True)
        (user_config_dir / "backend.env").write_text(user_env_file, encoding="utf-8")

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

    def test_closed_loop_flags_read_from_dotenv(self):
        with patch.dict(os.environ, {}, clear=True):
            config, temporary_project = load_config_from_temporary_project(
                "CLOSED_LOOP_ENABLED=true\n"
                "CLOSED_LOOP_TIME=16:00\n"
                "CANDIDATE_AUTO_REJECT=false\n"
            )
            self.addCleanup(temporary_project.cleanup)

            self.assertTrue(config.settings.closed_loop_enabled)
            self.assertEqual(config.settings.closed_loop_time, "16:00")
            self.assertFalse(config.settings.candidate_auto_reject)

    def test_closed_loop_defaults_on_without_env(self):
        with patch.dict(os.environ, {}, clear=True):
            config, temporary_project = load_config_from_temporary_project("")
            self.addCleanup(temporary_project.cleanup)

            self.assertTrue(config.settings.closed_loop_enabled)
            self.assertEqual(config.settings.closed_loop_time, "15:35")
            self.assertTrue(config.settings.candidate_auto_reject)

    def test_project_dotenv_can_explicitly_disable_closed_loop(self):
        with patch.dict(os.environ, {}, clear=True):
            config, temporary_project = load_config_from_temporary_project(
                "CLOSED_LOOP_ENABLED=false\n"
            )
            self.addCleanup(temporary_project.cleanup)
            self.assertFalse(config.settings.closed_loop_enabled)

    def test_user_closed_loop_setting_wins_over_project_dotenv(self):
        for user_value, project_value in (("false", "true"), ("true", "false")):
            with self.subTest(user_value=user_value), patch.dict(os.environ, {}, clear=True):
                config, temporary_project = load_config_from_temporary_project(
                    f"CLOSED_LOOP_ENABLED={project_value}\n",
                    f"CLOSED_LOOP_ENABLED={user_value}\n",
                )
                self.addCleanup(temporary_project.cleanup)
                self.assertEqual(config.settings.closed_loop_enabled, user_value == "true")

    def test_managed_state_config_can_disable_default_without_process_override(self):
        """容器/桌面 Host 使用持久化 state root，关闭值不会被默认开启覆盖。"""
        with tempfile.TemporaryDirectory() as state_root, patch.dict(
            os.environ, {"DSH_INVESTMENT_STATE_DIR": state_root}, clear=True
        ):
            config, temporary_project = load_config_from_temporary_project(
                "", "CLOSED_LOOP_ENABLED=false\n"
            )
            self.addCleanup(temporary_project.cleanup)
            self.assertFalse(config.settings.closed_loop_enabled)
            self.assertEqual(config.settings.user_config_dir, Path(state_root).resolve() / "user-config")

    def test_process_closed_loop_setting_wins_over_both_files(self):
        for process_value, file_value in (("false", "true"), ("true", "false")):
            with self.subTest(process_value=process_value), tempfile.TemporaryDirectory() as state_root, patch.dict(
                os.environ,
                {"DSH_INVESTMENT_STATE_DIR": state_root, "CLOSED_LOOP_ENABLED": process_value},
                clear=True,
            ):
                config, temporary_project = load_config_from_temporary_project(
                    f"CLOSED_LOOP_ENABLED={file_value}\n",
                    f"CLOSED_LOOP_ENABLED={file_value}\n",
                )
                self.addCleanup(temporary_project.cleanup)
                self.assertEqual(config.settings.closed_loop_enabled, process_value == "true")


if __name__ == "__main__":
    unittest.main()
