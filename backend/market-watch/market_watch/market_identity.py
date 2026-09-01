"""证券代码的市场归属及行情供应商标识。"""

from typing import Literal


Market = Literal["sh", "sz", "bj"]


class UnsupportedProviderMarket(ValueError):
    """供应商不支持该证券所属市场。"""


def resolve_market(code: str) -> Market:
    """根据代码前缀确定北交所、沪市或深市。"""
    prefix = str(code).strip()
    if prefix.startswith(("92", "4", "8")):
        return "bj"
    if prefix.startswith(("6", "5", "9")):
        return "sh"
    if prefix.startswith(("0", "1", "2", "3")):
        return "sz"
    raise ValueError(f"无法识别证券市场: {code!r}")


def sina_symbol(code: str) -> str:
    """生成新浪行情代码。"""
    return f"{resolve_market(code)}{str(code).strip()}"


def eastmoney_secid(code: str) -> str:
    """生成东财行情 secid。"""
    normalized = str(code).strip()
    return f"{'1' if resolve_market(normalized) == 'sh' else '0'}.{normalized}"


def baostock_code(code: str) -> str:
    """生成 baostock 行情代码；baostock 不支持北交所。"""
    normalized = str(code).strip()
    market = resolve_market(normalized)
    if market == "bj":
        raise UnsupportedProviderMarket(f"baostock 不支持北交所代码: {normalized}")
    return f"{market}.{normalized}"
