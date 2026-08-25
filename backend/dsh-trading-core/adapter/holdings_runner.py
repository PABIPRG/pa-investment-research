# -*- coding: utf-8 -*-
"""HoldingsRunner：持仓风险分析（功能3）。

两级分析：
  L1 定量（always）  逐股 akshare 历史价 → 年化波动率 / 最大回撤 / beta(vs 沪深300)；
                     组合市值 / 成本 / 浮盈 / 权重 / 组合波动率 wᵀΣw / HHI 集中度 / 行业暴露
  L2 深度（deep）    ThreadPoolExecutor(3) 并行跑引擎 standard 深度 → 每股 risk_score / action / confidence

数据源健壮性（本机实测）：
  - push2his.eastmoney.com 直连可用：stock_zh_a_hist（个股前复权）、stock_zh_index_daily_em（沪深300）
  - push2.eastmoney.com 直连被墙：stock_individual_info_em 取行业 → best-effort，失败标 "未知"
  - NO_PROXY 由 adapter/config.py load_dotenv(.env) 统一注入（eastmoney.com 等走直连绕过系统代理）

输出与 FakeHoldingsRunner 同构：{signal, reports{portfolio}, performance_metrics}。
"""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from typing import Callable

from .config import settings
from .risk_profiles import get_risk_profile, profile, risk_level_for
from .schemas import HoldingItem

logger = logging.getLogger("adapter.holdings")

# 历史行情回看天数：约一个交易日历年的交易日数
LOOKBACK_DAYS = 400
# 无风险日收益年化因子
TRADING_DAYS = 252
# 行业数据源可用性（push2 被墙时为 False）
_industry_ok = True
# baostock 全局 socket 非线程安全：本模块内部串行访问
_bs_lock = threading.Lock()

# 持仓 deep 要保留市场、社媒、新闻、基本面四分析师覆盖，但不额外增加辩论轮次。
HOLDINGS_ENGINE_DEPTH = "standard"


class HoldingDataError(RuntimeError):
    """行情数据拉取失败（网络/数据源不可用），向上抛出让任务标记 failed。"""


def _col(df, *names, default=None):
    """按常见列名取列；找不到返回 default。"""
    for n in names:
        if n in df.columns:
            return df[n]
    return default


def _a_share_code(ticker: str) -> str:
    """A 股代码 → baostock 格式（600519→sh.600519，000858→sz.000858）。"""
    t = ticker.strip()
    if t.startswith(("6", "9")):
        return f"sh.{t}"
    if t.startswith(("0", "3", "2")):
        return f"sz.{t}"
    if t.startswith(("4", "8")):
        raise HoldingDataError(f"{ticker} 属北交所，baostock 暂不支持，请改用沪深代码")
    return f"sh.{t}"


def _bs_hist(code: str, start: str, end: str, fields: str = "date,close") -> list:
    """带锁 baostock 前复权日线，返回 [{"date", <各列>}, ...] 升序。

    fields 默认 "date,close"（向后兼容 holdings/brief 调用）；回测引擎用
    "date,open,high,low,close" 取止损/止盈命中所需的 OHLC。数值列为 float，
    停牌/无数据返回 None。网络现实（本机实测）：eastmoney HTTP 间歇性被墙/
    限流，baostock socket 稳定且与引擎数据源一致（data_source_manager 也走 BAOSTOCK）。
    """
    import baostock as bs

    names = [n.strip() for n in fields.split(",") if n.strip()]
    if not names or names[0] != "date":
        raise ValueError(f"baostock fields 必须以 date 开头: {fields!r}")

    with _bs_lock:
        lg = bs.login()
        if lg.error_code != "0":
            raise HoldingDataError(f"baostock 登录失败: {lg.error_msg}")
        try:
            rs = bs.query_history_k_data_plus(
                code, fields,
                start_date=start, end_date=end, frequency="d", adjustflag="2",
            )
            rows = []
            while rs.error_code == "0" and rs.next():
                r = rs.get_row_data()
                if not r or not r[0]:
                    continue
                row: dict = {"date": r[0]}
                for i, name in enumerate(names[1:], start=1):
                    raw = r[i] if i < len(r) else ""
                    if raw in ("", None):
                        row[name] = None
                    else:
                        try:
                            row[name] = float(raw)
                        except (TypeError, ValueError):
                            row[name] = None
                rows.append(row)
            if rs.error_code != "0":
                raise HoldingDataError(f"baostock 查询失败({code}): {rs.error_msg}")
            return rows
        finally:
            bs.logout()


