# -*- coding: utf-8 -*-
"""rc.10 影子验证持久任务账本。"""

import tempfile
import unittest
import asyncio
import os
import sys
import threading
import types
from pathlib import Path
from unittest.mock import patch

from adapter.store import JsonStore

os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"


TASK_ID = "a" * 32


def _install_optional_app_stubs():
    """本机精简测试环境缺少 Web/Scheduler 可选包，只补路由装配所需类型。"""
    if "sse_starlette.sse" not in sys.modules:
        from starlette.responses import StreamingResponse

        sse_package = types.ModuleType("sse_starlette")
        sse_module = types.ModuleType("sse_starlette.sse")

        class EventSourceResponse(StreamingResponse):
            pass

        sse_module.EventSourceResponse = EventSourceResponse
        sys.modules["sse_starlette"] = sse_package
        sys.modules["sse_starlette.sse"] = sse_module
    if "apscheduler.schedulers.background" not in sys.modules:
        apscheduler = types.ModuleType("apscheduler")
        schedulers = types.ModuleType("apscheduler.schedulers")
        background = types.ModuleType("apscheduler.schedulers.background")
        triggers = types.ModuleType("apscheduler.triggers")
        cron = types.ModuleType("apscheduler.triggers.cron")

        class BackgroundScheduler:
            def __init__(self, *args, **kwargs):
                pass

        class CronTrigger:
            def __init__(self, *args, **kwargs):
                pass

        background.BackgroundScheduler = BackgroundScheduler
        cron.CronTrigger = CronTrigger
        sys.modules.update({
            "apscheduler": apscheduler,
            "apscheduler.schedulers": schedulers,
            "apscheduler.schedulers.background": background,
            "apscheduler.triggers": triggers,
            "apscheduler.triggers.cron": cron,
        })


