# -*- coding: utf-8 -*-
"""Tesseract 定位与报错翻译：装了的要被找到，没装的不许赖到客户端头上。

2026-09-18 真机：Windows 版 Tesseract 装好了但不在 PATH 里（安装器默认不写 PATH），
读持仓稳定失败，而且被包成「请确认客户端已登录且窗口未被遮挡」——用户照着这句去查
了一圈券商客户端和窗口状态，实际根因在 OCR 依赖。这里固定两件事：

  1. PATH 之外还要能探到常见安装目录，并把它指给 pytesseract；
  2. 探测不到时，报错必须指向 OCR，不能再提「窗口未被遮挡」。
"""

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from adapter.config import settings
from adapter.holdings_providers import _ocr
from adapter.holdings_providers import easytrader as easytrader_module
from adapter.holdings_providers.base import ProviderUnavailable
from adapter.holdings_providers.broker_profiles import resolve_profile
from adapter.holdings_providers.easytrader import EasyTraderProvider


class TesseractNotFoundError(Exception):
    """类名与 pytesseract 的异常一致——_ocr 按类名判断，测试不依赖真实库。"""


def fake_pytesseract():
    """替身：只要有一个可被赋值的 `pytesseract.tesseract_cmd`。"""
    module = types.ModuleType("pytesseract")
    module.pytesseract = types.SimpleNamespace(tesseract_cmd="tesseract")
    return module


def provider(account_mode="real"):
    """按平安档案构造 provider，并把客户端前置条件都桩成「就绪」。"""
    with patch.object(settings, "easytrader_broker", "pingan"):
        instance = EasyTraderProvider(account_mode=account_mode)
    instance._imported = True
    instance.profile = resolve_profile("pingan")
    instance._client_path = lambda: "C:/平安证券/同花顺版/xiadan.exe"
    instance._client_running = lambda: True
    return instance


class LocateTesseractTests(unittest.TestCase):
    """找到就用，找不到就返回 None——不在这里报错。"""

    def test_path_wins_over_install_dirs(self):
        """PATH 里已有的优先，用户自己的安装不被候选目录抢走。"""
        fake = fake_pytesseract()
        with patch.object(_ocr.shutil, "which", return_value="/custom/bin/tesseract"), \
                patch.object(_ocr, "candidate_dirs") as candidates, \
                patch.dict(sys.modules, {"pytesseract": fake}):
            found = _ocr.locate_tesseract()

        self.assertEqual(found, "/custom/bin/tesseract")
        self.assertEqual(fake.pytesseract.tesseract_cmd, "/custom/bin/tesseract")
        candidates.assert_not_called()

    def test_falls_back_to_known_install_dir(self):
        """PATH 没有时按候选目录探测——Windows 安装器的默认落点在这里兜住。"""
        fake = fake_pytesseract()
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / _ocr._EXE_NAME
            binary.write_text("", encoding="utf-8")
            with patch.object(_ocr.shutil, "which", return_value=None), \
                    patch.object(_ocr, "candidate_dirs", return_value=[Path(folder)]), \
                    patch.dict(sys.modules, {"pytesseract": fake}):
                found = _ocr.locate_tesseract()

        self.assertEqual(found, str(binary))
        self.assertEqual(fake.pytesseract.tesseract_cmd, str(binary))

    def test_returns_none_when_nothing_found(self):
        with patch.object(_ocr.shutil, "which", return_value=None), \
                patch.object(_ocr, "candidate_dirs", return_value=[]):
            self.assertIsNone(_ocr.locate_tesseract())

    def test_returns_none_when_pytesseract_missing(self):
        """easytrader 没装全时，别伪装成「tesseract 找到了」。"""
        with patch.object(_ocr.shutil, "which", return_value="/usr/bin/tesseract"), \
                patch.dict(sys.modules, {"pytesseract": None}):
            self.assertIsNone(_ocr.locate_tesseract())


class IsMissingTesseractTests(unittest.TestCase):
    """pytesseract 是「先 FileNotFoundError 再包一层」，只看最外层拿不到判据。"""

    def test_direct_error(self):
        self.assertTrue(_ocr.is_missing_tesseract(TesseractNotFoundError("nope")))

    def test_chained_error(self):
        """复刻真实链路：subprocess 的 FileNotFoundError 被 __context__ 串上来。"""
        try:
            try:
                raise FileNotFoundError(2, "系统找不到指定的文件。")
            except FileNotFoundError:
                raise TesseractNotFoundError(
                    "tesseract is not installed or it's not in your PATH."
                )
        except TesseractNotFoundError as exc:
            self.assertTrue(_ocr.is_missing_tesseract(exc))

    def test_unrelated_error_is_not_matched(self):
        self.assertFalse(_ocr.is_missing_tesseract(RuntimeError("连接超时")))
        self.assertFalse(_ocr.is_missing_tesseract(FileNotFoundError(2, "系统找不到指定的文件。")))


class MissingTesseractTranslationTests(unittest.TestCase):
    """OCR 缺失时不能再让用户去查券商客户端。"""

    def _read(self, instance, error):
        with patch.object(easytrader_module.sys, "platform", "win32"), \
                patch.object(easytrader_module._ocr, "locate_tesseract", lambda: None), \
                patch.object(instance, "_connect", side_effect=error):
            instance._read_with_navigation()

    def test_captcha_ocr_failure_points_at_ocr(self):
        instance = provider()
        with self.assertRaises(ProviderUnavailable) as caught:
            self._read(instance, TesseractNotFoundError(
                "tesseract is not installed or it's not in your PATH."
            ))

        self.assertEqual(caught.exception.code, "automation_required")
        self.assertIn("tesseract", str(caught.exception).lower())

    def test_ocr_failure_does_not_blame_the_window(self):
        """这句是本次修复的核心：旧文案把用户往「客户端没登录」上引。"""
        instance = provider()
        with self.assertRaises(ProviderUnavailable) as caught:
            self._read(instance, TesseractNotFoundError("tesseract is not installed"))

        self.assertNotIn("窗口未被遮挡", str(caught.exception))

    def test_other_failures_keep_the_window_hint(self):
        """别的失败仍然是窗口/登录问题，原文案不能丢。"""
        instance = provider()
        with self.assertRaises(ProviderUnavailable) as caught:
            self._read(instance, RuntimeError("连接超时"))

        self.assertNotEqual(caught.exception.code, "automation_required")
        self.assertIn("窗口未被遮挡", str(caught.exception))
        self.assertIn("平安证券", str(caught.exception))

    def test_read_resolves_tesseract_before_reading(self):
        """读取前必须先把 tesseract 指给 pytesseract，否则装了也白装。"""
        instance = provider()
        with patch.object(easytrader_module.sys, "platform", "win32"), \
                patch.object(easytrader_module._ocr, "locate_tesseract") as locate, \
                patch.object(instance, "_connect", side_effect=RuntimeError("boom")):
            with self.assertRaises(ProviderUnavailable):
                instance._read_with_navigation()

        locate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