def _fetch_hist(ticker: str) -> "tuple[list, str]":
    """拉取单只股票前复权日线，返回 (rows, error)。失败返回 (None, 原因)。"""
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    try:
        rows = _bs_hist(_a_share_code(ticker), start, end)
        if not rows:
            return None, f"{ticker} 无历史行情（baostock 返回空）"
        return rows, None
    except HoldingDataError as e:
        return None, str(e)
    except Exception as e:  # noqa: BLE001 — 网络抖动等，向上转成可读错误
        return None, f"{ticker} 历史行情拉取失败: {type(e).__name__}"


def _fetch_index_hist() -> list:
    """沪深300 日线（用于 beta），返回 [{"date", "close"}, ...]。失败抛错。"""
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    rows = _bs_hist("sh.000300", start, end)
    if not rows:
        raise HoldingDataError("沪深300 指数历史数据拉取失败")
    return rows


def _try_industry(ticker: str) -> str:
    """best-effort 行业分类（push2 直连被墙时为 '未知'）。"""
    global _industry_ok
    if not _industry_ok:
        return "未知"
    try:
        import warnings

        import akshare as ak

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            info = ak.stock_individual_info_em(symbol=ticker)
        val = dict(zip(info["item"], info["value"])).get("行业", "未知")
        return val if isinstance(val, str) and val else "未知"
    except Exception:
        _industry_ok = False  # 一次失败就降级，避免逐股重试拖慢
        return "未知"


def _compute_l1(hist: list, index: list) -> dict:
    """单只股票的定量指标（无需组合上下文）。"""
    closes = [r["close"] for r in hist]
    n = len(closes)
    if n < 30:
        raise HoldingDataError(f"历史数据不足 30 根（{n}），无法计算风险")
    rets = [closes[i] / closes[i - 1] - 1.0 for i in range(1, n)]
    vol = _std(rets) * (TRADING_DAYS ** 0.5) if rets else 0.0

    # 最大回撤
    peak = closes[0]
    mdd = 0.0
    for c in closes:
        peak = max(peak, c)
        if peak > 0:
            mdd = max(mdd, (peak - c) / peak)

    # beta：与指数对齐日期求日收益协方差/方差
    beta = None
    idx_close = {r["date"]: r["close"] for r in index}
    stock_map = {r["date"]: r["close"] for r in hist}
    common = sorted(set(stock_map) & set(idx_close))
    if len(common) >= 30:
        sr = [stock_map[d] for d in common]
        ir = [idx_close[d] for d in common]
        s_ret = [sr[i] / sr[i - 1] - 1.0 for i in range(1, len(sr))]
        i_ret = [ir[i] / ir[i - 1] - 1.0 for i in range(1, len(ir))]
        if len(s_ret) >= 30:
            var_i = _var(i_ret)
            if var_i > 1e-12:
                beta = _cov(s_ret, i_ret) / var_i

    return {
        "last_price": closes[-1],
        "annualized_vol": vol,
        "max_drawdown": mdd,
        "beta": beta,
        "n_bars": n,
    }


def _std(x: list) -> float:
    n = len(x)
    if n < 2:
        return 0.0
    m = sum(x) / n
    return (sum((v - m) ** 2 for v in x) / (n - 1)) ** 0.5


def _var(x: list) -> float:
    return _std(x) ** 2


def _cov(a: list, b: list) -> float:
    n = len(a)
    if n < 2:
        return 0.0
    ma, mb = sum(a) / n, sum(b) / n
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (n - 1)


