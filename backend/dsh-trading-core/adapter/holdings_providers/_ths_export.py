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
# 点「保存」后等多久还没生成文件就重提前台再点一次。留够客户端落盘的时间，
# 免得在正常慢保存上白白多点一次。
_RECLICK_AFTER = 5.0
# 点「保存」总共试几次（交替用坐标点击和 BM_CLICK）。第一下静默落空在真机上是常态。
_CLICK_ATTEMPTS = 3
_BM_CLICK = 0x00F5
# 另存为完成后客户端仍会独占文件一小会儿，读的时候等它一下。
_TEXT_READ_TIMEOUT = 5.0

# 另存为成功后客户端弹的「Excel导出成功 / 是否需要直接打开Excel?」——标题是空的，
# 只能认正文。选「否」：我们只要那个文件，不需要客户端去拉起 Excel。
_EXPORT_DONE_MARKERS = ("导出成功", "是否需要直接打开")
_DECLINE_TEXT = "否"


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
    # 点「保存」前必须把对话框提到前台。click() 是按屏幕坐标发物理点击，对话框不在
    # 前台时点击会落到别的窗口上——2026-09-16 真机（平安同花顺版）实测：文件名填对了、
    # 按钮也找到了，对话框却一直挂着，文件永远不生成。只提前主窗口不够，模态框弹出后
    # 焦点会丢回发起调用的程序。
    _press_save(save_as, button, 1)

    deadline = time.monotonic() + _SAVE_TIMEOUT
    attempts = 1
    while time.monotonic() < deadline:
        if _file_written(out_path):
            # 文件出来了不等于收工：客户端紧接着会弹一个**无标题**的 #32770
            # 「Excel导出成功，是否需要直接打开Excel?」。不关掉它会一直挂在客户端上
            # 当模态——用户得自己点，而且下一次读取会被它搅乱（2026-09-16 真机实测）。
            _dismiss_export_done(pid)
            return out_path
        # 第一下点击会静默落空（前台锁 / 坐标没落到按钮上），换一种方式再来。
        # 整轮读取白跑的代价不低（另存为之后还要解析整张表），值得多试几下。
        if attempts < _CLICK_ATTEMPTS and time.monotonic() > (
            deadline - _SAVE_TIMEOUT + _RECLICK_AFTER * attempts
        ):
            attempts += 1
            log.warning("「保存」点下去没动静，换一种方式再点（第 %d 次）", attempts)
            _press_save(save_as, button, attempts)
        time.sleep(0.5)
    raise ProviderUnavailable(
        "另存为没有生成文件：可能是文件名被客户端拒绝，或表里没有数据。", "read_failed"
    )


def _press_save(dialog, button, attempt: int) -> None:
    """第 `attempt` 次尝试点「保存」。

    `click()` 是按屏幕坐标发物理点击——对话框不在前台时点击会落到别的窗口上，
    而且落空时**不抛错**，只能靠文件落没落盘来判。`BM_CLICK` 是直接投递给按钮
    窗口的消息，不依赖坐标也不依赖前台，所以两种方式交替用，互为兜底。

    点击本身也要兜住异常：对话框可能已经被上一次点击关掉了，那时 wrapper 会抛
    `ElementNotVisible`。这一下没点到不代表失败——文件可能已经写出来了，
    不该为它把整轮读取废掉，交给调用方的轮询去判。
    """
    _focus_dialog(dialog)
    action = _click_by_coordinates if attempt % 2 == 1 else _click_by_message
    try:
        action(button)
    except Exception as exc:  # noqa: BLE001
        log.warning("第 %d 次点「保存」没成功（可能对话框已关）: %s", attempt, exc)


def _click_by_coordinates(button) -> None:
    button.click()


def _click_by_message(button) -> None:
    button.send_message(_BM_CLICK)


