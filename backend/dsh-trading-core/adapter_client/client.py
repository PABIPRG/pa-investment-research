# -*- coding: utf-8 -*-
"""TradingCoreClient：dsh-trading-core 适配器的同步 HTTP + SSE 客户端。

封装 adapter/app.py 暴露的全部对外接口（见 docs/adapter-http-api.md）：
  - 轻量读写：/health /watchlist /risk_profile /holdings/save /brief/latest /brief/{id}/dsh-pushed
  - 长任务（三态 + SSE）：/analyze /holdings/analyze /brief
  - 任务查询：/analyze/{id} /analyze/{id}/stream /analyze/{id}/result

设计要点：
  - 仅依赖 requests（已在 requirements.txt），不引入新依赖。
  - SSE 基于 requests 流式响应按行解析（兼容 LF/CRLF，遵循 SSE 规范去掉 data 后一个前导空格）。
  - 三类长任务共用一套启动→消费SSE→取结果的流程（run_analysis / run_holdings_analysis / run_brief）。
  - 边界做错误处理：HTTP 非 2xx 抛 AdapterHttpError；SSE error 事件抛 AdapterTaskError。
"""

from __future__ import annotations

import json
import time
from typing import Callable, Iterator, Optional

import requests

from .models import (
    AnalyzeParams,
    BriefParams,
    HoldingItem,
    HoldingsParams,
    SseEvent,
    TaskStatus,
)

__all__ = [
    "TradingCoreClient",
    "AdapterHttpError",
    "AdapterTaskError",
]


class AdapterHttpError(RuntimeError):
    """适配器 HTTP 调用失败（非 2xx 或网络异常）。"""


class AdapterTaskError(RuntimeError):
    """适配器任务执行失败（SSE error 事件）。"""


