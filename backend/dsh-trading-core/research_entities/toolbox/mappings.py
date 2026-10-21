# -*- coding: utf-8 -*-
"""实体 → 外部数据源代码的静态映射。

映射只放已被联网验证过的代码。没有可靠来源的实体不强行映射，
处理器会返回 ``unavailable`` 并说明原因，而不是猜一个代码。
"""

from __future__ import annotations

from typing import Any

# index entity_id -> (指数代码, 新浪代码, 标准名)
INDEX_DEFS: dict[str, tuple[str, str, str]] = {
    "INDEX:CSI300": ("000300", "sh000300", "沪深300"),
    "INDEX:CSI500": ("000905", "sh000905", "中证500"),
    "INDEX:CSI1000": ("000852", "sh000852", "中证1000"),
    "INDEX:SSE50": ("000016", "sh000016", "上证50"),
    "INDEX:CHINEXT": ("399006", "sz399006", "创业板指"),
    "INDEX:STAR50": ("000688", "sh000688", "科创50"),
    "INDEX:BSE50": ("899050", "bj899050", "北证50"),
    "INDEX:CSI_ALL_SHARE": ("000985", "sh000985", "中证全指"),
}

# 风格实体 -> 代表性指数。只映射有明确指数的风格；
# 动量/质量/低波动当前没有公开、稳定的单一指数，不映射。
STYLE_INDEX: dict[str, tuple[str, str, str]] = {
    "STYLE:HIGH_DIVIDEND": ("000922", "sh000922", "中证红利"),
    "STYLE:SMALL_CAP": ("000852", "sh000852", "中证1000"),
    "STYLE:LARGE_VALUE": ("000919", "sh000919", "300价值"),
    "STYLE:LARGE_GROWTH": ("000918", "sh000918", "300成长"),
    "STYLE:VALUE": ("000919", "sh000919", "300价值"),
    "STYLE:GROWTH": ("000918", "sh000918", "300成长"),
}

# 宏观实体 -> (akshare 函数, 参数, 展示名)
MACRO_SERIES: dict[str, tuple[str, dict[str, Any], str]] = {
    "MACRO:CPI": ("macro_china_cpi", {}, "居民消费价格指数"),
    "MACRO:PPI": ("macro_china_ppi", {}, "工业生产者出厂价格指数"),
    "MACRO:PMI": ("macro_china_pmi_yearly", {}, "制造业 PMI"),
    "MACRO:GDP": ("macro_china_gdp_yearly", {}, "GDP"),
    "MACRO:M2": ("macro_china_m2_yearly", {}, "M2"),
    "MACRO:TSF": ("macro_china_shrzgm", {}, "社会融资规模"),
    "MACRO:IVA": ("macro_china_industrial_production_yoy", {}, "工业增加值"),
    "MACRO:UNEMPLOYMENT": ("macro_china_urban_unemployment", {}, "城镇调查失业率"),
    "MACRO:INTEREST_RATE": ("macro_china_lpr", {}, "LPR"),
    "MACRO:SHIBOR": ("macro_china_shibor_all", {}, "SHIBOR"),
    "MACRO:DR007": (
        "rate_interbank",
        {
            "market": "上海银行同业拆借市场",
            "symbol": "Shibor人民币",
            "indicator": "隔夜",
        },
        "银行间同业拆借隔夜利率",
    ),
}

# 大宗商品 -> Sina 主力连续合约
COMMODITY_SERIES: dict[str, tuple[str, str]] = {
    "COMMODITY:COPPER": ("CU0", "沪铜"),
    "COMMODITY:ALUMINUM": ("AL0", "沪铝"),
    "COMMODITY:REBAR": ("RB0", "螺纹钢"),
    "COMMODITY:IRON_ORE": ("I0", "铁矿石"),
    "COMMODITY:CRUDE_OIL": ("SC0", "原油"),
    "COMMODITY:THERMAL_COAL": ("ZC0", "动力煤"),
    "COMMODITY:LITHIUM_CARBONATE": ("LC0", "碳酸锂"),
    "COMMODITY:HOG": ("LH0", "生猪"),
    "COMMODITY:POLYSILICON": ("PS0", "多晶硅"),
    "COMMODITY:RUBBER": ("RU0", "橡胶"),
    "COMMODITY:SILVER": ("AG0", "沪银"),
    "COMMODITY:GOLD": ("AU0", "沪金"),
    "COMMODITY:NATURAL_GAS": ("NG0", "天然气"),
}