class HoldingsRunner:
    """真持仓风险分析 runner：与 FakeHoldingsRunner 同接口。"""

    name = "holdings-analyzer"

    def __init__(self, max_workers: int = 3):
        self.max_workers = max_workers

    def run(self, params: dict, progress_cb: Callable[[str], None]) -> dict:
        mode = params.get("mode", "deep")
        use_saved = params.get("use_saved", True)
        profile_key = get_risk_profile(params)

        # ── resolve 持仓 ─────────────────────────────────────────────
        holdings = [HoldingItem(**h) for h in (params.get("holdings") or [])]
        if not holdings and use_saved:
            from .holdings_providers import get_provider

            provider = get_provider()
            holdings = provider.get_holdings()
        if not holdings:
            raise ValueError(
                "持仓为空：请在请求体提供 holdings（ticker/quantity/cost_price），"
                "或先 POST /holdings/save 保存持仓"
            )
        progress_cb(f"📦 读取持仓：共 {len(holdings)} 只（mode={mode}）")

        # ── L1 定量（always）─────────────────────────────────────────
        index_hist = _fetch_index_hist()
        per_stock: dict[str, dict] = {}
        total_mv = 0.0
        for h in holdings:
            progress_cb(f"📐 计算 {h.ticker} 定量风险（波动率/回撤/beta）…")
            hist, err = _fetch_hist(h.ticker)
            if err:
                raise HoldingDataError(f"{h.ticker}: {err}")
            l1 = _compute_l1(hist, index_hist)
            l1["_hist"] = hist  # 供组合波动率复用，避免二次拉取
            l1["industry"] = _try_industry(h.ticker)
            l1["current_price"] = l1["last_price"]
            l1["market_value"] = l1["last_price"] * h.quantity
            l1["cost"] = h.cost_price * h.quantity
            l1["floating_pnl"] = l1["market_value"] - l1["cost"]
            l1["pnl_pct"] = (l1["floating_pnl"] / l1["cost"]) if l1["cost"] else 0.0
            per_stock[h.ticker] = l1
            total_mv += l1["market_value"]

        for h in holdings:
            per_stock[h.ticker]["weight"] = per_stock[h.ticker]["market_value"] / total_mv if total_mv else 0.0

        # 组合指标（风险分先留待 deep 合并后再算）
        total_cost = sum(p["cost"] for p in per_stock.values())
        floating = total_mv - total_cost
        weights = [per_stock[h.ticker]["weight"] for h in holdings]
        hhi = sum(w * w for w in weights)
        vol = _portfolio_vol(holdings, per_stock)
        sector = _sector_exposure(holdings, per_stock)

        # ── L2 深度（deep 才跑）──────────────────────────────────────
        deep = {}
        if mode == "deep":
            deep = self._l2_deep(holdings, params, progress_cb)
            for h in holdings:
                d = deep.get(h.ticker) or {}
                if "risk_score" in d:
                    per_stock[h.ticker]["risk_score"] = d["risk_score"]

        # 加权风险分：deep 用引擎分，否则退回 L1 波动率折算（0~1）
        weighted_risk = _weighted_risk(holdings, per_stock, mode)

        # 组合风险预算对照（按风险画像）→ 超限项 + 调仓建议
        risk_breaches, rebalance_suggestions = _risk_budget_check(
            per_stock, vol, hhi, profile_key
        )

        from .engine_bridge import resolve_company_name  # lazy: fake 模式不需要
        signal = {
            "signal_type": "portfolio",
            "holdings": [h.model_dump() for h in holdings],
            "mode": mode,
            "risk_profile": profile_key,
            "total_market_value": round(total_mv, 2),
            "total_cost": round(total_cost, 2),
            "floating_pnl": round(floating, 2),
            "floating_pnl_pct": round(floating / total_cost, 4) if total_cost else 0.0,
            "weighted_risk_score": round(weighted_risk, 3),
            "portfolio_annualized_vol": round(vol, 4),
            "concentration_hhi": round(hhi, 3),
            "sector_exposure": sector,
            "risk_breaches": risk_breaches,
            "rebalance_suggestions": rebalance_suggestions,
            "n_positions": len(holdings),
            "per_stock": {
                t: {
                    "name": resolve_company_name(t),
                    "quantity": h.quantity,
                    "cost_price": h.cost_price,
                    "last_price": p["last_price"],
                    "market_value": round(p["market_value"], 2),
                    "floating_pnl": round(p["floating_pnl"], 2),
                    "weight": round(p["weight"], 4),
                    "annualized_vol": round(p["annualized_vol"], 4),
                    "max_drawdown": round(p["max_drawdown"], 4),
                    "beta": round(p["beta"], 3) if p["beta"] is not None else None,
                    "industry": p["industry"],
                    "risk_score": p.get("risk_score"),
                    # 风险等级：deep 用引擎 risk_score，quick 用年化波动率近似
                    "risk_level": risk_level_for(
                        p.get("risk_score") if p.get("risk_score") is not None else p["annualized_vol"],
                        profile_key,
                    ),
                    "action": (deep.get(t) or {}).get("action"),
                    "confidence": (deep.get(t) or {}).get("confidence"),
                    "reasoning": (deep.get(t) or {}).get("reasoning"),
                }
                for t, h, p in ((h.ticker, h, per_stock[h.ticker]) for h in holdings)
            },
        }

        report = _build_report(signal)
        return {
            "signal": signal,
            "reports": {"portfolio": report},
            "performance_metrics": {},
        }

    # ---- L2 深度：逐股引擎并行（standard）─────────────────────────────

    def _l2_deep(self, holdings, params, progress_cb) -> dict:
        from .engine_bridge import EngineRunner  # lazy: fake 模式不需要
        engine = EngineRunner()

        def analyze(h: HoldingItem) -> tuple[str, dict]:
            sub = {
                "ticker": h.ticker,
                "research_depth": HOLDINGS_ENGINE_DEPTH,
                "task_id": f"{params.get('task_id', '')}:{h.ticker}",
                "risk_profile": get_risk_profile(params),  # 逐股引擎沿用同一风险偏好
            }
            ticker = h.ticker

            def sub_cb(msg: str) -> None:
                progress_cb(f"🔍 [{ticker}] {msg}")

            try:
                result = engine.run(sub, sub_cb)
                sig = result.get("signal") or {}
                return ticker, {
                    "risk_score": sig.get("risk_score"),
                    "action": sig.get("action"),
                    "confidence": sig.get("confidence"),
                    "reasoning": sig.get("reasoning"),
                }
            except Exception as e:
                logger.warning("引擎深度分析 %s 失败: %s", ticker, e)
                return ticker, {"error": str(e)}

        progress_cb("🔬 深度模式：逐股跑引擎 standard 分析（四分析师，并行 3）…")
        results = {}
        with ThreadPoolExecutor(max_workers=min(self.max_workers, len(holdings))) as ex:
            futs = {ex.submit(analyze, h): h for h in holdings}
            for fut in as_completed(futs):
                t, res = fut.result()
                results[t] = res
                if "error" in res:
                    progress_cb(f"⚠️ [{t}] 引擎深度分析失败: {res['error'][:80]}")
        progress_cb("✅ 逐股深度分析完成")
        return results


