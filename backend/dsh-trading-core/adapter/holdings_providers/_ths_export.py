# -*- coding: utf-8 -*-
"""同花顺下单程序里「把一张 grid 另存为文件」的对话框流程（Windows 专用）。

为什么不用 easytrader 自带的两个 grid 策略（2026-09-15 真机实测，平安同花顺版）：

  * `WMCopy`：给 CVirtualGridCtrl 发 WM_COMMAND 0xE122 后剪贴板内容没有变化，
    复制策略在这个版本上不适用（无法读到表，且失败是静默的）。
  * `Xls`：Ctrl+S 在这个客户端上**先弹「验证码」框**（风控提示"检测到您正在拷贝数据"），
    通过之后才是「另存为」。而 `Xls.get()` 不认验证码框，会把临时路径填进验证码输入框，
    再发 `%{s}%{y}`，最后去读一个并不存在的文件——报错不可读。

所以这里自己走一遍：Ctrl+S → 验证码（OCR 或提示用户手工输入）→ 另存为 → 读文件。

**实盘安全约束**（逐条都是刻意的）：
  * 只把下单程序提到前台 + 给 grid 发 Ctrl+S，**不点任何交易按钮**、不碰密码框；
  * 所有控件都按文本/类名定位，找不到就中止并回报——不做「盲点第二个按钮」这种猜测，
    猜错在实盘上可能确认掉某个对话框；
  * 临时文件建在自己的目录里并在 finally 里删掉（easytrader 是写进 %TEMP% 且从不清理）。
"""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path
from typing import Callable, Iterable

from .base import ProviderUnavailable

log = logging.getLogger(__name__)

# 风控验证码框：上游 easytrader 的 Copy 策略用的就是这三个 control id，
# 同一家客户端弹出的同一个对话框，所以按 id 找图与输入框，找不到就中止。
_CAPTCHA_IMAGE_CONTROL_ID = 0x965
_CAPTCHA_EDIT_CONTROL_ID = 0x964
_CAPTCHA_TEXT = "验证码"
_SAVE_AS_TITLE = "另存为"
_SAVE_BUTTON_TEXT = "保存"
_CANCEL_BUTTON_TEXT = "取消"

# 对话框出现/保存完成的等待上限。成交表比持仓表大一个量级，给得比 easytrader 宽。
_DIALOG_TIMEOUT = 12.0
_SAVE_TIMEOUT = 30.0


def is_captcha_dialog(texts: Iterable[str]) -> bool:
    """对话框里出现「验证码」字样即认定为风控验证码框。"""
    return any(_CAPTCHA_TEXT in str(text) for text in texts)


def is_save_as_dialog(class_name: str, title: str) -> bool:
    """「另存为」是标准 #32770 对话框，标题随系统语言变化，故按标题关键词判定。"""
    return class_name == "#32770" and _SAVE_AS_TITLE in (title or "")


def pick_save_button(candidates: Iterable[tuple[str, str, object]]) -> object | None:
    """在 (类名, 文本, 控件) 候选里挑「保存」按钮；挑不到返回 None（调用方中止，不盲点）。"""
    for class_name, text, control in candidates:
        if class_name == "Button" and _SAVE_BUTTON_TEXT in (text or ""):
            return control
    return None


def pick_filename_edit(candidates: Iterable[tuple[str, bool, object]]) -> object | None:
    """在 (类名, 是否可见, 控件) 候选里挑文件名输入框。

    只取第一个可见 Edit：另存为对话框里不可见的 Edit 是历史路径下拉的残留，
    往里写会看起来「填了但没生效」。
    """
    for class_name, visible, control in candidates:
        if class_name == "Edit" and visible:
            return control
    return None


def _windows():
    """延迟导入 pywinauto：非 Windows 平台不该在模块导入期就炸。"""
    from pywinauto import Desktop

    return Desktop(backend="win32")