# 大宗商品 -> 东方财富期货库存品种名
INVENTORY_SYMBOLS: dict[str, str] = {
    "COMMODITY:COPPER": "沪铜",
    "COMMODITY:ALUMINUM": "沪铝",
    "COMMODITY:REBAR": "螺纹钢",
    "COMMODITY:IRON_ORE": "铁矿石",
    "COMMODITY:CRUDE_OIL": "原油",
    "COMMODITY:LITHIUM_CARBONATE": "碳酸锂",
    "COMMODITY:HOG": "生猪",
    "COMMODITY:POLYSILICON": "多晶硅",
    "COMMODITY:RUBBER": "橡胶",
}

# 明确无可靠公开数据源的实体，给出可供审计的原因。
UNSUPPORTED_REASONS: dict[str, str] = {
    "MACRO:USD_INDEX": "当前 akshare 版本没有稳定的美元指数序列接口。",
    "MACRO:CNY_RATE": "akshare.macro_china_rmb 当前返回结构无法解析，暂不纳入。",
    "COMMODITY:RARE_EARTH": "稀土没有连续、可复现的公开报价序列。",
    "COMMODITY:PANEL_PRICE": "面板价格属于第三方付费数据，当前无公开来源。",
    "STYLE:MOMENTUM": "动量和质量风格没有稳定的公开单一指数，需先确定指数口径。",
    "STYLE:QUALITY": "动量和质量风格没有稳定的公开单一指数，需先确定指数口径。",
    "STYLE:LOW_VOLATILITY": "低波动风格尚未确定可复现的指数口径。",
}


def index_def_for(entity_id: str | None, name: str | None = None) -> tuple[str, str, str] | None:
    if entity_id and entity_id in INDEX_DEFS:
        return INDEX_DEFS[entity_id]
    if name:
        for _code, (csindex, sina, canonical) in INDEX_DEFS.items():
            if name in (csindex, sina, canonical):
                return (csindex, sina, canonical)
    return None


def style_def_for(entity_id: str | None, name: str | None = None) -> tuple[str, str, str] | None:
    if entity_id and entity_id in STYLE_INDEX:
        return STYLE_INDEX[entity_id]
    if name:
        for (csindex, sina, canonical) in STYLE_INDEX.values():
            if name in (csindex, sina, canonical):
                return (csindex, sina, canonical)
    return None


def exchange_prefix(code: str) -> str | None:
    code = str(code or "").strip()
    if len(code) != 6 or not code.isdigit():
        return None
    if code.startswith(("60", "68", "90")):
        return "sh"
    if code.startswith(("00", "30", "20")):
        return "sz"
    if code.startswith(("4", "8", "92")):
        return "bj"
    return None


def security_symbol(code: str) -> str | None:
    """6 位代码 → 新浪/交易所符号（sh600519）。"""

    prefix = exchange_prefix(code)
    return f"{prefix}{code}" if prefix else None


def normalize_ths_name(name: str) -> list[str]:
    """行业/概念名候选：原名、去掉 Ⅰ/Ⅱ/Ⅲ 后缀、去掉“行业”。"""

    raw = str(name or "").strip()
    candidates = [raw]
    for suffix in ("Ⅰ", "Ⅱ", "Ⅲ", "I", "II", "III"):
        if raw.endswith(suffix) and len(raw) > len(suffix):
            candidates.append(raw[: -len(suffix)].strip())
            break
    for item in list(candidates):
        if item.endswith("行业") and len(item) > 2:
            candidates.append(item[:-2].strip())
        if item.endswith("指数") and len(item) > 2:
            candidates.append(item[:-2].strip())
    return [item for index, item in enumerate(candidates) if item and item not in candidates[:index]]
