# -*- coding: utf-8 -*-
"""时间事件测试：cron、时区、到期实例、漏执行补偿与三条提醒路径（V1.3 §5.6.1）。

运行：
    env/Scripts/python.exe -m unittest tests.test_research_partner_schedule -v
"""

from __future__ import annotations

import secrets
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from research_partner.api import create_app
from research_partner.commands import (
    MandateCreateRequest,
    MandateReviseRequest,
    MandateStatusRequest,
)
from research_partner.context import RequestContext
from research_partner.errors import InvalidRequest
from research_partner.factory import build_service
from research_partner.models import ResearchJobResult
from research_partner.pipeline import PartnerPipeline
from research_partner.schedules import ScheduleError, ScheduleSpec

FIXED = datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)  # 上海 周三 14:00


def key() -> str:
    return "idem_" + secrets.token_hex(8)


class ScheduleSpecTests(unittest.TestCase):
    def test_daily_next_due_in_timezone(self) -> None:
        spec = ScheduleSpec.parse({"cron": "0 9 * * *", "timezone": "Asia/Shanghai"})
        # 上海 14:00 之后的下一次 09:00 是次日 01:00 UTC。
        self.assertEqual(spec.next_after(FIXED), datetime(2026, 10, 22, 1, 0, tzinfo=timezone.utc))

    def test_utc_timezone_is_not_assumed(self) -> None:
        spec = ScheduleSpec.parse({"cron": "0 9 * * *", "timezone": "UTC"})
        self.assertEqual(spec.next_after(FIXED), datetime(2026, 10, 21, 9, 0, tzinfo=timezone.utc))

    def test_weekday_field(self) -> None:
        spec = ScheduleSpec.parse({"cron": "0 9 * * 5", "timezone": "Asia/Shanghai"})
        nxt = spec.next_after(FIXED)
        self.assertEqual(nxt, datetime(2026, 10, 23, 1, 0, tzinfo=timezone.utc))
        self.assertEqual(nxt.astimezone(ZoneInfo("Asia/Shanghai")).weekday(), 4)

    def test_step_list_and_range(self) -> None:
        spec = ScheduleSpec.parse({"cron": "0,30 9-17/4 * * *", "timezone": "UTC"})
        self.assertEqual(spec.minute, frozenset({0, 30}))
        self.assertEqual(spec.hour, frozenset({9, 13, 17}))

    def test_day_of_month_and_weekday_are_or(self) -> None:
        spec = ScheduleSpec.parse({"cron": "0 9 1 * 1", "timezone": "UTC"})
        first = datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc)  # 周日，1 号
        monday = datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
        neither = datetime(2026, 11, 3, 9, 0, tzinfo=timezone.utc)
        self.assertTrue(spec.matches(first))
        self.assertTrue(spec.matches(monday))
        self.assertFalse(spec.matches(neither))

    def test_invalid_cron_rejected(self) -> None:
        for cron in ["", "0 9 * *", "0 25 * * *", "*/0 9 * * *", "5-1 9 * * *"]:
            with self.subTest(cron=cron), self.assertRaises(ScheduleError):
                ScheduleSpec.parse({"cron": cron})

    def test_unknown_timezone_rejected(self) -> None:
        with self.assertRaises(ScheduleError):
            ScheduleSpec.parse({"cron": "0 9 * * *", "timezone": "Mars/Olympus"})

    def test_catchup_bounds(self) -> None:
        with self.assertRaises(ScheduleError):
            ScheduleSpec.parse({"cron": "0 9 * * *", "catchup_seconds": -1})
        with self.assertRaises(ScheduleError):
            ScheduleSpec.parse({"cron": "0 9 * * *", "catchup_seconds": 31 * 24 * 3600})


class CountingRunner:
    """记录是否真的跑了研究；到期提醒不得调用它。"""

    def __init__(self, now, *, metadata=None, contact_suggestion=None) -> None:
        self.now = now
        self.calls = []
        self.contact_suggestion = contact_suggestion or {}
        self.metadata = metadata or {}

    def run(self, job) -> ResearchJobResult:
        self.calls.append(job)
        return ResearchJobResult(
            result_id="RES_" + secrets.token_hex(16),
            job_id=job.job_id,
            run_id="run-" + secrets.token_hex(4),
            outcome="completed",
            structured_result=dict(self.metadata),
            evidence_batch_id="EVB_" + secrets.token_hex(4),
            contact_suggestion=dict(self.contact_suggestion),
            received_at=self.now(),
        )


