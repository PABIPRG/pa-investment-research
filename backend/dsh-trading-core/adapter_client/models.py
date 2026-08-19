# -*- coding: utf-8 -*-
"""adapter_client 数据模型：请求输入与关键响应的类型契约。

对应 adapter/schemas.py 的 Pydantic 模型，供客户端侧做类型化封装。
响应载荷（signal/reports）因结构动态、随 task_type 变化，统一以 dict 透传，
详见 docs/adapter-http-api.md 第 4 节。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

# ── 枚举字面量（与 adapter 一致）──────────────────────────────────────
RiskProfile = Literal["conservative", "balanced", "aggressive"]
ResearchDepth = Literal["quick", "basic", "standard", "deep", "full"]
HoldingsMode = Literal["quick", "deep"]
BriefPeriod = Literal["pre_market", "post_market", "now"]
BriefScope = Literal["market", "industry", "concept", "news", "watchlist", "all"]
TaskStatusValue = Literal["pending", "running", "done", "failed"]
TaskType = Literal["stock", "holdings", "brief"]
SseEventType = Literal["stage", "result", "error", "done", "heartbeat"]


# ── 请求输入 ─────────────────────────────────────────────────────────

@dataclass
class HoldingItem:
    """单只持仓：代码 + 数量 + 成本价（对应 schemas.HoldingItem）。"""

    ticker: str
    quantity: float
    cost_price: float

    def to_dict(self) -> dict:
        return {"ticker": self.ticker, "quantity": self.quantity, "cost_price": self.cost_price}


@dataclass
class AnalyzeParams:
    """个股分析请求参数（对应 schemas.AnalyzeRequest）。"""

    ticker: str
    date: Optional[str] = None
    market: str = "a_shares"
    research_depth: ResearchDepth = "standard"
    config_overrides: dict = field(default_factory=dict)
    risk_profile: Optional[RiskProfile] = None

    def to_dict(self) -> dict:
        body: dict = {
            "ticker": self.ticker,
            "market": self.market,
            "research_depth": self.research_depth,
            "config_overrides": self.config_overrides,
        }
        if self.date is not None:
            body["date"] = self.date
        if self.risk_profile is not None:
            body["risk_profile"] = self.risk_profile
        return body


@dataclass
class HoldingsParams:
    """持仓分析请求参数（对应 schemas.HoldingsRequest）。"""

    holdings: Optional[list[HoldingItem]] = None
    mode: HoldingsMode = "deep"
    use_saved: bool = True
    risk_profile: Optional[RiskProfile] = None

    def to_dict(self) -> dict:
        body: dict = {"mode": self.mode, "use_saved": self.use_saved}
        if self.holdings is not None:
            body["holdings"] = [h.to_dict() for h in self.holdings]
        if self.risk_profile is not None:
            body["risk_profile"] = self.risk_profile
        return body


@dataclass
class BriefParams:
    """市场简报请求参数（对应 schemas.BriefRequest）。"""

    period: BriefPeriod = "now"
    scope: BriefScope = "all"
    tickers: Optional[list[str]] = None
    risk_profile: Optional[RiskProfile] = None

    def to_dict(self) -> dict:
        body: dict = {"period": self.period, "scope": self.scope}
        if self.tickers is not None:
            body["tickers"] = self.tickers
        if self.risk_profile is not None:
            body["risk_profile"] = self.risk_profile
        return body


# ── 关键响应（小而稳的结构，单独建类型）──────────────────────────────

@dataclass
class TaskStatus:
    """GET /analyze/{task_id} 状态查询结果。"""

    task_id: str
    status: TaskStatusValue
    task_type: Optional[TaskType] = None
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "TaskStatus":
        return cls(
            task_id=d.get("task_id", ""),
            task_type=d.get("task_type"),
            status=d.get("status", "pending"),
            error=d.get("error"),
        )


@dataclass
class SseEvent:
    """SSE 事件载荷（适配器侧 _sse_gen 产出的结构）。

    type=stage  → node/message 有值
    type=result → data 为最终结果 dict
    type=error  → message 有值
    type=done   → 字段皆空
    """

    type: SseEventType
    node: Optional[str] = None
    message: Optional[str] = None
    data: Optional[Any] = None

    @classmethod
    def from_dict(cls, d: dict) -> "SseEvent":
        return cls(
            type=d.get("type", "stage"),
            node=d.get("node"),
            message=d.get("message"),
            data=d.get("data"),
        )
