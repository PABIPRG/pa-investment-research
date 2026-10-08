"""隔离无法可靠中断的行情客户端；一个 worker 复用一个串行会话。"""

from __future__ import annotations

import importlib
import multiprocessing
import queue
import threading
import time


class PriceWorkerError(RuntimeError):
    """数据源繁忙、异常或超过预算，可由调用方沿既有链路降级。"""


def _serve(connection, module: str, function: str, initializer: str | None) -> None:
    try:
        imported = importlib.import_module(module)
        source = getattr(imported, function)
        if initializer is not None:
            getattr(imported, initializer)()
        while True:
            args = connection.recv()
            try:
                connection.send((True, None if args is None else source(*args)))
            except Exception as exc:
                # 不把第三方响应、连接信息或凭证带回公开路径。
                connection.send((False, type(exc).__name__))
    except (EOFError, OSError):
        pass
    finally:
        connection.close()


class IsolatedPriceWorker:
    """惰性 spawn、有限准入和总等待；异常进程不会被下一次调用复用。

    Pipe 的完整收发也在预算内，不能只 poll 后无期限 recv。每个 worker
    同时最多一个收发线程，超时先终止子进程再关闭连接、回收线程。
    """

    def __init__(self, module: str, function: str, *, timeout: float = 2.0,
                 max_pending: int = 8, cooldown: float = 5.0,
                 initializer: str | None = None, startup_timeout: float = 8.0) -> None:
        self._module = module
        self._function = function
        self._timeout = timeout
        self._cooldown = cooldown
        self._initializer = initializer
        self._startup_timeout = startup_timeout
        self._reaping = False
        self._retry_at = 0.0
        self._slots = threading.BoundedSemaphore(max_pending)
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._process = None
        self._connection = None
        self._exchange_thread = None

    def _discard(self) -> None:
        self._reaping = False
        process = self._process
        if process is not None:
            if process.is_alive():
                process.terminate()
            process.join(timeout=0.1)
            if process.is_alive():
                process.kill()
                process.join(timeout=0.1)
            # 无法回收时禁止再起一代，避免孤儿进程累积。
            if process.is_alive():
                self._reaping = True
            else:
                process.close()
                self._process = None
        if self._connection is not None:
            self._connection.close()
            self._connection = None
        if self._exchange_thread is not None:
            self._exchange_thread.join(timeout=0.1)
            if self._exchange_thread.is_alive():
                self._reaping = True
            else:
                self._exchange_thread = None

    def _start(self) -> None:
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(target=_serve, args=(child, self._module, self._function, self._initializer), daemon=True)
        try:
            process.start()
        except BaseException:
            parent.close()
            child.close()
            raise
        child.close()
        self._connection = parent
        self._process = process

    def _exchange(self, args, deadline):
        result = queue.Queue(maxsize=1)
        connection = self._connection

        def exchange():
            try:
                connection.send(args)
                result.put(connection.recv())
            except (EOFError, OSError, ValueError):
                result.put((False, "行情子进程已断开"))

        self._exchange_thread = threading.Thread(target=exchange, daemon=True, name="price-ipc")
        self._exchange_thread.start()
        while True:
            remaining = deadline - time.monotonic()
            if self._closed.is_set() or remaining <= 0:
                raise PriceWorkerError("行情查询超时或服务已关闭")
            try:
                ok, payload = result.get(timeout=min(0.05, remaining))
                break
            except queue.Empty:
                continue
        self._exchange_thread.join(timeout=0.1)
        if not ok:
            raise PriceWorkerError(f"行情源失败：{payload}")
        return payload

    def call(self, *args):
        return self._call(args)

    def warm(self) -> None:
        self._call(None)

    def _call(self, args):
        deadline = time.monotonic() + self._timeout
        if self._closed.is_set() or not self._slots.acquire(blocking=False):
            raise PriceWorkerError("行情服务繁忙或已关闭")
        acquired = False
        try:
            # 分段等待，关闭时不必等到整个查询超时。
            while not acquired:
                if self._closed.is_set() or time.monotonic() >= deadline:
                    raise PriceWorkerError("行情排队超时或服务已关闭")
                acquired = self._lock.acquire(timeout=min(0.05, max(0, deadline - time.monotonic())))
            if self._closed.is_set() or time.monotonic() < self._retry_at:
                raise PriceWorkerError("行情服务正在恢复")
            try:
                if self._reaping:
                    self._discard()
                    if self._reaping:
                        raise PriceWorkerError("上一代行情进程仍在回收")
                if self._process is None:
                    started = time.monotonic()
                    self._start()
                    self._exchange(None, started + self._startup_timeout)
                    # 冷导入只发生一次，有独立上限，不侵占热查询预算。
                    deadline += time.monotonic() - started
                return self._exchange(args, deadline)
            except Exception as exc:
                self._discard()
                self._retry_at = time.monotonic() + self._cooldown
                if isinstance(exc, PriceWorkerError):
                    raise
                raise PriceWorkerError("行情子进程不可用") from exc
        finally:
            if acquired:
                self._lock.release()
            self._slots.release()

    def close(self) -> None:
        self._closed.set()
        if self._lock.acquire(timeout=0.5):
            try:
                self._discard()
            finally:
                self._lock.release()

    def open(self) -> None:
        """应用新生命周期可重开，但必须先确认旧一代已完全退出。"""
        if not self._closed.is_set():
            return
        if not self._lock.acquire(timeout=0.5):
            raise PriceWorkerError("行情服务尚未关闭")
        try:
            self._discard()
            if self._reaping:
                raise PriceWorkerError("旧行情进程尚未退出")
            self._retry_at = 0
            self._closed.clear()
        finally:
            self._lock.release()
