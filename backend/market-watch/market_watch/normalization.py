# -*- coding: utf-8 -*-
"""响应边界使用的轻量数据归一化。"""

import math


def finite_number(value: object) -> float | None:
    """把可解析的有限数转换为 float，其余值统一转换为 None。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None
