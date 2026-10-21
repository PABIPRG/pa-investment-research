# -*- coding: utf-8 -*-
"""工具执行上下文：网络、数据源与实体库的唯一入口。

网络调用统一走这里，目的有三：
1. 进程内临时绕过系统代理（Windows 上代理会劫持 akshare 请求）；
2. 给不可控的第三方 SDK 调用加超时，避免工具层被单个接口拖死；
3. 允许单测注入假的 akshare / HTTP 会话，不触网。
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from ..errors import SourceUnavailable
from ..models import EntityCollection, EntityInstance, EntityRelation
from ..ports import CollectionProvider, EntityRepository

_NO_PROXY_LOCK = threading.Lock()
_NO_PROXY_INSTALLED = False
_CA_BUNDLE_LOCK = threading.Lock()
_CA_BUNDLE_INSTALLED = False
_CALL_LOCK = threading.Lock()

DEFAULT_ACCEPT_AKSHARE_TIMEOUT = 30.0
DEFAULT_SERVICE_TIMEOUT = 5.0


class ToolUnavailable(SourceUnavailable):
    """数据源不可用或调用超时；上层应映射为 unavailable，而不是 error。"""


def install_no_proxy() -> None:
    """让 akshare / requests 绕过系统代理。

    这是进程级设置；工具进程是独立研究进程，不承载 LLM 调用，
    因此可以接受。重复调用是幂等的。
    """

    global _NO_PROXY_INSTALLED
    with _NO_PROXY_LOCK:
        if _NO_PROXY_INSTALLED:
            return
        for key in ("NO_PROXY", "no_proxy"):
            current = os.environ.get(key, "")
            parts = [item.strip() for item in current.split(",") if item.strip()]
            if "*" not in parts:
                parts.append("*")
                os.environ[key] = ",".join(parts)
        _NO_PROXY_INSTALLED = True


def install_curl_ca_bundle() -> None:
    """修复 curl_cffi 在非 ASCII 用户目录下加载 CA 证书失败的问题。

    akshare 的部分接口（如 ``stock_news_em``）走 curl_cffi。当 certifi 的
    cacert.pem 位于中文用户名路径时，libcurl 会报 "error adding trust anchors"。
    这里只在 Windows 且未显式设置 CURL_CA_BUNDLE 时，把证书复制到 ASCII
    目录并指向它；其他平台或已配置环境保持不动。重复调用是幂等的。
    """

    global _CA_BUNDLE_INSTALLED
    if os.name != "nt":
        return
    with _CA_BUNDLE_LOCK:
        if _CA_BUNDLE_INSTALLED:
            return
        _CA_BUNDLE_INSTALLED = True
        if os.environ.get("CURL_CA_BUNDLE"):
            return
        try:
            import certifi

            source = Path(certifi.where())
        except Exception:  # pragma: no cover - 依赖缺失
            return
        if not source.is_file() or str(source).isascii():
            return
        for base in (
            Path(os.environ.get("ProgramData", r"C:\ProgramData")),
            Path(r"C:\Windows\Temp"),
        ):
            if not str(base).isascii():
                continue
            destination = base / "investment-research-cacert.pem"
            try:
                shutil.copyfile(source, destination)
            except OSError:
                continue
            os.environ["CURL_CA_BUNDLE"] = str(destination)
            os.environ.setdefault("SSL_CERT_FILE", str(destination))
            return


def _json_safe(value: Any) -> Any:
    if value is None:
        return None
    # numpy / pandas 标量先还原成 Python 原生类型。
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except Exception:
            pass
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float) and value != value:  # NaN
        return None
    try:
        import pandas as pd

        if value is pd.NaT:
            return None
    except Exception:  # pragma: no cover - pandas 缺失时按普通值处理
        pass
    return value


def records_from_frame(
    frame: Any,
    *,
    limit: int | None = None,
    latest_first: bool = True,
) -> list[dict[str, Any]]:
    """DataFrame → JSON 安全的记录列表。未知结构按原字段返回。"""

    if frame is None:
        return []
    if not hasattr(frame, "to_dict"):
        if isinstance(frame, list):
            return [dict(item) for item in frame][: limit or None]
        return []
    if latest_first and len(frame):
        # 数据源通常按日期升序返回；工具结果默认最新在前。
        try:
            frame = frame.iloc[::-1]
        except Exception:
            pass
    if limit is not None:
        frame = frame.head(limit)
    records: list[dict[str, Any]] = []
    for item in frame.to_dict(orient="records"):
        records.append({str(key): _json_safe(value) for key, value in item.items()})
    return records


class ToolContext:
    """工具处理器共享的运行时依赖。"""

    def __init__(
        self,
        repository: EntityRepository,
        collection_provider: CollectionProvider | None = None,
        *,
        akshare_module: Any | None = None,
        http_session: Any | None = None,
        timeout: float = DEFAULT_ACCEPT_AKSHARE_TIMEOUT,
        service_timeout: float = DEFAULT_SERVICE_TIMEOUT,
        industry_chain_url: str | None = None,
        market_watch_url: str | None = None,
        evolution_url: str | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.collection_provider = collection_provider
        self._akshare = akshare_module
        self._http = http_session
        self.timeout = timeout
        self.service_timeout = service_timeout
        self.industry_chain_url = (
            industry_chain_url
            or os.getenv("INDUSTRY_CHAIN_URL", "http://127.0.0.1:8200")
        ).rstrip("/")
        self.market_watch_url = (
            market_watch_url
            or os.getenv("MARKET_WATCH_URL", "http://127.0.0.1:8100")
        ).rstrip("/")
        # 策略自进化在 trading-core 进程内；研究能力服务只经 HTTP 读取。
        self.evolution_url = (
            evolution_url
            or os.getenv("STRATEGY_EVOLUTION_URL")
            or os.getenv("TRADING_CORE_URL", "http://127.0.0.1:8000")
        ).rstrip("/")
        self._now = now or (lambda: datetime.now(timezone.utc))

    # ── 时间 ────────────────────────────────────────────────────────
    def now(self) -> datetime:
        return self._now()

    def today(self) -> date:
        return self.now().date()

    def recent_dates(self, days: int) -> list[date]:
        today = self.today()
        return [today - timedelta(days=offset) for offset in range(days)]

    # ── 实体库 ──────────────────────────────────────────────────────
    def get_entity(self, entity_id: str) -> EntityInstance | None:
        return self.repository.get(entity_id)

    def relations(
        self, entity_id: str, relation_type: str | None = None
    ) -> list[EntityRelation]:
        return self.repository.relations_from(entity_id, relation_type=relation_type)

    def collection(self, collection_type: str) -> EntityCollection | None:
        if self.collection_provider is None:
            return None
        return self.collection_provider.get_collection(collection_type)

    def entities_of_type(
        self, type_code: str, *, limit: int = 5000
    ) -> list[EntityInstance]:
        items, _cursor = self.repository.list_by_type(type_code, limit=limit)
        return items

    # ── 网络 ────────────────────────────────────────────────────────
    def _akshare_api(self) -> Any:
        if self._akshare is None:
            install_no_proxy()
            install_curl_ca_bundle()
            try:
                import akshare as ak
            except ImportError as exc:  # pragma: no cover - 依赖缺失
                raise ToolUnavailable("akshare 未安装，无法访问外部行情数据源") from exc
            self._akshare = ak
        return self._akshare

    def call_akshare(self, function_name: str, *, timeout: float | None = None, **kwargs: Any) -> Any:
        """按函数名调用 akshare，带超时与异常归一化。

        使用函数名而不是函数对象，便于单测用假模块替换。
        个别全市场接口较慢，可显式传入更长的 ``timeout``。
        """

        api = self._akshare_api()
        fn = getattr(api, function_name, None)
        if fn is None:
            raise ToolUnavailable(f"当前 akshare 版本不提供 {function_name}")
        return self._bounded_call(
            fn, kwargs, label=function_name, timeout=timeout or self.timeout
        )

    def _bounded_call(
        self,
        fn: Callable[..., Any],
        kwargs: Mapping[str, Any],
        *,
        label: str,
        timeout: float,
    ) -> Any:
        box: dict[str, Any] = {}

        def run() -> None:
            try:
                box["value"] = fn(**dict(kwargs))
            except BaseException as exc:  # noqa: BLE001 - 转成工具层异常
                box["error"] = exc

        # 第三方库不保证线程安全；串行化可避免环境变量与连接池竞争。
        with _CALL_LOCK:
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(timeout)
        if worker.is_alive():
            raise ToolUnavailable(f"{label} 调用超时（>{timeout:.0f}s）")
        error = box.get("error")
        if error is not None:
            raise ToolUnavailable(f"{label} 调用失败：{type(error).__name__}: {error}")
        return box.get("value")

    def _session(self) -> Any:
        if self._http is None:
            try:
                import requests
            except ImportError as exc:  # pragma: no cover - 依赖缺失
                raise ToolUnavailable("requests 未安装，无法访问兄弟服务") from exc
            session = requests.Session()
            # 兄弟服务在本机，绝不能走系统代理。
            session.trust_env = False
            self._http = session
        return self._http

    def http_get(self, url: str, params: Mapping[str, Any] | None = None) -> Any:
        try:
            response = self._session().get(
                url, params=dict(params or {}), timeout=self.service_timeout
            )
        except Exception as exc:  # noqa: BLE001
            raise ToolUnavailable(f"服务不可达：{url}（{type(exc).__name__}）") from exc
        return self._parse_response(url, response)

    def http_get_text(
        self,
        url: str,
        params: Mapping[str, Any] | None = None,
        *,
        headers: Mapping[str, str] | None = None,
        encoding: str | None = "utf-8",
    ) -> str:
        """抓取 HTML/文本页面；仅用于已核验的公开页面，不做 JSON 解析。"""

        kwargs: dict[str, Any] = {
            "params": dict(params or {}),
            "timeout": self.service_timeout,
        }
        if headers:
            kwargs["headers"] = dict(headers)
        try:
            response = self._session().get(url, **kwargs)
        except TypeError:
            # 测试替身可能不接受 headers；退回基础签名。
            kwargs.pop("headers", None)
            try:
                response = self._session().get(url, **kwargs)
            except Exception as exc:  # noqa: BLE001
                raise ToolUnavailable(
                    f"数据源不可达：{url}（{type(exc).__name__}）"
                ) from exc
        except Exception as exc:  # noqa: BLE001
            raise ToolUnavailable(f"数据源不可达：{url}（{type(exc).__name__}）") from exc
        status = getattr(response, "status_code", 200)
        if status >= 400:
            raise ToolUnavailable(f"数据源返回 HTTP {status}：{url}")
        if encoding:
            content = getattr(response, "content", None)
            if isinstance(content, (bytes, bytearray)):
                return bytes(content).decode(encoding, errors="replace")
        return getattr(response, "text", "")

    def http_post(self, url: str, payload: Mapping[str, Any]) -> Any:
        try:
            response = self._session().post(
                url, json=dict(payload), timeout=self.service_timeout
            )
        except Exception as exc:  # noqa: BLE001
            raise ToolUnavailable(f"服务不可达：{url}（{type(exc).__name__}）") from exc
        return self._parse_response(url, response)

    @staticmethod
    def _parse_response(url: str, response: Any) -> Any:
        status = getattr(response, "status_code", 200)
        if status >= 400:
            raise ToolUnavailable(f"服务返回 HTTP {status}：{url}")
        try:
            return response.json()
        except Exception as exc:  # noqa: BLE001
            raise ToolUnavailable(f"服务返回非 JSON：{url}") from exc

    def wait_seconds(self, seconds: float) -> None:  # pragma: no cover - 调试辅助
        time.sleep(seconds)


def build_context(
    repository: EntityRepository,
    collection_provider: CollectionProvider | None = None,
    **kwargs: Any,
) -> ToolContext:
    return ToolContext(repository, collection_provider, **kwargs)
