# -*- coding: utf-8 -*-
"""curl_cffi 证书路径修复的离线测试：只验证环境变量处理，不触网。"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from research_entities.toolbox import context


class CurlCaBundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cert = Path(self.temp.name) / "cacert.pem"
        self.cert.write_text("dummy", encoding="utf-8")
        patcher = mock.patch.object(context, "_CA_BUNDLE_INSTALLED", False)
        patcher.start()
        self.addCleanup(patcher.stop)
        clean_env = {
            key: value
            for key, value in os.environ.items()
            if key not in ("CURL_CA_BUNDLE", "SSL_CERT_FILE")
        }
        env_patcher = mock.patch.dict(os.environ, clean_env, clear=True)
        env_patcher.start()
        self.addCleanup(env_patcher.stop)

    def _patch_certifi(self, path: Path):
        module = mock.Mock()
        module.where.return_value = str(path)
        patcher = mock.patch.dict("sys.modules", {"certifi": module})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_non_windows_is_noop(self):
        self._patch_certifi(self.cert)
        with mock.patch.object(context.os, "name", "posix"):
            context.install_curl_ca_bundle()
        self.assertNotIn("CURL_CA_BUNDLE", os.environ)

    def test_ascii_cert_path_is_left_alone(self):
        self._patch_certifi(self.cert)
        with mock.patch.object(context.os, "name", "nt"):
            context.install_curl_ca_bundle()
        self.assertNotIn("CURL_CA_BUNDLE", os.environ)

    def test_non_ascii_cert_path_is_copied_to_ascii_directory(self):
        non_ascii = Path(self.temp.name) / "用户" / "cacert.pem"
        non_ascii.parent.mkdir()
        non_ascii.write_text("dummy", encoding="utf-8")
        self._patch_certifi(non_ascii)
        target = Path(self.temp.name) / "ascii"
        target.mkdir()
        destination = target / "investment-research-cacert.pem"
        with mock.patch.dict(
            os.environ, {"ProgramData": str(target)}, clear=True
        ), mock.patch.object(context.os, "name", "nt"):
            context.install_curl_ca_bundle()
            self.assertEqual(os.environ["CURL_CA_BUNDLE"], str(destination))
            self.assertEqual(os.environ["SSL_CERT_FILE"], str(destination))
        self.assertEqual(destination.read_text(encoding="utf-8"), "dummy")

    def test_existing_bundle_is_not_overridden(self):
        self._patch_certifi(self.cert)
        with mock.patch.dict(
            os.environ,
            {"CURL_CA_BUNDLE": r"C:\custom\bundle.pem", "ProgramData": self.temp.name},
            clear=True,
        ), mock.patch.object(context.os, "name", "nt"):
            context.install_curl_ca_bundle()
            self.assertEqual(os.environ["CURL_CA_BUNDLE"], r"C:\custom\bundle.pem")
            self.assertNotIn("SSL_CERT_FILE", os.environ)


if __name__ == "__main__":
    unittest.main()
