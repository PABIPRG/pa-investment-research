# -*- coding: utf-8 -*-
"""同花顺系表格字段映射（Windows easytrader 与 macOS AppleScript 共用）。

两个平台拿到的都是「列名 → 值」的表结构，只是取数方式不同：
  Windows  easytrader 返回 list[dict]，键就是中文列名
  macOS    AppleScript 读回表头 + 数据行，列名同样来自客户端界面
列名随券商版本/客户端版本漂移，因此这里统一维护候选名并在运行时按序取第一个命中项。

同时覆盖两类表：持仓表（holdings）与成交明细表（trades）。两者靠 TABLE_SIGNATURES
区分——表头同时含「方向列（买卖标志/操作）+ 成交价格 + 成交数量 + 成交日期」的才是
成交表，含「成本价」的才是持仓表。
"""

from __future__ import annotations

import math
import re

# 候选名前缀：加上它表示「列名必须完全等于」，不加则是子串匹配。
# 只给会被无关长列名抢先命中的短列名用（见 side 的「操作」）。
EXACT_PREFIX = "="


def strip_exact(candidate: str) -> str:
    """候选名 → 真实列名（去掉精确匹配前缀）。"""
    return candidate[len(EXACT_PREFIX):] if candidate.startswith(EXACT_PREFIX) else candidate


# 字段 → 客户端可能出现的列名（按优先级，先命中的胜出）
FIELD_CANDIDATES: dict[str, list[str]] = {
    "ticker": ["证券代码", "股票代码", "stock_code"],
    # 只用于成交明细的展示（持仓不需要名称）。不进任何表签名：名称缺列不该影响认表。
    "name": ["证券名称", "股票名称"],
    # 「成交数量」必须排在持仓候选之后：持仓表若同时有「股票余额」，应按持仓语义取值。
    "quantity": ["股票余额", "持仓数量", "证券余额", "volume", "成交数量"],
    # THS 同花顺持仓页成本列实际叫「参考成本价」，通达信/各券商版本有叫「成本价」的
    "cost_price": ["成本价", "参考成本价", "成本均价", "avg_price"],
    # ── 以下为成交明细字段（easytrader today_trades / THS 历史成交）──
    # 刻意只维护中文候选：两个平台的成交表列名都来自客户端中文界面；
    # 加英文候选（尤其裸 "price"）会与本表 cost_price 的 "avg_price" 发生子串相撞。
    # 平安同花顺版的历史成交表把方向列叫「操作」（实测 2026-09-15，值：买入/卖出/红股派息）。
    # 它必须以精确匹配加入（前缀 =）：裸 "操作" 的子串语义会先命中委托表里的「操作日期」。
    "side": ["买卖标志", "买卖方向", "委托方向", "买卖类型", "交易方向", "=操作"],
    "price": ["成交价格", "成交均价", "成交价", "委托价格"],
    "amount": ["成交金额", "成交额"],
    # 成交日期与成交时间在 THS 成交表里是两列，必须分开定位再拼装，不能合成一个字段。
    "trade_date": ["成交日期", "发生日期", "委托日期"],
    "trade_time": ["成交时间", "委托时间"],
    "trade_id": ["成交编号", "合同编号", "成交序号", "委托序号"],
}

# 字段 → 中文名，用于把缺列提示写成用户能看懂、开发者也能对照的话。
FIELD_LABELS: dict[str, str] = {
    "ticker": "证券代码",
    "quantity": "数量",
    "cost_price": "成本价",
    "side": "买卖标志",
    "price": "成交价格",
    "amount": "成交金额",
    "trade_date": "成交日期",
    "trade_time": "成交时间",
    "trade_id": "成交编号",
}


def label(field: str) -> str:
    """字段的内部键 → 报错文案里用的中文名（未登记时退回键本身）。"""
    return FIELD_LABELS.get(field, field)


# 客户端用来表示「没有值」的占位符。必须与「无法解析的脏数据」区分开：
# 前者按缺省值处理，后者要拒绝整批（详见 parse_number 与 mac_ths._to_float）。
BLANK_TOKENS = ("", "--", "-", "—")

# 表签名：表格类型 → 判定该表所必需的字段集合。
# trades 在前：它更具体（5 个字段）。两类签名互斥——成交表没有「成本价」，
# 持仓表没有「买卖标志」，因此判定结果不会互相覆盖。
TABLE_SIGNATURES: dict[str, tuple[str, ...]] = {
    "trades": ("ticker", "side", "price", "quantity", "trade_date"),
    "holdings": ("ticker", "quantity", "cost_price"),
}

