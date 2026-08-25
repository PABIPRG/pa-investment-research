# -*- coding: utf-8 -*-
"""持仓深度分析传给 EngineRunner 的无网络契约。"""

import sys
import types
import unittest
from unittest.mock import patch

from adapter.holdings_runner import HoldingsRunner
from adapter.schemas import HoldingItem


class FakeEngineRunner:
    """记录逐股分析入参，不初始化真实 graph。"""

    calls = []

    def run(self, params, progress_cb):
        self.__class__.calls.append(params)
        progress_cb("fake stage")
        return {
            "signal": {
                "risk_score": 25,
                "action": "hold",
                "confidence": 0.8,
                "reasoning": "fake",
            }
        }


class HoldingsDepthTests(unittest.TestCase):
    def setUp(self):
        FakeEngineRunner.calls.clear()

    def test_deep_mode_preserves_four_analyst_standard_engine_depth(self):
        fake_engine_bridge = types.ModuleType("adapter.engine_bridge")
        fake_engine_bridge.EngineRunner = FakeEngineRunner
        runner = HoldingsRunner(max_workers=1)
        holdings = [HoldingItem(ticker="600519", quantity=100, cost_price=1500)]

        with patch.dict(sys.modules, {"adapter.engine_bridge": fake_engine_bridge}):
            result = runner._l2_deep(
                holdings,
                {"task_id": "portfolio-1", "risk_profile": "balanced"},
                progress_cb=lambda _: None,
            )

        self.assertEqual(
            FakeEngineRunner.calls,
            [
                {
                    "ticker": "600519",
                    "research_depth": "standard",
                    "task_id": "portfolio-1:600519",
                    "risk_profile": "balanced",
                }
            ],
        )
        self.assertEqual(result["600519"]["action"], "hold")


if __name__ == "__main__":
    unittest.main()
