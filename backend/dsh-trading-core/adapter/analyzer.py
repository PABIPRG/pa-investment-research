# -*- coding: utf-8 -*-
"""任务管理器：线程桥接 + 进度队列（集成方案 §3.1 核心）。

线程模型：
  POST /analyze（FastAPI 事件循环线程）→ TaskManager.start()
     → 提交到 ThreadPoolExecutor worker 线程运行同步 runner
     → worker 线程调用 progress_cb（引擎线程）→ loop.call_soon_threadsafe 投递
     → SSE generator（事件循环线程）await queue.get() 消费

引擎是同步阻塞的，必须放 worker 线程，避免阻塞 dsh 侧事件循环；
引擎代码在无运行事件循环的普通线程里执行，天然规避已知的事件循环冲突。
"""

import asyncio
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

from .decision_recorder import DecisionRecorder
from .report_store import ReportStore
from .runner import FakeRunner


class TaskManager:
    """多任务类型管理器：registry: task_type → runner。

    三个任务类型共用同一套 SSE/result/status 基础设施：
      - stock    （POST /analyze，analyze_stock 工具）
      - holdings （POST /holdings/analyze，analyze_holdings 工具）
      - brief    （POST /brief，market_brief 工具）
    """

    def __init__(
        self,
        registry: dict | None = None,
        max_workers: int = 6,
        report_store: ReportStore | None = None,
    ):
        self.registry = registry or {"stock": FakeRunner()}
        self.report_store = report_store if report_store is not None else ReportStore()
        self.executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="analysis"
        )
        self._queues: dict[str, asyncio.Queue] = {}  # task_id → 进度事件队列
        self._loops: dict[str, asyncio.AbstractEventLoop] = {}  # task_id → 主事件循环
        self._status: dict[str, str] = {}  # task_id → pending/running/done/failed
        self._results: dict[str, dict] = {}  # task_id → 最终结果
        self._errors: dict[str, str] = {}  # task_id → 错误信息
        self._task_types: dict[str, str] = {}  # task_id → task_type
        self._cancel_events: dict[str, threading.Event] = {}
        self._futures: dict[str, object] = {}

    # ---- 生命周期 -------------------------------------------------------

    def start(
        self,
        params: dict,
        task_type: str = "stock",
        task_id: str | None = None,
    ) -> str:
        """在事件循环线程内被调用：记录主循环引用，提交到 worker 线程。

        task_type 从 registry 解析对应 runner；缺省 stock 保持向后兼容。
        """
        runner = self.registry.get(task_type)
        if runner is None:
            raise KeyError(f"未知任务类型: {task_type}（可用: {list(self.registry)}）")
        task_id = task_id or uuid.uuid4().hex
        params = dict(params)
        params["task_id"] = task_id  # 透传给 propagate(task_id=...) 做性能追踪
        should_dispatch = True
        prepared = None
        prepare = getattr(runner, "prepare_task", None)
        if prepare is not None:
            prepared = prepare(task_id, params)
            if isinstance(prepared, dict) and prepared.get("task_id"):
                task_id = str(prepared["task_id"])
                params["task_id"] = task_id
                should_dispatch = bool(prepared.get("should_dispatch", True))
        if task_id in self._queues:
            return task_id
        self._queues[task_id] = asyncio.Queue()
        self._loops[task_id] = asyncio.get_running_loop()
        self._status[task_id] = "pending"
        self._task_types[task_id] = task_type
        cancel_event = threading.Event()
        self._cancel_events[task_id] = cancel_event
        params["_cancel_event"] = cancel_event
        if not should_dispatch and isinstance(prepared, dict):
            durable_status = str(prepared.get("status") or "completed")
            persisted_result = prepared.get("result")
            if isinstance(persisted_result, dict):
                self._results[task_id] = dict(persisted_result)
            if durable_status in ("completed", "partial"):
                self._status[task_id] = "done"
            elif durable_status in ("failed", "interrupted", "cancelled"):
                self._status[task_id] = "cancelled" if durable_status == "cancelled" else "failed"
                error = prepared.get("error") or prepared.get("failure_reason")
                if error:
                    self._errors[task_id] = str(error)
            self._put(task_id, {"type": "done"})
            return task_id
        self._futures[task_id] = self.executor.submit(
            self._run_sync, task_id, params, runner
        )
        return task_id

    def _run_sync(self, task_id: str, params: dict, runner) -> None:
        """worker 线程：跑同步 runner，产出进度事件与最终结果。"""
        try:
            self._status[task_id] = "running"
            # 任务启动：先下发管道清单（前端据此渲染步骤器）
            manifest = self._safe_manifest(runner, params)
            if manifest:
                self._put(task_id, manifest)
            result = runner.run(
                params, lambda msg: self._put_stage(task_id, msg)
            )
            # runner 可能无法在计算中途立即退出；取消信号一旦置位，晚到的
            # 正常返回也不能发布结果、生成报告或把 cancelled 覆盖成 done。
            cancel_event = self._cancel_events.get(task_id)
            if cancel_event is not None and cancel_event.is_set():
                self._status[task_id] = "cancelled"
                return
            # 决策记录：仅 stock 分析落盘结构化 signal（回测主数据源）；
            # FakeRunner 记 source="fake" 作无 LLM 演示种子。
            DecisionRecorder().maybe_record(
                self._task_types.get(task_id), params, result,
                source="fake" if getattr(runner, "name", "") == "fake" else "engine",
            )
            # 报告正文必须先稳定落盘，任务才可对外进入 done；没有非空正文的
            # 回测/策略类结果会由 ReportStore 明确 no-op。
            report = self.report_store.get_report(task_id)
            if report is None:
                report = self.report_store.save_task_result(
                    task_id,
                    self._task_types[task_id],
                    params,
                    result,
                )
            attach_report = getattr(runner, "attach_report", None)
            if report is not None and attach_report is not None:
                attach_report(task_id, report["id"])
            self._results[task_id] = result
            self._status[task_id] = "done"
            self._put(task_id, {"type": "result", "data": result})
        except Exception as exc:  # 引擎异常不拖垮服务
            if self._cancel_events.get(task_id) is not None \
                    and self._cancel_events[task_id].is_set():
                self._status[task_id] = "cancelled"
                return
            fail_task = getattr(runner, "fail_task", None)
            if fail_task is not None:
                try:
                    fail_task(task_id, f"{type(exc).__name__}: {exc}")
                except Exception:
                    pass
            self._errors[task_id] = str(exc)
            self._status[task_id] = "failed"
            self._put(task_id, {"type": "error", "message": str(exc)})
        finally:
            self._put(task_id, {"type": "done"})

    def _safe_manifest(self, runner, params: dict) -> dict | None:
        """安全获取 runner 的 pipeline_manifest（Runner 未实现时返回 None）。"""
        try:
            fn = getattr(runner, "pipeline_manifest", None)
            if fn is None:
                return None
            return fn(params)
        except Exception:
            return None

    # ---- 查询 -----------------------------------------------------------

    def exists(self, task_id: str) -> bool:
        return task_id in self._queues

    def status(self, task_id: str) -> dict:
        return {
            "task_id": task_id,
            "task_type": self._task_types.get(task_id),
            "status": self._status.get(task_id, "pending"),
            "error": self._errors.get(task_id),
        }

    def result(self, task_id: str) -> Optional[dict]:
        return self._results.get(task_id)

    def cancel(self, task_id: str) -> bool:
        """请求取消内存 worker，并让支持持久化的 runner 同步落盘。"""
        if task_id not in self._status:
            return False
        if self._status.get(task_id) not in ("pending", "running"):
            return False
        runner = self.registry.get(self._task_types.get(task_id, ""))
        cancel_task = getattr(runner, "cancel_task", None)
        if cancel_task is not None and not cancel_task(task_id):
            # 持久化状态已经 completed/failed/cancelled 时，以权威状态为准，
            # 避免完成与取消竞态把内存状态错误覆盖成 cancelled。
            return False
        event = self._cancel_events.get(task_id)
        if event is not None:
            event.set()
        future = self._futures.get(task_id)
        if future is not None:
            cancelled_before_start = future.cancel()
            if cancelled_before_start:
                self._put(task_id, {"type": "done"})
        self._status[task_id] = "cancelled"
        return True

    # ---- 线程安全投递 ----------------------------------------------------

    def _put_stage(self, task_id: str, event) -> None:
        """引擎 progress_callback：兼容 str（旧 Runner）和 dict（新结构化事件）。

        - str：旧 FakeRunner / 旧引擎纯文本 → 包装成 legacy stage 事件
        - dict：新 trading_graph 结构化事件 → 补 ts 后透传（type 已由引擎侧填写）
        """
        if isinstance(event, dict):
            ev = {"ts": time.time(), **event}
        else:  # str 或其他 → 向后兼容
            ev = {"type": "stage", "node": None, "message": str(event), "ts": time.time()}
        self._put(task_id, ev)

    def _put(self, task_id: str, event: dict) -> None:
        """worker 线程 → 主事件循环队列（线程安全）。"""
        loop = self._loops.get(task_id)
        q = self._queues.get(task_id)
        if loop is None or q is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(q.put_nowait, event)

    # ---- SSE 消费 -------------------------------------------------------

    async def stream_events(self, task_id: str):
        """SSE async generator：排空已有事件后阻塞等待新事件，直到 done/error。"""
        q = self._queues.get(task_id)
        if q is None:
            yield {"type": "error", "message": "任务不存在"}
            return

        # 任务已完成且队列已空（晚来的订阅者）：直接补发结果
        if self._status.get(task_id) == "done" and self._results.get(task_id):
            yield {"type": "result", "data": self._results[task_id]}
            yield {"type": "done"}
            return

        # 先排空排队中的事件
        while True:
            try:
                ev = q.get_nowait()
            except asyncio.QueueEmpty:
                break
            yield ev
            if ev["type"] in ("done", "error"):
                return

        # 阻塞等待后续事件
        while True:
            ev = await q.get()
            yield ev
            if ev["type"] in ("done", "error"):
                return
