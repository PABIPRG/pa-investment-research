# -*- coding: utf-8 -*-
"""BriefRunner：盘前/盘后市场简报 + 事件驱动机会点挖掘（功能4）。

数据原语（本机实测可用，eastmoney push2 被墙处已避开）：
  指数        stock_zh_index_spot_sina（新浪）
  涨跌家数    stock_market_activity_legu（乐咕，含涨跌停/活跃度）
  板块        stock_sector_spot(新浪行业)（新浪）
  北向        stock_hsgt_fund_flow_summary_em（东财，亿）
  龙虎榜      stock_lhb_detail_em（东财）
  资讯        stock_info_global_cls（财联社，快）+ stock_news_main_cx（财新，慢，可选）
  交易日历    tool_trade_date_hist_sina（新浪，供 scheduler 判交易日/幂等）
  自选股行情  baostock 前复权日线（与引擎一致，稳定）

流程：拉数据 → 规则挖机会点 → LLM 生成 Markdown → 落 store（(period, trade_date) 幂等）。
LLM 不可用时降级为确定性模板，保证简报始终可用。
"""

import json
import logging
from datetime import datetime

from .holdings_runner import _bs_hist
from .llm import summarize
from .risk_profiles import get_risk_profile, profile
from .store import JsonStore

logger = logging.getLogger("adapter.brief")

# 关键指数（名称 → 新浪代码）
MAIN_INDICES = {
    "上证指数": "sh000001",
    "深证成指": "sz399001",
    "创业板指": "sz399006",
    "沪深300": "sh000300",
    "上证50": "sh000016",
    "科创50": "sh000688",
}
PERIOD_LABEL = {"pre_market": "盘前", "post_market": "盘后", "now": "盘中"}

# 机会点 kind → 风险等级（低/中/高）
KIND_RISK = {
    "northbound": "低",       # 北向资金异动：趋势性、可跟踪
    "watchlist_move": "中",   # 自选股异动：个股波动，中性
    "sector": "中",           # 板块涨跌：轮动信号
    "news_event": "中",       # 事件驱动：题材，需甄别
    "lhb": "高",              # 龙虎榜：投机资金博弈
    "market_heat": "高",      # 市场过热：情绪顶风险
    "market_risk": "高",      # 风险释放：系统性下行
}
RISK_ORDER = {"低": 0, "中": 1, "高": 2}
# profile["brief_max_risk"]（low/medium/high）→ 中文等级
_MAX_RISK = {"low": "低", "medium": "中", "high": "高"}


# ---- 基础工具 -----------------------------------------------------------


def _to_yi(value) -> float | None:
    """把 '1.23亿'/'4567万'/数字 统一转成 亿元；失败返回 None。"""
    if value is None:
        return None
    s = str(value).strip()
    try:
        if s.endswith("亿"):
            return float(s[:-1])
        if s.endswith("万"):
            return float(s[:-1]) / 10000.0
        f = float(s)
        # 东财成交净买额本身是亿单位，龙虎榜净买额是元 → 统一转亿
        return f
    except ValueError:
        return None


def _latest_trade_date() -> str:
    """最近交易日（≤今天）YYYY-MM-DD。"""
    import akshare as ak

    cal = ak.tool_trade_date_hist_sina()
    today = datetime.now().strftime("%Y-%m-%d")
    dates = [d for d in cal["trade_date"].astype(str).tolist() if d <= today]
    return dates[-1] if dates else today


def _is_trading_day(d: str) -> bool:
    import akshare as ak

    cal = ak.tool_trade_date_hist_sina()
    return d in set(cal["trade_date"].astype(str))


# ---- 数据原语 -----------------------------------------------------------


def _indices_spot() -> list[dict]:
    import akshare as ak

    df = ak.stock_zh_index_spot_sina()
    rows = []
    for code, name, price, pct in df[["代码", "名称", "最新价", "涨跌幅"]].itertuples(index=False):
        if code in MAIN_INDICES.values():
            rows.append({"name": name, "code": code, "price": float(price), "pct": float(pct)})
    return rows


def _market_activity() -> dict:
    import akshare as ak

    df = ak.stock_market_activity_legu()
    out = {}
    for item, value in df[["item", "value"]].itertuples(index=False):
        out[str(item)] = value
    act = str(out.get("活跃度", "")).replace("%", "")
    out["活跃度"] = float(act) if act else None
    return out


