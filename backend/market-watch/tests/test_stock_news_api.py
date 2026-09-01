# -*- coding: utf-8 -*-
"""与证券绑定的结构化资讯 API 合同。"""

import logging
import os
import threading
import unittest
import warnings
from unittest.mock import patch

import pandas as pd


os.environ["MW_SCHEDULE_ENABLED"] = "false"

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient
    from market_watch import news
    from market_watch.app import app

client = TestClient(app)
logging.getLogger("httpx").setLevel(logging.WARNING)


class FakeClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _news_frame(title: str = "贵州茅台发布经营数据") -> pd.DataFrame:
    return pd.DataFrame([{
        "新闻标题": title,
        "发布时间": "2026-08-31 10:00:00",
    }])


def _news_item(title: str) -> dict:
    return {"title": title, "source": "东财", "time": "2026-08-31 10:00:00"}


class StockNewsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        cache = getattr(news, "_STOCK_NEWS_CACHE", None)
        if cache is not None:
            cache.clear()
        flights = getattr(news, "_STOCK_NEWS_FLIGHTS", None)
        if flights is not None:
            flights.clear()

    def tearDown(self) -> None:
        cache = getattr(news, "_STOCK_NEWS_CACHE", None)
        if cache is not None:
            cache.clear()
        flights = getattr(news, "_STOCK_NEWS_FLIGHTS", None)
        if flights is not None:
            flights.clear()

    def _run_same_key_concurrently(self, outcomes):
        """让 follower 读完初始缓存后才释放 leader，稳定复现旧缓存竞态。"""
        leader_entered = threading.Event()
        follower_cache_read = threading.Event()
        calls_lock = threading.Lock()
        calls = []
        results = {}
        errors = {}
        original_cached = news._stock_news_cached

        def observed_cached(key, now):
            result = original_cached(key, now)
            if threading.current_thread().name == "stock-news-follower":
                follower_cache_read.set()
            return result

        def source(code, limit):
            with calls_lock:
                index = len(calls)
                calls.append((code, limit))
            if index == 0:
                leader_entered.set()
                if not follower_cache_read.wait(2):
                    raise AssertionError("follower 未完成初次缓存读取")
            outcome = outcomes[min(index, len(outcomes) - 1)]
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        def invoke(label):
            try:
                results[label] = news.stock_news_snapshot("600519", limit=8)
            except BaseException as exc:
                errors[label] = exc

        with (
            patch.object(news, "_stock_news_cached", side_effect=observed_cached),
            patch.object(news, "_fetch_stock_news_source", side_effect=source),
        ):
            leader = threading.Thread(target=invoke, args=("leader",), name="stock-news-leader")
            follower = threading.Thread(target=invoke, args=("follower",), name="stock-news-follower")
            leader.start()
            self.assertTrue(leader_entered.wait(2))
            follower.start()
            leader.join(2)
            follower.join(2)

        self.assertFalse(leader.is_alive())
        self.assertFalse(follower.is_alive())
        self.assertEqual(errors, {})
        self.assertFalse(news._STOCK_NEWS_FLIGHTS)
        return results, calls

    @patch("akshare.stock_news_em")
    def test_route_normalizes_code_and_returns_ready_snapshot(self, stock_news_em):
        stock_news_em.return_value = _news_frame()

        response = client.get("/news/stock", params={"code": " 600519 ", "limit": 8})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["code"], "600519")
        self.assertEqual(payload["items"], [{
            "title": "贵州茅台发布经营数据",
            "source": "东财",
            "time": "2026-08-31 10:00:00",
        }])
        self.assertTrue(payload["complete"])
        self.assertIsNone(payload["message"])
        self.assertIsInstance(payload["as_of"], str)
        self.assertTrue(payload["as_of"])
        stock_news_em.assert_called_once_with(symbol="600519")

    @patch("market_watch.news.fetch_global_news", side_effect=AssertionError("不得回退市场快讯"))
    @patch("akshare.stock_news_em")
    def test_successful_empty_source_is_ready_and_never_filled_with_market_flash(
        self, stock_news_em, _fetch_global_news,
    ):
        stock_news_em.return_value = pd.DataFrame(columns=["新闻标题", "发布时间"])

        response = client.get("/news/stock", params={"code": "600519", "limit": 8})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["items"], [])
        self.assertTrue(response.json()["complete"])
        self.assertIsNone(response.json()["message"])
        self.assertFalse(news._STOCK_NEWS_FLIGHTS)

    @patch("akshare.stock_news_em")
    def test_source_failure_returns_stale_cache_with_original_as_of(self, stock_news_em):
        clock = FakeClock()
        stock_news_em.side_effect = [_news_frame(), ConnectionError("eastmoney down")]
        with (
            patch.object(news, "_STOCK_NEWS_CLOCK", clock, create=True),
            patch.object(news.settings, "stock_news_cache_ttl", 60, create=True),
            patch.object(news.settings, "stock_news_stale_ttl", 300, create=True),
        ):
            first = client.get("/news/stock", params={"code": "600519", "limit": 8})
            original_as_of = first.json()["as_of"]
            clock.advance(61)
            stale = client.get("/news/stock", params={"code": "600519", "limit": 8})

        self.assertEqual(stale.status_code, 200)
        self.assertEqual(stale.json()["status"], "stale")
        self.assertEqual(stale.json()["as_of"], original_as_of)
        self.assertEqual(stale.json()["items"], first.json()["items"])
        self.assertFalse(stale.json()["complete"])
        self.assertTrue(stale.json()["message"])

    @patch("akshare.stock_news_em", side_effect=ConnectionError("eastmoney down"))
    def test_source_failure_without_cache_returns_unavailable(self, _stock_news_em):
        response = client.get("/news/stock", params={"code": "600519", "limit": 8})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["code"], "600519")
        self.assertEqual(payload["items"], [])
        self.assertFalse(payload["complete"])
        self.assertTrue(payload["message"])

    @patch("market_watch.news._fetch_stock_news_source")
    def test_unavailable_is_not_cached_and_the_next_call_retries(self, source):
        source.side_effect = [ConnectionError("eastmoney down"), [_news_item("重试成功")]]

        unavailable = news.stock_news_snapshot("600519", limit=8)
        retried = news.stock_news_snapshot("600519", limit=8)

        self.assertEqual(unavailable.status, "unavailable")
        self.assertEqual(retried.status, "ready")
        self.assertEqual(retried.items[0]["title"], "重试成功")
        self.assertEqual(source.call_count, 2)

    @patch("market_watch.news._fetch_stock_news_source")
    def test_legacy_unavailable_returns_empty_without_blocking_a_retry(self, source):
        source.side_effect = [ConnectionError("eastmoney down"), [_news_item("兼容重试成功")]]

        unavailable = news.fetch_stock_news("600519", top=8)
        retried = news.fetch_stock_news("600519", top=8)

        self.assertEqual(unavailable, [])
        self.assertEqual(retried[0]["title"], "兼容重试成功")
        self.assertEqual(source.call_count, 2)

    @patch("akshare.stock_news_em", side_effect=AssertionError("非法输入不应进入资讯源"))
    def test_invalid_code_and_out_of_range_limits_return_422(self, _stock_news_em):
        requests = (
            {"code": "abcdef", "limit": 8},
            {"code": "600519", "limit": 4},
            {"code": "600519", "limit": 21},
        )

        for params in requests:
            with self.subTest(params=params):
                response = client.get("/news/stock", params=params)
                self.assertEqual(response.status_code, 422)

    @patch("akshare.stock_news_em")
    def test_fresh_cache_isolated_by_code_and_limit(self, stock_news_em):
        stock_news_em.side_effect = [
            _news_frame("600519 八条键"),
            _news_frame("600519 九条键"),
            _news_frame("000858 八条键"),
        ]

        first = client.get("/news/stock", params={"code": "600519", "limit": 8})
        second = client.get("/news/stock", params={"code": "600519", "limit": 9})
        third = client.get("/news/stock", params={"code": "000858", "limit": 8})
        cached_first = client.get("/news/stock", params={"code": "600519", "limit": 8})

        self.assertEqual(first.json()["items"][0]["title"], "600519 八条键")
        self.assertEqual(second.json()["items"][0]["title"], "600519 九条键")
        self.assertEqual(third.json()["items"][0]["title"], "000858 八条键")
        self.assertEqual(cached_first.json(), first.json())
        self.assertEqual(stock_news_em.call_count, 3)

    @patch("akshare.stock_news_em", return_value=_news_frame())
    def test_cache_capacity_promotes_a_hit_and_evicts_the_least_recently_used_key(
        self, stock_news_em,
    ):
        with patch.object(news.settings, "stock_news_cache_size", 2, create=True):
            for limit in (5, 6):
                response = client.get("/news/stock", params={"code": "600519", "limit": limit})
                self.assertEqual(response.status_code, 200)
            client.get("/news/stock", params={"code": "600519", "limit": 5})  # A 晋升
            client.get("/news/stock", params={"code": "600519", "limit": 7})  # 淘汰 B
            client.get("/news/stock", params={"code": "600519", "limit": 5})  # A 仍命中
            client.get("/news/stock", params={"code": "600519", "limit": 6})  # B 重新抓取

        self.assertEqual(stock_news_em.call_count, 4)

    def test_concurrent_cold_requests_share_one_source_result(self):
        results, calls = self._run_same_key_concurrently([
            [_news_item("单次冷抓取")],
            [_news_item("不应发生的第二次抓取")],
        ])

        self.assertEqual(calls, [("600519", 8)])
        self.assertEqual(results["leader"], results["follower"])
        self.assertEqual(results["leader"].items[0]["title"], "单次冷抓取")

    def test_concurrent_stale_refresh_success_publishes_one_new_ready_snapshot(self):
        old = news.StockNewsSnapshot(
            status="ready", code="600519", as_of="2026-08-31T09:00:00+08:00",
            items=(_news_item("旧缓存"),), complete=True,
        )
        news._STOCK_NEWS_CACHE[("600519", 8)] = (0, old)
        clock = FakeClock(61)
        with (
            patch.object(news, "_STOCK_NEWS_CLOCK", clock),
            patch.object(news.settings, "stock_news_cache_ttl", 60),
            patch.object(news.settings, "stock_news_stale_ttl", 300),
        ):
            results, calls = self._run_same_key_concurrently([
                [_news_item("刷新成功")],
                ConnectionError("不应发生的第二次刷新"),
            ])

        self.assertEqual(calls, [("600519", 8)])
        self.assertEqual(results["leader"], results["follower"])
        self.assertEqual(results["leader"].status, "ready")
        self.assertEqual(results["leader"].items[0]["title"], "刷新成功")

    def test_concurrent_stale_refresh_failure_publishes_one_identical_fallback(self):
        old = news.StockNewsSnapshot(
            status="ready", code="600519", as_of="2026-08-31T09:00:00+08:00",
            items=(_news_item("旧缓存"),), complete=True,
        )
        news._STOCK_NEWS_CACHE[("600519", 8)] = (0, old)
        clock = FakeClock(61)
        with (
            patch.object(news, "_STOCK_NEWS_CLOCK", clock),
            patch.object(news.settings, "stock_news_cache_ttl", 60),
            patch.object(news.settings, "stock_news_stale_ttl", 300),
        ):
            results, calls = self._run_same_key_concurrently([
                ConnectionError("刷新失败"),
                ConnectionError("不应发生的第二次刷新"),
            ])

        self.assertEqual(calls, [("600519", 8)])
        self.assertEqual(results["leader"], results["follower"])
        self.assertEqual(results["leader"].status, "stale")
        self.assertEqual(results["leader"].items[0]["title"], "旧缓存")

    @patch("market_watch.news._fetch_stock_news_source")
    def test_failed_flight_is_cleaned_and_a_later_request_can_retry(self, source):
        source.side_effect = [ConnectionError("first failed"), [_news_item("second ready")]]

        first = news.stock_news_snapshot("600519", limit=8)

        self.assertEqual(first.status, "unavailable")
        self.assertFalse(news._STOCK_NEWS_FLIGHTS)

        second = news.stock_news_snapshot("600519", limit=8)

        self.assertEqual(second.status, "ready")
        self.assertEqual(second.items[0]["title"], "second ready")
        self.assertFalse(news._STOCK_NEWS_FLIGHTS)

    @patch("market_watch.news._fetch_stock_news_source")
    def test_base_exception_also_cleans_the_flight_before_a_retry(self, source):
        class FatalRefresh(BaseException):
            pass

        source.side_effect = [FatalRefresh("fatal"), [_news_item("recovered")]]

        with self.assertRaises(FatalRefresh):
            news.stock_news_snapshot("600519", limit=8)
        self.assertFalse(news._STOCK_NEWS_FLIGHTS)

        recovered = news.stock_news_snapshot("600519", limit=8)

        self.assertEqual(recovered.status, "ready")
        self.assertEqual(recovered.items[0]["title"], "recovered")
        self.assertFalse(news._STOCK_NEWS_FLIGHTS)

    @patch("market_watch.news._fetch_stock_news_source")
    def test_different_keys_refresh_in_parallel(self, source):
        both_sources = threading.Barrier(2)

        def concurrent_source(code, _limit):
            both_sources.wait(2)
            return [_news_item(code)]

        source.side_effect = concurrent_source
        results = {}

        def invoke(code):
            results[code] = news.stock_news_snapshot(code, limit=8)

        first = threading.Thread(target=invoke, args=("600519",))
        second = threading.Thread(target=invoke, args=("000858",))
        first.start()
        second.start()
        first.join(2)
        second.join(2)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(set(results), {"600519", "000858"})
        self.assertEqual(source.call_count, 2)

    @patch("akshare.stock_news_em")
    def test_reading_stale_cache_does_not_extend_its_stale_lifetime(self, stock_news_em):
        clock = FakeClock()
        stock_news_em.side_effect = [
            _news_frame(),
            ConnectionError("first refresh failed"),
            ConnectionError("second refresh failed"),
        ]
        with (
            patch.object(news, "_STOCK_NEWS_CLOCK", clock, create=True),
            patch.object(news.settings, "stock_news_cache_ttl", 60, create=True),
            patch.object(news.settings, "stock_news_stale_ttl", 300, create=True),
        ):
            ready = client.get("/news/stock", params={"code": "600519", "limit": 8})
            clock.advance(61)
            stale = client.get("/news/stock", params={"code": "600519", "limit": 8})
            clock.advance(240)
            unavailable = client.get("/news/stock", params={"code": "600519", "limit": 8})

        self.assertEqual(stale.json()["status"], "stale")
        self.assertEqual(stale.json()["as_of"], ready.json()["as_of"])
        self.assertEqual(unavailable.json()["status"], "unavailable")
        self.assertEqual(unavailable.json()["items"], [])

    @patch("akshare.stock_news_em", return_value=_news_frame())
    def test_legacy_fetch_stock_news_keeps_returning_a_list(self, _stock_news_em):
        result = news.fetch_stock_news("600519", top=8)

        self.assertIsInstance(result, list)
        self.assertEqual(result[0]["source"], "东财")


if __name__ == "__main__":
    unittest.main()