class RecordingDispatcher:
    def __init__(self) -> None:
        self.decisions = []

    def dispatch(self, decision):
        from research_partner.models import ContactRecord

        self.decisions.append(decision)
        return ContactRecord(
            decision_id=decision.decision_id,
            channel="app",
            status="queued",
        )


class ScheduleTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "schedule.db"
        self.now = FIXED
        self.store, self.service = build_service(self.path, now=lambda: self.now)
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset(
                {"mandate:read", "mandate:write", "notification:read", "notification:write"}
            ),
        )
        self.dispatcher = RecordingDispatcher()
        self.runner = CountingRunner(lambda: self.now)
        self.pipeline = PartnerPipeline(
            self.store,
            runner=self.runner,
            dispatcher=self.dispatcher,
            now=lambda: self.now,
        )

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def advance(self, **kwargs) -> None:
        self.now = self.now + timedelta(**kwargs)

    def create_mandate(self, contact_policy: dict, **overrides) -> str:
        data = {
            "goal": "跟踪应收账款周转",
            "subjects": [{"entity_id": "company:600519"}],
            "triggers": [{"hook_type": "company.event_available"}],
            "contact_policy": contact_policy,
            "idempotency_key": key(),
        }
        data.update(overrides)
        response = self.service.create(self.ctx, MandateCreateRequest(**data))
        self.mandate_id = response["mandate"]["mandate_id"]
        return self.mandate_id

    def baseline(self) -> None:
        """跑完基线复核后清空记录，后续断言只看时间事件产生的联系。"""

        self.pipeline.tick()
        self.runner.calls.clear()
        self.dispatcher.decisions.clear()
        with self.store.transaction():
            connection = self.store._connect()
            connection.execute("DELETE FROM contact_records")
            connection.execute("DELETE FROM contact_decisions")

    def decisions(self):
        return self.store.list_contact_decisions(self.mandate_id)


class ReminderPathTests(ScheduleTestCase):
    def test_due_reminder_skips_research_and_sends(self) -> None:
        self.create_mandate(
            {"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}
        )
        self.baseline()
        self.advance(hours=19)  # 上海 09:00
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)
        self.assertEqual(self.runner.calls, [])
        decisions = self.decisions()
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].decision, "send")
        self.assertEqual(decisions[0].reason_code, "due_reminder")
        self.assertEqual(len(self.dispatcher.decisions), 1)

    def test_scheduled_delivery_runs_research_even_without_change(self) -> None:
        self.runner.contact_suggestion = {
            "judgements": {"x": {"judgement": "unmet"}}
        }
        self.create_mandate(
            {
                "mode": "scheduled_delivery",
                "schedule": {"cron": "0 9 * * 5"},  # 周五 09:00
            }
        )
        self.baseline()
        self.advance(days=2)
        result = self.pipeline.tick()
        self.assertEqual(result["schedules_due"], 1)
        self.assertEqual(len(self.runner.calls), 1)
        self.assertEqual(self.runner.calls[0].action, "scheduled_delivery")
        decision = self.decisions()[0]
        self.assertEqual(decision.decision, "send")
        self.assertEqual(decision.reason_code, "scheduled_delivery")

    def test_periodic_check_stays_silent_without_material_change(self) -> None:
        self.runner.contact_suggestion = {
            "judgements": {"x": {"judgement": "unmet"}}
        }
        self.create_mandate(
            {
                "mode": "periodic_check",
                "condition": {"type": "semantic", "claim": "x"},
                "schedule": {"cron": "0 9 * * *"},
            }
        )
        self.baseline()
        self.advance(hours=19)
        self.pipeline.tick()
        self.assertEqual(len(self.runner.calls), 1)
        decision = self.decisions()[0]
        self.assertEqual(decision.decision, "suppress")
        self.assertEqual(decision.reason_code, "no_material_change")
        self.assertEqual(self.dispatcher.decisions, [])


