# -*- coding: utf-8 -*-
"""API 请求/响应模型（Pydantic v2）。Literal 强校验 field/operator/period/kind。"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .scanner import SCAN_KINDS

FIELDS = ("price", "pct_change", "volume_ratio", "amount", "turnover")
OPERATORS = (">", ">=", "<", "<=")


# ---- 自选 ---------------------------------------------------------------


class WatchAddRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6, description="6 位股票代码，如 600519")
    name: str | None = Field(default=None, description="名称，缺省由行情快照补")


class WatchRemoveRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


# ---- 批量行情 ------------------------------------------------------------


class QuotesBatchRequest(BaseModel):
    codes: list[str] = Field(description="待查询的 6 位股票代码列表，单次上限 100 只")


class AlertCondition(BaseModel):
    field: str = Field(description="price / pct_change / volume_ratio / amount / turnover")
    operator: str = Field(description="> >= < <=")
    value: float = Field(description="阈值；amount 按亿元，pct/turnover 按%数值")


class AlertRule(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    ticker: str | None = Field(default=None, description="可空=全部自选；也可指定不在自选的代码")
    enabled: bool = True
    time_frame: str = Field(default="trading", description="trading=交易时段才评估 / anytime")
    combine: str = Field(default="or", description="and=全部满足 / or=任一满足")
    conditions: list[AlertCondition] = Field(min_length=1, max_length=5)
    cooldown_min: int = Field(default=0, ge=0, description="两次触发最小间隔(分钟)")
    daily_cap: int = Field(default=0, ge=0, description="每日最多触发次数，0=不限")


# ---- 扫描 / 技术信号 / 简报 -------------------------------------------------


class ScanRequest(BaseModel):
    kind: str = Field(default="gainers", description="gainers / volume_ratio / limit / turnover / amount")
    top_n: int = Field(default=10, ge=1, le=100)
    min_amount_yi: float | None = Field(default=None, description="仅 amount 生效：最小成交额(亿元)")


class TechSignalRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    lookback: int = Field(default=120, ge=30, le=500, description="K线根数")


class SecurityDetailRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    lookback: int = Field(default=120, ge=30, le=500, description="K线根数")


class BriefRequest(BaseModel):
    period: str = Field(default="pre", description="pre=盘前 / post=盘后")
    manual: bool = Field(default=False, description="true 绕交易日守卫（仅测试）")
