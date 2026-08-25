# -*- coding: utf-8 -*-
"""adapter 分析深度与引擎构建的无网络契约。"""

import importlib
import sys
import types
import unittest
from unittest.mock import patch


ANALYST_IDS = {
    "market": "Market Analyst",
    "social": "Social Analyst",
    "news": "News Analyst",
    "fundamentals": "Fundamentals Analyst",
}


class FakeTradingAgentsGraph:
    """记录 adapter 传入的构图参数，不初始化真实 LLM 和数据源。"""

    instances = []
    embedding_calls = 0

    def __init__(self, selected_analysts, debug, config):
        self.selected_analysts = tuple(selected_analysts)
        self.debug = debug
        self.config = config
        self.__class__.instances.append(self)
        if config.get("memory_enabled", True):
            self.__class__.embedding_calls += 5

    def propagate(self, *args, **kwargs):
        return {}, {}


def _package(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__path__ = []
    return module


class EngineDepthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tradingagents = _package("tradingagents")
        dataflows = _package("tradingagents.dataflows")
        graph = _package("tradingagents.graph")

        data_source_manager = types.ModuleType(
            "tradingagents.dataflows.data_source_manager"
        )
        data_source_manager.get_china_stock_info_unified = lambda ticker: ticker

        default_config = types.ModuleType("tradingagents.default_config")
        default_config.DEFAULT_CONFIG = {
            "backend_url": "https://api.openai.com/v1",
            "memory_enabled": True,
            "use_memory": True,
        }

        trading_graph = types.ModuleType("tradingagents.graph.trading_graph")
        trading_graph.TradingAgentsGraph = FakeTradingAgentsGraph
        trading_graph.NODE_META = {
            node_id: {"label": node_id} for node_id in ANALYST_IDS.values()
        }
        trading_graph.NODE_META.update(
            {
                node_id: {"label": node_id}
                for node_id in (
                    "Bull Researcher",
                    "Bear Researcher",
                    "Research Manager",
                    "Trader",
                    "Risky Analyst",
                    "Safe Analyst",
                    "Neutral Analyst",
                    "Risk Judge",
                )
            }
        )

        cls._module_stubs = patch.dict(
            sys.modules,
            {
                "tradingagents": tradingagents,
                "tradingagents.dataflows": dataflows,
                "tradingagents.dataflows.data_source_manager": data_source_manager,
                "tradingagents.default_config": default_config,
                "tradingagents.graph": graph,
                "tradingagents.graph.trading_graph": trading_graph,
            },
        )
        cls._module_stubs.start()
        cls._previous_engine_bridge = sys.modules.pop("adapter.engine_bridge", None)
        cls.engine_bridge = importlib.import_module("adapter.engine_bridge")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("adapter.engine_bridge", None)
        if cls._previous_engine_bridge is not None:
            sys.modules["adapter.engine_bridge"] = cls._previous_engine_bridge
        cls._module_stubs.stop()

    def setUp(self):
        FakeTradingAgentsGraph.instances.clear()
        FakeTradingAgentsGraph.embedding_calls = 0

    def test_depths_have_distinct_analyst_and_node_budgets(self):
        expected = {
            "quick": (("market",), 9),
            "basic": (("market", "fundamentals"), 10),
            "standard": (
                ("market", "social", "news", "fundamentals"),
                12,
            ),
            "deep": (("market", "social", "news", "fundamentals"), 17),
            "full": (("market", "social", "news", "fundamentals"), 22),
        }

        runner = self.engine_bridge.EngineRunner()
        for depth, (analysts, total_steps) in expected.items():
            with self.subTest(depth=depth):
                params = {
                    "ticker": "600519",
                    "research_depth": depth,
                    "risk_profile": "balanced",
                }
                config = runner._build_config(params)
                manifest = runner.pipeline_manifest(params)

                self.assertEqual(config["selected_analysts"], analysts)
                self.assertEqual(manifest["total_steps"], total_steps)
                self.assertEqual(
                    tuple(
                        node["id"]
                        for node in manifest["phases"][0]["nodes"]
                    ),
                    tuple(ANALYST_IDS[key] for key in analysts),
                )

    def test_unknown_depth_falls_back_to_standard_budget(self):
        runner = self.engine_bridge.EngineRunner()
        params = {
            "ticker": "600519",
            "research_depth": "unknown",
            "risk_profile": "balanced",
        }

        config = runner._build_config(params)

        self.assertEqual(
            config["selected_analysts"],
            ("market", "social", "news", "fundamentals"),
        )
        self.assertEqual(runner.pipeline_manifest(params)["total_steps"], 12)

    def test_adapter_forces_memory_off_when_building_graph(self):
        runner = self.engine_bridge.EngineRunner(
            base_config={"memory_enabled": True, "use_memory": True}
        )
        params = {
            "ticker": "600519",
            "research_depth": "quick",
            "risk_profile": "balanced",
            "config_overrides": {
                "memory_enabled": True,
                "use_memory": True,
            },
        }

        with patch.object(
            self.engine_bridge,
            "build_signal_result",
            return_value={"signal": {}},
        ):
            result = runner.run(params, progress_cb=lambda _: None)

        self.assertEqual(result, {"signal": {}})
        self.assertEqual(len(FakeTradingAgentsGraph.instances), 1)
        graph = FakeTradingAgentsGraph.instances[0]
        self.assertEqual(graph.selected_analysts, ("market",))
        self.assertFalse(graph.config["memory_enabled"])
        self.assertNotIn("use_memory", graph.config)
        self.assertEqual(FakeTradingAgentsGraph.embedding_calls, 0)


if __name__ == "__main__":
    unittest.main()
