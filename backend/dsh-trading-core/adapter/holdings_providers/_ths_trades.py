# -*- coding: utf-8 -*-
"""同花顺系「成交明细」行 → TradeItem（Windows easytrader 与 macOS AX 共用）。

与持仓映射（mac_ths.rows_to_items）的三条关键差别：

  1. **一行就是一笔，不做「过滤掉某类行」**。持仓映射会跳过零持仓，那是快照语义；
     成交是事件流，跳过一行就是丢一笔历史，所以归不了类的行也必须留下（落 unclassified）。
  2. **方向列可能是非买卖流水**。「操作」列还会出现 红股派息/红利入账/申购/中签，
     归一不了不算错，但必须如实计数——上层会把它单独报出来。
  3. **日期与时间在客户端是两列**，必须拼装成 ISO8601 的 T 分隔形式（TradeItem 要求）。

日期列实测是 `20260626` 这种紧凑写法（不是 `2026-06-26`），时间列是 `11:12:51`。
两种都可能带 Excel 公式包裹（`="159607"`），所以文本与数字都要先清洗再解析。
"""

from __future__ import annotations

import re

from ..schemas import TradeItem
from ._ths_fields import (
    classify_table,
    is_blank,
    label,
    locate_columns,
    normalize_side,
    normalize_ticker,
    parse_number,
    required_fields,
)
from .base import ProviderUnavailable

# 客户端把值写成 Excel 公式 `="159607"` 时才需要剥壳；正常值原样返回。
_FORMULA_WRAPPER = re.compile(r'^="?(?P<inner>[^"]*)"?$')
_TIME_PATTERN = re.compile(r"^(?P<h>\d{2}):?(?P<m>\d{2}):?(?P<s>\d{2})?$")


def clean_text(raw: object) -> str:
    """客户端展示值 → 纯文本：剥掉 Excel 公式外壳与首尾空白。

    只用于文本字段（代码另有 normalize_ticker，它按数字抽取，天然免疫）。
    """
    if raw is None:
        return ""
    text = str(raw).strip()
    match = _FORMULA_WRAPPER.match(text)
    if match and text.startswith('="'):
        return match.group("inner").strip()
    return text


def build_traded_at(date_raw: object, time_raw: object) -> str | None:
    """把客户端的「成交日期 + 成交时间」两列拼成 ISO8601；任一缺失返回 None。

    不补造精度：客户端只给到分钟就保留分钟，不会替它写成 :00——那会凭空造出秒级精度，
    并让同一笔成交在不同取数路径下产生两个不同的去重键。
    """
    digits = re.sub(r"\D", "", clean_text(date_raw))
    if len(digits) != 8:
        return None
    date_part = f"{digits[:4]}-{digits[4:6]}-{digits[6:]}"

    time_text = clean_text(time_raw)
    match = _TIME_PATTERN.match(time_text)
    if match is None:
        return None
    hour, minute, second = match.group("h"), match.group("m"), match.group("s")
    if int(hour) > 23 or int(minute) > 59 or (second is not None and int(second) > 60):
        return None
    time_part = f"{hour}:{minute}" if second is None else f"{hour}:{minute}:{second}"
    return f"{date_part}T{time_part}"


def _number(cell: object) -> float | None:
    """数值单元格 → float；空占位当 0.0，脏数据返回 None（由调用方判 partial_read）。"""
    value = parse_number(cell)
    if value is not None:
        return value
    if is_blank(cell):
        return 0.0
    return None


