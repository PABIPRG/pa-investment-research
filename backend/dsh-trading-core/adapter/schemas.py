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


class HypothesizeRequest(BaseModel):
    """POST /strategies/hypothesize 请求体：事件 → 投资假设 → 候选入库。"""

    limit: int = Field(default=20, ge=1, le=100, description="事件条数上限")
    dry_run: bool = Field(
        default=False, description="true=只生成候选不落库（返回假设供预览）"
    )


class StrategyRunRequest(BaseModel):
    """POST /strategies/run 请求体：候选策略历史+样本外回测。"""

    strategy_id: str = Field(description="策略 id（strategies 集合键）")
    lookback_years: float = Field(
        default=2.0, ge=0.5, le=10, description="历史回看年数"
    )
    oos_frac: float = Field(
        default=0.3, gt=0.0, lt=0.5, description="样本外比例（0~0.5，默认 0.3）"
    )
    initial_capital: float = Field(
        default=0.0, ge=0.0, description="回测初始资金（0=用 SHADOW_INITIAL_CAPITAL）"
    )
    min_oos_trades: int = Field(
        default=4, ge=1, le=100, description="样本外最低成交数（不足保持 candidate）"
    )


class ShadowRunRequest(BaseModel):
    """POST /shadow/run 请求体：实时影子策略验证。"""

    force: bool = Field(default=False, description="true=强制重跑当日（忽略幂等）")
    strategy_id: Optional[str] = Field(
        default=None, description="只验证该策略；空=全部 active 策略"
    )


class WatchlistRequest(BaseModel):
    """POST /watchlist 请求体：整体替换自选列表"""

    tickers: list[str] = Field(description="自选股票代码列表")


class RiskProfileRequest(BaseModel):
    """POST /risk_profile 请求体：持久化全局风险偏好"""

    risk_profile: Literal["conservative", "balanced", "aggressive"] = Field(
        description="风险偏好画像: conservative(保守)/balanced(稳健)/aggressive(进取)"
    )


class KyAnswer(BaseModel):
    """KYC 单题答案：题目 ID + 选项文本 + 得分（1-5）。"""

    qid: str = Field(description="题目 ID（见 QUESTION_BANK，如 horizon/loss_tolerance）")
    label: str = Field(description="选项文本")
    score: int = Field(ge=1, le=5, description="选项得分")


class KycQuestionnaireRequest(BaseModel):
    """POST /kyc/questionnaire 请求体：提交问卷答案。"""

    answers: list[KyAnswer] = Field(description="覆盖该档全部题目的答案列表")
    tier: Literal["quick", "full"] = Field(description="问卷档位: quick=三问速测, full=8 题完整")
    method: Literal["questionnaire", "voice"] = Field(
        default="questionnaire", description="作答方式: questionnaire=手动点选, voice=语音"
    )
    voice_source: Optional[str] = Field(
        default=None, description="语音作答时保存的原始转写文本"
    )


class KycAdjustRequest(BaseModel):
    """POST /kyc/adjust 请求体：滑块微调已推断画像。"""

    risk_tolerance: float = Field(
        default=0.5, ge=0, le=1, description="风险承受能力 0-1（0=保守 / 0.5=稳健 / 1=进取）"
    )
    horizon_years: int = Field(
        default=3, ge=1, le=10, description="投资期限（年），作辅助约束"
    )
    note: str = Field(default="", description="调整说明（可选）")


class KycParseRequest(BaseModel):
    """POST /kyc/parse 请求体：整段自然语言 → 结构化问卷答案。"""

    text: str = Field(min_length=1, description="自然语言描述（语音转写或手打）")


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