class TradingCoreClient:
    """适配器 HTTP 客户端。

    Args:
        base_url: 适配器根地址，默认 http://127.0.0.1:8000。
        timeout: 普通（非流式）请求的默认超时秒数。
        session: 可注入自定义 requests.Session（默认每次自建）。
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8000",
        timeout: float = 30.0,
        session: Optional[requests.Session] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = session or requests.Session()

    # ── 内部：通用 JSON 请求 ──────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[dict] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        url = f"{self.base_url}{path}"
        kwargs: dict = {"timeout": timeout if timeout is not None else self.timeout}
        if body is not None:
            kwargs["json"] = body
        try:
            resp = self._session.request(method, url, **kwargs)
        except requests.RequestException as e:
            raise AdapterHttpError(f"{method} {url} 网络错误: {e}") from e
        if not resp.ok:
            raise AdapterHttpError(
                f"{method} {url} → HTTP {resp.status_code}: {resp.text}"
            )
        try:
            return resp.json()
        except ValueError as e:
            raise AdapterHttpError(f"{method} {url} 响应非 JSON: {resp.text[:200]}") from e

    # ── 1. 健康检查 ───────────────────────────────────────────────────

    def health(self) -> dict:
        """GET /health → {"status":"ok","runners":{...}}。"""
        return self._request("GET", "/health")

    # ── 2. 个股分析 ──────────────────────────────────────────────────

    def analyze_stock(
        self,
        ticker: str,
        *,
        date: Optional[str] = None,
        market: str = "a_shares",
        research_depth: str = "standard",
        config_overrides: Optional[dict] = None,
        risk_profile: Optional[str] = None,
    ) -> str:
        """POST /analyze → task_id（异步启动）。"""
        body = AnalyzeParams(
            ticker=ticker, date=date, market=market,
            research_depth=research_depth,  # type: ignore[arg-type]
            config_overrides=config_overrides or {},
            risk_profile=risk_profile,  # type: ignore[arg-type]
        ).to_dict()
        data = self._request("POST", "/analyze", body=body)
        return self._task_id(data, "/analyze")

    # ── 3. 持仓 ──────────────────────────────────────────────────────

    def analyze_holdings(
        self,
        *,
        holdings: Optional[list[HoldingItem]] = None,
        mode: str = "deep",
        use_saved: bool = True,
        risk_profile: Optional[str] = None,
    ) -> str:
        """POST /holdings/analyze → task_id。holdings 为空且 use_saved=True 时用已保存持仓。"""
        body = HoldingsParams(
            holdings=holdings, mode=mode,  # type: ignore[arg-type]
            use_saved=use_saved, risk_profile=risk_profile,  # type: ignore[arg-type]
        ).to_dict()
        data = self._request("POST", "/holdings/analyze", body=body)
        return self._task_id(data, "/holdings/analyze")

    def save_holdings(
        self,
        holdings: list[HoldingItem],
        *,
        mode: str = "deep",
    ) -> dict:
        """POST /holdings/save → {"saved": N, "mode": ...}。"""
        body = HoldingsParams(holdings=holdings, mode=mode).to_dict()  # type: ignore[arg-type]
        return self._request("POST", "/holdings/save", body=body)

    # ── 4. 自选列表 ───────────────────────────────────────────────────

    def get_watchlist(self) -> list[str]:
        """GET /watchlist → tickers 列表。"""
        data = self._request("GET", "/watchlist")
        return list(data.get("tickers", []))

    def set_watchlist(self, tickers: list[str]) -> int:
        """POST /watchlist → 返回保存条数。"""
        data = self._request("POST", "/watchlist", body={"tickers": tickers})
        return int(data.get("saved", 0))

    # ── 5. 风险偏好 ───────────────────────────────────────────────────

    def get_risk_profile(self) -> dict:
        """GET /risk_profile → {"risk_profile":..., "label":...}。"""
        return self._request("GET", "/risk_profile")

    def set_risk_profile(self, risk_profile: str) -> dict:
        """POST /risk_profile → 持久化全局风险偏好。"""
        return self._request(
            "POST", "/risk_profile", body={"risk_profile": risk_profile}
        )

    # ── 6. 市场简报 ──────────────────────────────────────────────────

    def generate_brief(
        self,
        *,
        period: str = "now",
        scope: str = "all",
        tickers: Optional[list[str]] = None,
        risk_profile: Optional[str] = None,
    ) -> str:
        """POST /brief → task_id。注意：brief 请串行调用。"""
        body = BriefParams(
            period=period, scope=scope, tickers=tickers, risk_profile=risk_profile,  # type: ignore[arg-type]
        ).to_dict()
        data = self._request("POST", "/brief", body=body)
        return self._task_id(data, "/brief")

    def get_latest_brief(self) -> dict:
        """GET /brief/latest → 最近一份简报（无则 id=null）。"""
        return self._request("GET", "/brief/latest")

    def mark_brief_pushed(self, brief_id: str) -> dict:
        """POST /brief/{id}/dsh-pushed → 幂等标记已推送。"""
        return self._request(
            "POST", f"/brief/{brief_id}/dsh-pushed", body=None
        )

    # ── 7. 任务查询 ───────────────────────────────────────────────────

    def get_task_status(self, task_id: str) -> TaskStatus:
        """GET /analyze/{task_id} → TaskStatus。"""
        data = self._request("GET", f"/analyze/{task_id}")
        return TaskStatus.from_dict(data)

    def get_task_result(self, task_id: str) -> dict:
        """GET /analyze/{task_id}/result → 最终结果（未完成抛 HTTP 409）。"""
        return self._request("GET", f"/analyze/{task_id}/result")

    # ── 8. SSE 进度流 ──────────────────────────────────────────────────

    def stream_task(
        self,
        task_id: str,
        *,
        read_timeout: float = 60.0,
    ) -> Iterator[SseEvent]:
        """GET /analyze/{task_id}/stream → 生成 SSE 事件流（生成器）。

        服务端每 15s 发 ping 心跳，read_timeout 给足（默认 60s）。
        事件序列：stage* → result → done（失败为 error → done）。
        晚到订阅者会立即收到 result + done。
        """
        url = f"{self.base_url}/analyze/{task_id}/stream"
        try:
            resp = self._session.get(url, stream=True, timeout=read_timeout)
        except requests.RequestException as e:
            raise AdapterHttpError(f"GET {url} 网络错误: {e}") from e
        if not resp.ok:
            raise AdapterHttpError(
                f"GET {url} → HTTP {resp.status_code}: {resp.text}"
            )
        try:
            for event_type, data_text in _iter_sse_frames(resp):
                yield _decode_event(event_type, data_text)
        finally:
            resp.close()

    # ── 9. 高层一站式：启动 + 消费 SSE + 返回最终结果 ─────────────────

    def run_analysis(
        self,
        ticker: str,
        *,
        date: Optional[str] = None,
        market: str = "a_shares",
        research_depth: str = "standard",
        config_overrides: Optional[dict] = None,
        risk_profile: Optional[str] = None,
        on_stage: Optional[Callable[[str], None]] = None,
        timeout: float = 900.0,
    ) -> dict:
        """启动个股分析并阻塞至完成，返回最终 result 载荷。

        Args:
            on_stage: 每条进度消息回调（用于注入 UI/模型上下文）。
            timeout: 整体超时秒数（默认 15 分钟，引擎单股约 3~9 分钟）。
        """
        task_id = self.analyze_stock(
            ticker, date=date, market=market, research_depth=research_depth,
            config_overrides=config_overrides, risk_profile=risk_profile,
        )
        return self._consume_until_result(task_id, on_stage=on_stage, timeout=timeout)

    def run_holdings_analysis(
        self,
        *,
        holdings: Optional[list[HoldingItem]] = None,
        mode: str = "deep",
        use_saved: bool = True,
        risk_profile: Optional[str] = None,
        on_stage: Optional[Callable[[str], None]] = None,
        timeout: float = 1800.0,
    ) -> dict:
        """启动持仓分析并阻塞至完成，返回最终 result 载荷。"""
        task_id = self.analyze_holdings(
            holdings=holdings, mode=mode, use_saved=use_saved,
            risk_profile=risk_profile,
        )
        return self._consume_until_result(task_id, on_stage=on_stage, timeout=timeout)

    def run_brief(
        self,
        *,
        period: str = "now",
        scope: str = "all",
        tickers: Optional[list[str]] = None,
        risk_profile: Optional[str] = None,
        on_stage: Optional[Callable[[str], None]] = None,
        timeout: float = 300.0,
    ) -> dict:
        """启动市场简报生成并阻塞至完成，返回最终 result 载荷。"""
        task_id = self.generate_brief(
            period=period, scope=scope, tickers=tickers, risk_profile=risk_profile,
        )
        return self._consume_until_result(task_id, on_stage=on_stage, timeout=timeout)

    # ── 内部工具 ──────────────────────────────────────────────────────

    @staticmethod
    def _task_id(data: dict, where: str) -> str:
        task_id = data.get("task_id")
        if not task_id:
            raise AdapterHttpError(f"{where} 未返回 task_id: {json.dumps(data)}")
        return str(task_id)

    def _consume_until_result(
        self,
        task_id: str,
        *,
        on_stage: Optional[Callable[[str], None]] = None,
        timeout: float,
    ) -> dict:
        """消费 SSE 流至 done，返回 result 载荷。超时或 error 抛错。"""
        deadline = time.monotonic() + timeout
        final: Optional[dict] = None
        for ev in self.stream_task(task_id):
            if time.monotonic() > deadline:
                raise TimeoutError(f"任务 {task_id} 超时（{timeout}s）")
            if ev.type == "stage":
                if ev.message and on_stage:
                    on_stage(ev.message)
            elif ev.type == "result":
                final = ev.data if isinstance(ev.data, dict) else {}
            elif ev.type == "error":
                raise AdapterTaskError(f"任务 {task_id} 失败：{ev.message or '未知错误'}")
            elif ev.type == "done":
                break
        if final is None:
            # 流异常结束未拿到 result：回退到 /result 兜底
            final = self.get_task_result(task_id)
        return final


# ── SSE 解析（独立函数，便于单测）─────────────────────────────────────


def _iter_sse_frames(response: requests.Response) -> Iterator[tuple[str, str]]:
    """把 requests 流式响应拆成 (event, data) 帧。

    sse-starlette 以空行分隔帧；每帧含 event:/data: 行。
    遵循 SSE 规范：data 后若有且仅有一个前导空格则去除。
    """
    event = ""
    data_lines: list[str] = []
    for raw in response.iter_lines(decode_unicode=True):
        if raw is None:
            continue
        line = raw
        if line == "":
            # 空行 = 帧结束（即使无 event 也派发，兼容裸 data 帧）
            if event or data_lines:
                yield event, "\n".join(data_lines)
                event = ""
                data_lines = []
            continue
        if line.startswith(":"):
            # 注释 / 心跳 ping，忽略
            continue
        field, sep, value = line.partition(":")
        if not sep:
            continue
        # 去掉一个前导空格（SSE 规范）
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    # 流末尾残留帧（部分实现不以空行结尾）
    if event or data_lines:
        yield event, "\n".join(data_lines)


def _decode_event(event_type: str, data_text: str) -> SseEvent:
    """把一帧 (event, data_text) 解析为 SseEvent。data 非 JSON 时原样透传。"""
    payload: dict = {}
    if data_text:
        try:
            payload = json.loads(data_text)
            if not isinstance(payload, dict):
                payload = {"data": payload}
        except json.JSONDecodeError:
            payload = {"message": data_text}
    ev_type = event_type or payload.get("type", "stage")
    if ev_type == "stage":
        return SseEvent(type="stage", node=payload.get("node"), message=payload.get("message"))
    if ev_type == "result":
        return SseEvent(type="result", data=payload.get("data", payload))
    if ev_type == "error":
        return SseEvent(type="error", message=payload.get("message"))
    # done / heartbeat / 其它
    return SseEvent(type=ev_type)  # type: ignore[arg-type]