def _dismiss_export_done(pid: int) -> bool:
    """关掉另存为成功后的「Excel导出成功，是否需要直接打开Excel?」。

    这个框**没有标题**，所以只能靠正文识别；选「否」——我们只要文件，不要客户端
    去拉起 Excel。关不掉不算失败（文件已经在手里了），但要记一条日志：
    它留在屏幕上会挡住用户，也会让下一次读取失败。
    """
    for dialog in _top_dialogs(pid):
        try:
            children = _descendants(dialog)
            texts = [(child.window_text() or "") for child in children]
        except Exception:  # noqa: BLE001
            continue
        if not any(
            marker in text for text in texts for marker in _EXPORT_DONE_MARKERS
        ):
            continue
        no_button = None
        for child in children:
            try:
                if child.class_name() == "Button" and _DECLINE_TEXT in (
                    child.window_text() or ""
                ):
                    no_button = child
                    break
            except Exception:  # noqa: BLE001
                continue
        if no_button is None:
            log.warning("认出了「导出成功」框但没找到「否」按钮，未关闭")
            return False
        _focus_dialog(dialog)
        try:
            no_button.click()
        except Exception as exc:  # noqa: BLE001
            log.warning("关闭「导出成功」框失败: %s", exc)
            return False
        log.info("已关闭「导出成功」提示框")
        return True
    return False


def _file_written(path: Path) -> bool:
    """另存为落盘了没有：文件存在且非空。

    **刻意不在这里判「能不能读」**。2026-09-16 真机实测：客户端点完「保存」后
    对话框会先关，文件过一会儿才出现、而且出现之后还会被独占一小会儿。若把
    「读不了」当成「没写」，调用方会以为失败了继续重点——可对话框早关了，
    再点只会打到死 wrapper 上抛 ElementNotVisible，把一次已经成功的另存为报成
    read_failed。可读性由读取侧（`_read_text_when_unlocked`）负责等。
    """
    try:
        return path.exists() and path.stat().st_size > 0
    except OSError:
        return False


def _focus_dialog(dialog) -> None:
    """把模态对话框提到前台。

    `_set_foreground` 用裸 `SetForegroundWindow`，受 Windows 前台锁限制会静默失败；
    pywinauto 的 `set_focus` 走 AttachThreadInput，成功率高一些。两个都试，
    反正失败也不报错——真正判定「点没点动」的是调用方对文件是否出现的轮询。
    """
    _set_foreground(dialog)
    try:
        dialog.set_focus()
        time.sleep(0.2)
    except Exception as exc:  # noqa: BLE001
        log.debug("另存为对话框 set_focus 失败: %s", exc)


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


def _read_text_when_unlocked(path: Path) -> str:
    """等客户端松开手再读，读不了就退让重试。

    `_file_ready` 只是「此刻能打开」的快照，客户端可能在我们真正去读之前又把文件
    抓回去（真机实测就是这样：探测通过、紧接着 Errno 13）。让一小会儿，比把一次
    已经成功的另存为报成 read_failed 划算。
    """
    deadline = time.monotonic() + _TEXT_READ_TIMEOUT
    while True:
        try:
            return path.read_text(encoding="gbk", errors="replace")
        except OSError as exc:
            if time.monotonic() >= deadline:
                raise ProviderUnavailable(
                    f"另存为的文件一直被客户端占着，读不了：{exc}", "read_failed"
                ) from exc
            time.sleep(0.3)


def read_tab_separated(path: Path) -> tuple[list[str], list[list[str]]]:
    """读回另存为的文件 → (表头, 数据行)。

    客户端存出来的是 GBK 编码的制表符分隔文本（不是真正的 xls 二进制）。用
    `errors="replace"` 容忍个别坏字节，但**不静默接受乱码**：表头认不出成交表时
    由 _ths_trades 报「列名无法识别」并附上实际表头，那比一条 partial_read 好排查。
    """
    if not path.exists() or path.stat().st_size == 0:
        raise ProviderUnavailable("另存为的文件不存在或为空。", "read_failed")
    text = _read_text_when_unlocked(path)
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ProviderUnavailable("另存为的文件里没有任何内容。", "read_failed")
    header = [cell.strip() for cell in lines[0].split("\t")]
    rows = [[cell.strip() for cell in line.split("\t")] for line in lines[1:]]
    return header, rows
