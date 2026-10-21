# -*- coding: utf-8 -*-
"""交易日历适配器：接研究实体的 A 股交易日历数据（新浪 ``tool_trade_date_hist_sina``）。

``ScheduleService`` 只依赖 ``is_trading_day(day)`` 端口。默认按周一至周五
降级；配置 ``RESEARCH_TRADING_CALENDAR=akshare`` 后，首次需要判断时加载
真实交易日并缓存一天。数据源失败、超出覆盖范围或依赖缺失时继续按工作日
近似，并在 ``degraded`` 中暴露，绝不把“不知道”当成休市。

日历是调度的一部分，不在导入时恢复；它只决定到期实例是否存在。
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime
from typing import Callable, Iterable

TTL_SECONDS = 86400
FALLBACK_TTL_SECONDS = 600


def load_akshare_dates() -> Iterable[date]:
    """默认加载器；独立函数便于测试与替换。"""

    import akshare as ak  # 延迟导入：不启用时不增加启动依赖

    frame = ak.tool_trade_date_hist_sina()
    column = frame["trade_date"]
    dates: list[date] = []
    for value in column:
        if isinstance(value, datetime):
            dates.append(value.date())
        elif isinstance(value, date):
            dates.append(value)
        else:
            try:
                dates.append(date.fromisoformat(str(value)[:10]))
            except ValueError:
                continue
    return dates


class AkshareTradingCalendar:
    """带日缓存与降级标记的交易日历。"""

    def __init__(
        self,
        loader: Callable[[], Iterable[date]] | None = None,
        *,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._loader = loader or load_akshare_dates
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._dates: set[date] | None = None
        self._expires_at = 0.0
        self.source = "weekday_fallback"

    def _ensure(self) -> None:
        now = self._clock()
        with self._lock:
            if self._dates is not None and now < self._expires_at:
                return
            try:
                loaded = {item for item in self._loader() if isinstance(item, date)}
            except Exception:  # noqa: BLE001 - 数据源不可用时降级，不阻断调度
                loaded = set()
            self._dates = loaded
            self.source = "akshare" if loaded else "weekday_fallback"
            self._expires_at = now + (TTL_SECONDS if loaded else FALLBACK_TTL_SECONDS)

    @property
    def degraded(self) -> bool:
        self._ensure()
        return self.source != "akshare"

    def is_trading_day(self, day: date) -> bool:
        self._ensure()
        assert self._dates is not None
        if self._dates and min(self._dates) <= day <= max(self._dates):
            return day in self._dates
        # 覆盖范围之外（数据源失败或未来年份）按工作日近似。
        return day.weekday() < 5
