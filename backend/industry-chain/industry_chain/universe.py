# -*- coding: utf-8 -*-
"""全 A 股兜底清单：东财行情列表接口（clist）拉全量 A 股基础档案。

覆盖现实：A 股 5000+ 家，仅约 3000-4000 家有券商研报。本模块提供全 A 股
基础档案（代码/名称/行业/市值/板块），保证「能点击的 A 股公司」至少有档案；
深度产业链关系由研报管线（reports.py / extract.py / merge.py）在核心公司上叠加。

数据流：东财 push2 clist 分页拉取 → data/a_share_universe.json（不在 git）。
只读查询不落盘时用 universe_index()（lru_cache）。
"""

import json
import time
from functools import lru_cache

import requests

from .config import settings

UNIVERSE_PATH = settings.root / "data" / "a_share_universe.json"

# push2delay 节点实测可达（push2.eastmoney.com 域名在本环境被重置）
_CLIST_URL = "https://push2delay.eastmoney.com/api/qt/clist/get"
# 深主板 / 创业板 / 沪主板 / 科创板 / 北交所（akshare stock_zh_a_spot_em 同源）
_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
# f12=code f13=市场 f14=name f20=总市值 f100=行业
_FIELDS = "f12,f13,f14,f20,f100"
_PAGE_SIZE = 100  # push2delay 单页上限 100

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.eastmoney.com/",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def _market_cap_yi(v):
    """总市值归一化为亿元。

    push2delay 返回整数元（如 3879091392466），akshare 的 fltt=2 则返回亿字符串。
    >=1e8 视为元（除 1e8 转亿元），否则视为已是亿元。
    """
    if v in (None, "-", ""):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f >= 1e8:
        return round(f / 1e8, 2)
    return round(f, 2)


def _board(code: str) -> str:
    """按代码段判断所属板块（北交所 8/4/92 段、科创板 688/689、创业板 300/301/302）。"""
    if code.startswith(("4", "8", "92")):
        return "北交所"
    if code.startswith(("688", "689")):
        return "科创板"
    if code.startswith(("300", "301", "302")):
        return "创业板"
    if code.startswith(("600", "601", "603", "605")):
        return "沪主板"
    if code.startswith(("000", "001", "002", "003")):
        return "深主板"
    return "其他"


def _get_json(params: dict) -> dict | None:
    """带浏览器头 + 失败退避的 clist 请求（SSL 错误重试，参照 akshare provider）。"""
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(_CLIST_URL, params=params, headers=_HEADERS, timeout=15)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"东财 clist 拉取失败: {last}")


def fetch_universe(force: bool = False) -> list[dict]:
    """拉取全 A 股清单到 data/a_share_universe.json。已存在且非 force 则直接读本地。"""
    if UNIVERSE_PATH.is_file() and not force:
        return load_rows()
    rows: list[dict] = []
    pn = 1
    while True:
        params = {
            "pn": pn, "pz": _PAGE_SIZE, "po": 1, "np": 1, "fltt": 2, "invt": 2,
            "fid": "f20", "fs": _FS, "fields": _FIELDS,
        }
        d = (_get_json(params) or {}).get("data") or {}
        diff = d.get("diff") or []
        if not diff:
            break
        for it in diff:
            code = it.get("f12")
            if not code:
                continue
            rows.append(
                {
                    "code": code,
                    "name": it.get("f14"),
                    "industry": it.get("f100") or "",
                    "market_cap": _market_cap_yi(it.get("f20")),  # 亿元
                    "board": _board(code),
                }
            )
        total = d.get("total") or 0
        if pn * _PAGE_SIZE >= total:
            break
        pn += 1
        time.sleep(0.5)  # 东财限速
    UNIVERSE_PATH.parent.mkdir(parents=True, exist_ok=True)
    UNIVERSE_PATH.write_text(
        json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return rows


def load_rows() -> list[dict]:
    with open(UNIVERSE_PATH, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def universe_index() -> dict[str, dict]:
    """code → 基础档案 dict（图模块查询用）。清单缺失/未拉取时返回空 dict。"""
    if not UNIVERSE_PATH.is_file():
        return {}
    return {r["code"]: r for r in load_rows()}