class InstanceTests(ScheduleTestCase):
    def test_same_instance_is_emitted_once(self) -> None:
        self.create_mandate(
            {"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}
        )
        self.baseline()
        self.advance(hours=19)
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)
        # 同一时刻重复扫描（例如 worker 重入）不得重复触发。
        self.assertEqual(self.pipeline.tick()["schedules_due"], 0)
        self.assertEqual(len(self.decisions()), 1)

        # 次日同一时间产生新的实例。
        self.advance(days=1)
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)
        self.assertEqual(len(self.decisions()), 2)

    def test_catchup_window_emits_missed_instance(self) -> None:
        self.create_mandate(
            {
                "mode": "due_reminder",
                "schedule": {"cron": "0 9 * * *", "catchup_seconds": 86400},
            }
        )
        self.baseline()
        self.advance(hours=19, minutes=30)  # 错过 30 分钟，仍在补偿窗口内
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)

    def test_beyond_catchup_is_skipped_not_sent_late(self) -> None:
        self.create_mandate(
            {
                "mode": "due_reminder",
                "schedule": {"cron": "0 9 * * *", "catchup_seconds": 60},
            }
        )
        self.baseline()
        self.advance(days=2)
        result = self.pipeline.tick()
        self.assertEqual(result["schedules_due"], 0)
        self.assertEqual(self.decisions(), [])
        schedule = self.store.list_schedules(self.mandate_id)[0]
        self.assertGreaterEqual(schedule.skipped_missed, 2)
        self.assertGreater(schedule.next_due_at, self.now)

    def test_paused_mandate_does_not_emit_until_resume(self) -> None:
        self.create_mandate(
            {
                "mode": "due_reminder",
                "schedule": {"cron": "0 9 * * *", "catchup_seconds": 60},
            }
        )
        self.baseline()
        self.service.pause(
            self.ctx,
            self.mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.advance(hours=19)
        self.assertEqual(self.pipeline.tick()["schedules_due"], 0)
        self.assertEqual(self.decisions(), [])

        # 刚到期就恢复：仍在补偿窗口内，按约补发一次。
        self.service.resume(
            self.ctx,
            self.mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)
        self.assertEqual(len(self.decisions()), 1)

        # 下一个实例照常提醒。
        self.advance(days=1)
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)
        self.assertEqual(len(self.decisions()), 2)

    def test_long_pause_does_not_replay_missed_reminders(self) -> None:
        self.create_mandate(
            {
                "mode": "due_reminder",
                "schedule": {"cron": "0 9 * * *", "catchup_seconds": 60},
            }
        )
        self.baseline()
        self.service.pause(
            self.ctx,
            self.mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.advance(days=2)
        self.service.resume(
            self.ctx,
            self.mandate_id,
            MandateStatusRequest(expected_revision=1, idempotency_key=key()),
        )
        self.assertEqual(self.pipeline.tick()["schedules_due"], 0)
        self.assertEqual(self.decisions(), [])
        schedule = self.store.list_schedules(self.mandate_id)[0]
        self.assertGreaterEqual(schedule.skipped_missed, 2)
        self.assertGreater(schedule.next_due_at, self.now)


class RevisionTests(ScheduleTestCase):
    def test_revision_replaces_schedule(self) -> None:
        mandate_id = self.create_mandate(
            {"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}
        )
        self.service.revise(
            self.ctx,
            mandate_id,
            MandateReviseRequest(
                expected_revision=1,
                goal="改为周五提醒",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available"}],
                contact_policy={
                    "mode": "due_reminder",
                    "schedule": {"cron": "0 9 * * 5"},
                },
                idempotency_key=key(),
            ),
        )
        active = self.store.list_schedules(mandate_id)
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0].revision, 2)
        self.assertEqual(active[0].cron, "0 9 * * 5")

    def test_schedule_trigger_is_compiled(self) -> None:
        mandate_id = self.create_mandate(
            {"mode": "due_reminder", "schedule": {"cron": "0 9 * * *"}}
        )
        view = self.service.get(self.ctx, mandate_id)
        hooks = {item["hook_type"] for item in view["dependencies"]}
        self.assertIn("schedule.due", hooks)

    def test_time_mode_requires_schedule(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create_mandate({"mode": "due_reminder"})
        with self.assertRaises(InvalidRequest):
            self.create_mandate({"mode": "scheduled_delivery"})
        with self.assertRaises(InvalidRequest):
            self.create_mandate({"mode": "periodic_check"})

    def test_bad_schedule_rejected_at_save(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create_mandate(
                {"mode": "due_reminder", "schedule": {"cron": "every friday"}}
            )


class HolidayCalendar:
    """测试用日历：指定日期休市，其余按工作日。"""

    def __init__(self, holidays) -> None:
        self.holidays = set(holidays)

    def is_trading_day(self, day) -> bool:
        return day not in self.holidays and day.weekday() < 5


class TradingDayTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "calendar.db"
        self.now = FIXED
        # 2026-10-22（周四）休市。
        self.calendar = HolidayCalendar({FIXED.date() + timedelta(days=1)})
        self.store, self.service = build_service(
            path, now=lambda: self.now, calendar=self.calendar
        )
        self.ctx = RequestContext(
            instance_id="instance-1",
            principal_id="user-1",
            capabilities=frozenset({"mandate:read", "mandate:write"}),
        )
        self.pipeline = PartnerPipeline(
            self.store,
            dispatcher=RecordingDispatcher(),
            calendar=self.calendar,
            now=lambda: self.now,
        )

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def create(self, schedule: dict) -> str:
        response = self.service.create(
            self.ctx,
            MandateCreateRequest(
                goal="交易日提醒",
                subjects=[{"entity_id": "company:600519"}],
                triggers=[{"hook_type": "company.event_available"}],
                contact_policy={"mode": "due_reminder", "schedule": schedule},
                idempotency_key=key(),
            ),
        )
        return response["mandate"]["mandate_id"]

    def test_holiday_is_not_scheduled(self) -> None:
        mandate_id = self.create(
            {"cron": "0 9 * * *", "trading_days_only": True}
        )
        schedule = self.store.list_schedules(mandate_id)[0]
        # 周四休市，直接排到周五 09:00（上海）= 周五 01:00 UTC。
        self.assertEqual(
            schedule.next_due_at, datetime(2026, 10, 23, 1, 0, tzinfo=timezone.utc)
        )

    def test_holiday_without_flag_still_reminds(self) -> None:
        mandate_id = self.create({"cron": "0 9 * * *"})
        schedule = self.store.list_schedules(mandate_id)[0]
        self.assertEqual(
            schedule.next_due_at, datetime(2026, 10, 22, 1, 0, tzinfo=timezone.utc)
        )

    def test_scan_skips_holiday_instance(self) -> None:
        self.create({"cron": "0 9 * * *", "trading_days_only": True})
        self.pipeline.tick()
        self.now = self.now + timedelta(hours=19)  # 周四 09:00 上海，休市
        self.assertEqual(self.pipeline.tick()["schedules_due"], 0)
        self.now = self.now + timedelta(days=1)  # 周五 09:00
        self.assertEqual(self.pipeline.tick()["schedules_due"], 1)

    def test_trading_days_only_must_be_boolean(self) -> None:
        with self.assertRaises(InvalidRequest):
            self.create({"cron": "0 9 * * *", "trading_days_only": "yes"})


class ScheduleApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "api-schedule.db"
        self._client_ctx = TestClient(create_app(store_path=path))
        self.client = self._client_ctx.__enter__()
        self.headers = {"X-Principal-Id": "user-1", "X-Instance-Id": "instance-1"}

    def tearDown(self) -> None:
        self._client_ctx.__exit__(None, None, None)
        self._tmp.cleanup()

    def test_schedule_listed_for_owner(self) -> None:
        created = self.client.post(
            "/research/mandates",
            json={
                "goal": "周报",
                "subjects": [{"entity_id": "company:600519"}],
                "triggers": [{"hook_type": "company.event_available"}],
                "contact_policy": {
                    "mode": "scheduled_delivery",
                    "schedule": {"cron": "0 9 * * 5"},
                },
                "idempotency_key": key(),
            },
            headers=self.headers,
        ).json()
        mandate_id = created["mandate"]["mandate_id"]
        response = self.client.get(
            f"/research/mandates/{mandate_id}/schedules", headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["cron"], "0 9 * * 5")

        other = {"X-Principal-Id": "user-2", "X-Instance-Id": "instance-1"}
        self.assertEqual(
            self.client.get(
                f"/research/mandates/{mandate_id}/schedules", headers=other
            ).status_code,
            404,
        )


if __name__ == "__main__":
    unittest.main()
