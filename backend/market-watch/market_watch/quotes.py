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
import math
import re
import requests
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
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


# 浏览器 UA：东财 push2 WAF 会断连 requests 默认 UA（python-requests/2.34.2）
_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
}


# push2 子域轮换：东财对单 host 有间歇性断连/限流窗口，跨子域重试提高成功率
_EM_HOSTS = ["82.push2.eastmoney.com", "push2.eastmoney.com", "push2his.eastmoney.com"]


def _http_get(url: str, params: dict | None = None, timeout: int = 10, retries: int = 2) -> requests.Response:
    """东财直连 GET：浏览器 UA + proxies={} 禁用系统代理 + push2 子域轮换重试。

    两个坑：requests 默认 UA（python-requests/x）被 push2 WAF 拒连；trust_env 会把
    Windows 系统代理 127.0.0.1:7892 套到 push2 上（clash 对该域断连）。显式 proxies={} +
    浏览器 UA 直连。东财 push2 单 host 有间歇断连/限流窗口，同一 host 失败时轮换子域重试。
    """
    from urllib.parse import urlparse

    parsed = urlparse(url)
    base = parsed.netloc
    hosts = _EM_HOSTS if "eastmoney.com" in base else [base]
    last = None
    for i in range(len(hosts) * (retries + 1)):
        h = hosts[i % len(hosts)]
        u = url if h == base else url.replace(base, h)
        try:
            r = requests.get(u, params=params, timeout=timeout, proxies={}, headers=_UA)
            r.raise_for_status()
            return r
        except Exception as exc:
            last = exc
            time.sleep(0.2)
    raise last


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
    """东财实时快照（主源，含量比/换手率）。失败抛异常由调用方走新浪 fallback。

    直连 push2 clist（浏览器 UA + 禁用系统代理），pz=100 分页并发拉全市场。
    akshare 原实现是 59 页串行 + 每页随机 sleep 0.5-1.5s（防反爬），首拉 30s+ 卡死盯盘按钮；
    且走系统代理对 push2 断连重试。这里并发 8 + 无 sleep，首拉 ~5s，60s TTL 缓存后基本无感。
    """
    url = "https://82.push2.eastmoney.com/api/qt/clist/get"
    base = {
        "pn": "1", "pz": "100", "po": "1", "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2", "invt": "2", "fid": "f12",
        "fs": "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048",
        "fields": "f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,"
        "f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f115,f152",
    }

    def _page(pn: int) -> tuple[list, int]:
        p = dict(base)
        p["pn"] = str(pn)
        j = _http_get(url, p).json()
        data = (j or {}).get("data") or {}
        return (data.get("diff") or []), int(data.get("total") or 0)

    first, total = _page(1)
    per = len(first) or 100
    pages = max(1, math.ceil(total / per))
    diff = first
    if pages > 1:
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = [ex.submit(_page, pn) for pn in range(2, pages + 1)]
            for f in futs:
                try:
                    d, _ = f.result()
                    diff.extend(d)
                except Exception:
                    continue  # 单页失败跳过（下轮 TTL 重拉）

    out: dict[str, dict] = {}
    for d in diff:
        code = str(d.get("f12", "")).strip()
        if not (len(code) == 6 and code.isdigit()):
            continue
        amount = _num(d.get("f6"))
        out[code] = {
            "code": code,
            "name": str(d.get("f14") or ""),
            "price": _num(d.get("f2")),
            "pct_change": _num(d.get("f3")),
            "volume_ratio": _num(d.get("f10")),
            "turnover": _num(d.get("f8")),
            "amount_yi": (amount / 1e8) if amount is not None else None,
            "volume": _num(d.get("f5")),  # 手
        }
    return out


def _secid(code: str) -> str:
    """A 股代码 → 东财 secid（600519→1.600519，000858→0.000858）。"""
    return ("1." if code.startswith("6") else "0.") + code


