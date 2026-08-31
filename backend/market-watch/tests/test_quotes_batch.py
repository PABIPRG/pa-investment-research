import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException


os.environ["MW_SCHEDULE_ENABLED"] = "false"

from market_watch.app import quotes_batch
from market_watch.schemas import QuotesBatchRequest


class QuotesBatchTests(unittest.TestCase):
    @patch("market_watch.app.quotes.cache")
    def test_batch_returns_normalized_quote_rows(self, cache):
        cache.return_value.get_quotes.return_value = [
            {"code": "600519", "name": "贵州茅台", "price": 1450.0, "pct_change": 1.2},
            {"code": "000858", "name": "五粮液", "price": 160.0, "pct_change": -0.5},
        ]

        payload = quotes_batch(QuotesBatchRequest(codes=["600519", "000858"]))

        cache.return_value.get_quotes.assert_called_once_with(["600519", "000858"])
        self.assertEqual(len(payload["items"]), 2)
        self.assertEqual(payload["items"][0]["name"], "贵州茅台")
        self.assertEqual(payload["items"][0]["price"], 1450.0)
        self.assertIn("as_of", payload)
        self.assertIn("trade_date", payload)

    def test_batch_rejects_an_invalid_code(self):
        with self.assertRaises(HTTPException) as raised:
            quotes_batch(QuotesBatchRequest(codes=["600519", "abc"]))
        self.assertEqual(raised.exception.status_code, 422)

    def test_batch_rejects_more_than_100_codes(self):
        with self.assertRaises(HTTPException) as raised:
            quotes_batch(QuotesBatchRequest(codes=[f"{i:06d}" for i in range(101)]))
        self.assertEqual(raised.exception.status_code, 422)

    @patch("market_watch.app.quotes.cache")
    def test_batch_skips_quotes_missing_from_the_source(self, cache):
        cache.return_value.get_quotes.return_value = [
            {"code": "600519", "name": "贵州茅台", "price": 1450.0},
        ]

        payload = quotes_batch(QuotesBatchRequest(codes=["600519", "000858"]))

        self.assertEqual([i["code"] for i in payload["items"]], ["600519"])

    @patch("market_watch.app.quotes.cache")
    def test_batch_empty_codes_returns_empty_items(self, cache):
        cache.return_value.get_quotes.return_value = []

        payload = quotes_batch(QuotesBatchRequest(codes=[]))

        self.assertEqual(payload["items"], [])

    @patch("market_watch.app.quotes.cache")
    def test_batch_deduplicates_codes_preserving_order(self, cache):
        cache.return_value.get_quotes.return_value = [
            {"code": "600519", "name": "贵州茅台", "price": 1450.0},
        ]

        quotes_batch(QuotesBatchRequest(codes=["600519", "600519"]))

        cache.return_value.get_quotes.assert_called_once_with(["600519"])


if __name__ == "__main__":
    unittest.main()
