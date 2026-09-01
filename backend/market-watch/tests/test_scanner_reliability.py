# -*- coding: utf-8 -*-
"""市场扫描的来源能力、最近成功缓存与 HTTP 错误分类。"""

import logging
import os
import unittest
import warnings
from unittest.mock import patch


os.environ["MW_SCHEDULE_ENABLED"] = "false"

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient
    from market_watch import quotes, scanner
    from market_watch.app import app

client = TestClient(app)
logging.getLogger("httpx").setLevel(logging.WARNING)


def _row(
    code: str,
    *,
    pct_change: float = 1.0,
    volume_ratio: float | None = 2.0,
    turnover: float | None = 3.0,
    amount_yi: float | None = 4.0,
) -> dict:
    return {
        "code": code,
        "name": f"测试{code}",
        "price": 10.0,
        "pct_change": pct_change,
        "volume_ratio": volume_ratio,
        "turnover": turnover,
        "amount_yi": amount_yi,
        "volume": 1000.0,
    }


class ProviderRows(list):
    """兼容旧 list 返回形状，同时表达新来源事实。"""

    def __init__(
        self,
        rows: list[dict],
        *,
        source: str = "eastmoney",
        complete: bool = True,
        warnings: tuple[str, ...] = (),
    ) -> None:
        super().__init__(rows)
        self.rows = rows
        self.source = source
        self.complete = complete
        self.warnings = warnings


class FakeClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class ScannerReliabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        cache = getattr(scanner, "_SCAN_CACHE", None)
        if cache is not None:
            cache.clear()

    def tearDown(self) -> None:
        cache = getattr(scanner, "_SCAN_CACHE", None)
        if cache is not None:
            cache.clear()

    def test_invalid_kind_remains_a_422_input_error(self):
        response = client.post("/scan", json={"kind": "unknown", "top_n": 10})

        self.assertEqual(response.status_code, 422)

    def test_capability_table_does_not_claim_a_sina_volume_ratio_fallback(self):
        self.assertEqual(
            getattr(scanner, "SCAN_CAPABILITIES", {}).get("volume_ratio"),
            ("eastmoney",),
        )

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.quotes._sina_market")
    @patch("market_watch.quotes._clist_top", side_effect=ConnectionError("eastmoney down"))
    def test_supported_scan_uses_sina_with_source_warning_and_null_missing_field(
        self, _eastmoney, sina, _trade_date,
    ):
        sina.return_value = [_row("600001", volume_ratio=None)]

        response = client.post("/scan", json={"kind": "gainers", "top_n": 10})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("source"), "sina")
        self.assertFalse(payload.get("stale"))
        self.assertTrue(payload.get("complete"))
        self.assertTrue(any("备用源" in warning for warning in payload.get("warnings", [])))
        self.assertIsNone(payload["items"][0]["volume_ratio"])

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.quotes._sina_market")
    @patch("market_watch.quotes._clist_top", side_effect=TimeoutError("eastmoney timeout"))
    def test_limit_sina_fallback_samples_both_directions_before_filtering(
        self, _eastmoney, sina, _trade_date,
    ):
        def rankings(sort: str, _top_n: int, asc: int = 0) -> list[dict]:
            self.assertEqual(sort, "changepercent")
            if asc == 0:
                return [_row("600010", pct_change=10.0), _row("600011", pct_change=3.0)]
            return [_row("600012", pct_change=-10.0), _row("600013", pct_change=-2.0)]

        sina.side_effect = rankings

        response = client.post("/scan", json={"kind": "limit", "top_n": 5})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source"], "sina")
        self.assertFalse(payload["complete"])
        self.assertEqual([row["code"] for row in payload["limit_up"]], ["600010"])
        self.assertEqual([row["code"] for row in payload["limit_down"]], ["600012"])
        self.assertEqual(
            sorted(call.kwargs.get("asc", call.args[2] if len(call.args) > 2 else 0) for call in sina.call_args_list),
            [0, 1],
        )

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.quotes._sina_market")
    @patch("market_watch.quotes._clist_top", side_effect=ConnectionError("eastmoney down"))
    def test_volume_ratio_does_not_fabricate_a_sina_result(
        self, _eastmoney, sina, _trade_date,
    ):
        response = client.post("/scan", json={"kind": "volume_ratio", "top_n": 10})

        self.assertEqual(response.status_code, 503)
        sina.assert_not_called()

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.scanner.quotes._scan_rows")
    def test_same_key_failure_returns_stale_success_with_original_as_of(
        self, scan_rows, _trade_date,
    ):
        clock = FakeClock()
        scan_rows.side_effect = [
            ProviderRows([_row("600001")]),
            ConnectionError("all sources down"),
        ]
        with (
            patch.object(scanner, "_SCAN_CLOCK", clock, create=True),
            patch.object(
                scanner,
                "_now_str",
                side_effect=["2026-08-31T10:00:00+08:00", "2026-08-31T10:01:00+08:00"],
            ),
            patch.object(scanner.settings, "scan_cache_ttl", 15, create=True),
            patch.object(scanner.settings, "scan_stale_ttl", 300, create=True),
        ):
            first_response = client.post(
                "/scan", json={"kind": "gainers", "top_n": 10},
            )
            clock.advance(16)
            second_response = client.post(
                "/scan", json={"kind": "gainers", "top_n": 10},
            )

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        first = first_response.json()
        second = second_response.json()
        self.assertEqual(first["as_of"], "2026-08-31T10:00:00+08:00")
        self.assertEqual(second["as_of"], first["as_of"])
        self.assertTrue(second["stale"])
        self.assertTrue(any("缓存" in warning for warning in second["warnings"]))

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.quotes._sina_market", side_effect=TimeoutError("sina timeout"))
    @patch("market_watch.quotes._clist_top", side_effect=ConnectionError("eastmoney down"))
    def test_all_sources_failed_without_cache_maps_to_503(
        self, _eastmoney, _sina, _trade_date,
    ):
        response = client.post("/scan", json={"kind": "gainers", "top_n": 10})

        self.assertEqual(response.status_code, 503)

    @patch("market_watch.quotes._sina_market", side_effect=TimeoutError("sina timeout"))
    @patch("market_watch.quotes._clist_top", side_effect=ConnectionError("eastmoney down"))
    def test_all_source_failure_preserves_the_last_provider_error_type(
        self, _eastmoney, _sina,
    ):
        with self.assertRaises(TimeoutError):
            quotes._scan_rows("gainers", 10)

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.scanner.quotes._scan_rows")
    def test_fresh_cache_key_includes_kind_top_n_and_min_amount(
        self, scan_rows, _trade_date,
    ):
        clock = FakeClock()
        scan_rows.return_value = ProviderRows([_row("600001")])
        with (
            patch.object(scanner, "_SCAN_CLOCK", clock, create=True),
            patch.object(scanner.settings, "scan_cache_ttl", 15, create=True),
            patch.object(scanner.settings, "scan_stale_ttl", 300, create=True),
            patch.object(scanner.settings, "scan_cache_size", 64, create=True),
        ):
            scanner.scan("gainers", 10, None)
            scanner.scan("gainers", 10, None)
            scanner.scan("gainers", 5, None)
            scanner.scan("gainers", 10, 1.0)
            scanner.scan("amount", 10, None)

        self.assertEqual(scan_rows.call_count, 4)

    @patch("market_watch.scanner.quotes.latest_trade_date", return_value="2026-08-31")
    @patch("market_watch.scanner.quotes._scan_rows")
    def test_cache_capacity_is_configurable_and_uses_lru_eviction(
        self, scan_rows, _trade_date,
    ):
        clock = FakeClock()
        scan_rows.return_value = ProviderRows([_row("600001")])
        with (
            patch.object(scanner, "_SCAN_CLOCK", clock, create=True),
            patch.object(scanner.settings, "scan_cache_ttl", 15, create=True),
            patch.object(scanner.settings, "scan_stale_ttl", 300, create=True),
            patch.object(scanner.settings, "scan_cache_size", 2, create=True),
        ):
            scanner.scan("gainers", 10, None)  # A
            scanner.scan("gainers", 5, None)   # B
            scanner.scan("gainers", 10, None)  # A 最近使用
            scanner.scan("gainers", 3, None)   # C 淘汰 B
            scanner.scan("gainers", 5, None)   # B 需重取

        self.assertEqual(scan_rows.call_count, 4)


if __name__ == "__main__":
    unittest.main()