def _row_from_diff(d: dict) -> dict | None:
    """东财 clist/ulist diff 行 → normalized quote row。非法代码返回 None。"""
    code = str(d.get("f12", "")).strip()
    if not (len(code) == 6 and code.isdigit()):
        return None
    amount = _num(d.get("f6"))
    return {
        "code": code,
        "name": str(d.get("f14") or ""),
        "price": _num(d.get("f2")),
        "pct_change": _num(d.get("f3")),
        "volume_ratio": _num(d.get("f10")),
        "turnover": _num(d.get("f8")),
        "amount_yi": (amount / 1e8) if amount is not None else None,
        "volume": _num(d.get("f5")),
    }


# ulist 批量行情短缓存（防 scheduler 30s 轮询高频打 push2）
_UL_TTL = 10.0
_ul_cache: dict[str, tuple[float, dict[str, dict]]] = {}


def _ulist(codes: list[str]) -> dict[str, dict]:
    """按代码批量查实时行情（东财 ulist 单请求，浏览器 UA + 直连）。
    自选几十只 = 1 个请求，替代全市场快照分页；失败返回空表（调用方降级）。"""
    if not codes:
        return {}
    key = ",".join(sorted(set(codes)))
    now = time.time()
    hit = _ul_cache.get(key)
    if hit and (now - hit[0]) < _UL_TTL:
        return hit[1]
    try:
        # 快速失败（retries=0）：东财限流时几秒内降级新浪 hq，不拖住 /overview
        j = _http_get("https://push2.eastmoney.com/api/qt/ulist.np/get", {
            "secids": ",".join(_secid(c) for c in codes),
            "fltt": "2", "invt": "2", "fields": "f2,f3,f5,f6,f8,f10,f12,f14",
        }, timeout=5, retries=0).json()
        diff = ((j or {}).get("data") or {}).get("diff") or []
        out = {}
        for d in diff:
            row = _row_from_diff(d)
            if row:
                out[row["code"]] = row
        _ul_cache[key] = (now, out)
        return out
    except Exception as exc:
        logger.warning("ulist 行情 %d 只失败: %s", len(codes), exc)
        return {}


_CLIST_FS = "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048"


def _clist_top(fid: str, top_n: int, po: int = 1, page_size: int | None = None) -> list[dict]:
    """东财 clist 服务端排序取前 N（涨幅/量比/换手/成交额榜），浏览器 UA + 直连。
    fid: f3=涨跌幅 f10=量比 f8=换手率 f6=成交额；po: 1=降序 0=升序。"""
    size = page_size or max(top_n * 3, 50)
    # 三个 push2 子域各尝试一次，总体约 4 秒内失败，让 /scan 尽快降级。
    j = _http_get("https://82.push2.eastmoney.com/api/qt/clist/get", {
        "pn": "1", "pz": str(size), "po": str(po), "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2", "invt": "2", "fid": fid, "fs": _CLIST_FS,
        "fields": "f2,f3,f5,f6,f8,f10,f12,f14",
    }, timeout=1.2, retries=0).json()
    diff = ((j or {}).get("data") or {}).get("diff") or []
    return [row for row in (_row_from_diff(d) for d in diff) if row]


# ---- 新浪源（东财 push2 间歇限流时的稳定替代） -------------------------------
# 新浪字段缺口：无 volume_ratio（量比），hq 实时无 turnover。price/pct/amount 齐全。


def _sina_sym(code: str) -> str:
    """A 股代码 → 新浪 symbol（600519→sh600519，000858→sz000858）。"""
    if code.startswith("6"):
        return "sh" + code
    if code.startswith(("4", "8", "92")):
        return "bj" + code
    return "sz" + code


