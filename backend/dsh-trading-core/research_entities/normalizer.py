# -*- coding: utf-8 -*-
"""文本、证券代码与实体 ID 的标准化。

口径约定：
- 偏移统一使用 Python 字符偏移（与 ``str`` 索引一致）。
- 不做 NFKC 全量归一化，避免把中文罗马数字（Ⅱ）改成 ``II``，破坏行业名称匹配。
- 只折叠全角 ASCII、空白与常见标点。
"""

from __future__ import annotations

import re
import unicodedata

_WHITESPACE_RE = re.compile(r"\s+")
_FULLWIDTH_ASCII_START = 0xFF01
_FULLWIDTH_ASCII_END = 0xFF5E
_FULLWIDTH_OFFSET = 0xFEE0


def fold_fullwidth(text: str) -> str:
    """把全角 ASCII 折叠为半角；保留中文罗马数字等非 ASCII 字符。"""

    chars: list[str] = []
    for char in text:
        code = ord(char)
        if _FULLWIDTH_ASCII_START <= code <= _FULLWIDTH_ASCII_END:
            chars.append(chr(code - _FULLWIDTH_OFFSET))
        else:
            chars.append(char)
    return "".join(chars)


def normalize_text(text: str) -> str:
    """用于匹配的轻量标准化：折叠全角、压缩空白。"""

    return _WHITESPACE_RE.sub(" ", fold_fullwidth(text or "")).strip()


def normalize_name(text: str) -> str:
    """实体名称标准化：去掉空白与常见分隔符，保留中文与字母数字。"""

    value = normalize_text(text)
    for char in (" ", "　", "-", "_", "·"):
        value = value.replace(char, "")
    return value.strip()


def is_six_digit_code(text: str) -> bool:
    return bool(re.fullmatch(r"\d{6}", normalize_text(text)))


def infer_exchange(code: str) -> str | None:
    """按代码前缀推断交易所：SH / SZ / BJ，无法判断时返回 None。"""

    code = normalize_text(code)
    if not is_six_digit_code(code):
        return None
    if code.startswith(("600", "601", "603", "605", "688", "689", "50", "51", "52", "56", "58", "11")):
        return "SH"
    if code.startswith(("000", "001", "002", "003", "300", "301", "15", "16", "12", "39")):
        return "SZ"
    if code.startswith(("43", "83", "87", "88", "92")):
        return "BJ"
    return None


def security_kind_for_code(code: str) -> str:
    """返回 stock / fund / bond / unknown。

    指数与股票代码可能重叠（如 000300），这里只做保守分类，
    最终类型由实体库检索结果决定。
    """

    code = normalize_text(code)
    if not is_six_digit_code(code):
        return "unknown"
    if code.startswith(("11", "12")):
        return "bond"
    if code.startswith(("15", "16", "50", "51", "52", "56", "58")):
        return "fund"
    if code.startswith(("60", "68", "00", "30", "43", "83", "87", "88", "92")):
        return "stock"
    return "unknown"


def identifier_key_for_type(type_code: str) -> str:
    return {
        "ENTITY_01_01": "security_code",
        "ENTITY_01_02": "fund_code",
        "ENTITY_01_03": "index_code",
        "ENTITY_01_04": "bond_code",
        "ENTITY_02_01": "company_code",
    }.get(type_code, "code")


def entity_id_for_security(type_code: str, code: str) -> str:
    code = normalize_text(code)
    prefix = {
        "ENTITY_01_01": "SEC:CN:A",
        "ENTITY_01_02": "FUND",
        "ENTITY_01_03": "INDEX",
        "ENTITY_01_04": "BOND",
        "ENTITY_02_01": "CO:CN:A",
    }.get(type_code, "SEC")
    return f"{prefix}:{code}"


def entity_id_for_named_type(type_code: str, key: str) -> str:
    """非证券类实体的稳定 ID；key 由数据源或词典显式提供。"""

    prefix = {
        "ENTITY_03_01": "IND:CN",
        "ENTITY_03_02": "THEME",
        "ENTITY_03_03": "CHAIN",
        "ENTITY_04_01": "TREND",
        "ENTITY_04_02": "POLICY",
        "ENTITY_05_02": "STYLE",
        "ENTITY_06_01": "MACRO",
        "ENTITY_06_02": "COMMODITY",
        "ENTITY_06_03": "REGION",
    }.get(type_code, type_code.replace("ENTITY_", "E"))
    return f"{prefix}:{key}"


def strip_accents(text: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", text)
        if unicodedata.category(char) != "Mn"
    )
