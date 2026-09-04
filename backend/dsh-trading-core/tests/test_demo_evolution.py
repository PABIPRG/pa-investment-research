# -*- coding: utf-8 -*-
"""演示进化数据必须隔离、可重复，并稳定覆盖关键场景。"""

import tempfile
import unittest
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from adapter.demo_evolution import (
    DEMO_BACKTEST_TASK_ID,
    DEMO_MARKER,
    DEMO_SHADOW_TASK_ID,
    RC10_TRADE_DATES,
    clean_demo_state,
    prepare_demo_state,
    seed_deterministic_demo,
    verify_demo_state,
)
from adapter.store import JsonStore
from adapter.config import settings


class DemoEvolutionTests(unittest.TestCase):
    def test_fixture_is_repeatable_and_covers_all_scenarios(self):
        root = Path(tempfile.mkdtemp()) / "demo-state"
        prepare_demo_state(root)
        store = JsonStore(root / "data")

        first = seed_deterministic_demo(store)
        second = seed_deterministic_demo(store)
        result = verify_demo_state(store)

        self.assertEqual(first["dates"], second["dates"])
        self.assertEqual(result["days"], 5)
        self.assertEqual(
            set(result["scenarios"]),
            {"normal", "promote_mutate", "watch", "retire"},
        )
        self.assertEqual(result["backtest_task_id"], DEMO_BACKTEST_TASK_ID)
        self.assertEqual(result["shadow_task_id"], DEMO_SHADOW_TASK_ID)
        self.assertEqual(result["reports"], 2)
        self.assertEqual(len(store.all("shadow_equity")), 5)
        self.assertTrue((root / DEMO_MARKER).is_file())
        self.assertEqual(first["dates"], list(RC10_TRADE_DATES))
        self.assertEqual(result["dates"], list(RC10_TRADE_DATES))
        self.assertEqual(result["children"], 2)
        self.assertEqual(
            set(result["action_types"]),
            {"promote", "mutate", "demote", "retire"},
        )

    def test_rebuild_clears_stale_business_data_and_ignores_runtime_thresholds(self):
        root = Path(tempfile.mkdtemp()) / "demo-state"
        prepare_demo_state(root)
        store = JsonStore(root / "data")
        store.set("reports", "stale", {"id": "stale"})
        store.set("strategy_backtests", "stale", {"task_id": "stale"})

        with (
            patch.object(settings, "evolve_min_days", 99),
            patch.object(settings, "evolve_mutate_branches", 0),
            patch.object(settings, "evolve_promote_nav", 9.0),
        ):
            seed_deterministic_demo(store)
            result = verify_demo_state(store)

        self.assertEqual(set(result["scenarios"]), {"normal", "promote_mutate", "watch", "retire"})
        self.assertNotIn("stale", store.all("reports"))
        self.assertNotIn("stale", store.all("strategy_backtests"))
        self.assertEqual(set(store.all("reports")), {DEMO_BACKTEST_TASK_ID, DEMO_SHADOW_TASK_ID})
        self.assertEqual(set(store.all("strategy_backtests")), {DEMO_BACKTEST_TASK_ID})

    def test_fixture_uses_authoritative_task_and_report_collections_without_orphans(self):
        root = Path(tempfile.mkdtemp()) / "demo-state"
        prepare_demo_state(root)
        store = JsonStore(root / "data")
        seed_deterministic_demo(store)

        backtest = store.get("strategy_backtests", DEMO_BACKTEST_TASK_ID)
        shadow = store.get("shadow_tasks", DEMO_SHADOW_TASK_ID)
        results = store.all("shadow_task_results")
        reports = store.all("reports")

        self.assertEqual(backtest["report_id"], DEMO_BACKTEST_TASK_ID)
        self.assertEqual(shadow["report_id"], DEMO_SHADOW_TASK_ID)
        self.assertEqual(len(results), 4)
        self.assertTrue(all(row["report_id"] in reports for row in results.values()))
        self.assertTrue(all(row["equity_ref"]["key"] in store.all("shadow_equity") for row in results.values()))
        self.assertEqual(verify_demo_state(store)["reports"], 2)

    def test_clean_refuses_unmarked_directory(self):
        root = Path(tempfile.mkdtemp()) / "ordinary-state"
        root.mkdir()
        (root / "keep.txt").write_text("keep", encoding="utf-8")

        with self.assertRaises(ValueError):
            clean_demo_state(root)

        self.assertTrue((root / "keep.txt").is_file())

    def test_prepare_refuses_to_claim_an_existing_unmarked_directory(self):
        root = Path(tempfile.mkdtemp()) / "existing-state"
        root.mkdir()

        with self.assertRaises(ValueError):
            prepare_demo_state(root)

        self.assertFalse((root / DEMO_MARKER).exists())

    def test_clean_removes_only_marked_demo_state(self):
        root = Path(tempfile.mkdtemp()) / "demo-state"
        prepare_demo_state(root)
        (root / "data").mkdir()
        (root / "data" / "strategies.json").write_text("{}", encoding="utf-8")

        clean_demo_state(root)

        self.assertFalse(root.exists())


