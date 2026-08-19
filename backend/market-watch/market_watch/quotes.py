# -*- coding: utf-8 -*-
"""行情数据层：akshare 实时快照 + TTL 缓存 + 资金流 + K 线 + 交易日历。

akshare 权威列名（1.18.92，读安装源码确认）：
  stock_zh_a_spot_em：代码/名称/最新价/涨跌幅/量比/换手率/成交额(元)/成交量(手)
    涨跌幅/换手率 是百分数数值（5.32 = +5.32%）；成交额是元（显示亿需 /1e8）；
    停牌股涨跌幅/量比/换手率为 NaN，使用前 dropna。
  stock_zh_a_hist：前复权日线完整 OHLCV（主源）；baostock 带锁作 fallback。
  stock_individual_fund_flow：逐股主力净流入（升序日表最后一行），TTL 缓存。
  tool_trade_date_hist_sina：交易日历。

⚠️ NO_PROXY 由 config.py 在 import 时注入；本模块所有 akshare 均为函数内延迟 import。
"""

import logging
import threading
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

from .config import settings

logger = logging.getLogger("market_watch.quotes")

# baostock 全局 socket 非线程安全：本模块内部串行访问
_bs_lock = threading.Lock()

# K 线回看自然日倍数（保证凑够 lookback 根交易日）
_CALENDAR_CACHE: list[str] | None = None
_CALENDAR_TS = 0.0
_DAY_CAL_TTL = 6 * 3600.0  # 交易日历一天缓存足矣


def _num(value):
    """转 float，NaN/None/字符串空 → None。"""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(f):
        return None
    return f


def normalize_code(code: str) -> str:
    """标准化股票代码：去空白、校验 6 位数字。非法抛 ValueError。"""
    c = str(code).strip()
    if len(c) == 6 and c.isdigit():
        return c
    # 允许带交易所前缀或名字误传时的友好提示
    raise ValueError(f"非法股票代码: {code!r}（应为 6 位数字，如 600519）")


def _bs_code(code: str) -> str:
    """A 股代码 → baostock 格式（600519→sh.600519，000858→sz.000858）。"""
    t = code.strip()
    if t.startswith(("6", "9")):
        return f"sh.{t}"
    if t.startswith(("0", "3", "2")):
        return f"sz.{t}"
    if t.startswith(("4", "8", "92")):
        raise ValueError(f"{code} 属北交所，暂不支持，请改用沪深代码")
    return f"sh.{t}"


def _fetch_spot_em() -> dict[str, dict]:
    """东财实时快照（主源，含量比/换手率）。失败抛异常由调用方走新浪 fallback。"""
    import akshare as ak

    df = ak.stock_zh_a_spot_em()
    out: dict[str, dict] = {}
    for r in df.itertuples(index=False):
        d = r._asdict()
        code = str(d.get("代码", "")).strip()
        if not (len(code) == 6 and code.isdigit()):
            continue
        amount = _num(d.get("成交额"))
        row = {
            "code": code,
            "name": str(d.get("名称") or ""),
            "price": _num(d.get("最新价")),
            "pct_change": _num(d.get("涨跌幅")),
            "volume_ratio": _num(d.get("量比")),
            "turnover": _num(d.get("换手率")),
            "amount_yi": (amount / 1e8) if amount is not None else None,
            "volume": _num(d.get("成交量")),  # 手
        }
        out[code] = row
    return out


