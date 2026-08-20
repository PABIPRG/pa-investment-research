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
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

from .decision_recorder import DecisionRecorder
from .runner import FakeRunner


class TaskManager:
    """多任务类型管理器：registry: task_type → runner。

    三个任务类型共用同一套 SSE/result/status 基础设施：
      - stock    （POST /analyze，analyze_stock 工具）
      - holdings （POST /holdings/analyze，analyze_holdings 工具）
      - brief    （POST /brief，market_brief 工具）
    """

    def __init__(self, registry: dict | None = None, max_workers: int = 6):
        self.registry = registry or {"stock": FakeRunner()}
        self.executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="analysis"
        )
        self._queues: dict[str, asyncio.Queue] = {}  # task_id → 进度事件队列
        self._loops: dict[str, asyncio.AbstractEventLoop] = {}  # task_id → 主事件循环
        self._status: dict[str, str] = {}  # task_id → running/done/failed
        self._results: dict[str, dict] = {}  # task_id → 最终结果
        self._errors: dict[str, str] = {}  # task_id → 错误信息
        self._task_types: dict[str, str] = {}  # task_id → task_type

    # ---- 生命周期 -------------------------------------------------------

    def start(self, params: dict, task_type: str = "stock") -> str:
        """在事件循环线程内被调用：记录主循环引用，提交到 worker 线程。

        task_type 从 registry 解析对应 runner；缺省 stock 保持向后兼容。
        """
        runner = self.registry.get(task_type)
        if runner is None:
            raise KeyError(f"未知任务类型: {task_type}（可用: {list(self.registry)}）")
        task_id = uuid.uuid4().hex
        self._queues[task_id] = asyncio.Queue()
        self._loops[task_id] = asyncio.get_running_loop()
        self._status[task_id] = "running"
        self._task_types[task_id] = task_type
        params = dict(params)
        params["task_id"] = task_id  # 透传给 propagate(task_id=...) 做性能追踪
        self.executor.submit(self._run_sync, task_id, params, runner)
        return task_id

    def _run_sync(self, task_id: str, params: dict, runner) -> None:
        """worker 线程：跑同步 runner，产出进度事件与最终结果。"""
        try:
            result = runner.run(
                params, lambda msg: self._put_stage(task_id, msg)
            )
            # 决策记录：仅 stock 分析落盘结构化 signal（回测主数据源）；
            # FakeRunner 记 source="fake" 作无 LLM 演示种子。
            DecisionRecorder().maybe_record(
                self._task_types.get(task_id), params, result,
                source="fake" if getattr(runner, "name", "") == "fake" else "engine",
            )
            self._results[task_id] = result
            self._status[task_id] = "done"
            self._put(task_id, {"type": "result", "data": result})
        except Exception as exc:  # 引擎异常不拖垮服务
            self._errors[task_id] = str(exc)
            self._status[task_id] = "failed"
            self._put(task_id, {"type": "error", "message": str(exc)})
        finally:
            self._put(task_id, {"type": "done"})

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

    # ---- 线程安全投递 ----------------------------------------------------

    def _put_stage(self, task_id: str, message: str) -> None:
        """引擎 progress_callback：纯文本透传为 stage 事件。"""
        self._put(task_id, {"type": "stage", "node": None, "message": message, "ts": time.time()})

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