def extract(row: dict, target: str) -> float | str | None:
    """从「列名 → 值」的行字典中按候选列名提取值。

    这里的键就是客户端列名本身（easytrader 的 grid 直接返回中文列名），所以是整键
    取值而不是子串匹配——子串匹配的活由 locate_columns 干，两者不要混。
    """
    for key in FIELD_CANDIDATES.get(target, [target]):
        val = row.get(strip_exact(key))
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
    """在表头里定位所有可识别字段的列号。

    返回 {字段名: 列下标}，只包含命中的字段。调用方用字段子集是否齐全来判定
    「这是哪类表」或「列名不认识」，判定逻辑统一走 TABLE_SIGNATURES + classify_table()。

    默认是子串语义（candidate in name）：THS 实际列名是「参考成本价」这类，
    用相等匹配会让现有持仓读取全部落空。候选以 EXACT_PREFIX 开头时改为整名相等，
    用于「操作」这类会被更长的无关列名（操作日期）抢先命中的短列名。
    """
    normalized = [h.strip() for h in header]
    found: dict[str, int] = {}
    for target, candidates in FIELD_CANDIDATES.items():
        for candidate in candidates:
            exact = candidate.startswith(EXACT_PREFIX)
            needle = strip_exact(candidate)
            for index, name in enumerate(normalized):
                if name == needle if exact else needle in name:
                    found[target] = index
                    break
            if target in found:
                break
    return found


def classify_table(header: list[str]) -> str | None:
    """判定表头属于哪类表：holdings / trades；无法判定返回 None。

    取代原先「表头里含『代码』就当持仓表」的弱判据——成交表同样含「证券代码」，
    旧判据会把成交表送进 rows_to_items，缺列后抛错并被上层包装成
    「请进入持仓页」这种与事实不符的提示。
    """
    columns = locate_columns(header)
    for kind, required in TABLE_SIGNATURES.items():
        if set(required).issubset(columns):
            return kind
    return None


def required_fields(kind: str) -> tuple[str, ...]:
    """返回某类表的签名字段，供调用方生成准确的缺列提示。"""
    return TABLE_SIGNATURES.get(kind, ())


def normalize_side(raw: str | None) -> str | None:
    """把客户端的买卖标志规范化为 buy / sell；无法识别的返回 None。

    同花顺成交表的「买卖标志」不止买卖两值，还有 申购/中签/新股入账/配股/送股/
    红利入账 等非交易流水。返回 None 表示「无法归类」，由调用方单独计数上报，
    不得静默丢弃，也不得因为无法归类而拒绝整批数据。
    """
    if raw is None:
        return None
    value = str(raw).strip()
    if value == "":
        return None
    if any(token in value for token in ("买", "申购", "中签", "转入")):
        return "buy"
    if any(token in value for token in ("卖", "赎回", "转出")):
        return "sell"
    return None


def _clean(raw: object) -> str:
    """去掉千分位逗号、货币符号和空白，得到可解析的文本。"""
    return str(raw).replace(",", "").replace("¥", "").replace("￥", "").strip()


def is_blank(raw: object) -> bool:
    """清洗后是否为客户端表示「没有值」的占位符（None 也算没有值）。

    与 parse_number 共用同一套清洗，所以「¥」这类只剩符号的展示值也算没有值——
    两个函数的判定边界必须完全一致，否则会出现「既不是空值也解析不出数字」的缝。
    """
    return raw is None or _clean(raw) in BLANK_TOKENS


def parse_number(raw: object) -> float | None:
    """把客户端展示值解析成有限浮点数（容忍千分位逗号、货币符号、空占位）。

    返回 None 表示「空值或无法解析」，与数值 0.0 区分开。这是本模块唯一的数字
    解析实现，mac_ths._to_float 与 quantize_price 都复用它。

    None 把两种情况压成了一个返回值。需要区分「客户端明确表示没有值」（应取缺省值）
    与「读到了脏数据」（应拒绝整批）的调用方，用 is_blank 判定。
    """
    if raw is None:
        return None
    text = _clean(raw)
    if text in BLANK_TOKENS:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def quantize_price(raw: object) -> float | None:
    """把价格规范到 3 位小数，供去重键使用。

    Xls 路径的价格来自 pandas、macOS 路径来自字符串清洗，同一笔成交在不同路径下
    的浮点表示可能不同（16.2117 vs 16.211700000000001），直接进哈希会导致
    重复导入时同一笔被当成新增。
    """
    value = parse_number(raw)
    if value is None:
        return None
    return round(value, 3)
