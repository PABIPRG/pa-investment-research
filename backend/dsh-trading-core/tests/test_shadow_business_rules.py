# -*- coding: utf-8 -*-
"""影子验证只接收已生效策略的业务护栏。"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from adapter.shadow import ShadowRunner
from adapter.store import JsonStore


class ShadowBusinessRuleTests(unittest.TestCase):
    def test_explicit_candidate_is_skipped_instead_of_entering_paper_account(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = JsonStore(Path(temporary))
            store.set(
                "strategies",
                "candidate-1",
                {"id": "candidate-1", "status": "candidate", "symbols": ["600519"]},
            )
            runner = ShadowRunner(store)

            with patch("adapter.shadow._latest_trade_date", return_value="2026-08-26"):
                result = runner.run(
                    {"strategy_id": "candidate-1", "force": False}, lambda _message: None
                )

            self.assertTrue(result["skipped"])
            self.assertIn("无 active 策略", result["reason"])
            self.assertNotIn("reports", result)
            self.assertEqual(store.all("shadows"), {})
            self.assertEqual(store.all("shadow_equity"), {})


if __name__ == "__main__":
    unittest.main()