def _sector_spot() -> list[dict]:
    import akshare as ak

    df = ak.stock_sector_spot(indicator="新浪行业")
    rows = []
    for r in df.to_dict("records"):
        pct = r.get("涨跌幅")
        if pct is None:
            continue
        rows.append({"name": str(r.get("板块") or ""), "pct": float(pct)})
    rows.sort(key=lambda r: r["pct"], reverse=True)
    return rows


def _northbound() -> list[dict]:
    import akshare as ak

    df = ak.stock_hsgt_fund_flow_summary_em()
    rows = []
    for r in df.to_dict("records"):
        if r.get("资金方向") != "北向":
            continue
        rows.append({"board": r.get("板块"), "net_yi": _to_yi(r.get("成交净买额"))})
    return rows


def _lhb_today() -> list[dict]:
    import akshare as ak

    today = datetime.now().strftime("%Y%m%d")
    try:
        df = ak.stock_lhb_detail_em(start_date=today, end_date=today)
    except Exception as exc:
        logger.warning("龙虎榜拉取失败: %s", exc)
        return []
    rows = []
    for r in df.to_dict("records"):
        net = _to_yi(r.get("龙虎榜净买额"))
        if net is None:
            continue
        rows.append({
            "code": str(r.get("代码") or ""),
            "name": str(r.get("名称") or ""),
            "pct": float(r.get("涨跌幅") or 0.0),
            "net_yi": net,
        })
    rows.sort(key=lambda r: r["net_yi"] or 0, reverse=True)
    return rows[:8]


def _news() -> list[dict]:
    """财联社资讯（列: 标题/内容/发布日期/发布时间）。逐行转 str 防类型坑。"""
    import akshare as ak

    items = []
    try:
        df = ak.stock_info_global_cls(symbol="全部")
        for r in df.to_dict("records"):
            title = str(r.get("标题") or "").strip() or str(r.get("内容") or "").strip()
            if not title:
                continue
            items.append({
                "title": title,
                "source": "财联社",
                "time": f"{r.get('发布日期')} {r.get('发布时间')}".strip(),
            })
    except Exception as exc:
        logger.warning("财联社资讯拉取失败: %s", exc)
    return items[:20]


def _watchlist_quotes(tickers: list[str]) -> list[dict]:
    """自选股最新收盘（baostock 前复权，取最近两日算涨跌幅）。"""
    from datetime import date, timedelta

    from .holdings_runner import _a_share_code, HoldingDataError

    end = date.today().isoformat()
    start = (date.today() - timedelta(days=30)).isoformat()
    out = []
    for t in tickers:
        try:
            rows = _bs_hist(_a_share_code(t), start, end)
            if len(rows) < 2:
                continue
            prev, last = rows[-2]["close"], rows[-1]["close"]
            pct = (last / prev - 1.0) * 100 if prev else 0.0
            out.append({"ticker": t, "last_close": last, "prev_close": prev, "pct": pct})
        except (HoldingDataError, Exception):
            logger.warning("自选股 %s 行情拉取失败，跳过", t)
    return out


def _scope_flags(scope: str) -> dict:
    """scope → 需要拉取的模块。all 全拉。"""
    if scope == "all":
        return {"indices": True, "activity": True, "sector": True, "northbound": True,
                "lhb": True, "news": True, "watchlist": True}
    flags = {"indices": True, "activity": True, "sector": False, "northbound": False,
             "lhb": False, "news": False, "watchlist": False}
    if scope in ("market", "industry", "concept"):
        flags["sector"] = True
    if scope == "news":
        flags["news"] = True
    if scope == "watchlist":
        flags["watchlist"] = True
    return flags


# ---- 机会点挖掘 ---------------------------------------------------------