def _fetch_spot_sina() -> dict[str, dict]:
    """新浪实时快照（fallback：东财 push2 被限流时）。无量比/换手率，对应字段为 None。"""
    import akshare as ak

    df = ak.stock_zh_a_spot()
    out: dict[str, dict] = {}
    for r in df.itertuples(index=False):
        d = r._asdict()
        raw = str(d.get("代码", "")).strip()  # sh600519 / sz000001 / bj920000
        if raw.startswith("bj"):
            continue  # 北交所不在盯盘范围
        code = raw[2:] if len(raw) > 6 else raw
        if not (len(code) == 6 and code.isdigit()):
            continue
        amount = _num(d.get("成交额"))
        out[code] = {
            "code": code,
            "name": str(d.get("名称") or ""),
            "price": _num(d.get("最新价")),
            "pct_change": _num(d.get("涨跌幅")),
            "volume_ratio": None,  # 新浪快照无量比
            "turnover": None,      # 新浪快照无换手率
            "amount_yi": (amount / 1e8) if amount is not None else None,
            "volume": _num(d.get("成交量")),
        }
    return out


def _fetch_spot_map() -> dict[str, dict]:
    """拉全市场实时快照（东财主源 → 新浪 fallback），返回 {code: normalized_row}。
    两源都失败时抛异常，由调用方降级为空表。"""
    try:
        return _fetch_spot_em()
    except Exception as exc:
        logger.warning("东财实时快照失败，降级新浪: %s", exc)
        try:
            return _fetch_spot_sina()
        except Exception as exc2:
            logger.warning("新浪实时快照也失败: %s", exc2)
            raise


class QuoteCache:
    """全市场实时快照 TTL 缓存（线程安全）。"""

    def __init__(self, ttl: float | None = None):
        self.ttl = ttl if ttl is not None else settings.quote_cache_ttl
        self._map: dict[str, dict] | None = None
        self._ts = 0.0
        self._lock = threading.Lock()

    def _load(self) -> dict[str, dict]:
        with self._lock:
            now = time.time()
            if self._map is None or (now - self._ts) > self.ttl:
                try:
                    self._map = _fetch_spot_map()
                    self._ts = now
                except Exception as exc:
                    logger.warning("实时行情拉取失败: %s", exc)
                    if self._map is None:
                        # 整轮失败不无限重试：缓存空表到 TTL 过期，行情操作优雅降级
                        self._map = {}
                        self._ts = now
            return self._map

    def get_quote(self, code: str) -> dict | None:
        return self._load().get(code)

    def get_quotes(self, codes: list[str]) -> list[dict]:
        m = self._load()
        out = []
        for c in codes:
            row = m.get(c)
            if row is not None:
                out.append(row)
        return out

    def all_quotes(self) -> list[dict]:
        """全部沪深快照（排除停牌 NaN 行）。"""
        rows = [r for r in self._load().values() if r["pct_change"] is not None]
        rows = [r for r in rows if r["code"].startswith(("6", "0", "3"))]
        return rows


_cache: QuoteCache | None = None


def cache() -> QuoteCache:
    global _cache
    if _cache is None:
        _cache = QuoteCache()
    return _cache


# ---- 资金流 -------------------------------------------------------------

_fund_cache: dict[str, tuple[float, float]] = {}  # code -> (ts, value_yi)


def get_fund_flow(code: str) -> float | None:
    """最近交易日主力净流入（亿元）。best-effort，失败返回 None。"""
    if not settings.fund_flow_enabled:
        return None
    now = time.time()
    hit = _fund_cache.get(code)
    if hit and (now - hit[0]) < settings.fund_flow_ttl:
        return hit[1]
    try:
        import akshare as ak

        market = "sh" if code.startswith("6") else "sz"
        df = ak.stock_individual_fund_flow(stock=code, market=market)
        if df is None or df.empty:
            return None
        last = df.iloc[-1]
        value = _num(last.get("主力净流入-净额"))
        if value is None:
            return None
        yi = round(value / 1e8, 3)
        _fund_cache[code] = (now, yi)
        return yi
    except Exception as exc:
        logger.warning("主力净流入 %s 拉取失败: %s", code, exc)
        return None


# ---- K 线 ---------------------------------------------------------------