def _sina_hq(codes: list[str]) -> dict[str, dict]:
    """新浪实时行情（hq.sinajs.cn 批量，GBK）。无换手/量比，price/pct/amount 齐全。"""
    if not codes:
        return {}
    syms = [_sina_sym(c) for c in codes]
    try:
        r = requests.get(
            "https://hq.sinajs.cn/list=" + ",".join(syms),
            timeout=8, proxies={}, headers={**_UA, "Referer": "https://finance.sina.com.cn"},
        )
        r.raise_for_status()
        txt = r.content.decode("gbk", errors="replace")
    except Exception as exc:
        logger.warning("新浪 hq 失败: %s", exc)
        return {}
    out: dict[str, dict] = {}
    for line in txt.splitlines():
        if '="' not in line:
            continue
        sym, _, payload = line.partition('="')
        code = sym.strip().split("hq_str_")[-1][2:]
        if len(code) != 6 or not code.isdigit():
            continue
        f = payload.rstrip('";').split(",")
        if len(f) < 10:
            continue
        price = _num(f[3])
        prev = _num(f[2])
        amount = _num(f[9])
        out[code] = {
            "code": code,
            "name": f[0],
            "price": price,
            "pct_change": (round((price - prev) / prev * 100, 2) if price and prev else None),
            "volume_ratio": None,
            "turnover": None,
            "amount_yi": (amount / 1e8) if amount is not None else None,
            "volume": _num(f[8]),  # 股（新浪），clist 为手
        }
    return out


_SINA_MARKET = (
    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
    "Market_Center.getHQNodeData"
)


def _sina_market(sort: str, top_n: int, asc: int = 0) -> list[dict]:
    """新浪全市场排序行情。有 changepercent/turnoverratio/amount，无量比。
    sort: changepercent / turnoverratio / amount / volume；asc: 0=降序 1=升序。"""
    r = _http_get(_SINA_MARKET, {
        "page": "1", "num": str(max(top_n, 20)), "sort": sort, "asc": str(asc),
        "node": "hs_a", "_s_r_a": "init",
    }, timeout=1.5, retries=0)
    out = []
    for d in (r.json() or []):
        code = str(d.get("code", "")).strip()
        if not (len(code) == 6 and code.isdigit()):
            continue
        amount = _num(d.get("amount"))
        out.append({
            "code": code,
            "name": str(d.get("name") or ""),
            "price": _num(d.get("trade")),
            "pct_change": _num(d.get("changepercent")),
            "volume_ratio": None,
            "turnover": _num(d.get("turnoverratio")),
            "amount_yi": (amount / 1e8) if amount is not None else None,
            "volume": _num(d.get("volume")),
        })
    return out


def _sina_kline(sym: str, lookback: int) -> list[dict] | None:
    """新浪日 K（升序）。无成交额列，amount 用 close*volume 估算。"""
    r = _http_get(
        "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData",
        {"symbol": sym, "scale": "240", "ma": "no", "datalen": str(max(lookback, 60))},
        timeout=settings.kline_source_timeout,
        retries=0,
    )
    out = []
    for d in (r.json() or []):
        close = _num(d.get("close"))
        volume = _num(d.get("volume"))
        out.append({
            "date": str(d.get("day"))[:10],
            "open": _num(d.get("open")), "close": close,
            "high": _num(d.get("high")), "low": _num(d.get("low")),
            "volume": volume,
            "amount": (close * volume) if close is not None and volume is not None else None,
        })
    return out or None