# ---- 组合级计算 -------------------------------------------------------


def _portfolio_vol(holdings, per_stock) -> float:
    """组合年化波动率：对角 Σ（忽略个股协方差），组合方差 = Σ wᵢ²σᵢ²。

    复用 L1 已拉取的前复权收盘序列（存于 per_stock[ticker]["_hist"]），
    对齐各股共同交易日求日收益。对齐不足时回退加权平均波动率。
    """
    weights = [per_stock[h.ticker]["weight"] for h in holdings]
    if not weights:
        return 0.0
    try:
        maps = {h.ticker: {r["date"]: r["close"] for r in per_stock[h.ticker]["_hist"]} for h in holdings}
        common = set.intersection(*[set(v) for v in maps.values()])
        if len(common) < 30:
            raise ValueError(f"对齐交易日不足: {len(common)}")
        dates = sorted(common)
        series = {}
        for t in maps:
            closes = [maps[t][d] for d in dates]
            series[t] = [closes[i] / closes[i - 1] - 1.0 for i in range(1, len(closes))]
        pvar = sum(weights[i] ** 2 * _std(series[h.ticker]) ** 2 for i, h in enumerate(holdings))
        return (pvar * TRADING_DAYS) ** 0.5
    except Exception:
        wvol = sum(w * p["annualized_vol"] for w, p in zip(weights, (per_stock[h.ticker] for h in holdings)))
        return wvol


def _sector_exposure(holdings, per_stock) -> list[dict]:
    """行业暴露：按行业汇总权重（best-effort，未知行业聚为一个桶）。"""
    agg: dict[str, float] = {}
    for h in holdings:
        ind = per_stock[h.ticker].get("industry") or "未知"
        agg[ind] = agg.get(ind, 0.0) + per_stock[h.ticker]["weight"]
    return [
        {"industry": k, "weight": round(v, 4)}
        for k, v in sorted(agg.items(), key=lambda kv: -kv[1])
    ]


