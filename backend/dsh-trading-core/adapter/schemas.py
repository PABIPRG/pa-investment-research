# -*- coding: utf-8 -*-
"""Pydantic 模型：请求 / 状态 / 进度事件（API 契约，对应集成方案 §3.1/§3.3）"""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    """POST /analyze 请求体"""

    ticker: str = Field(description="股票代码（如 600519）或名称（如 贵州茅台）")
    date: Optional[str] = Field(
        default=None, description="分析日期 YYYY-MM-DD，可选，默认最近交易日"
    )
    market: str = Field(default="a_shares", description="市场，可选，默认按代码自动识别")
    research_depth: str = Field(
        default="standard",
        description="研究深度: quick/basic/standard/deep/full，可选",
    )
    config_overrides: dict = Field(
        default_factory=dict, description="会话级参数覆盖（辩论轮数等）"
    )
    risk_profile: Optional[Literal["conservative", "balanced", "aggressive"]] = Field(
        default=None, description="风险偏好: conservative/balanced/aggressive；缺省用已保存偏好"
    )


class HoldingItem(BaseModel):
    """单只持仓：代码 + 数量 + 成本价（手动结构化输入）。"""

    ticker: str = Field(description="股票代码（如 600519）")
    quantity: float = Field(gt=0, description="持仓数量（股）")
    cost_price: float = Field(ge=0, description="持仓成本价（元）")


class HoldingsRequest(BaseModel):
    """POST /holdings/analyze 请求体"""

    holdings: Optional[list[HoldingItem]] = Field(
        default=None, description="持仓列表；为空时使用已保存持仓"
    )
    mode: Literal["quick", "deep"] = Field(
        default="deep", description="deep=逐股引擎分析(慢), quick=仅定量风险(秒级)"
    )
    use_saved: bool = Field(
        default=True, description="holdings 为空时是否回退到已保存持仓"
    )
    risk_profile: Optional[Literal["conservative", "balanced", "aggressive"]] = Field(
        default=None, description="风险偏好: conservative/balanced/aggressive；缺省用已保存偏好"
    )


class BriefRequest(BaseModel):
    """POST /brief 请求体（盘前/盘后简报，on-demand）"""

    period: Literal["pre_market", "post_market", "now"] = Field(
        default="now", description="pre_market=盘前, post_market=盘后, now=当前"
    )
    scope: str = Field(
        default="all",
        description="范围: market/industry/concept/news/watchlist/all",
    )
    tickers: Optional[list[str]] = Field(
        default=None, description="覆盖的自选股；为空使用已保存 watchlist"
    )
    risk_profile: Optional[Literal["conservative", "balanced", "aggressive"]] = Field(
        default=None, description="风险偏好: conservative/balanced/aggressive；缺省用已保存偏好"
    )


class BacktestRunRequest(BaseModel):
    """POST /backtest/run 请求体：基于历史决策的前瞻回测。"""

    code: Optional[str] = Field(
        default=None, description="仅回测该股票代码（如 600519）"
    )
    force: bool = Field(
        default=False, description="强制重评估（忽略同版本同窗口的已评估缓存）"
    )
    eval_window_days: int = Field(
        default=10, ge=1, le=120,
        description="评估窗口（入场后前景交易日数）",
    )
    min_age_days: int = Field(
        default=14, ge=0, le=365,
        description="决策最小年龄（自然日）；0=不限制（含今天）",
    )
    analysis_date_from: Optional[str] = Field(
        default=None, description="决策分析日期下界 YYYY-MM-DD"
    )
    analysis_date_to: Optional[str] = Field(
        default=None, description="决策分析日期上界 YYYY-MM-DD"
    )
    limit: int = Field(default=200, ge=1, le=2000, description="最多评估决策条数")
    stop_loss_pct: float = Field(default=5.0, description="止损幅度（%）")
    take_profit_pct: float = Field(default=10.0, description="止盈幅度（%）")
    neutral_band_pct: float = Field(
        default=2.0, description="中性带（%），|区间收益|低于此视为方向中性"
    )


class WatchlistRequest(BaseModel):
    """POST /watchlist 请求体：整体替换自选列表"""

    tickers: list[str] = Field(description="自选股票代码列表")


class RiskProfileRequest(BaseModel):
    """POST /risk_profile 请求体：持久化全局风险偏好"""

    risk_profile: Literal["conservative", "balanced", "aggressive"] = Field(
        description="风险偏好画像: conservative(保守)/balanced(稳健)/aggressive(进取)"
    )


class TaskStarted(BaseModel):
    """POST /analyze 响应"""

    task_id: str


class TaskStatus(BaseModel):
    """GET /analyze/{task_id} 状态查询"""

    task_id: str
    status: Literal["pending", "running", "done", "failed"]
    error: Optional[str] = None


class ProgressEvent(BaseModel):
    """SSE 进度事件载荷（engine 产出的是 str，这里只做透传）"""

    type: Literal["stage", "result", "error", "done", "heartbeat"]
    node: Optional[str] = None
    message: Optional[str] = None
    data: Optional[Any] = None
    ts: float = 0.0