def _scan_rows(kind: str, top_n: int, min_amount_yi: float | None = None) -> list[dict]:
    """异动扫描行情源：东财 clist 服务端排序为主（完整字段含量比/换手），
    东财限流时降级新浪 Market_Center 排序（无 volume_ratio）。量比仅东财有。"""
    if kind == "volume_ratio":
        return _clist_top("f10", top_n)  # 东财限流时抛错，由 app 层 503 提示
    fid = {"gainers": "f3", "turnover": "f8", "amount": "f6"}[kind]
    try:
        rows = _clist_top(fid, top_n * 3 if kind == "amount" else top_n)
    except Exception:
        sort = {"f3": "changepercent", "f8": "turnoverratio", "f6": "amount"}[fid]
        rows = _sina_market(sort, max(top_n * 3, 30))
    if kind == "turnover":
        rows = [r for r in rows if r.get("turnover") is not None]
    elif kind == "amount":
        rows = [r for r in rows if r.get("amount_yi") is not None]
        if min_amount_yi is not None:
            rows = [r for r in rows if r["amount_yi"] >= min_amount_yi]
    return rows


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
        m = _ulist([code]) or _sina_hq([code])
        return m.get(code)

    def get_quotes(self, codes: list[str]) -> list[dict]:
        m = _ulist(codes) or _sina_hq(codes)
        return [m[c] for c in codes if c in m]

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


# ---- 名称→code 反查（事件抽取用）----
_NAME_INDEX: dict[str, list[str]] | None = None
_NAME_INDEX_TS = 0.0
_NAME_INDEX_TTL = 3600.0  # 名称映射几乎不变，1 小时足够；用轻量名称表而非全市场快照


def _name_to_code_index() -> dict[str, list[str]]:
    """全市场 name→code 索引（TTL 缓存，失败返回空）。
    用 akshare 名称表（一次请求返回全 A code+name），比全市场行情快照（55+ 请求）轻得多。"""
    global _NAME_INDEX, _NAME_INDEX_TS
    now = time.time()
    if _NAME_INDEX is None or (now - _NAME_INDEX_TS) > _NAME_INDEX_TTL:
        idx: dict[str, list[str]] = {}
        try:
            import akshare as ak
            for r in ak.stock_info_a_code_name().to_dict("records"):
                nm = str(r.get("name") or "").strip()
                cd = str(r.get("code") or "").strip()
                if nm and cd:
                    idx.setdefault(nm, []).append(cd)
        except Exception as exc:
            logger.warning("名称→code 索引构建失败: %s", exc)
        _NAME_INDEX, _NAME_INDEX_TS = idx, now
    return _NAME_INDEX


def resolve_company_codes(name: str, limit: int = 3) -> list[str]:
    """公司中文名 → 可能的 6 位 A 股 code。精确匹配优先，再试去常见后缀模糊。
    重名返回多个候选；找不到返回空。"""
    if not name:
        return []
    idx = _name_to_code_index()
    nm = str(name).strip()
    cands = idx.get(nm) or []
    if cands:
        return cands[:limit]
    base = re.sub(r"(股份有限公司|有限公司|股份公司|控股公司|集团公司|公司|集团|股份|控股|科技)$", "", nm)
    if base and base != nm:
        cands = idx.get(base) or []
        if cands:
            return cands[:limit]
    return []


# ---- 资金流 -------------------------------------------------------------

_fund_cache: dict[str, tuple[float, float]] = {}  # code -> (ts, value_yi)
_fund_fail_ts: dict[str, float] = {}  # code -> 失败时间戳（东财限流时 60s 内不再重试）
_FUND_FAIL_TTL = 60.0


def get_fund_flow(code: str) -> float | None:
    """最近交易日主力净流入（亿元）。best-effort，失败返回 None（60s 内不重试）。"""
    if not settings.fund_flow_enabled:
        return None
    now = time.time()
    hit = _fund_cache.get(code)
    if hit and (now - hit[0]) < settings.fund_flow_ttl:
        return hit[1]
    fail_ts = _fund_fail_ts.get(code)
    if fail_ts and (now - fail_ts) < _FUND_FAIL_TTL:
        return None
    try:
        secid = ("1." if code.startswith("6") else "0.") + code
        # 快速失败（timeout=5 retries=0 = 3 子域各 1 次），东财限流时 ~1s 放弃，不拖住 /overview
        j = _http_get("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get", {
            "lmt": "0", "klt": "101", "secid": secid,
            "fields1": "f1,f2,f3,f7",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
        }, timeout=5, retries=0).json()
        klines = ((j or {}).get("data") or {}).get("klines") or []
        if not klines:
            return None
        value = _num(klines[-1].split(",")[1])  # f52 主力净流入净额（元）
        if value is None:
            return None
        yi = round(value / 1e8, 3)
        _fund_cache[code] = (now, yi)
        _fund_fail_ts.pop(code, None)
        return yi
    except Exception as exc:
        logger.warning("主力净流入 %s 拉取失败: %s", code, exc)
        _fund_fail_ts[code] = now
        return None


