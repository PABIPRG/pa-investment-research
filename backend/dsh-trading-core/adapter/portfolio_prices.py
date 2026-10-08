"""行情源及父端降级编排；spawn 导入本模块不会初始化应用或业务存储。"""

import logging
import math
from datetime import date

from .isolated_price_worker import IsolatedPriceWorker

logger = logging.getLogger("adapter.portfolio_prices")
_http_worker = IsolatedPriceWorker(__name__, "_load_http_prices", timeout=1.5, initializer="_prepare_eastmoney")
_sina_worker = IsolatedPriceWorker(__name__, "_load_sina_prices", timeout=1.0, initializer="_prepare_sina")


def _prepare_eastmoney():
    import akshare  # noqa: F401 — 子进程在独立启动预算内预热


def _prepare_sina():
    import requests  # noqa: F401

_ETF_CODE_PREFIXES = ("15", "16", "18", "50", "51", "52", "56", "58")


def _is_exchange_traded_fund(ticker: str) -> bool:
    return len(ticker) == 6 and ticker.isdigit() and ticker.startswith(_ETF_CODE_PREFIXES)


def _load_sina_prices(ticker: str, start_date: str, end_date: str) -> list[dict]:
    """东财不可用时读取新浪日线；仅返回请求区间内的有效收盘价。"""
    import requests

    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    calendar_days = max(0, (end - start).days)
    response = requests.get(
        "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData",
        params={
            "symbol": ("sh" if ticker.startswith(("5", "6", "9")) else "sz") + ticker,
            "scale": "240",
            "ma": "no",
            "datalen": str(min(1023, max(60, calendar_days + 20))),
        },
        timeout=8,
    )
    response.raise_for_status()
    rows: list[dict] = []
    for item in response.json() or []:
        try:
            trade_date = date.fromisoformat(str(item.get("day", ""))[:10])
            close = float(item["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if start <= trade_date <= end and close > 0 and math.isfinite(close):
            rows.append({"date": trade_date.isoformat(), "close": close})
    return rows


def _load_etf_prices(ticker: str, start_date: str, end_date: str) -> list[dict]:
    """用 AkShare 的东财 ETF 前复权接口补齐 baostock 的 ETF 覆盖空洞。"""
    import akshare as ak

    for attempt in range(2):
        try:
            frame = ak.fund_etf_hist_em(
                symbol=ticker,
                period="daily",
                start_date=start_date.replace("-", ""),
                end_date=end_date.replace("-", ""),
                adjust="qfq",
            )
            break
        except Exception:
            if attempt:
                logger.warning("AkShare/东财 ETF 日线 %s 重试失败，降级到新浪", ticker)
                raise
            logger.warning("AkShare/东财 ETF 日线 %s 瞬时失败，重试一次", ticker)
    rows: list[dict] = []
    for _, row in frame.iterrows():
        try:
            close = float(row["收盘"])
        except (KeyError, TypeError, ValueError):
            continue
        trade_date = str(row.get("日期", ""))[:10]
        if trade_date and close > 0 and math.isfinite(close):
            rows.append({"date": trade_date, "close": close})
    return rows


def _load_stock_prices(ticker: str, start_date: str, end_date: str) -> list[dict]:
    """用 AkShare 的东财 A 股前复权接口补齐 baostock 的瞬时故障。"""
    import akshare as ak

    for attempt in range(2):
        try:
            frame = ak.stock_zh_a_hist(
                symbol=ticker,
                period="daily",
                start_date=start_date.replace("-", ""),
                end_date=end_date.replace("-", ""),
                adjust="qfq",
            )
            break
        except Exception:
            if attempt:
                logger.warning("AkShare/东财 A 股日线 %s 重试失败，降级到新浪", ticker)
                raise
            logger.warning("AkShare/东财 A 股日线 %s 瞬时失败，重试一次", ticker)
    rows: list[dict] = []
    for _, row in frame.iterrows():
        try:
            close = float(row["收盘"])
        except (KeyError, TypeError, ValueError):
            continue
        trade_date = str(row.get("日期", ""))[:10]
        if trade_date and close > 0 and math.isfinite(close):
            rows.append({"date": trade_date, "close": close})
    return rows


def load_portfolio_prices(ticker: str, start_date: str, end_date: str) -> list[dict]:
    """以 baostock 为主源，失败或无覆盖时降级到东财和新浪日线。"""
    from .holdings_runner import _a_share_code, _bs_hist

    try:
        rows = _bs_hist(_a_share_code(ticker), start_date, end_date)
        if rows:
            return rows
    except Exception:
        logger.warning("BaoStock 日线 %s 不可用，降级到 HTTP 行情", ticker)
    try:
        return _http_worker.call(ticker, start_date, end_date)
    except Exception:
        logger.warning("东财日线 %s 不可用，降级到新浪", ticker)
        return _sina_worker.call(ticker, start_date, end_date)


def _load_http_prices(ticker: str, start_date: str, end_date: str) -> list[dict]:
    loader = _load_etf_prices if _is_exchange_traded_fund(ticker) else _load_stock_prices
    return loader(ticker, start_date, end_date)


def close_price_workers() -> None:
    from .holdings_runner import _bs_worker
    _bs_worker.close()
    _http_worker.close()
    _sina_worker.close()


def open_price_workers() -> None:
    from .holdings_runner import _bs_worker
    for worker in (_bs_worker, _http_worker, _sina_worker):
        worker.open()
        try:
            worker.warm()
        except Exception:
            logger.warning("行情源预热失败；其他接口仍可用，下次查询按退避重试")
