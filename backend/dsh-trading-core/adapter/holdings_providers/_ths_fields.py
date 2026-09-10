# -*- coding: utf-8 -*-
"""同花顺系持仓字段映射（Windows easytrader 与 macOS AppleScript 共用）。

两个平台拿到的都是「列名 → 值」的表结构，只是取数方式不同：
  Windows  easytrader 返回 list[dict]，键就是中文列名
  macOS    AppleScript 读回表头 + 数据行，列名同样来自客户端界面
列名随券商版本/客户端版本漂移，因此这里统一维护候选名并在运行时按序取第一个命中项。
"""

from __future__ import annotations

import re

# HoldingItem 字段 → 客户端可能出现的列名（按优先级）
FIELD_CANDIDATES: dict[str, list[str]] = {
    "ticker": ["证券代码", "股票代码", "stock_code"],
    "quantity": ["股票余额", "持仓数量", "证券余额", "volume"],
    # THS 同花顺持仓页成本列实际叫「参考成本价」，通达信/各券商版本有叫「成本价」的
    "cost_price": ["成本价", "参考成本价", "成本均价", "avg_price"],
}


def extract(row: dict, target: str) -> float | str | None:
    """从「列名 → 值」的持仓行中按候选列名提取值。"""
    for key in FIELD_CANDIDATES.get(target, [target]):
        val = row.get(key)
        if val is not None:
            return val
    return None


def normalize_ticker(raw: str | None) -> str | None:
    """将证券代码规范化为6位纯数字（HoldingItem 要求 pattern ^\\d{6}$）。

    客户端可能返回 '000001' 或 '000001.SZ' 等格式。
    """
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) >= 6:
        return digits[:6]
    return None


def locate_columns(header: list[str]) -> dict[str, int]:
    """在表头里定位 ticker/quantity/cost_price 三列的列号。

    返回 {字段名: 列下标}，只包含命中的字段；三列全未命中时返回空 dict，
    供调用方判定「这不是持仓表」或「列名不认识」。
    """
    normalized = [h.strip() for h in header]
    found: dict[str, int] = {}
    for target, candidates in FIELD_CANDIDATES.items():
        for candidate in candidates:
            index = next((i for i, name in enumerate(normalized) if candidate in name), None)
            if index is not None:
                found[target] = index
                break
    return found
