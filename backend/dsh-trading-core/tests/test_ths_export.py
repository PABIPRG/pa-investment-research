# -*- coding: utf-8 -*-
"""另存为流程里可以脱离真实客户端验证的那部分：对话框识别与文件读回。

对话框本身（Ctrl+S 之后弹什么）只能在真机上验，所以这里刻意只测纯函数——
它们决定的是「认不认得出这个框」和「认不出时是否中止」。这两件事出错在实盘上
的代价是点错按钮，因此测试里对「找不到就返回 None」要比对正常路径更严。
"""

import tempfile
import unittest
from pathlib import Path

from adapter.holdings_providers import _ths_export as export
from adapter.holdings_providers.base import ProviderUnavailable


class CaptchaDialogTests(unittest.TestCase):
    def test_detects_by_the_word_in_any_child(self):
        """风控框标题随版本变，但正文一定有「验证码」三个字。"""
        self.assertTrue(export.is_captcha_dialog(["请输入验证码", "确定", "取消"]))
        self.assertTrue(export.is_captcha_dialog(["检测到您正在拷贝数据，请输入验证码"]))

    def test_other_dialogs_are_not_mistaken_for_captcha(self):
        for texts in (["另存为", "保存", "取消"], [], ["确认要退出吗"]):
            with self.subTest(texts=texts):
                self.assertFalse(export.is_captcha_dialog(texts))


class SaveAsDialogTests(unittest.TestCase):
    def test_requires_both_dialog_class_and_title(self):
        self.assertTrue(export.is_save_as_dialog("#32770", "另存为"))
        # 同是 #32770 的别的框不能当另存为处理，否则会把路径填进无关输入框
        self.assertFalse(export.is_save_as_dialog("#32770", "系统提示"))
        self.assertFalse(export.is_save_as_dialog("Notepad", "另存为"))


class PickSaveButtonTests(unittest.TestCase):
    def test_finds_the_save_button(self):
        save, cancel = object(), object()
        picked = export.pick_save_button(
            [("Static", "文件名:", object()), ("Button", "保存(&S)", save),
             ("Button", "取消", cancel)]
        )
        self.assertIs(picked, save)

    def test_returns_none_when_absent_instead_of_guessing(self):
        """挑不到必须中止：盲点一个按钮在实盘上可能确认掉别的对话框。"""
        self.assertIsNone(export.pick_save_button([("Button", "取消", object())]))
        self.assertIsNone(export.pick_save_button([]))
        # 「保存」只认按钮类，不能被同名的静态文本骗到
        self.assertIsNone(export.pick_save_button([("Static", "保存", object())]))


class PickFilenameEditTests(unittest.TestCase):
    def test_finds_the_first_visible_edit(self):
        hidden, visible = object(), object()
        picked = export.pick_filename_edit(
            [("Edit", False, hidden), ("Edit", True, visible)]
        )
        self.assertIs(picked, visible)

    def test_skips_hidden_edits(self):
        """不可见的 Edit 是历史路径下拉的残留，往里写会「看起来填了但没生效」。"""
        self.assertIsNone(export.pick_filename_edit([("Edit", False, object())]))
        self.assertIsNone(export.pick_filename_edit([]))


class ReadTabSeparatedTests(unittest.TestCase):
    def _write(self, folder: str, text: str, encoding: str = "gbk") -> Path:
        path = Path(folder) / "trades.xls"
        path.write_bytes(text.encode(encoding))
        return path

    def test_reads_gbk_tab_separated_export(self):
        """客户端存出来的是 GBK 制表符文本，不是真正的 xls 二进制。"""
        with tempfile.TemporaryDirectory() as folder:
            path = self._write(folder, "成交日期\t证券代码\t操作\n20260626\t159607\t买入\n")
            header, rows = export.read_tab_separated(path)
        self.assertEqual(header, ["成交日期", "证券代码", "操作"])
        self.assertEqual(rows, [["20260626", "159607", "买入"]])

    def test_blank_lines_are_dropped(self):
        """表尾空行是客户端常态，留着会被当成数据行判 partial_read。"""
        with tempfile.TemporaryDirectory() as folder:
            path = self._write(folder, "A\tB\n\n1\t2\n\n")
            _, rows = export.read_tab_separated(path)
        self.assertEqual(rows, [["1", "2"]])

    def test_missing_or_empty_file_is_read_failed(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = Path(folder) / "nope.xls"
            with self.assertRaises(ProviderUnavailable) as ctx:
                export.read_tab_separated(missing)
            self.assertEqual(ctx.exception.code, "read_failed")

            empty = self._write(folder, "")
            with self.assertRaises(ProviderUnavailable) as ctx:
                export.read_tab_separated(empty)
            self.assertEqual(ctx.exception.code, "read_failed")

    def test_header_only_file_yields_no_rows(self):
        """查不到数据时客户端仍会存出表头，交给上层判 EmptyTradesError。"""
        with tempfile.TemporaryDirectory() as folder:
            path = self._write(folder, "成交日期\t证券代码\n")
            header, rows = export.read_tab_separated(path)
        self.assertEqual(header, ["成交日期", "证券代码"])
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