def _weighted_risk(holdings, per_stock, mode: str) -> float:
    """加权风险分：deep 用引擎 risk_score，否则用波动率归一（年化波动/1.0 截断）。"""
    wsum = 0.0
    for h in holdings:
        p = per_stock[h.ticker]
        w = p["weight"]
        if mode == "deep" and "risk_score" in p and p["risk_score"] is not None:
            r = min(max(float(p["risk_score"]), 0.0), 1.0)
        else:
            r = min(max(p["annualized_vol"] / 1.0, 0.0), 1.0)  # 年化100%波动≈满分风险
        wsum += w * r
    return wsum


def _risk_budget_check(per_stock: dict, vol: float, hhi: float, profile_key: str) -> tuple[list, list]:
    """组合指标 vs 风险画像预算 → (breaches, rebalance_suggestions)。

    breach: {indicator, label, value, limit, excess}。label 为涉及的个股代码（组合级为空串）。
    """
    budget = profile(profile_key)["risk_budget"]
    breaches: list[dict] = []

    def add(indicator: str, label: str, value, limit: float) -> None:
        if value is not None and value > limit:
            breaches.append({
                "indicator": indicator,
                "label": label,
                "value": round(value, 4),
                "limit": limit,
                "excess": round(value - limit, 4),
            })

    if per_stock:
        w_t = max(per_stock, key=lambda t: per_stock[t]["weight"])
        add("single_stock_weight", w_t, per_stock[w_t]["weight"], budget["single_stock_weight_max"])
        betas = {t: per_stock[t]["beta"] for t in per_stock if per_stock[t].get("beta") is not None}
        if betas:
            b_t = max(betas, key=betas.get)
            add("beta", b_t, betas[b_t], budget["beta_max"])
    add("portfolio_vol", "", vol, budget["portfolio_vol_max"])
    add("hhi", "", hhi, budget["hhi_max"])

    suggestions = []
    for b in breaches:
        if b["indicator"] == "single_stock_weight":
            suggestions.append(
                f"建议减持 {b['label']}，使权重降至 {b['limit'] * 100:.0f}% 以内"
                f"（当前 {b['value'] * 100:.1f}%）"
            )
        elif b["indicator"] == "beta":
            suggestions.append(
                f"组合 β 偏高（{b['label']} β={b['value']:.2f}，预算 {b['limit']:.2f}）："
                f"建议降低高 β 个股仓位或对冲"
            )
        elif b["indicator"] == "portfolio_vol":
            suggestions.append(
                f"组合波动率 {b['value'] * 100:.1f}% 超出预算 {b['limit'] * 100:.0f}%："
                f"建议降低高风险仓位或增配低波动防御资产"
            )
        elif b["indicator"] == "hhi":
            suggestions.append(
                f"集中度 HHI {b['value']:.2f} 超出预算 {b['limit']:.2f}：建议分散到相关性低的标的"
            )
    return breaches, suggestions


_BREACH_LABELS = {
    "single_stock_weight": "单股权重",
    "beta": "组合 β",
    "portfolio_vol": "组合波动率",
    "hhi": "集中度 HHI",
}


def _budget_row(lines: list, label: str, value, limit: float, pct: bool = True) -> None:
    """预算对照表格行。pct=True：value/limit 为 0~1 小数，显示为 %；否则原样。"""
    fmt = (lambda x: f"{x * 100:.1f}%") if pct else (lambda x: f"{x:.3f}" if x < 1 else f"{x:.2f}")
    ok = value is None or value <= limit
    v = fmt(value) if value is not None else "—"
    l = fmt(limit)
    lines.append(f"| {label} | {v} | {l} | {'✅ 达标' if ok else '🚨 超限'} |")


def _breach_text(b: dict) -> str:
    """把一条 breach 渲染成中文说明（_build_report 用）。"""
    ind = b["indicator"]
    name = _BREACH_LABELS.get(ind, ind)
    who = f"（{b['label']}）" if b.get("label") else ""
    if ind == "beta":
        return f"{name}{who} {b['value']:.2f} 超预算 {b['limit']:.2f}"
    if ind == "hhi":
        return f"{name}{who} {b['value']:.3f} 超预算 {b['limit']:.3f}"
    return f"{name}{who} {b['value'] * 100:.1f}% 超预算 {b['limit'] * 100:.0f}%（超 {b['excess'] * 100:.1f}pp）"


