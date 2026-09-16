# -*- coding: utf-8 -*-
"""另存为流程里可以脱离真实客户端验证的那部分：对话框识别、点击时序与文件读回。

对话框本身（Ctrl+S 之后弹什么）只能在真机上验，所以识别类断言刻意只测纯函数——
它们决定的是「认不认得出这个框」和「认不出时是否中止」。这两件事出错在实盘上
的代价是点错按钮，因此测试里对「找不到就返回 None」要比对正常路径更严。

`ExportGridTests` 是例外：它拿替身拼出一次完整的另存为，验的是**动作顺序**。
2026-09-16 真机（平安同花顺版）就是这么坏的——点击本身没报错，只是没点到，
所以「填对了路径、找到了按钮、文件却没生成」这种失败只能靠顺序来防。
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


class _FakeControl:
    """最小的 pywinauto 控件替身：只实现 export_grid 真正用到的那几个方法。

    每个动作都往共享的 `order` 里记一笔，测试靠它断言先后顺序。
    """

    def __init__(self, class_name="", text="", *, order=None, on_click=None,
                 focus_raises=False, handle=1):
        self._class_name = class_name
        self._text = text
        self._order = order if order is not None else []
        self._on_click = on_click
        self._focus_raises = focus_raises
        self.handle = handle
        self.clicks = 0      # 坐标点击次数
        self.presses = 0     # 按下去的总次数（坐标点击 + BM_CLICK）

    def send_message(self, message):
        self._order.append(f"bm_click:{message}")
        self.presses += 1
        if self._on_click is not None:
            self._on_click()

    def class_name(self):
        return self._class_name

    def window_text(self):
        return self._text

    def control_id(self):
        return 0

    def is_visible(self):
        return True

    def descendants(self):
        return []

    def set_edit_text(self, value):
        self._text = value

    def set_focus(self):
        if self._focus_raises:
            raise RuntimeError("前台锁：SetForegroundWindow 被拒")
        self._order.append("focus")

    def click(self):
        self.clicks += 1
        self.presses += 1
        self._order.append("click")
        if self._on_click is not None:
            self._on_click()


class ExportGridTests(unittest.TestCase):
    """整轮另存为的动作顺序。

    真机暴露的坏法只有一种：**点击没点到**。文件没生成、对话框还开着，
    但代码里没有任何一步抛错——所以这里必须断言顺序，不能只断言结果。
    """

    def _run(self, *, save_after=1, focus_raises=False, reclick_after=100.0):
        """跑一轮 export_grid。

        `save_after` 表示第几次点击才真的写出文件——用来模拟「前几下点击落空」。
        """
        order: list[str] = []
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out_path = Path(tmp.name) / "trades.xls"
        clicks = {"n": 0}

        def on_click():
            clicks["n"] += 1
            if clicks["n"] >= save_after:
                out_path.write_bytes(b"client output")

        button = _FakeControl("Button", "保存(&S)", order=order, on_click=on_click)
        editor = _FakeControl("Edit", "", order=order, handle=2)
        dialog = _FakeControl(
            "#32770", "另存为", order=order, focus_raises=focus_raises, handle=3
        )
        dialog.descendants = lambda: [editor, button]

        grid = _FakeControl("CVirtualGridCtrl", "", order=order, handle=4)
        grid.type_keys = lambda *a, **k: order.append("ctrl+s")

        patchers = [
            patch.object(export, "_top_dialogs", lambda pid: [dialog]),
            patch.object(
                export, "_set_foreground",
                lambda w: order.append(f"foreground:{w.class_name()}"),
            ),
            patch.object(export, "_DIALOG_TIMEOUT", 0.1),
            patch.object(export, "_SAVE_TIMEOUT", 3.0),
            patch.object(export, "_RECLICK_AFTER", reclick_after),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        result = export.export_grid(grid, out_path, pid=1234)
        return result, order, button, editor, out_path

    def test_dialog_is_focused_before_the_save_button_is_clicked(self):
        """click() 是按屏幕坐标发物理点击，对话框不在前台就点到别的窗口上。

        只把主窗口提前不够——模态框弹出后焦点会丢回发起调用的程序。
        """
        result, seq, button, editor, out_path = self._run()

        self.assertEqual(result, out_path)
        self.assertIn("focus", seq, "点保存之前必须先提对话框前台")
        self.assertLess(
            seq.index("focus"), seq.index("click"),
            f"提前台必须发生在点击之前，实际顺序: {seq}",
        )
        # 主窗口前台 → Ctrl+S → 对话框前台 → 点保存
        self.assertLess(seq.index("ctrl+s"), seq.index("focus"))
        self.assertIn("foreground:CVirtualGridCtrl", seq)
        self.assertEqual(button.clicks, 1)
        self.assertEqual(editor.window_text(), str(out_path))
        self.assertGreater(out_path.stat().st_size, 0)

    def test_save_is_retried_when_the_first_click_lands_nowhere(self):
        """第一下点击在真机上会静默落空，重提前台再点一次而不是整轮白跑。"""
        result, seq, button, _editor, out_path = self._run(
            save_after=2, reclick_after=0.0
        )

        self.assertEqual(result, out_path)
        self.assertEqual(button.presses, 2)
        self.assertEqual(seq.count("focus"), 2, "重试前必须重新提一次前台")
        self.assertLess(seq.index("focus"), seq.index("click"))

    def test_the_retry_uses_a_click_that_does_not_need_coordinates(self):
        """重试用 BM_CLICK：坐标点击落空的原因就是坐标/前台，换汤不换药没用。"""
        _result, seq, button, _editor, _out = self._run(save_after=2, reclick_after=0.0)

        self.assertEqual(button.clicks, 1, "只在第一次用坐标点击")
        self.assertIn(f"bm_click:{export._BM_CLICK}", seq)

    def test_a_failing_set_focus_does_not_abort_the_export(self):
        """set_focus 失败不报错：判定「点没点动」靠的是文件出没出现。"""
        result, _seq, _button, _editor, out_path = self._run(focus_raises=True)

        self.assertEqual(result, out_path)


class _FakeDialog:
    """另存为流程里那个「框」本身。只有 _dismiss_export_done 用得到。"""

    def __init__(self, children, *, tag="", handle=99):
        self._children = children
        self._tag = tag
        self.handle = handle

    def class_name(self):
        return "#32770"

    def window_text(self):
        return self._tag

    def descendants(self):
        return self._children

    def set_focus(self):
        pass


class DismissExportDoneTests(unittest.TestCase):
    """另存为成功后客户端还要弹一个**无标题**的「Excel导出成功」框。

    标题是空的，所以只能认正文。不关掉它：用户得自己点，而且下一次读取会被它
    搅乱——2026-09-16 真机就是这么连着坑了两轮。
    """

    def _run(self, children):
        dialog = _FakeDialog(children)
        patchers = [
            patch.object(export, "_top_dialogs", lambda pid: [dialog]),
            patch.object(export, "_set_foreground", lambda w: None),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        return export._dismiss_export_done(1234)

    def test_clicks_no_on_the_export_done_prompt(self):
        """选「否」：我们只要文件，不要客户端去拉起 Excel。"""
        yes = _FakeControl("Button", "是(&Y)")
        no = _FakeControl("Button", "否(&N)")
        text = _FakeControl("Static", "Excel导出成功\n\n是否需要直接打开Excel?\n")

        self.assertTrue(self._run([text, yes, no]))
        self.assertEqual(no.clicks, 1)
        self.assertEqual(yes.clicks, 0)

    def test_ignores_unrelated_dialogs(self):
        """别的框一律不碰——盲点一个按钮在实盘上可能确认掉别的东西。"""
        yes = _FakeControl("Button", "是(&Y)")
        self.assertFalse(self._run([_FakeControl("Static", "确认要退出吗"), yes]))
        self.assertEqual(yes.clicks, 0)

    def test_reports_failure_when_the_no_button_is_missing(self):
        """缺「否」就如实返回 False，不去猜着点「是」。"""
        self.assertFalse(
            self._run(
                [_FakeControl("Static", "Excel导出成功"), _FakeControl("Button", "是(&Y)")]
            )
        )


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
