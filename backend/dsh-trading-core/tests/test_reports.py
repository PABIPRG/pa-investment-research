# -*- coding: utf-8 -*-
"""统一报告库的落盘、任务钩子与 HTTP 查询契约。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


os.environ["ADAPTER_RUNNER"] = "fake"
os.environ["BRIEF_SCHEDULE_ENABLED"] = "false"

from fastapi.testclient import TestClient

from adapter.analyzer import TaskManager
from adapter.app import create_app
from adapter.report_store import (
    ReportStore,
    ReportStoreCorruptionError,
    ReportValidationError,
)
from adapter.store import JsonStore
from adapter.task_report_render import (
    render_backtest_report,
    render_shadow_report,
    render_strategy_report,
)


FIRST_ID = "1" * 32
SECOND_ID = "2" * 32


def _stock_result(report_body: str = "# 市场分析\n\n正文") -> dict:
    return {
        "signal": {
            "signal_type": "final",
            "ticker": "600519",
            "company_name": "贵州茅台",
            "action": "持有",
        },
        "reports": {"market": report_body, "risk": "   "},
        "performance_metrics": {},
    }


class _ImmediateRunner:
    name = "test-runner"

    def __init__(self, result: dict):
        self.result = result

    def run(self, params: dict, progress_cb) -> dict:
        return self.result


class ReportStoreTests(unittest.TestCase):
    def test_full_report_survives_store_recreation_and_summary_stays_lightweight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_store = ReportStore(JsonStore(root))

            saved = report_store.save_task_result(
                FIRST_ID,
                "stock",
                {"ticker": "600519", "date": "2026-08-26"},
                _stock_result(),
            )

            self.assertTrue((root / "reports.json").is_file())
            self.assertEqual(saved["id"], FIRST_ID)
            self.assertEqual(saved["task_type"], "stock")
            self.assertEqual(saved["title"], "个股分析报告 · 贵州茅台（600519）")
            self.assertEqual(saved["subject"], "贵州茅台（600519）")
            self.assertEqual(saved["reference"], {"ticker": "600519"})
            self.assertEqual(saved["section_keys"], ["market"])
            self.assertEqual(saved["reports"], {"market": "# 市场分析\n\n正文"})

            restarted = ReportStore(JsonStore(root))
            self.assertEqual(restarted.get_report(FIRST_ID), saved)
            summaries = restarted.list_reports()
            self.assertEqual(len(summaries), 1)
            self.assertNotIn("signal", summaries[0])
            self.assertNotIn("reports", summaries[0])
            self.assertEqual(summaries[0]["section_keys"], ["market"])

    def test_listing_filters_task_type_orders_newest_first_and_enforces_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            report_store = ReportStore(JsonStore(Path(temporary)))
            with patch(
                "adapter.report_store._utc_now",
                side_effect=[
                    "2026-08-26T01:00:00+00:00",
                    "2026-08-26T02:00:00+00:00",
                ],
            ):
                report_store.save_task_result(
                    FIRST_ID, "stock", {"ticker": "600519"}, _stock_result()
                )
                report_store.save_task_result(
                    SECOND_ID,
                    "brief",
                    {"period": "pre_market", "scope": "all"},
                    {
                        "signal": {"signal_type": "brief", "period": "pre_market"},
                        "reports": {"brief": "# 盘前简报"},
                    },
                )

            self.assertEqual(
                [item["id"] for item in report_store.list_reports(limit=2)],
                [SECOND_ID, FIRST_ID],
            )
            self.assertEqual(
                [item["id"] for item in report_store.list_reports(task_type="stock")],
                [FIRST_ID],
            )
            self.assertEqual(report_store.list_reports(limit=1)[0]["id"], SECOND_ID)

    def test_empty_reports_are_a_noop_and_malformed_contract_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            report_store = ReportStore(JsonStore(Path(temporary)))

            self.assertIsNone(
                report_store.save_task_result(
                    FIRST_ID,
                    "stock",
                    {"ticker": "600519"},
                    {"signal": {}, "reports": {"market": " \n "}},
                )
            )
            self.assertEqual(report_store.list_reports(), [])

            with self.assertRaisesRegex(ReportValidationError, "必须是字符串"):
                report_store.save_task_result(
                    FIRST_ID,
                    "stock",
                    {"ticker": "600519"},
                    {"signal": {}, "reports": {"market": ["非法正文"]}},
                )
            with self.assertRaisesRegex(ReportValidationError, "32 位"):
                report_store.get_report("../reports.json")
            with self.assertRaisesRegex(ReportValidationError, "limit"):
                report_store.list_reports(limit=0)
            with self.assertRaisesRegex(ReportValidationError, "task_type"):
                report_store.list_reports(task_type="unknown")

    def test_corrupt_persisted_record_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set("reports", FIRST_ID, {"id": FIRST_ID, "reports": {}})
            report_store = ReportStore(store)

            with self.assertRaisesRegex(ReportStoreCorruptionError, FIRST_ID):
                report_store.get_report(FIRST_ID)
            with self.assertRaisesRegex(ReportStoreCorruptionError, FIRST_ID):
                report_store.list_reports()


class QuantitativeTaskReportTests(unittest.TestCase):
    def test_backtest_strategy_and_shadow_render_non_empty_auditable_reports(self):
        backtest = render_backtest_report(
            {
                "eval_window_days": 20,
                "n_evaluated": 12,
                "n_fetch_failed": 0,
                "direction_accuracy_pct": 66.7,
                "win_rate_pct": 60.0,
                "avg_simulated_return_pct": 2.5,
                "sharpe_annualized": 1.2,
                "max_drawdown_pct": -3.4,
            },
            [{"ticker": "600519"}],
            {"code": "600519"},
        )
        strategy = render_strategy_report(
            {
                "id": "strategy-1",
                "name": "事件动量策略",
                "kind": "momentum",
                "direction": "利好",
                "symbols": ["600519"],
            },
            "active",
            {
                "in_sample": {"n_evaluated": 20, "win_rate_pct": 55.0},
                "out_of_sample": {"n_evaluated": 8, "win_rate_pct": 62.5},
                "thresholds_pass": True,
                "reason": "样本外胜率/均收益达标",
            },
        )
        shadow = render_shadow_report(
            "2026-08-26",
            {
                "strategy-1": {
                    "name": "事件动量策略",
                    "symbols": ["600519"],
                    "nav": 1.03,
                    "equity": 103000,
                    "closed_count": 2,
                }
            },
            1.03,
            {},
        )

        self.assertIn("# 历史决策回测报告", backtest)
        self.assertIn("已评估决策 | 12", backtest)
        self.assertIn("# 策略样本外回测报告", strategy)
        self.assertIn("样本外胜率/均收益达标", strategy)
        self.assertIn("# 影子验证报告", shadow)
        self.assertIn("事件动量策略", shadow)

    def test_quantitative_sections_round_trip_through_unified_report_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            report_store = ReportStore(JsonStore(Path(temporary)))
            report_store.save_task_result(
                FIRST_ID,
                "strategy",
                {"strategy_id": "strategy-1"},
                {
                    "signal": {"strategy_id": "strategy-1"},
                    "reports": {
                        "strategy": render_strategy_report(
                            {"id": "strategy-1", "symbols": ["600519"]},
                            "candidate",
                            {"reason": "样本外成交不足"},
                        )
                    },
                },
            )

            detail = report_store.get_report(FIRST_ID)
            self.assertEqual(detail["task_type"], "strategy")
            self.assertEqual(detail["section_keys"], ["strategy"])
            self.assertIn("样本外成交不足", detail["reports"]["strategy"])


class TaskManagerReportPersistenceTests(unittest.TestCase):
    def _run_task(self, manager: TaskManager, params: dict, task_type: str) -> str:
        async def run_and_wait() -> str:
            task_id = manager.start(params, task_type=task_type)
            for _ in range(200):
                if manager.status(task_id)["status"] != "running":
                    return task_id
                await asyncio.sleep(0.005)
            self.fail("任务未在预期时间内结束")

        with patch("adapter.analyzer.DecisionRecorder.maybe_record", return_value=None):
            return asyncio.run(run_and_wait())

    def test_successful_task_persists_report_before_marking_done(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_store = ReportStore(JsonStore(root))
            manager = TaskManager(
                registry={"stock": _ImmediateRunner(_stock_result())},
                report_store=report_store,
            )
            try:
                task_id = self._run_task(manager, {"ticker": "600519"}, "stock")
                self.assertEqual(manager.status(task_id)["status"], "done")
                persisted = ReportStore(JsonStore(root)).get_report(task_id)
                self.assertIsNotNone(persisted)
                self.assertEqual(persisted["id"], task_id)
                self.assertEqual(persisted["reports"]["market"], "# 市场分析\n\n正文")
            finally:
                manager.executor.shutdown(wait=True)

    def test_malformed_report_prevents_false_done_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            report_store = ReportStore(JsonStore(Path(temporary)))
            manager = TaskManager(
                registry={
                    "stock": _ImmediateRunner(
                        {"signal": {}, "reports": {"market": {"invalid": True}}}
                    )
                },
                report_store=report_store,
            )
            try:
                task_id = self._run_task(manager, {"ticker": "600519"}, "stock")
                status = manager.status(task_id)
                self.assertEqual(status["status"], "failed")
                self.assertIn("必须是字符串", status["error"])
                self.assertIsNone(report_store.get_report(task_id))
            finally:
                manager.executor.shutdown(wait=True)


class ReportsApiTests(unittest.TestCase):
    def test_list_detail_restart_and_query_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_store = ReportStore(JsonStore(root))
            report_store.save_task_result(
                FIRST_ID,
                "stock",
                {"ticker": "600519"},
                _stock_result(),
            )

            app = create_app(report_store=report_store)
            try:
                with TestClient(app) as client:
                    response = client.get("/reports", params={"limit": 10, "task_type": "stock"})
                    self.assertEqual(response.status_code, 200)
                    payload = response.json()
                    self.assertEqual(payload["count"], 1)
                    list_item = payload["items"][0]
                    self.assertEqual(
                        set(list_item),
                        {"id", "title", "kind", "created_at", "summary", "task_id"},
                    )
                    self.assertEqual(list_item["id"], FIRST_ID)
                    self.assertEqual(list_item["task_id"], FIRST_ID)
                    self.assertEqual(list_item["kind"], "stock")
                    self.assertEqual(list_item["summary"], "贵州茅台（600519）")

                    detail = client.get(f"/reports/{FIRST_ID}")
                    self.assertEqual(detail.status_code, 200)
                    detail_payload = detail.json()
                    self.assertEqual(
                        set(detail_payload),
                        {
                            "id",
                            "title",
                            "kind",
                            "created_at",
                            "summary",
                            "task_id",
                            "sections",
                        },
                    )
                    self.assertEqual(detail_payload["kind"], "stock")
                    self.assertEqual(
                        detail_payload["sections"],
                        [
                            {
                                "key": "market",
                                "title": "市场分析",
                                "content": "# 市场分析\n\n正文",
                            }
                        ],
                    )

                    self.assertEqual(client.get("/reports", params={"limit": 0}).status_code, 422)
                    self.assertEqual(
                        client.get("/reports", params={"task_type": "unknown"}).status_code,
                        422,
                    )
                    self.assertEqual(client.get("/reports/not-a-task-id").status_code, 422)
                    self.assertEqual(client.get(f"/reports/{'f' * 32}").status_code, 404)
            finally:
                app.state.manager.executor.shutdown(wait=True)

            restarted_app = create_app(
                report_store=ReportStore(JsonStore(root))
            )
            try:
                with TestClient(restarted_app) as client:
                    self.assertEqual(client.get(f"/reports/{FIRST_ID}").status_code, 200)
            finally:
                restarted_app.state.manager.executor.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