def _bs_hist_ohlcv(code: str, start: str, end: str) -> list[dict]:
    """带锁 baostock 前复权日线，返回 [{date,open,high,low,close,volume,amount}] 升序。"""
    import baostock as bs

    bs_code = _bs_code(code)
    with _bs_lock:
        lg = bs.login()
        if lg.error_code != "0":
            raise RuntimeError(f"baostock 登录失败: {lg.error_msg}")
        try:
            rs = bs.query_history_k_data_plus(
                bs_code, "date,open,high,low,close,volume,amount",
                start_date=start, end_date=end, frequency="d", adjustflag="2",
            )
            rows = []
            while rs.error_code == "0" and rs.next():
                r = rs.get_row_data()
                if r and r[0]:
                    rows.append({
                        "date": r[0],
                        "open": float(r[1]), "high": float(r[2]),
                        "low": float(r[3]), "close": float(r[4]),
                        "volume": float(r[5]), "amount": float(r[6]),
                    })
            if rs.error_code != "0":
                raise RuntimeError(f"baostock 查询失败({code}): {rs.error_msg}")
            return rows
        finally:
            bs.logout()


def get_kline(code: str, lookback: int = 120) -> pd.DataFrame | None:
    """前复权日线，返回列 date/open/close/high/low/volume/amount（升序）。
    主源 akshare stock_zh_a_hist，失败降级 baostock。无数据返回 None。"""
    today = date.today()
    start = today - timedelta(days=int(lookback * 1.5))
    start_s, end_s = start.strftime("%Y%m%d"), today.strftime("%Y%m%d")
    rows = None
    try:
        import akshare as ak

        df = ak.stock_zh_a_hist(
            symbol=code, period="daily", start_date=start_s, end_date=end_s, adjust="qfq"
        )
        if df is not None and not df.empty:
            rows = [
                {
                    "date": str(r.get("日期"))[:10],
                    "open": _num(r.get("开盘")), "close": _num(r.get("收盘")),
                    "high": _num(r.get("最高")), "low": _num(r.get("最低")),
                    "volume": _num(r.get("成交量")), "amount": _num(r.get("成交额")),
                }
                for r in df.to_dict("records")
            ]
    except Exception as exc:
        logger.warning("akshare K线 %s 失败，降级 baostock: %s", code, exc)
    if not rows:
        try:
            rows = _bs_hist_ohlcv(code, start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d"))
        except Exception as exc:
            logger.warning("baostock K线 %s 失败: %s", code, exc)
            return None
    if not rows:
        return None
    df = pd.DataFrame(rows).tail(lookback)
    df = df.dropna(subset=["open", "close", "high", "low"])
    df = df.reset_index(drop=True)
    return df


# ---- 交易日历 ------------------------------------------------------------


def _calendar() -> list[str]:
    """交易日列表（升序）。按序返回才能取最新交易日。"""
    global _CALENDAR_CACHE, _CALENDAR_TS
    now = time.time()
    if _CALENDAR_TS and (now - _CALENDAR_TS) < _DAY_CAL_TTL:
        return _CALENDAR_CACHE or []
    try:
        import akshare as ak

        cal = ak.tool_trade_date_hist_sina()
        dates = sorted({str(d)[:10] for d in cal["trade_date"]})  # 去重+升序
        _CALENDAR_CACHE = dates
        _CALENDAR_TS = now
    except Exception as exc:
        logger.warning("交易日历拉取失败: %s", exc)
    return _CALENDAR_CACHE or []


def is_trading_day(d: str) -> bool:
    return d in set(_calendar())


def latest_trade_date() -> str:
    today = datetime.now(ZoneInfo(settings.timezone)).strftime("%Y-%m-%d")
    dates = [d for d in _calendar() if d <= today]
    return dates[-1] if dates else today


def in_trading_session(now: datetime | None = None) -> bool:
    """09:30-11:30 / 13:00-15:00，周一至周五。"""
    if now is None:
        now = datetime.now(ZoneInfo(settings.timezone))
    if now.weekday() >= 5:
        return False
    t = now.strftime("%H:%M:%S")
    return ("09:30:00" <= t <= "11:30:00") or ("13:00:00" <= t <= "15:00:00")