def _process_id() -> int:
    """定位下单程序进程；找不到时由调用方转成用户可读的失败原因。"""
    for window in _windows().windows(visible_only=True):
        try:
            title = window.window_text() or ""
        except Exception:  # noqa: BLE001
            continue
        if "网上股票交易系统" in title or "模拟炒股" in title:
            return window.element_info.process_id
    raise ProviderUnavailable("未找到同花顺下单程序窗口，请先启动并登录。", "client_not_running")


def _top_dialogs(pid: int) -> list:
    found = []
    for window in _windows().windows(visible_only=True):
        try:
            if window.class_name() != "#32770" or window.element_info.process_id != pid:
                continue
        except Exception:  # noqa: BLE001
            continue
        found.append(window)
    return found


def _descendants(dialog) -> list:
    try:
        return list(dialog.descendants())
    except Exception:  # noqa: BLE001
        return []


def _wait_for_dialog(pid: int, predicate: Callable[[object], bool], timeout: float):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for dialog in _top_dialogs(pid):
            try:
                if predicate(dialog):
                    return dialog
            except Exception:  # noqa: BLE001
                continue
        time.sleep(0.4)
    return None


def _describe(dialog) -> str:
    """把对话框里的控件列成文字，供报错文案引用（用户能照着截图对照）。"""
    parts = []
    for child in _descendants(dialog):
        try:
            text = (child.window_text() or "").strip()
            parts.append(f"{child.class_name()}[{child.control_id()}]{text[:40]!r}")
        except Exception:  # noqa: BLE001
            continue
    return " ".join(parts)


def _solve_captcha(dialog) -> bool:
    """用 OCR 识别验证码并填入；识别不出就返回 False 交给调用方提示人工输入。

    失败时**不点任何按钮**：验证码框的「确定」在实盘上等价于确认一次风控校验，
    盲点等于替用户做决定。
    """
    try:
        from easytrader.utils.captcha import captcha_recognize
    except Exception:  # noqa: BLE001
        log.warning("验证码识别组件不可用（需要 tesseract 与 easytrader 的 captcha 模块）")
        return False

    image, editor = None, None
    for child in _descendants(dialog):
        try:
            if child.control_id() == _CAPTCHA_IMAGE_CONTROL_ID:
                image = child
            elif child.control_id() == _CAPTCHA_EDIT_CONTROL_ID:
                editor = child
        except Exception:  # noqa: BLE001
            continue
    if image is None or editor is None:
        log.warning("验证码框结构与预期不符，不猜测控件：%s", _describe(dialog))
        return False

    with tempfile.TemporaryDirectory(prefix="pa_captcha_") as folder:
        image_path = str(Path(folder) / "captcha.png")
        try:
            image.capture_as_image().save(image_path)
            code = "".join(captcha_recognize(image_path).split())
        except Exception as exc:  # noqa: BLE001
            log.warning("验证码识别失败: %s", exc)
            return False
        if len(code) != 4:
            # 上游也只接受 4 位：位数不对说明识别错了，填进去只会浪费一次校验机会
            log.warning("验证码识别结果不是 4 位，放弃: %r", code)
            return False
        try:
            editor.set_edit_text(code)
            dialog.set_focus()
            import pywinauto.keyboard

            pywinauto.keyboard.SendKeys("{ENTER}")
        except Exception as exc:  # noqa: BLE001
            log.warning("填入验证码失败: %s", exc)
            return False
    return True


def _dismiss(dialog) -> None:
    """只点「取消」按钮关掉对话框；找不到取消就什么都不做（不发 ESC）。"""
    for child in _descendants(dialog):
        try:
            if child.class_name() == "Button" and _CANCEL_BUTTON_TEXT in (child.window_text() or ""):
                child.click()
                return
        except Exception:  # noqa: BLE001
            continue