class ShadowTaskLedgerTests(unittest.TestCase):
    def _running_task(self, store, tasks, task_id, strategy_ids):
        tasks.create_pending_task(
            store,
            task_id=task_id,
            source="scheduled",
            scope="batch",
            strategy_ids=strategy_ids,
            trade_date="2026-09-03",
            force=False,
            request_params={},
        )
        self.assertTrue(tasks.claim_task(store, task_id))

    def test_task_lifecycle_survives_store_recreation(self):
        """删除任务落盘或只写内存时，本测试必须失败。"""
        from adapter import shadow_tasks as tasks

        with tempfile.TemporaryDirectory() as temporary, patch(
            "adapter.shadow_tasks._now", side_effect=[
                "2026-09-03 09:00:00",
                "2026-09-03 09:00:01",
                "2026-09-03 09:00:02",
            ],
        ):
            root = Path(temporary)
            store = JsonStore(root)
            row = tasks.create_pending_task(
                store,
                task_id=TASK_ID,
                source="manual",
                scope="single",
                strategy_ids=["strategy-a"],
                trade_date="2026-09-03",
                force=False,
                request_params={"strategy_id": "strategy-a", "force": False},
            )
            self.assertEqual(row["status"], "pending")
            self.assertTrue(tasks.claim_task(store, TASK_ID))
            self.assertTrue(tasks.complete_task(store, TASK_ID))

            restarted = tasks.get_task(JsonStore(root), TASK_ID)
            self.assertEqual(restarted["status"], "completed")
            self.assertEqual(restarted["created_at"], "2026-09-03 09:00:00")
            self.assertEqual(restarted["started_at"], "2026-09-03 09:00:01")
            self.assertEqual(restarted["completed_at"], "2026-09-03 09:00:02")
            self.assertEqual(restarted["ended_at"], "2026-09-03 09:00:02")
            self.assertEqual(restarted["strategy_ids"], ["strategy-a"])

    def test_recovery_marks_pending_and_running_tasks_interrupted(self):
        """重启若遗留不可执行状态或把它伪装成普通失败，本测试必须失败。"""
        from adapter import shadow_tasks as tasks

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            for task_id in ("b" * 32, "c" * 32):
                tasks.create_pending_task(
                    store,
                    task_id=task_id,
                    source="scheduled",
                    scope="batch",
                    strategy_ids=["strategy-a"],
                    trade_date="2026-09-03",
                    force=False,
                    request_params={},
                )
            tasks.claim_task(store, "c" * 32)

            with patch("adapter.shadow_tasks._now", return_value="2026-09-03 10:00:00"):
                counts = tasks.recover_tasks(store)

            self.assertEqual(counts, {"interrupted": 2})
            for task_id in ("b" * 32, "c" * 32):
                row = tasks.get_task(store, task_id)
                self.assertEqual(row["status"], "interrupted")
                self.assertEqual(row["completed_at"], "2026-09-03 10:00:00")
                self.assertIn("服务重启", row["error"])

    def test_strategy_results_aggregate_partial_without_losing_success(self):
        """把局部失败误聚合为 completed，或只保留失败列表时必须失败。"""
        from adapter import shadow_tasks as tasks

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            self._running_task(store, tasks, TASK_ID, ["strategy-a", "strategy-b"])
            first = tasks.save_strategy_result(
                store,
                task_id=TASK_ID,
                strategy_id="strategy-a",
                status="success",
                reason=None,
                snapshot={"nav": 1.02},
                trade_date="2026-09-03",
            )
            second = tasks.save_strategy_result(
                store,
                task_id=TASK_ID,
                strategy_id="strategy-b",
                status="failed",
                reason="ValueError: 策略无 symbols",
                snapshot=None,
                trade_date="2026-09-03",
            )
            self.assertTrue(tasks.finalize_task(store, TASK_ID, overall_nav=1.02))

            task = tasks.get_task(store, TASK_ID)
            self.assertEqual(task["status"], "partial")
            self.assertEqual(task["summary"], {
                "total": 2, "success": 1, "failed": 1, "skipped": 0,
                "overall_nav": 1.02, "all_skipped": False,
            })
            self.assertEqual(task["result_ids"], [first["result_id"], second["result_id"]])
            results = tasks.list_task_results(store, TASK_ID)
            self.assertEqual([row["status"] for row in results], ["success", "failed"])
            self.assertEqual(results[1]["reason"], "ValueError: 策略无 symbols")
            self.assertEqual(results[0]["equity_ref"], {
                "collection": "shadow_equity", "key": "2026-09-03", "task_id": TASK_ID,
            })

    def test_aggregate_all_failed_and_all_skipped_are_distinct(self):
        """全失败和全跳过若无法从任务摘要区分，本测试必须失败。"""
        from adapter import shadow_tasks as tasks

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            failed_id = "d" * 32
            self._running_task(store, tasks, failed_id, ["strategy-a"])
            tasks.save_strategy_result(
                store, task_id=failed_id, strategy_id="strategy-a", status="failed",
                reason="数据失败", snapshot=None, trade_date="2026-09-03",
            )
            tasks.finalize_task(store, failed_id, overall_nav=None)
            self.assertEqual(tasks.get_task(store, failed_id)["status"], "failed")

            skipped_id = "e" * 32
            self._running_task(store, tasks, skipped_id, ["strategy-b"])
            tasks.save_strategy_result(
                store, task_id=skipped_id, strategy_id="strategy-b", status="skipped",
                reason="策略不参与影子验证", snapshot=None, trade_date="2026-09-03",
            )
            tasks.finalize_task(store, skipped_id, overall_nav=None)
            skipped = tasks.get_task(store, skipped_id)
            self.assertEqual(skipped["status"], "completed")
            self.assertTrue(skipped["summary"]["all_skipped"])

    def test_non_force_reuses_scope_task_and_force_links_rerun(self):
        """同日同作用域若新增重复账本，或 force 覆盖旧任务，本测试必须失败。"""
        from adapter import shadow_tasks as tasks

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            key = tasks.scope_key("2026-09-03", "single", ["strategy-a"])
            first = tasks.create_pending_task(
                store, task_id="1" * 32, source="scheduled", scope="single",
                strategy_ids=["strategy-a"], trade_date="2026-09-03", force=False,
                request_params={}, dedupe_key=key,
            )
            repeated = tasks.create_pending_task(
                store, task_id="2" * 32, source="manual", scope="single",
                strategy_ids=["strategy-a"], trade_date="2026-09-03", force=False,
                request_params={}, dedupe_key=key,
            )
            forced = tasks.create_pending_task(
                store, task_id="3" * 32, source="manual", scope="single",
                strategy_ids=["strategy-a"], trade_date="2026-09-03", force=True,
                request_params={"force": True}, dedupe_key=None,
                rerun_of_task_id=tasks.find_latest_for_scope(
                    store, "2026-09-03", "single", ["strategy-a"]
                )["task_id"],
            )

            self.assertEqual(repeated["task_id"], first["task_id"])
            self.assertFalse(repeated["should_dispatch"])
            self.assertEqual(forced["task_id"], "3" * 32)
            self.assertEqual(forced["rerun_of_task_id"], first["task_id"])
            self.assertEqual(len(tasks.list_tasks(store)), 2)

    def test_task_manager_does_not_dispatch_reused_terminal_task(self):
        """TaskManager 若把幂等命中的终态任务再次提交 worker，本测试必须失败。"""
        from adapter.analyzer import TaskManager

        class ReusedRunner:
            name = "shadow-validator"

            def __init__(self):
                self.runs = 0

            def prepare_task(self, task_id, params):
                return {
                    "task_id": TASK_ID,
                    "status": "completed",
                    "result": {"task_id": TASK_ID, "task_status": "completed"},
                    "should_dispatch": False,
                }

            def run(self, params, progress_cb):
                self.runs += 1
                return {}

        async def exercise():
            runner = ReusedRunner()
            manager = TaskManager(registry={"shadow": runner})
            selected = manager.start({}, task_type="shadow", task_id="f" * 32)
            await asyncio.sleep(0.02)
            return runner, manager, selected

        runner, manager, selected = asyncio.run(exercise())
        self.assertEqual(selected, TASK_ID)
        self.assertEqual(runner.runs, 0)
        self.assertEqual(manager.status(TASK_ID)["status"], "done")
        self.assertEqual(manager.result(TASK_ID)["task_status"], "completed")

    def test_task_manager_does_not_publish_result_after_running_task_is_cancelled(self):
        """运行中取消后，worker 晚到的正常返回不得覆盖 cancelled 或生成报告。"""
        from adapter.analyzer import TaskManager

        class SlowRunner:
            name = "shadow-validator"

            def __init__(self):
                self.started = threading.Event()
                self.release = threading.Event()
                self.attached = []

            def run(self, params, progress_cb):
                self.started.set()
                self.release.wait(timeout=2)
                return {"task_id": params["task_id"], "reports": {"shadow": "late"}}

            def cancel_task(self, task_id):
                return True

            def attach_report(self, task_id, report_id):
                self.attached.append(report_id)

        async def exercise():
            runner = SlowRunner()
            manager = TaskManager(registry={"shadow": runner})
            selected = manager.start({}, task_type="shadow", task_id=TASK_ID)
            while not runner.started.is_set():
                await asyncio.sleep(0.01)
            self.assertTrue(manager.cancel(selected))
            runner.release.set()
            for _ in range(100):
                if manager._futures[selected].done():
                    break
                await asyncio.sleep(0.01)
            return runner, manager, selected

        runner, manager, selected = asyncio.run(exercise())
        self.assertEqual(manager.status(selected)["status"], "cancelled")
        self.assertIsNone(manager.result(selected))
        self.assertEqual(runner.attached, [])

    def test_shadow_runner_persists_batch_partial_results(self):
        """runner 若只返回 strategy_errors 而不写逐策略账本，本测试必须失败。"""
        from adapter import shadow_tasks as tasks
        from adapter.shadow import ShadowRunner

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            for strategy_id in ("strategy-a", "strategy-b"):
                store.set("strategies", strategy_id, {
                    "id": strategy_id, "name": strategy_id, "status": "active",
                    "symbols": ["600519"], "kind": "ma_cross", "params": {},
                })
            runner = ShadowRunner(store)

            def execute(strategy, trade_date, history_start, meta, progress_cb):
                if strategy["id"] == "strategy-b":
                    raise ValueError("fixture failure")
                return {
                    "name": strategy["name"], "kind": strategy["kind"],
                    "symbols": strategy["symbols"], "initial_capital": 100000.0,
                    "equity": 102000.0, "nav": 1.02, "per_symbol": {},
                    "symbol_errors": {}, "closed_count": 0, "track_from": trade_date,
                }

            runner._run_strategy = execute
            with patch("adapter.shadow._latest_trade_date", return_value="2026-09-03"):
                prepared = runner.prepare_task(TASK_ID, {
                    "task_id": TASK_ID, "source": "manual", "force": False,
                })
                result = runner.run({
                    "task_id": TASK_ID, "source": "manual", "force": False,
                    "trade_date": "2026-09-03",
                }, lambda _message: None)

            self.assertTrue(prepared["should_dispatch"])
            self.assertEqual(result["task_id"], TASK_ID)
            self.assertEqual(result["task_status"], "partial")
            task = tasks.get_task(store, TASK_ID)
            self.assertEqual(task["status"], "partial")
            self.assertEqual(
                [row["status"] for row in tasks.list_task_results(store, TASK_ID)],
                ["success", "failed"],
            )

    def test_shadow_runner_does_not_persist_late_strategy_result_after_cancel(self):
        """策略计算返回前已取消时，不得继续写逐策略结果、净值或报告载荷。"""
        from adapter import shadow_tasks as tasks
        from adapter.shadow import ShadowRunner

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-a", {
                "id": "strategy-a", "name": "A", "status": "active",
                "symbols": ["600519"], "kind": "ma_cross", "params": {},
            })
            runner = ShadowRunner(store)
            cancel_event = threading.Event()

            def execute(strategy, trade_date, history_start, meta, progress_cb):
                cancel_event.set()
                self.assertTrue(runner.cancel_task(TASK_ID))
                return {
                    "name": "A", "kind": "ma_cross", "symbols": ["600519"],
                    "initial_capital": 100000.0, "equity": 101000.0, "nav": 1.01,
                    "per_symbol": {}, "symbol_errors": {}, "closed_count": 0,
                    "track_from": trade_date,
                }

            runner._run_strategy = execute
            with patch("adapter.shadow._latest_trade_date", return_value="2026-09-03"):
                runner.prepare_task(TASK_ID, {
                    "task_id": TASK_ID, "source": "manual", "force": True,
                })
                with self.assertRaisesRegex(RuntimeError, "已取消"):
                    runner.run({
                        "task_id": TASK_ID, "source": "manual", "force": True,
                        "trade_date": "2026-09-03", "_cancel_event": cancel_event,
                    }, lambda _message: None)

            task = tasks.get_task(store, TASK_ID)
            self.assertEqual(task["status"], "cancelled")
            self.assertEqual(task["result_ids"], [])
            self.assertIsNone(store.get("shadow_equity", "2026-09-03"))

    def test_shadow_runner_reuses_non_force_and_preserves_force_equity_runs(self):
        """幂等请求若重算，或 force 后旧净值证据消失，本测试必须失败。"""
        from adapter import shadow_tasks as tasks
        from adapter.shadow import ShadowRunner

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-a", {
                "id": "strategy-a", "name": "strategy-a", "status": "active",
                "symbols": ["600519"], "kind": "ma_cross", "params": {},
            })
            runner = ShadowRunner(store)
            executions = {"count": 0}

            def execute(strategy, trade_date, history_start, meta, progress_cb):
                executions["count"] += 1
                nav = 1.0 + executions["count"] / 100
                return {
                    "name": strategy["name"], "kind": strategy["kind"],
                    "symbols": strategy["symbols"], "initial_capital": 100000.0,
                    "equity": nav * 100000.0, "nav": nav, "per_symbol": {},
                    "symbol_errors": {}, "closed_count": 0, "track_from": trade_date,
                }

            runner._run_strategy = execute
            with patch("adapter.shadow._latest_trade_date", return_value="2026-09-03"):
                first = runner.prepare_task("1" * 32, {
                    "task_id": "1" * 32, "source": "scheduled", "force": False,
                })
                first_result = runner.run(first["request_params"], lambda _message: None)
                repeated = runner.prepare_task("2" * 32, {
                    "task_id": "2" * 32, "source": "manual", "force": False,
                })
                forced = runner.prepare_task("3" * 32, {
                    "task_id": "3" * 32, "source": "manual", "force": True,
                })
                forced_result = runner.run(forced["request_params"], lambda _message: None)

            self.assertEqual(repeated["task_id"], first["task_id"])
            self.assertFalse(repeated["should_dispatch"])
            self.assertEqual(forced["rerun_of_task_id"], first["task_id"])
            self.assertEqual(executions["count"], 2)
            evidence = store.get("shadow_equity", "2026-09-03")
            self.assertEqual(set(evidence["runs"]), {first_result["task_id"], forced_result["task_id"]})
            self.assertEqual(
                evidence["runs"][first_result["task_id"]]["overall_nav"], 1.01,
            )
            self.assertEqual(
                evidence["runs"][forced_result["task_id"]]["overall_nav"], 1.02,
            )
            self.assertEqual(len(tasks.list_tasks(store)), 2)

    def test_direct_scheduled_run_is_idempotent_and_records_source(self):
        """调度器直调若被记成 manual 或同日重复计算，本测试必须失败。"""
        from adapter import shadow_tasks as tasks
        from adapter.shadow import ShadowRunner

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("strategies", "strategy-a", {
                "id": "strategy-a", "name": "A", "status": "active",
                "symbols": ["600519"], "kind": "ma_cross", "params": {},
            })
            runner = ShadowRunner(store)
            calls = {"count": 0}

            def execute(strategy, trade_date, history_start, meta, progress_cb):
                calls["count"] += 1
                return {
                    "name": "A", "kind": "ma_cross", "symbols": ["600519"],
                    "initial_capital": 100000.0, "equity": 100000.0, "nav": 1.0,
                    "per_symbol": {}, "symbol_errors": {}, "closed_count": 0,
                    "track_from": trade_date,
                }

            runner._run_strategy = execute
            with patch("adapter.shadow._latest_trade_date", return_value="2026-09-03"):
                first = runner.run({"force": False}, lambda _message: None)
                second = runner.run({"force": False}, lambda _message: None)

            self.assertEqual(second["task_id"], first["task_id"])
            self.assertEqual(calls["count"], 1)
            rows = tasks.list_tasks(store)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["source"], "scheduled")

    def test_empty_batch_is_completed_with_explicit_skipped_summary(self):
        """无参与策略若生成空报告或看似执行成功，本测试必须失败。"""
        from adapter import shadow_tasks as tasks
        from adapter.shadow import ShadowRunner

        with tempfile.TemporaryDirectory() as temporary, patch(
            "adapter.shadow._latest_trade_date", return_value="2026-09-03"
        ):
            store = JsonStore(Path(temporary))
            result = ShadowRunner(store).run({"force": False}, lambda _message: None)

            task = tasks.get_task(store, result["task_id"])
            self.assertTrue(result["skipped"])
            self.assertNotIn("reports", result)
            self.assertEqual(task["status"], "completed")
            self.assertEqual(task["summary"]["total"], 0)
            self.assertTrue(task["summary"]["all_skipped"])

    def test_report_reference_is_attached_to_task_and_each_strategy_result(self):
        """报告若只存在 reports 集合而账本无法追溯，本测试必须失败。"""
        from adapter import shadow_tasks as tasks

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            self._running_task(store, tasks, TASK_ID, ["strategy-a"])
            tasks.save_strategy_result(
                store, task_id=TASK_ID, strategy_id="strategy-a", status="success",
                reason=None, snapshot={"nav": 1.02}, trade_date="2026-09-03",
            )
            tasks.finalize_task(store, TASK_ID, overall_nav=1.02, result={"task_id": TASK_ID})

            self.assertTrue(tasks.attach_report(store, TASK_ID, TASK_ID))
            task = tasks.get_task(store, TASK_ID)
            self.assertEqual(task["report_ids"], [TASK_ID])
            self.assertEqual(task["report_id"], TASK_ID)
            self.assertEqual(tasks.list_task_results(store, TASK_ID)[0]["report_id"], TASK_ID)

    def test_history_detail_and_transport_fallback_read_durable_ledger(self):
        """重启后 API 若仍只查 TaskManager 内存或日期快照，本测试必须失败。"""
        from adapter import shadow_tasks as tasks
        _install_optional_app_stubs()
        from adapter.app import create_app

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            self._running_task(store, tasks, TASK_ID, ["strategy-a", "strategy-b"])
            tasks.save_strategy_result(
                store, task_id=TASK_ID, strategy_id="strategy-a", status="success",
                reason=None, snapshot={"name": "A", "nav": 1.02}, trade_date="2026-09-03",
            )
            tasks.save_strategy_result(
                store, task_id=TASK_ID, strategy_id="strategy-b", status="failed",
                reason="行情失败", snapshot=None, trade_date="2026-09-03",
            )
            persisted_result = {"task_id": TASK_ID, "task_status": "partial", "strategies": {}}
            tasks.finalize_task(store, TASK_ID, overall_nav=1.02, result=persisted_result)
            tasks.attach_report(store, TASK_ID, TASK_ID)

            with patch("adapter.app.JsonStore", return_value=store):
                app = create_app()
                history = next(route.endpoint for route in app.routes if route.path == "/shadow/history")
                detail = next(route.endpoint for route in app.routes if route.path == "/shadow/tasks/{task_id}")
                status = next(route.endpoint for route in app.routes if route.path == "/analyze/{task_id}")
                result = next(route.endpoint for route in app.routes if route.path == "/analyze/{task_id}/result")
                history_payload = asyncio.run(history(strategy_id="strategy-a", limit=20))
                detail_payload = asyncio.run(detail(task_id=TASK_ID))
                status_payload = asyncio.run(status(task_id=TASK_ID))
                result_payload = asyncio.run(result(task_id=TASK_ID))

            self.assertEqual(history_payload["count"], 1)
            self.assertEqual(history_payload["items"][0]["task_id"], TASK_ID)
            self.assertEqual(history_payload["items"][0]["status"], "partial")
            self.assertEqual(len(detail_payload["results"]), 2)
            self.assertEqual(status_payload["task_type"], "shadow")
            self.assertEqual(status_payload["status"], "done")
            self.assertEqual(status_payload["task_status"], "partial")
            self.assertEqual(result_payload, persisted_result)

    def test_cancel_route_cancels_durable_pending_task_and_rejects_terminal_task(self):
        """取消能力若只存在账本内部而没有 HTTP 入口，本测试必须失败。"""
        from fastapi import HTTPException
        from adapter import shadow_tasks as tasks
        _install_optional_app_stubs()
        from adapter.app import create_app

        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            pending_id = "9" * 32
            tasks.create_pending_task(
                store, task_id=pending_id, source="manual", scope="single",
                strategy_ids=["strategy-a"], trade_date="2026-09-03", force=True,
                request_params={"strategy_id": "strategy-a", "force": True},
            )
            self._running_task(store, tasks, TASK_ID, ["strategy-a"])
            tasks.finalize_task(store, TASK_ID, overall_nav=None, result={"task_id": TASK_ID})

            with patch("adapter.app.JsonStore", return_value=store):
                app = create_app()
                cancel = next(
                    route.endpoint for route in app.routes
                    if route.path == "/shadow/tasks/{task_id}/cancel"
                )
                payload = asyncio.run(cancel(task_id=pending_id))
                with self.assertRaises(HTTPException) as terminal_error:
                    asyncio.run(cancel(task_id=TASK_ID))

            self.assertEqual(payload, {"task_id": pending_id, "status": "cancelled"})
            self.assertEqual(tasks.get_task(store, pending_id)["status"], "cancelled")
            self.assertEqual(terminal_error.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