def _mine_opportunities(data: dict, tickers: list[str]) -> list[dict]:
    """挖掘机会点，每条约打上风险等级（低/中/高，按 kind）。"""
    opps = []

    def make(kind: str, **kw) -> dict:
        return {"kind": kind, "risk_level": KIND_RISK.get(kind, "中"), **kw}

    # 1) 自选股异动（±4%）
    for w in data.get("watchlist") or []:
        if abs(w["pct"]) >= 4:
            kind = "大涨" if w["pct"] > 0 else "大跌"
            opps.append(make(
                "watchlist_move",
                ticker=w["ticker"],
                title=f"自选股{w['ticker']}{kind} {w['pct']:+.1f}%（收 {w['last_close']:.2f}）",
            ))

    # 2) 龙虎榜主力净买入（>1 亿）
    for r in (data.get("lhb") or [])[:5]:
        if r["net_yi"] and r["net_yi"] >= 1:
            opps.append(make(
                "lhb",
                ticker=r["code"],
                title=f"龙虎榜净买入 {r['net_yi']:.2f} 亿（{r['name']} {r['pct']:+.1f}%）",
            ))

    # 3) 北向净流入异动（>20 亿）
    for r in data.get("northbound") or []:
        if r["net_yi"] is not None and abs(r["net_yi"]) >= 20:
            d = "净流入" if r["net_yi"] > 0 else "净流出"
            opps.append(make(
                "northbound",
                title=f"{r['board']}{d} {abs(r['net_yi']):.1f} 亿",
            ))

    # 4) 板块异动（涨幅/跌幅前3）
    sectors = data.get("sector") or []
    for r in sectors[:3]:
        opps.append(make("sector", title=f"板块走强 {r['name']} +{r['pct']:.1f}%"))
    for r in sectors[-3:]:
        if r["pct"] < 0:
            opps.append(make("sector", title=f"板块走弱 {r['name']} {r['pct']:.1f}%"))

    # 5) 资讯关键词事件
    kw = ("重组", "并购", "中标", "减持", "增持", "业绩", "涨停", "监管", "政策", "获批", "回购")
    for n in (data.get("news") or [])[:15]:
        text = n.get("title", "")
        hit = [k for k in kw if k in text]
        if hit:
            opps.append(make("news_event", title=f"[{'/'.join(hit[:2])}] {text[:60]}"))

    # 6) 市场温度：涨停/跌停家数
    act = data.get("activity") or {}
    zt = act.get("涨停") or 0
    dt = act.get("跌停") or 0
    if zt and zt >= 80:
        opps.append(make("market_heat", title=f"市场情绪偏热：涨停 {int(zt)} 家"))
    if dt and dt >= 30:
        opps.append(make("market_risk", title=f"市场风险释放：跌停 {int(dt)} 家"))

    return opps


def _apply_profile(opps: list[dict], profile_key: str) -> list[dict]:
    """按风险画像过滤 + 排序机会点。

    保守档（brief_max_risk=medium）只保留 ≤中 风险项；进取档把高风险机会置顶。
    """
    max_risk = _MAX_RISK.get(profile(profile_key)["brief_max_risk"], "高")
    keep = [o for o in opps if RISK_ORDER[o.get("risk_level", "中")] <= RISK_ORDER[max_risk]]
    if profile_key == "aggressive":
        keep.sort(key=lambda o: RISK_ORDER[o.get("risk_level", "中")], reverse=True)
    return keep


# ---- LLM 简报 -----------------------------------------------------------


def _build_prompt(period: str, data: dict, opps: list[dict], tickers: list[str],
                  profile_key: str = "balanced") -> tuple[str, str]:
    block = {
        "period": period,
        "指数": data.get("indices"),
        "市场活跃度": data.get("activity"),
        "板块涨跌幅TOP5": data.get("sector")[:5] if data.get("sector") else [],
        "北向资金": data.get("northbound"),
        "龙虎榜": data.get("lhb")[:5] if data.get("lhb") else [],
        "资讯": [n["title"] for n in (data.get("news") or [])][:10],
        "自选股": data.get("watchlist"),
        "机会点": opps,
    }
    label = PERIOD_LABEL.get(period, "盘中")
    pf = profile(profile_key)
    max_risk = _MAX_RISK.get(pf["brief_max_risk"], "高")
    system = (
        "你是A股专业播报助手。根据提供的结构化行情数据，输出简洁的中文Markdown简报。"
        f"标题用『{label}简报 · YYYY-MM-DD』。结构：## 市场概览 / ## 板块动向 / "
        "## 资金与龙虎榜 / ## 自选股 / ## 机会点（逐条列出，附代码/方向/理由/风险等级）。"
        "只陈述数据呈现的事实，不臆测、不荐股、不编造不存在的数字；数字一律保留原有量纲。"
        f"【面向{label}{pf['label']}投资者】机会点已标注风险等级（低/中/高），"
        f"简报只展示 ≤{max_risk} 风险的机会点；请在每条机会点后给出一条与该档风险偏好相称的风险提示。"
    )
    return system, json.dumps(block, ensure_ascii=False, indent=1)