class DemoEvolutionScriptTests(unittest.TestCase):
    repo = Path(__file__).resolve().parents[3]
    script = repo / "scripts" / "prepare-demo-evolution-data.sh"
    service_script = repo / "scripts" / "prepare-rc10-demo-service-data.py"

    def _run(self, action: str, state: Path, **extra: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.pop("DSH_DEMO_STATE_DIR", None)
        environment.update(
            {
                "DSH_INVESTMENT_STATE_DIR": str(state),
                "DSH_DEMO_PYTHON": sys.executable,
                **extra,
            }
        )
        return subprocess.run(
            ["bash", str(self.script), action],
            cwd=self.repo,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def test_script_is_directly_executable(self):
        self.assertTrue(os.access(self.script, os.X_OK))

    def test_service_script_refuses_unmarked_root_before_writing(self):
        root = Path(tempfile.mkdtemp()) / "ordinary-state"
        events = root / "services" / "market-watch" / "data" / "events.json"
        stats = root / "services" / "industry-chain" / "data" / "seed" / "stats.json"
        events.parent.mkdir(parents=True)
        stats.parent.mkdir(parents=True)
        events.write_text("daily-market", encoding="utf-8")
        stats.write_text("daily-industry", encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(self.service_script), "prepare", "--demo-root", str(root)],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

        self.assertEqual({
            "returncode_is_nonzero": result.returncode != 0,
            "events": events.read_text(encoding="utf-8"),
            "stats": stats.read_text(encoding="utf-8"),
            "unexpected_seed_exists": (stats.parent / "companies.json").exists(),
        }, {
            "returncode_is_nonzero": True,
            "events": "daily-market",
            "stats": "daily-industry",
            "unexpected_seed_exists": False,
        }, result.stdout)
        self.assertIn("拒绝操作未标记的状态目录", result.stdout)

    def test_service_script_accepts_a_marked_isolated_root(self):
        root = Path(tempfile.mkdtemp()) / "demo-state"
        prepare_demo_state(root)

        prepared = subprocess.run(
            [sys.executable, str(self.service_script), "prepare", "--demo-root", str(root)],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        verified = subprocess.run(
            [sys.executable, str(self.service_script), "verify", "--demo-root", str(root)],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

        self.assertEqual(prepared.returncode, 0, prepared.stdout)
        self.assertEqual(verified.returncode, 0, verified.stdout)
        self.assertTrue(
            (root / "services" / "market-watch" / "data" / "events.json").is_file()
        )

    def test_prepare_verify_preflight_clean_leave_ordinary_state_unchanged(self):
        base = Path(tempfile.mkdtemp())
        demo = base / "demo"
        ordinary = base / "ordinary"
        ordinary.mkdir()
        sentinel = ordinary / "keep.txt"
        sentinel.write_text("daily-state", encoding="utf-8")

        for action in ("prepare", "verify", "preflight", "prepare", "verify"):
            result = self._run(action, demo)
            self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "daily-state")

        cleaned = self._run("clean", demo)
        self.assertEqual(cleaned.returncode, 0, cleaned.stdout)
        self.assertFalse(demo.exists())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "daily-state")

    def test_mismatched_state_variables_fail_with_actionable_message(self):
        base = Path(tempfile.mkdtemp())
        result = self._run(
            "prepare",
            base / "authoritative",
            DSH_DEMO_STATE_DIR=str(base / "different"),
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("指向不同目录", result.stdout)
        self.assertFalse((base / "authoritative").exists())
        self.assertFalse((base / "different").exists())

    def test_failed_verify_can_be_recovered_by_prepare(self):
        demo = Path(tempfile.mkdtemp()) / "demo"
        prepared = self._run("prepare", demo)
        self.assertEqual(prepared.returncode, 0, prepared.stdout)
        (demo / "data" / "shadow_equity.json").write_text("{}", encoding="utf-8")

        failed = self._run("verify", demo)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("演示数据校验失败", failed.stdout)

        recovered = self._run("prepare", demo)
        self.assertEqual(recovered.returncode, 0, recovered.stdout)
        verified = self._run("verify", demo)
        self.assertEqual(verified.returncode, 0, verified.stdout)

    def test_preflight_failure_is_actionable(self):
        demo = Path(tempfile.mkdtemp()) / "demo"
        prepared = self._run("prepare", demo)
        self.assertEqual(prepared.returncode, 0, prepared.stdout)

        failed = self._run("preflight", demo, EVOLVE_MIN_DAYS="6")

        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("演示数据门槛为 5 日", failed.stdout)
        self.assertIn("演示前检查未通过", failed.stdout)


if __name__ == "__main__":
    unittest.main()
