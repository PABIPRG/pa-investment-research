# -*- coding: utf-8 -*-
"""研报抓取层：东财 reportapi 列表 + 详情页 HTML 正文提取。

数据流：reportapi list（按公司 code 过滤近 N 天）→ infoCode 列表
      → data.eastmoney.com/report/info/{infoCode}.html → <p> 段落正文
落盘：data/reports/{code}/{infoCode}.html（正文纯文本段）+ meta.json（标题/机构/日期/评级）
反爬：东财请求串行间隔 ≥0.6s、浏览器 UA/Referer、失败指数退避。
注意：东财详情页 HTML 含全文正文，无需突破 PDF 反爬。
"""

import json
import re
import time
from datetime import date, timedelta

import requests

from .config import settings

REPORTS_DIR = settings.root / "data" / "reports"

# 东财请求串行节流（进程级），reportapi 与详情页共用
_MIN_INTERVAL = 0.6
_last_ts: dict[str, float] = {"t": 0.0}

_LIST_URL = "https://reportapi.eastmoney.com/report/list"
_DETAIL_URL = "https://data.eastmoney.com/report/info/{info_code}.html"
_PAGE_SIZE = 50

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://data.eastmoney.com/report/industry.jshtml",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 页面尾部噪声段落（正文结束后出现的组件标题）
_NOISE_STARTS = ("郑重声明", "最新研究报告", "买入评级个股", "数据来源", "盈利预测排行")


def _throttle() -> None:
    now = time.time()
    wait = _MIN_INTERVAL - (now - _last_ts["t"])
    if wait > 0:
        time.sleep(wait)
    _last_ts["t"] = time.time()


def _get_json(url: str, params: dict) -> dict:
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=_HEADERS, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"东财请求失败: {url} -> {last}")


def fetch_report_list(code: str, days: int = 365) -> list[dict]:
    """某公司近 N 天研报列表（标题/机构/日期/评级/行业）。"""
    _throttle()
    end = date.today()
    begin = end - timedelta(days=days)
    rows: list[dict] = []
    pn = 1
    while True:
        params = {
            "industryCode": "*", "pageSize": _PAGE_SIZE, "industry": "*",
            "rating": "*", "ratingChange": "*",
            "beginTime": begin.strftime("%Y-%m-%d"),
            "endTime": end.strftime("%Y-%m-%d"),
            "pageNo": pn, "qType": 0, "code": code, "codeType": "1",
        }
        data = _get_json(_LIST_URL, params)
        items = data.get("data") or []
        for it in items:
            rows.append(
                {
                    "infoCode": it.get("infoCode"),
                    "title": it.get("title"),
                    "org": it.get("orgSName"),
                    "publish_date": (it.get("publishDate") or "")[:10],
                    "rating": it.get("emRatingName"),
                    "researcher": it.get("researcher"),
                    "industry": it.get("indvInduName"),
                    "eps_this_year": it.get("predictThisYearEps"),
                    "pe_this_year": it.get("predictThisYearPe"),
                }
            )
        total = data.get("hits") or 0
        if pn * _PAGE_SIZE >= total or not items:
            break
        pn += 1
        _throttle()
    return rows


def extract_body(html: str) -> list[str]:
    """详情页 HTML → 正文段落（去标签、滤空、滤尾部噪声）。"""
    ps = re.findall(r"<p[^>]*>(.*?)</p>", html, re.S)
    out: list[str] = []
    for p in ps:
        text = re.sub(r"<[^>]+>", "", p)
        text = text.replace("&nbsp;", " ").strip()
        if len(text) < 6:
            continue
        out.append(text)
    cut = next((i for i, t in enumerate(out) if t.startswith(_NOISE_STARTS)), None)
    if cut is not None:
        out = out[:cut]
    return out


def fetch_report_body(info_code: str) -> list[str]:
    """详情页 → 正文段落（串行限速 + 失败退避）。"""
    _throttle()
    url = _DETAIL_URL.format(info_code=info_code)
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers=_HEADERS, timeout=20)
            r.raise_for_status()
            return extract_body(r.text)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"研报详情页失败: {url} -> {last}")


def download_company_reports(code: str, days: int = 365) -> list[dict]:
    """下载某公司全部研报 → data/reports/{code}/，返回 meta 列表（含正文段落）。"""
    reports = fetch_report_list(code, days)
    out_dir = REPORTS_DIR / code
    out_dir.mkdir(parents=True, exist_ok=True)
    meta: list[dict] = []
    for rep in reports:
        body = fetch_report_body(rep["infoCode"])
        rep["_body"] = body  # 内存携带正文，同时落盘一份
        (out_dir / f"{rep['infoCode']}.html").write_text(
            "\n".join(body), encoding="utf-8"
        )
        meta.append({k: v for k, v in rep.items() if k != "_body"})
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return reports


def load_company_reports(code: str) -> list[dict]:
    """从 data/reports/{code}/ 读已下载研报（meta.json + 各篇 .html 正文）。"""
    out_dir = REPORTS_DIR / code
    meta_path = out_dir / "meta.json"
    if not meta_path.is_file():
        return []
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    for rep in meta:
        body_path = out_dir / f"{rep['infoCode']}.html"
        rep["_body"] = (
            body_path.read_text(encoding="utf-8").splitlines()
            if body_path.is_file()
            else []
        )
    return meta
