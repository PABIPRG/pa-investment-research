# -*- coding: utf-8 -*-
"""Tesseract OCR 定位：让 pytesseract 找得到 tesseract，并在找不到时说人话。

easytrader 读持仓/成交网格时会撞上券商风控验证码，它用 pytesseract 调 tesseract
识别。pytesseract 只按 PATH 查找（除非显式设置 `pytesseract.tesseract_cmd`），而
Windows 版 Tesseract 的安装器**默认不写 PATH**——于是本机明明装了 OCR，读取却
稳定失败；更麻烦的是 pytesseract 抛出的 TesseractNotFoundError 会被上层包成
「请确认客户端已登录且窗口未被遮挡」，把排查方向整个带偏。2026-09-18 真机踩过：
用户看着「窗口没登录」的提示去查券商客户端，实际根因是 OCR 依赖没暴露。

本模块只做两件事，都不改变读取逻辑本身：
    locate_tesseract()        找到就设进 pytesseract，返回路径；找不到返回 None
    is_missing_tesseract(exc) 判断一个异常链是不是「tesseract 没找到」
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

# 探测顺序＝「官方安装器 → 用户级安装 → 包管理器」，先命中先返回。
# 这些目录只是候选：PATH 里已有的永远优先，用户自己装的不会被这里抢走。
_WINDOWS_HINTS: tuple[str, ...] = (
    r"%ProgramFiles%\Tesseract-OCR",
    r"%ProgramFiles(x86)%\Tesseract-OCR",
    r"%ProgramW6432%\Tesseract-OCR",
    r"%LOCALAPPDATA%\Programs\Tesseract-OCR",
    r"%LOCALAPPDATA%\Tesseract-OCR",
    r"%USERPROFILE%\scoop\apps\tesseract\current",
    r"%ProgramData%\chocolatey\bin",
)

# macOS/Linux 上 GUI 启动的进程拿不到 shell 的 PATH，Homebrew 装了也可能找不到。
_UNIX_HINTS: tuple[str, ...] = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
)

_EXE_NAME = "tesseract.exe" if os.name == "nt" else "tesseract"


def candidate_dirs() -> list[Path]:
    """按优先级列出可能藏着 tesseract 的目录（只列，不检查存在性）。"""
    hints = _WINDOWS_HINTS if os.name == "nt" else _UNIX_HINTS
    return [Path(os.path.expandvars(hint)) for hint in hints]


def locate_tesseract() -> str | None:
    """找到 tesseract 并交给 pytesseract；找不到返回 None。

    PATH 优先，其次按常见落点探测。命中时设置 `pytesseract.tesseract_cmd` ——
    那是 pytesseract 唯一认的覆盖点，设完后续所有识别都走这个路径。

    pytesseract 本身缺失时返回 None：那是另一类问题（easytrader 没装全），
    不该在这里伪装成「tesseract 找到了」。
    """
    found = shutil.which(_EXE_NAME)
    if found is None:
        for folder in candidate_dirs():
            candidate = folder / _EXE_NAME
            if candidate.is_file():
                found = str(candidate)
                break
    if found is None:
        return None
    try:
        import pytesseract
    except ImportError:
        return None
    pytesseract.pytesseract.tesseract_cmd = found
    return found


def is_missing_tesseract(exc: BaseException) -> bool:
    """异常链里是否出现「tesseract 不可用」。

    沿 `__cause__`/`__context__` 走：pytesseract 是先抛 FileNotFoundError 再包成
    TesseractNotFoundError，只看最外层拿不到判据。

    按类名判断而不是 isinstance：pytesseract 是 easytrader 的可选依赖，这里只是
    给上层翻译报错文案，不该反过来把本模块变成硬依赖。
    """
    seen = 0
    current: BaseException | None = exc
    while current is not None and seen < 10:
        if type(current).__name__ == "TesseractNotFoundError":
            return True
        if "tesseract is not installed" in str(current).lower():
            return True
        current = current.__cause__ or current.__context__
        seen += 1
    return False


def missing_tesseract_hint() -> str:
    """找不到 tesseract 时给用户的可照做文案。"""
    return (
        "读取持仓时券商弹出了风控验证码，但本机没找到 tesseract OCR，无法自动识别。"
        "请安装 Tesseract OCR（Windows 安装包默认不写 PATH，本应用会自动探测常见"
        "安装目录，装好后重启本应用即可）。装之前也可以在弹出的验证码框里手工输入。"
    )