# ---- K 线 ---------------------------------------------------------------

_KLINE_CACHE: dict[tuple[str, int], tuple[float, pd.DataFrame]] = {}
_KLINE_FLIGHTS: dict[tuple[str, int], Future] = {}
_KLINE_LOCK = threading.RLock()
_KLINE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="kline-refresh")
_KLINE_CLOCK = time.monotonic

_POINT_QUOTE_CACHE: dict[str, tuple[float, dict]] = {}
_POINT_QUOTE_FLIGHTS: dict[str, Future] = {}
_POINT_QUOTE_LOCK = threading.RLock()
_POINT_QUOTE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="quote-name")


class KlineDeadlineExceeded(TimeoutError):
    """冷 K 线请求超过前台等待预算，后台 single-flight 仍继续刷新。"""


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


def _fetch_kline_uncached(code: str, lookback: int = 120) -> pd.DataFrame | None:
    """前复权日线，返回列 date/open/close/high/low/volume/amount（升序）。
    主源新浪（稳定）→ 东财 push2his → baostock，逐级降级。无数据返回 None。"""
    today = date.today()
    start = today - timedelta(days=int(lookback * 1.5))
    start_s, end_s = start.strftime("%Y%m%d"), today.strftime("%Y%m%d")

    rows = None
    try:
        rows = _sina_kline(_sina_sym(code), lookback)
    except Exception as exc:
        logger.warning("新浪K线 %s 失败: %s", code, exc)
    if rows:
        df = pd.DataFrame(rows).tail(lookback)
        df = df.dropna(subset=["open", "close", "high", "low"])
        return df.reset_index(drop=True)

    try:
        j = _http_get("https://push2his.eastmoney.com/api/qt/stock/kline/get", {
            "secid": _secid(code),
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101", "fqt": "1", "beg": start_s, "end": end_s,
        }, timeout=settings.kline_source_timeout, retries=0).json()
        klines = ((j or {}).get("data") or {}).get("klines") or []
        if klines:
            rows = []
            for line in klines:
                p = line.split(",")
                if len(p) >= 7:
                    rows.append({
                        "date": p[0], "open": _num(p[1]), "close": _num(p[2]),
                        "high": _num(p[3]), "low": _num(p[4]),
                        "volume": _num(p[5]), "amount": _num(p[6]),
                    })
            df = pd.DataFrame(rows).tail(lookback)
            df = df.dropna(subset=["open", "close", "high", "low"])
            return df.reset_index(drop=True)
    except Exception as exc:
        logger.warning("东财K线直连 %s 失败，降级 baostock: %s", code, exc)

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


def _finish_kline_refresh(key: tuple[str, int], future: Future) -> None:
    try:
        result = future.result()
    except Exception as exc:
        logger.warning("K线后台刷新 %s 失败: %s", key[0], exc)
        result = None
    with _KLINE_LOCK:
        if result is not None and not result.empty:
            _KLINE_CACHE[key] = (_KLINE_CLOCK(), result.copy(deep=True))
        if _KLINE_FLIGHTS.get(key) is future:
            _KLINE_FLIGHTS.pop(key, None)


def _start_kline_refresh(key: tuple[str, int]) -> Future:
    future = _KLINE_FLIGHTS.get(key)
    if future is None:
        future = _KLINE_EXECUTOR.submit(_fetch_kline_uncached, key[0], key[1])
        _KLINE_FLIGHTS[key] = future
        future.add_done_callback(lambda done: _finish_kline_refresh(key, done))
    return future