def _build_report(signal: dict) -> str:
    s = signal
    lines = [
        "# 持仓风险分析报告",
        "",
        f"- **模式**：{'深度（逐股引擎）' if s.get('mode') == 'deep' else '快速（仅定量）'}",
        f"- **持仓数**：{s['n_positions']}",
        "",
        "## 组合概览",
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        f"| 总市值 | ¥{s['total_market_value']:,.2f} |",
        f"| 总成本 | ¥{s['total_cost']:,.2f} |",
        f"| 浮动盈亏 | ¥{s['floating_pnl']:+,.2f}（{s['floating_pnl_pct'] * 100:.2f}%） |",
        f"| 加权风险分 | **{s['weighted_risk_score']:.2f}**（0 低 ~ 1 高） |",
        f"| 组合年化波动率 | {s['portfolio_annualized_vol'] * 100:.1f}% |",
        f"| 集中度 HHI | {s['concentration_hhi']:.3f}（>0.3 偏高） |",
        "",
        "## 🎯 风险画像与预算对照",
        "",
    ]
    pf = profile(s.get("risk_profile", "balanced"))
    budget = pf["risk_budget"]
    lines += [
        f"**画像：{pf['label']}**（{pf['desc']}）",
        "",
        "| 指标 | 当前 | 预算上限 | 状态 |",
        "|---|---|---|---|",
    ]
    _budget_row(lines, "组合年化波动率", s["portfolio_annualized_vol"], budget["portfolio_vol_max"], pct=True)
    _budget_row(lines, "集中度 HHI", s["concentration_hhi"], budget["hhi_max"], pct=False)
    w_t = max(s["per_stock"], key=lambda t: s["per_stock"][t]["weight"]) if s["per_stock"] else None
    if w_t:
        _budget_row(lines, f"单股权重（{w_t}）", s["per_stock"][w_t]["weight"], budget["single_stock_weight_max"], pct=True)
    betas = {t: s["per_stock"][t]["beta"] for t in s["per_stock"] if s["per_stock"][t].get("beta") is not None}
    if betas:
        b_t = max(betas, key=betas.get)
        _budget_row(lines, f"β（{b_t}）", betas[b_t], budget["beta_max"], pct=False)

    breaches = s.get("risk_breaches") or []
    if breaches:
        lines.append("")
        lines.append("**🚨 超限项：**")
        for b in breaches:
            lines.append(f"- {_breach_text(b)}")
    sugs = s.get("rebalance_suggestions") or []
    if sugs:
        lines.append("")
        lines.append("**调仓建议：**")
        lines += [f"- {g}" for g in sugs]

    lines += [
        "",
        "## 行业暴露",
        "",
        "| 行业 | 权重 |",
        "|---|---|",
    ]
    lines += [f"| {e['industry']} | {e['weight'] * 100:.1f}% |" for e in s["sector_exposure"]]
    lines += [
        "",
        "## 逐股明细",
        "",
        "| 代码 | 名称 | 权重 | 现价 | 市值 | 浮盈 | 年化波动 | 回撤 | β | 行业 | 风险等级 | 风险分 | 信号 |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for t, p in s["per_stock"].items():
        act = p.get("action") or "—"
        lv = p.get("risk_level") or "—"
        rs = f"{p['risk_score']:.2f}" if p.get("risk_score") is not None else "—"
        beta = f"{p['beta']:.2f}" if p.get("beta") is not None else "—"
        lines.append(
            f"| {t} | {p['name']} | {p['weight'] * 100:.1f}% | ¥{p['last_price']:,.2f} | "
            f"¥{p['market_value']:,.0f} | ¥{p['floating_pnl']:+,.0f} | "
            f"{p['annualized_vol'] * 100:.0f}% | {p['max_drawdown'] * 100:.0f}% | {beta} | "
            f"{p['industry']} | {lv} | {rs} | {act} |"
        )
    if any(p.get("reasoning") for p in s["per_stock"].values()):
        lines += ["", "## 逐股深度结论", ""]
        for t, p in s["per_stock"].items():
            if p.get("reasoning"):
                lines.append(f"**{t} {p['name']}**：{p['reasoning'][:200]}")
                lines.append("")
    lines.append("")
    lines.append("> ⚠️ 风险分与信号由引擎 LLM 给出，仅供研究参考，不构成投资建议。")
    return "\n".join(lines)