def _fold(  # noqa: PLR0913 — 字段逐个显式传入，避免再引入一个中间结构
    *,
    ticker: str,
    name: str,
    side_raw: str,
    price_raw: object,
    quantity_raw: object,
    amount_raw: object,
    traded_at: str | None,
    trade_id: str,
    source: str,
    account_mode: str,
) -> TradeItem:
    """校验并组装一笔成交；数值脏数据或时间缺失一律判 partial_read。

    与持仓读取同一条原则：宁可让用户重读一次，也不要把一批里的一部分静默写进历史。
    成交是 append-only 的事件流，写错一笔之后没有「下次同步覆盖」能纠正它。
    """
    numbers = {
        "成交价格": _number(price_raw),
        "成交数量": _number(quantity_raw),
        "成交金额": _number(amount_raw),
    }
    for field, value in numbers.items():
        if value is None:
            raise ProviderUnavailable(
                f"部分成交的{field}无法识别，未写入本地成交明细。"
                "请在客户端确认该列有值后重试。",
                "partial_read",
            )
    if traded_at is None:
        raise ProviderUnavailable(
            "部分成交缺少可识别的成交日期或时间，未写入本地成交明细。"
            "请在客户端确认「成交日期」「成交时间」两列都有值后重试。",
            "partial_read",
        )
    normalized_side = normalize_side(side_raw)
    return TradeItem(
        ticker=ticker,
        name=name,
        # 归不了类的落 unclassified，原始字样留给界面如实显示；不猜方向。
        side=normalized_side or "unclassified",
        side_label=side_raw.strip(),
        price=numbers["成交价格"],
        quantity=numbers["成交数量"],
        amount=numbers["成交金额"],
        traded_at=traded_at,
        trade_id=trade_id,
        source=source,
        account_mode=account_mode,
    )


def _is_empty_row(cells: list[object]) -> bool:
    """整行都没有值——客户端表尾常见，直接跳过而不是判 partial_read。"""
    return not any(clean_text(cell) for cell in cells)


def _trade_ticker(raw: str | None) -> str | None:
    """成交行的证券代码 → 6 位代码；不是恰好 6 位数字时返回 None。

    刻意比 normalize_ticker 严：后者对 ≥6 位取前 6 位，7 位代码（港股通、带后缀的
    外盘代码）会被**静默截断**成一个看起来合法的 A 股代码。持仓表里这种代码罕见，
    成交表里常见——一旦截断，这笔成交会被记到一只完全无关的股票上，而且去重键也
    跟着错。宁可让用户重读一次，也不要静默错位。
    """
    if raw is None:
        return None
    if len(re.sub(r"\D", "", raw)) != 6:
        return None
    return normalize_ticker(raw)


def rows_to_trades(
    header: list[str], rows: list[list[str]], *, source: str, account_mode: str
) -> list[TradeItem]:
    """按表头名映射列，把「表头 + 数据行」转成 TradeItem。

    Raises:
        ProviderUnavailable: 表头不满足成交表签名（读错了页），或部分行无法识别。
    """
    _require_trades_table(header)
    columns = locate_columns(header)

    def cell(row: list[str], field: str) -> str | None:
        index = columns.get(field)
        return row[index] if index is not None and index < len(row) else None

    items: list[TradeItem] = []
    for row in rows:
        if _is_empty_row(row):
            continue
        ticker = _trade_ticker(cell(row, "ticker"))
        if ticker is None:
            raise ProviderUnavailable(
                f"部分成交的证券代码无法识别（{clean_text(cell(row, 'ticker'))[:20]!r}），"
                "未写入本地成交明细。",
                "partial_read",
            )
        items.append(_fold(
            ticker=ticker,
            name=clean_text(cell(row, "name")),
            side_raw=clean_text(cell(row, "side")),
            price_raw=cell(row, "price"),
            quantity_raw=cell(row, "quantity"),
            amount_raw=cell(row, "amount"),
            traded_at=build_traded_at(cell(row, "trade_date"), cell(row, "trade_time")),
            trade_id=clean_text(cell(row, "trade_id")),
            source=source,
            account_mode=account_mode,
        ))
    return items


def _require_trades_table(header: list[str]) -> None:
    """表头不是成交表时给出「该怎么恢复」的提示，而不是让缺列错误往下漏。"""
    kind = classify_table(header)
    if kind == "trades":
        return
    shown = " | ".join(str(name).strip() for name in header if str(name).strip())
    if kind == "holdings":
        raise ProviderUnavailable(
            "当前读到的是一张持仓表，不是成交明细表。"
            f"实际表头：{shown}。请在客户端切换到「历史成交」页后重试。",
            "navigation_required",
        )
    missing = [name for name in required_fields("trades") if name not in locate_columns(header)]
    raise ProviderUnavailable(
        "同花顺成交明细表的列名无法识别"
        f"（缺少：{'、'.join(label(field) for field in missing) or '全部字段'}）。"
        f"实际表头：{shown}。请把这条信息反馈给开发者补充列名映射。",
        "read_failed",
    )