def _summarize(period: str, data: dict, opps: list[dict], tickers: list[str],
               profile_key: str = "balanced") -> str:
    system, user = _build_prompt(period, data, opps, tickers, profile_key)
    try:
        md = summarize(system, user)
        if md:
            return md
    except Exception as exc:
        logger.warning("简报 LLM 生成失败，降级模板: %s", exc)
    return _fallback_markdown(period, data, opps, profile_key)


def _fallback_markdown(period: str, data: dict, opps: list[dict],
                       profile_key: str = "balanced") -> str:
    """LLM 不可用时的确定性模板简报。"""
    today = datetime.now().strftime("%Y-%m-%d")
    pf = profile(profile_key)
    lines = [f"# {PERIOD_LABEL.get(period, '盘中')}简报 · {today}", ""]
    lines.append(f"**风险画像：{pf['label']}**")
    lines.append("## 市场概览")
    for ix in data.get("indices") or []:
        lines.append(f"- {ix['name']} {ix['price']:.2f}（{ix['pct']:+.2f}%）")
    act = data.get("activity") or {}
    lines.append(f"- 上涨 {act.get('上涨', 0)} / 下跌 {act.get('下跌', 0)} / 涨停 {act.get('涨停', 0)} / 跌停 {act.get('跌停', 0)}")
    lines.append("")
    if data.get("sector"):
        lines.append("## 板块动向")
        for r in data["sector"][:5]:
            lines.append(f"- {r['name']} {r['pct']:+.1f}%")
        lines.append("")
    if opps:
        lines.append("## 机会点")
        for o in opps:
            lv = o.get("risk_level", "中")
            lines.append(f"- [{lv}] {o['title']}")
    lines.append("")
    lines.append("> 由确定性模板生成（LLM 未配置）。")
    return "\n".join(lines)


class BriefRunner:
    """真简报 runner：与 FakeBriefRunner 同接口。"""

    name = "brief-engine"

    def __init__(self):
        self.store = JsonStore()

    def run(self, params: dict, progress_cb) -> dict:
        period = params.get("period", "now")
        scope = params.get("scope", "all")
        profile_key = get_risk_profile(params)
        tickers = params.get("tickers") or self.store.get("watchlist", "default", []) or []
        flags = _scope_flags(scope)
        trade_date = _latest_trade_date()

        data = {}
        if flags["indices"]:
            progress_cb("🌏 拉取指数与市场概况…")
            data["indices"] = _indices_spot()
            data["activity"] = _market_activity()
        if flags["sector"]:
            progress_cb("🧩 拉取板块行情…")
            data["sector"] = _sector_spot()
        if flags["northbound"]:
            progress_cb("🧭 拉取北向资金…")
            data["northbound"] = _northbound()
        if flags["lhb"]:
            progress_cb("🔥 拉取龙虎榜…")
            data["lhb"] = _lhb_today()
        if flags["news"]:
            progress_cb("📰 汇总资讯…")
            data["news"] = _news()
        if flags["watchlist"]:
            progress_cb("⭐ 拉取自选股行情…")
            data["watchlist"] = _watchlist_quotes(tickers)

        progress_cb("🎯 挖掘事件驱动机会点…")
        opps = _mine_opportunities(data, tickers)
        opps = _apply_profile(opps, profile_key)
        progress_cb(f"🤖 LLM 生成 {PERIOD_LABEL.get(period, '盘中')}简报（{profile(profile_key)['label']}视角）…")
        md = _summarize(period, data, opps, tickers, profile_key)

        # 落 store（幂等 key）
        key = f"{period}:{trade_date}"
        record = {
            "id": key,
            "period": period,
            "trade_date": trade_date,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "summary": md,
            "opportunities": opps,
            "scope": scope,
            "risk_profile": profile_key,
            "dsh_pushed": False,
        }
        self.store.set("briefs", key, record)
        self.store.set("briefs", "latest", key)
        progress_cb("✅ 简报生成完成")

        return {
            "signal": {
                "signal_type": "brief",
                "period": period,
                "trade_date": trade_date,
                "summary": md,
                "opportunities": opps,
                "risk_profile": profile_key,
            },
            "reports": {"brief": md},
            "performance_metrics": {},
        }
