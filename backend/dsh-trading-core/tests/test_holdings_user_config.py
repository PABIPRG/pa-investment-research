# -*- coding: utf-8 -*-
"""Tests for GET/PUT /holdings/user-config and config.py user-config loading."""

import os
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


class TestHoldingsUserConfigAPI(unittest.TestCase):
    """Integration tests against the FastAPI app for /holdings/user-config."""

    def setUp(self):
        from adapter.app import create_app

        self.app = create_app()
        self.client = TestClient(self.app)

    def test_get_returns_backend_env_and_effective(self):
        resp = self.client.get("/holdings/user-config")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("backend_env", body)
        self.assertIn("effective", body)
        self.assertIn("HOLDINGS_PROVIDER", body["effective"])
        self.assertIsInstance(body["backend_env"], dict)

    def test_put_writes_and_returns_restart_required(self):
        resp = self.client.put("/holdings/user-config", json={
            "entries": {"HOLDINGS_PROVIDER": "mac_ths"},
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["restart_required"])
        self.assertEqual(body["written"]["HOLDINGS_PROVIDER"], "mac_ths")

    def test_put_roundtrip(self):
        """After PUT, GET should reflect the written entry in backend_env."""
        self.client.put("/holdings/user-config", json={
            "entries": {"HOLDINGS_PROVIDER": "easytrader"},
        })
        resp = self.client.get("/holdings/user-config")
        body = resp.json()
        self.assertEqual(body["backend_env"].get("HOLDINGS_PROVIDER"), "easytrader")

    def test_put_rejects_invalid_key(self):
        resp = self.client.put("/holdings/user-config", json={
            "entries": {"123INVALID": "value"},
        })
        self.assertEqual(resp.status_code, 422)

    def test_put_rejects_empty_entries(self):
        resp = self.client.put("/holdings/user-config", json={"entries": {}})
        self.assertEqual(resp.status_code, 422)

    def test_put_writes_multiple_keys(self):
        resp = self.client.put("/holdings/user-config", json={
            "entries": {
                "HOLDINGS_PROVIDER": "qmt",
                "EASYTRADER_BROKER": "yh",
            },
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["written"]["HOLDINGS_PROVIDER"], "qmt")
        self.assertEqual(body["written"]["EASYTRADER_BROKER"], "yh")


class TestConfigUserConfigLoading(unittest.TestCase):
    """Test that config.py loads user-config/backend.env with override=False."""

    def test_user_config_file_is_read(self):
        """When DSH_INVESTMENT_STATE_DIR is set, user-config/backend.env is read.
        Use an env var that is NOT set in ROOT/.env to avoid precedence issues."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            user_config = state_dir / "user-config"
            user_config.mkdir()
            (user_config / "backend.env").write_text(
                "DSH_TEST_USER_CONFIG_VAR=from_backend_env\n", encoding="utf-8"
            )
            old_state = os.environ.get("DSH_INVESTMENT_STATE_DIR")
            old_var = os.environ.get("DSH_TEST_USER_CONFIG_VAR")
            os.environ["DSH_INVESTMENT_STATE_DIR"] = str(state_dir)
            try:
                import importlib
                from adapter import config as config_mod

                importlib.reload(config_mod)
                self.assertEqual(os.getenv("DSH_TEST_USER_CONFIG_VAR"), "from_backend_env")
            finally:
                if old_state is None:
                    os.environ.pop("DSH_INVESTMENT_STATE_DIR", None)
                else:
                    os.environ["DSH_INVESTMENT_STATE_DIR"] = old_state
                if old_var is None:
                    os.environ.pop("DSH_TEST_USER_CONFIG_VAR", None)
                else:
                    os.environ["DSH_TEST_USER_CONFIG_VAR"] = old_var

    def test_shell_env_takes_precedence(self):
        """Shell env var should not be overridden by backend.env (override=False)."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp)
            user_config = state_dir / "user-config"
            user_config.mkdir()
            (user_config / "backend.env").write_text(
                "DSH_TEST_SHELL_PRECEDENCE=from_backend_env\n", encoding="utf-8"
            )
            # Set shell env first
            os.environ["DSH_TEST_SHELL_PRECEDENCE"] = "from_shell"
            old_state = os.environ.get("DSH_INVESTMENT_STATE_DIR")
            os.environ["DSH_INVESTMENT_STATE_DIR"] = str(state_dir)
            try:
                import importlib
                from adapter import config as config_mod

                importlib.reload(config_mod)
                # Shell env should win
                self.assertEqual(os.getenv("DSH_TEST_SHELL_PRECEDENCE"), "from_shell")
            finally:
                if old_state is None:
                    os.environ.pop("DSH_INVESTMENT_STATE_DIR", None)
                else:
                    os.environ["DSH_INVESTMENT_STATE_DIR"] = old_state
                os.environ.pop("DSH_TEST_SHELL_PRECEDENCE", None)

    def test_non_absolute_state_dir_raises(self):
        """DSH_INVESTMENT_STATE_DIR must be an absolute path."""
        import importlib
        from adapter import config as config_mod

        # Save current state and set a relative path
        old_state = os.environ.get("DSH_INVESTMENT_STATE_DIR")
        os.environ["DSH_INVESTMENT_STATE_DIR"] = "relative/path"
        try:
            with self.assertRaises(ValueError):
                importlib.reload(config_mod)
        finally:
            # Restore so the module can be reloaded cleanly by other tests
            if old_state is None:
                os.environ.pop("DSH_INVESTMENT_STATE_DIR", None)
            else:
                os.environ["DSH_INVESTMENT_STATE_DIR"] = old_state
            importlib.reload(config_mod)


class TestHoldingsUserConfigRequestSchema(unittest.TestCase):
    """Test the Pydantic schema validation."""

    def test_valid_entries(self):
        from adapter.schemas import HoldingsUserConfigRequest

        req = HoldingsUserConfigRequest(entries={"HOLDINGS_PROVIDER": "mac_ths"})
        self.assertEqual(req.entries["HOLDINGS_PROVIDER"], "mac_ths")

    def test_invalid_key_rejected(self):
        from adapter.schemas import HoldingsUserConfigRequest
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            HoldingsUserConfigRequest(entries={"123BAD": "value"})

    def test_empty_entries_rejected(self):
        from adapter.schemas import HoldingsUserConfigRequest
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            HoldingsUserConfigRequest(entries={})

    def test_underscore_prefix_key_allowed(self):
        from adapter.schemas import HoldingsUserConfigRequest

        req = HoldingsUserConfigRequest(entries={"_PRIVATE_VAR": "value"})
        self.assertEqual(req.entries["_PRIVATE_VAR"], "value")


if __name__ == "__main__":
    unittest.main()