def get_kline(code: str, lookback: int = 120) -> pd.DataFrame | None:
    """以短冷请求 deadline 读取 K 线，复用 TTL/stale cache 与并发 single-flight。

    fresh cache 直接返回；stale cache 立即返回并后台刷新。冷请求超过 deadline
    抛出 KlineDeadlineExceeded，但唯一后台 flight 会继续填充缓存，后续请求可直接命中。
    """
    key = (code, lookback)
    now = _KLINE_CLOCK()
    with _KLINE_LOCK:
        cached = _KLINE_CACHE.get(key)
        age = (now - cached[0]) if cached else None
        if cached and age is not None and age <= settings.kline_cache_ttl:
            return cached[1].copy(deep=True)
        future = _start_kline_refresh(key)
        if cached and age is not None and age <= settings.kline_stale_ttl:
            return cached[1].copy(deep=True)
    try:
        result = future.result(timeout=max(0.0, settings.kline_cold_deadline))
    except FutureTimeout:
        raise KlineDeadlineExceeded(f"{code} K线冷请求超过前台等待预算")
    except Exception as exc:
        logger.warning("K线冷请求 %s 失败: %s", code, exc)
        return None
    if result is None or result.empty:
        return None
    return result.copy(deep=True)


def _fetch_point_quote(code: str) -> dict | None:
    rows = _ulist([code]) or _sina_hq([code])
    return rows.get(code)


def _finish_point_quote(code: str, future: Future) -> None:
    try:
        result = future.result()
    except Exception as exc:
        logger.warning("名称行情后台刷新 %s 失败: %s", code, exc)
        result = None
    with _POINT_QUOTE_LOCK:
        if result:
            _POINT_QUOTE_CACHE[code] = (_KLINE_CLOCK(), dict(result))
        if _POINT_QUOTE_FLIGHTS.get(code) is future:
            _POINT_QUOTE_FLIGHTS.pop(code, None)


def get_quote_bounded(code: str) -> dict | None:
    """短 deadline 获取技术信号展示名；超时不阻塞技术指标响应。"""
    now = _KLINE_CLOCK()
    with _POINT_QUOTE_LOCK:
        cached = _POINT_QUOTE_CACHE.get(code)
        if cached and (now - cached[0]) <= settings.kline_stale_ttl:
            return dict(cached[1])
        future = _POINT_QUOTE_FLIGHTS.get(code)
        if future is None:
            future = _POINT_QUOTE_EXECUTOR.submit(_fetch_point_quote, code)
            _POINT_QUOTE_FLIGHTS[code] = future
            future.add_done_callback(lambda done: _finish_point_quote(code, done))
    try:
        result = future.result(timeout=max(0.0, settings.quote_name_deadline))
    except Exception:
        return None
    return dict(result) if result else None


# ---- 交易日历 ------------------------------------------------------------


def _calendar() -> list[str]:
    """交易日列表（升序）。按序返回才能取最新交易日。"""
    global _CALENDAR_CACHE, _CALENDAR_TS
    now = time.time()
    if _CALENDAR_TS and (now - _CALENDAR_TS) < _DAY_CAL_TTL:
        return _CALENDAR_CACHE or []
    try:
        # 新浪交易日历纯文本（每行 YYYYMMDD），直连替代 akshare（避免走系统代理卡死）
        txt = _http_get("https://finance.sina.com.cn/realstock/company/klc_td_sh.txt").text
        raw = sorted({ln.strip() for ln in txt.splitlines() if len(ln.strip()) == 8 and ln.strip().isdigit()})
        dates = [f"{r[:4]}-{r[4:6]}-{r[6:]}" for r in raw]  # 转 YYYY-MM-DD（与 akshare 原格式一致）
        if dates:
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