def export_grid(grid, out_path: Path, *, pid: int) -> Path:
    """给 grid 发 Ctrl+S，把整表另存为 out_path 并返回该路径。

    调用方负责清理 out_path（以及它所在目录）。grid 必须已经在前台页面上。

    Raises:
        ProviderUnavailable: 验证码未通过、另存为框控件与预期不符、或文件没生成。
    """
    _set_foreground(grid)
    grid.type_keys("^s", set_foreground=False)

    captcha = _wait_for_dialog(
        pid, lambda dialog: is_captcha_dialog(
            [(child.window_text() or "") for child in _descendants(dialog)]
        ), _DIALOG_TIMEOUT,
    )
    if captcha is not None:
        if not _solve_captcha(captcha):
            _dismiss(captcha)
            raise ProviderUnavailable(
                "券商客户端弹出了风控验证码，自动识别没能通过（需安装 tesseract OCR）。"
                "请在弹出的验证码框里手工输入后再试。",
                "automation_required",
            )
        log.info("验证码已自动填入，等待另存为对话框")

    save_as = _wait_for_dialog(pid, lambda dialog: is_save_as_dialog(
        dialog.class_name(), dialog.window_text()
    ), _DIALOG_TIMEOUT)
    if save_as is None:
        raise ProviderUnavailable(
            "没有得到「另存为」对话框：请确认客户端停在「历史成交」页且表里查到了数据。",
            "navigation_required",
        )

    children = _descendants(save_as)
    editor = pick_filename_edit(
        [(child.class_name(), child.is_visible(), child) for child in children]
    )
    if editor is None:
        raise ProviderUnavailable(
            f"「另存为」对话框里没有找到文件名输入框，已中止。"
            f"对话框内容：{_describe(save_as)}",
            "read_failed",
        )
    if out_path.exists():
        out_path.unlink()
    editor.set_edit_text(str(out_path))

    button = pick_save_button(
        [(child.class_name(), child.window_text() or "", child) for child in children]
    )
    if button is None:
        raise ProviderUnavailable(
            f"「另存为」对话框里没有找到「保存」按钮，已中止。"
            f"对话框内容：{_describe(save_as)}",
            "read_failed",
        )
    button.click()

    deadline = time.monotonic() + _SAVE_TIMEOUT
    while time.monotonic() < deadline:
        if out_path.exists() and out_path.stat().st_size > 0:
            return out_path
        time.sleep(0.5)
    raise ProviderUnavailable(
        "另存为没有生成文件：可能是文件名被客户端拒绝，或表里没有数据。", "read_failed"
    )


def _set_foreground(window) -> None:
    """把下单程序提到前台。

    Ctrl+S 是窗口级按键，后台窗口收不到；`SetForegroundWindow` 受 Windows 前台锁
    限制会静默失败，所以失败也不报错——后续拿不到对话框时给出的提示已经够定位问题。
    """
    import ctypes
    from ctypes import wintypes

    try:
        ctypes.windll.user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        ctypes.windll.user32.SetForegroundWindow(window.handle)
        time.sleep(0.4)
    except Exception as exc:  # noqa: BLE001
        log.warning("把下单程序提到前台失败: %s", exc)


def read_tab_separated(path: Path) -> tuple[list[str], list[list[str]]]:
    """读回另存为的文件 → (表头, 数据行)。

    客户端存出来的是 GBK 编码的制表符分隔文本（不是真正的 xls 二进制）。用
    `errors="replace"` 容忍个别坏字节，但**不静默接受乱码**：表头认不出成交表时
    由 _ths_trades 报「列名无法识别」并附上实际表头，那比一条 partial_read 好排查。
    """
    if not path.exists() or path.stat().st_size == 0:
        raise ProviderUnavailable("另存为的文件不存在或为空。", "read_failed")
    text = path.read_text(encoding="gbk", errors="replace")
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ProviderUnavailable("另存为的文件里没有任何内容。", "read_failed")
    header = [cell.strip() for cell in lines[0].split("\t")]
    rows = [[cell.strip() for cell in line.split("\t")] for line in lines[1:]]
    return header, rows
