# -*- coding: utf-8 -*-
"""主数据新鲜度与刷新调度的离线测试；不访问外网。"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from research_entities.adapters.storage_memory import InMemoryEntityRepository
from research_entities.errors import SourceUnavailable
from research_entities.freshness import source_freshness, stale_source_warnings
from research_entities.models import SourceBatch, SourceEntityRecord, SourceImport
from research_entities.refresh import (
    MasterDataRefresher,
    RefreshScheduler,
    refresh_lock,
)

from tests.research_entities_fixtures import build_service

NOW = datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc)


def record_import(
    repository,
    *,
    source_id: str,
    status: str = "success",
    imported: int = 1,
    at: datetime = NOW,
    error: str | None = None,
    warnings: list[str] | None = None,
) -> None:
    repository.record_source_import(
        SourceImport(
            import_id=f"{source_id}-{at.isoformat()}-{status}",
            source_id=source_id,
            source_version="v1",
            imported_count=imported,
            status=status,
            warnings=list(warnings or []),
            error=error,
            imported_at=at,
        )
    )


class FakeSource:
    def __init__(self, source_id: str = "fake_source", *, fail: bool = False) -> None:
        self.source_id = source_id
        self.fail = fail
        self.calls = 0

    def fetch_entities(self) -> SourceBatch:
        self.calls += 1
        if self.fail:
            raise SourceUnavailable("模拟网络失败")
        return SourceBatch(
            source_id=self.source_id,
            source_version="v1",
            fetched_at=NOW,
            records=[
                SourceEntityRecord(
                    entity_id="THEME:测试主题",
                    name="测试主题",
                    entity_type_code="ENTITY_03_02",
                )
            ],
        )


class SourceFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.repository = InMemoryEntityRepository()

    def freshness(self, **kwargs):
        return {
            item["source_id"]: item
            for item in source_freshness(self.repository, now=NOW, **kwargs)
        }

    def test_never_imported_is_not_treated_as_fresh(self):
        items = self.freshness()
        self.assertEqual(items["akshare_security"]["state"], "never_imported")
        self.assertTrue(items["akshare_security"]["needs_refresh"])
        self.assertIsNone(items["akshare_security"]["last_success_at"])

    def test_fresh_and_stale_use_last_success(self):
        record_import(self.repository, source_id="akshare_security")
        self.assertEqual(self.freshness()["akshare_security"]["state"], "fresh")

        record_import(
            self.repository,
            source_id="universe_json",
            at=NOW - timedelta(days=45),
        )
        item = self.freshness()["universe_json"]
        self.assertEqual(item["state"], "stale")
        self.assertGreater(item["age_hours"], item["max_age_hours"])

    def test_failed_latest_attempt_keeps_previous_success_age(self):
        record_import(self.repository, source_id="universe_json", at=NOW - timedelta(days=2))
        record_import(
            self.repository,
            source_id="universe_json",
            status="failed",
            imported=0,
            at=NOW - timedelta(hours=1),
            error="URLError",
        )
        item = self.freshness()["universe_json"]
        self.assertEqual(item["state"], "fresh")
        self.assertEqual(item["last_status"], "failed")
        self.assertEqual(item["last_error"], "URLError")

    def test_only_failures_mark_source_as_failed(self):
        record_import(
            self.repository,
            source_id="akshare_security",
            status="failed",
            imported=0,
            error="timeout",
        )
        item = self.freshness()["akshare_security"]
        self.assertEqual(item["state"], "failed")
        self.assertTrue(item["needs_refresh"])

    def test_max_age_override_applies_to_every_source(self):
        record_import(self.repository, source_id="gazetteer_json", at=NOW - timedelta(hours=2))
        item = self.freshness(max_age_hours=1)["gazetteer_json"]
        self.assertEqual(item["state"], "stale")


class StaleWarningTest(unittest.TestCase):
    def setUp(self):
        self.repository = InMemoryEntityRepository()

    def warnings(self, source: str):
        return stale_source_warnings(
            self.repository,
            {"SEC:CN:A:600519": f"{source}:v1"},
            now=NOW,
        )

    def test_stale_source_is_marked_in_scope_warnings(self):
        record_import(
            self.repository,
            source_id="akshare_security",
            at=NOW - timedelta(days=10),
        )
        warnings = self.warnings("akshare_security")
        self.assertEqual(len(warnings), 1)
        self.assertIn("未刷新", warnings[0])
        self.assertIn("akshare_security", warnings[0])

    def test_failed_refresh_is_reported_with_previous_data_note(self):
        record_import(self.repository, source_id="universe_json", at=NOW - timedelta(days=1))
        record_import(
            self.repository,
            source_id="universe_json",
            status="failed",
            imported=0,
            at=NOW - timedelta(minutes=5),
            error="URLError",
        )
        # 最新尝试失败但上一次成功仍在有效期内：不标记过期。
        self.assertEqual(self.warnings("universe_json"), [])

        old = InMemoryEntityRepository()
        record_import(old, source_id="universe_json", at=NOW - timedelta(days=60))
        record_import(
            old,
            source_id="universe_json",
            status="failed",
            imported=0,
            at=NOW - timedelta(minutes=5),
            error="URLError",
        )
        warnings = stale_source_warnings(
            old, {"SEC:CN:A:600519": "universe_json:v1"}, now=NOW
        )
        self.assertEqual(len(warnings), 1)
        self.assertIn("刷新失败", warnings[0])
        self.assertIn("上一次成功导入", warnings[0])

    def test_unknown_source_does_not_raise(self):
        self.assertEqual(self.warnings("never_seen_source"), [])


class SourceImportRecordingTest(unittest.TestCase):
    def test_successful_import_is_recorded(self):
        service = build_service()
        records = service.repository.list_source_imports()
        self.assertTrue(any(item.source_id == "gazetteer_json" for item in records))
        self.assertTrue(all(item.status == "success" for item in records))

    def test_failed_import_is_recorded_by_import_sources(self):
        service = build_service()
        results = service.import_sources([FakeSource(fail=True)])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].imported, 0)
        records = service.repository.list_source_imports()
        failed = [item for item in records if item.status == "failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0].source_id, "fake_source")
        self.assertIn("模拟网络失败", failed[0].error or "")

    def test_partial_warnings_are_recorded(self):
        service = build_service()

        class WarningSource(FakeSource):
            def fetch_entities(self):
                batch = super().fetch_entities()
                return batch.model_copy(update={"warnings": ["债券接口不可用"]})

        service.import_sources([WarningSource()])
        record = next(
            item
            for item in service.repository.list_source_imports()
            if item.source_id == "fake_source"
        )
        self.assertEqual(record.warnings, ["债券接口不可用"])


class MasterDataRefresherTest(unittest.TestCase):
    def build(self, *sources, max_age_hours=None, lock_path=None):
        service = build_service()
        self.repository = service.repository
        seen: list[bool | None] = []

        def builder(*, include_akshare):
            seen.append(include_akshare)
            return list(sources)

        refresher = MasterDataRefresher(
            service,
            source_builder=builder,
            lock_path=lock_path,
            max_age_hours=max_age_hours,
            now=lambda: NOW,
        )
        return service, refresher, seen

    def test_refresh_imports_and_then_skips_when_fresh(self):
        source = FakeSource()
        _, refresher, _ = self.build(source)
        first = refresher.refresh()
        self.assertTrue(first["ran"])
        self.assertEqual(first["results"][0]["imported"], 1)
        self.assertEqual(source.calls, 1)

        second = refresher.refresh()
        self.assertFalse(second["ran"])
        self.assertIn("有效期内", second["reason"])
        self.assertEqual(source.calls, 1)

    def test_force_runs_even_when_fresh(self):
        source = FakeSource()
        _, refresher, _ = self.build(source)
        refresher.refresh()
        forced = refresher.refresh(force=True)
        self.assertTrue(forced["ran"])
        self.assertEqual(source.calls, 2)

    def test_failed_import_is_reported_not_silently_retried_forever(self):
        _, refresher, _ = self.build(FakeSource(fail=True))
        result = refresher.refresh()
        self.assertTrue(result["ran"])
        self.assertEqual(result["results"][0]["imported"], 0)
        self.assertTrue(result["results"][0]["warnings"])
        # 失败记录会进入新鲜度，状态必须是 failed 而不是 fresh。
        state = {
            item["source_id"]: item
            for item in source_freshness(self.repository, now=NOW)
        }["fake_source"]
        self.assertEqual(state["state"], "failed")

    def test_akshare_is_only_used_when_history_exists(self):
        source = FakeSource()
        _, refresher, seen = self.build(source)
        refresher.refresh(force=True)
        self.assertFalse(seen[-1])

        record_import(self.repository, source_id="akshare_security", at=NOW - timedelta(days=1))
        refresher.refresh(force=True)
        self.assertTrue(seen[-1])

    def test_with_akshare_can_be_forced_off(self):
        source = FakeSource()
        _, refresher, seen = self.build(source)
        record_import(self.repository, source_id="akshare_security", at=NOW - timedelta(days=1))
        refresher.refresh(force=True, with_akshare=False)
        self.assertFalse(seen[-1])

    def test_env_off_prevents_scheduled_network_access(self):
        source = FakeSource()
        _, refresher, seen = self.build(source)
        record_import(self.repository, source_id="akshare_security", at=NOW - timedelta(days=1))
        with mock.patch.dict(
            "os.environ", {"RESEARCH_ENTITIES_AKSHARE_SOURCE": "false"}
        ):
            refresher.refresh(force=True)
        self.assertFalse(seen[-1])

    def test_lock_prevents_concurrent_refresh(self):
        with tempfile.TemporaryDirectory() as temp:
            lock = Path(temp) / "refresh.lock"
            source = FakeSource()
            _, refresher, _ = self.build(source, lock_path=lock)
            with refresh_lock(lock):
                result = refresher.refresh()
            self.assertFalse(result["ran"])
            self.assertIn("占用", result["reason"])
            self.assertEqual(source.calls, 0)

    def test_scheduler_run_once_swallows_errors(self):
        class BrokenRefresher:
            def refresh(self):
                raise RuntimeError("boom")

        scheduler = RefreshScheduler(BrokenRefresher(), interval_seconds=60)
        result = scheduler.run_once()
        self.assertFalse(result["ran"])
        self.assertIn("boom", result["reason"])


if __name__ == "__main__":
    unittest.main()
