# -*- coding: utf-8 -*-
"""策略自进化能力的只读 HTTP 端口。

自进化状态、归因与待确认预案只由 trading-core 持有；研究能力服务（:8300）与
委托执行器都不应复制它的存储。本模块只读 ``/evolution/*``，不调用
``POST /evolution/run``——升级/降级/变异属于写动作，必须由用户在 trading-core
侧凭预案令牌确认，或由已授权的闭环调度执行。
"""

from __future__ import annotations

import os
from typing import Any

import requests


class EvolutionServiceError(RuntimeError):
    """自进化服务不可达、返回错误或返回了无法解析的结果。"""


def default_evolution_url() -> str:
    """trading-core 地址；显式 ``STRATEGY_EVOLUTION_URL`` 优先。"""

    return (
        os.getenv("STRATEGY_EVOLUTION_URL")
        or os.getenv("TRADING_CORE_URL")
        or "http://127.0.0.1:8000"
    ).rstrip("/")


class HttpStrategyEvolutionClient:
    """``/evolution/status|attribution|preview`` 的薄客户端。"""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 5.0,
        session: Any | None = None,
    ) -> None:
        self.base_url = (base_url or default_evolution_url()).rstrip("/")
        self.timeout = timeout
        self._session = session

    def _session_or_default(self) -> Any:
        return self._session if self._session is not None else requests

    def _get(self, path: str, **params: Any) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        query = {key: value for key, value in params.items() if value is not None}
        try:
            response = self._session_or_default().get(
                url, params=query, timeout=self.timeout
            )
        except Exception as exc:  # noqa: BLE001 — 网络异常统一成能力不可用
            raise EvolutionServiceError(
                f"策略自进化服务不可达：{url}（{type(exc).__name__}）"
            ) from exc
        status = getattr(response, "status_code", 200)
        if status == 404:
            raise EvolutionServiceError(f"策略不存在：{query.get('strategy_id')}")
        if status >= 400:
            raise EvolutionServiceError(f"策略自进化服务返回 HTTP {status}：{url}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise EvolutionServiceError(f"策略自进化服务返回非 JSON：{url}") from exc
        if not isinstance(payload, dict):
            raise EvolutionServiceError(f"策略自进化服务返回了非对象结果：{url}")
        return payload

    def status(
        self,
        *,
        strategy_id: str | None = None,
        include_history: bool = False,
    ) -> dict[str, Any]:
        return self._get(
            "/evolution/status",
            strategy_id=strategy_id,
            include_history=str(include_history).lower(),
        )

    def attribution(self, *, strategy_id: str | None = None) -> dict[str, Any]:
        return self._get("/evolution/attribution", strategy_id=strategy_id)

    def preview(self, *, strategy_id: str | None = None) -> dict[str, Any]:
        return self._get("/evolution/preview", strategy_id=strategy_id)
