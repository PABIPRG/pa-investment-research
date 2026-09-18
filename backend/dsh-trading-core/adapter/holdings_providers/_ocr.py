# -*- coding: utf-8 -*-
"""Tesseract OCR 定位：让 pytesseract 找得到 tesseract，并在找不到时说人话。

easytrader 读持仓/成交网格时会撞上券商风控验证码，它用 pytesseract 调 tesseract
识别。pytesseract 只按 PATH 查找（除非显式设置 `pytesseract.tesseract_cmd`），而
Windows 版 Tesseract 的安装器**默认不写 PATH**——于是本机明明装了 OCR，读取却
稳定失败；更麻烦的是 pytesseract 抛出的 TesseractNotFoundError 会被上层包成
「请确认客户端已登录且窗口未被遮挡」，把排查方向整个带偏。2026-09-18 真机踩过：
用户看着「窗口没登录」的提示去查券商客户端，实际根因是 OCR 依赖没暴露。

本模块只做四件事，都不改变读取逻辑本身：
    find_tesseract()          纯查找：只返回路径，不碰任何全局状态
    locate_tesseract()        找到就设进 pytesseract，返回路径；找不到返回 None
    tesseract_status()        给 UI 做前置提醒用的纯探测：'available' | 'missing'
    is_missing_tesseract(exc) 判断一个异常链是不是「tesseract 没找到」

find_tesseract 与 locate_tesseract 的区别是「有没有副作用」：后者会设
`pytesseract.pytesseract.tesseract_cmd`，所以只能放在真正要读取的路径上；
快照接口是只读探测，必须走前者。
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


def find_tesseract() -> str | None:
    """只找路径，不做别的。

    PATH 优先，其次按常见落点探测。不 import pytesseract，也不写任何全局状态，
    所以可以随时调用而不会影响后续读取——快照探测必须用这个而不是
    `locate_tesseract`。

    刻意不看 pytesseract 是否可导入：那是「easytrader 装没装全」的另一类问题，
    调用方要分清楚时自己查（见 `locate_tesseract` 的返回约定）。
    """
    found = shutil.which(_EXE_NAME)
    if found is None:
        for folder in candidate_dirs():
            candidate = folder / _EXE_NAME
            if candidate.is_file():
                found = str(candidate)
                break
    return found


def locate_tesseract() -> str | None:
    """找到 tesseract 并交给 pytesseract；找不到返回 None。

    命中时设置 `pytesseract.tesseract_cmd` —— 那是 pytesseract 唯一认的覆盖点，
    设完后续所有识别都走这个路径。

    pytesseract 本身缺失时返回 None：那是另一类问题（easytrader 没装全），
    不该在这里伪装成「tesseract 找到了」。
    """
    found = find_tesseract()
    if found is None:
        return None
    try:
        import pytesseract
    except ImportError:
        return None
    pytesseract.pytesseract.tesseract_cmd = found
    return found


def tesseract_status() -> str:
    """本机 tesseract 是否可用，供 UI 做读取前提醒：'available' | 'missing'。

    只看二进制在不在。**不看 pytesseract 能不能导入**——那属于「本应用依赖是否
    完整」，修复动作是重装本应用而不是装 Tesseract，两者文案不能混。真要覆盖，
    得再加一个取值，别塞进 'missing'。
    """
    return "available" if find_tesseract() is not None else "missing"


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


def missing_tesseract_notice() -> str:
    """读取之前给用户看的预告式提醒。

    与 `missing_tesseract_hint` 的区别是时机：那条是「已经失败了，解释为什么」，
    这条是「还没点，先说清风险」。所以措辞是条件句而不是过去式——缺 OCR 不等于
    一定读不了，验证码不保证每次都弹。

    「怎么装」那半句和 `missing_tesseract_hint` 是同一份措辞（探测策略变了要一起改）。
    """
    return (
        "读取时如果券商弹出风控验证码，需要手工输入才能继续。"
        "想恢复自动识别请安装 Tesseract OCR（Windows 安装包默认不写 PATH，"
        "本应用会自动探测常见安装目录，装好后重启本应用即可）。"
    )
