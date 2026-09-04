# -*- coding: utf-8 -*-
"""产业链关系权重必须区分披露值、默认值与推断关系。"""

import unittest
from unittest.mock import patch

from industry_chain import graph


class GraphWeightProvenanceTests(unittest.TestCase):
    def test_relation_weight_preserves_zero_and_marks_defaults_and_inference(self):
        self.assertEqual(
            graph._relation_weight({"share": 0, "type": "direct"}, 20),
            {"share": 0, "share_source": "disclosed"},
        )
        self.assertEqual(
            graph._relation_weight({"share": None, "type": "direct"}, 20),
            {"share": 20, "share_source": "default"},
        )
        self.assertEqual(
            graph._relation_weight({"share": 99, "type": "inferred"}, 10),
            {"share": None, "share_source": "inferred"},
        )
        self.assertEqual(
            graph._relation_weight({"share": 20, "type": "direct", "share_source": "default"}, 10),
            {"share": 20, "share_source": "default"},
        )

    def test_direct_chain_relations_expose_source_without_treating_zero_as_missing(self):
        company = {
            "code": "600001", "name": "核心公司",
            "materials": [{"name": "材料", "suppliers": [
                {"id": "s-zero", "name": "零占比", "share": 0, "type": "direct"},
                {"id": "s-default", "name": "默认上游", "share": None, "type": "direct"},
                {"id": "s-inferred", "name": "推断上游", "share": 88, "type": "inferred", "confidence": 0.82},
            ]}],
            "products": [{"name": "产品", "customers": [
                {"id": "c-default", "name": "默认下游", "share": None, "type": "direct"},
            ]}],
        }
        with (
            patch.object(graph, "_view", return_value=company),
            patch.object(graph, "company_profile", return_value={"code": "600001"}),
        ):
            upstream = graph._direct_upstream_list("600001")
            downstream = graph._direct_downstream_list("600001")

        by_id = {row["id"]: row for row in upstream}
        self.assertEqual((by_id["s-zero"]["share"], by_id["s-zero"]["share_source"]), (0, "disclosed"))
        self.assertEqual((by_id["s-default"]["share"], by_id["s-default"]["share_source"]), (20, "default"))
        self.assertEqual((by_id["s-inferred"]["share"], by_id["s-inferred"]["share_source"]), (None, "inferred"))
        self.assertEqual((downstream[0]["share"], downstream[0]["share_source"]), (10, "default"))

    def test_direct_chain_deduplicates_entity_using_best_provenance(self):
        company = {
            "code": "600001", "name": "核心公司",
            "materials": [
                {"name": "材料A", "suppliers": [{"id": "same", "name": "同一供应商", "share": None, "type": "direct"}]},
                {"name": "材料B", "suppliers": [{"id": "same", "name": "同一供应商", "share": 5, "type": "direct"}]},
            ],
            "products": [],
        }
        with (
            patch.object(graph, "_view", return_value=company),
            patch.object(graph, "company_profile", return_value={"code": "600001"}),
        ):
            upstream = graph._direct_upstream_list("600001", limit=1)
            single = graph.graph_single("600001")

        self.assertEqual(len(upstream), 1)
        self.assertEqual((upstream[0]["share"], upstream[0]["share_source"]), (5, "disclosed"))
        self.assertEqual(upstream[0]["vias"], ["材料A", "材料B"])
        self.assertEqual(single["suppliers"][0]["share_source"], "disclosed")

    def test_disclosed_edge_wins_over_larger_default_during_aggregation(self):
        aggregate = {}
        graph._merge_edge(aggregate, "supplier", "company", "supplier", None, "direct", "材料A")
        graph._merge_edge(aggregate, "supplier", "company", "supplier", 5, "direct", "材料B")

        edge = aggregate[("supplier", "company")]
        self.assertEqual(edge["share"], 5)
        self.assertEqual(edge["share_source"], "disclosed")
        self.assertEqual(edge["type"], "direct")

    def test_network_min_share_filters_projected_defaults_but_keeps_inference(self):
        net = {
            "nodes": [
                {"id": "company", "degree": 1},
                {"id": "supplier", "degree": 1},
                {"id": "inferred", "degree": 1},
            ],
            "links": [
                {"source": "supplier", "target": "company", "kind": "supplier", "share": None, "type": "direct"},
                {"source": "inferred", "target": "company", "kind": "supplier", "share": None, "type": "inferred"},
            ],
            "macro_communities": [],
        }
        with (
            patch.object(graph, "network", return_value=net),
            patch.object(graph.universe, "universe_index", return_value={}),
        ):
            result = graph.graph_network(min_degree=0, min_share=30)

        self.assertEqual(len(result["links"]), 1)
        self.assertEqual(result["links"][0]["share_source"], "inferred")

    def test_regular_network_preserves_inferred_confidence(self):
        net = {
            "nodes": [
                {"id": "company", "degree": 1},
                {"id": "inferred", "degree": 1},
            ],
            "links": [
                {
                    "source": "inferred",
                    "target": "company",
                    "kind": "supplier",
                    "share": None,
                    "type": "inferred",
                    "confidence": 0.82,
                },
            ],
            "macro_communities": [],
        }
        with (
            patch.object(graph, "network", return_value=net),
            patch.object(graph.universe, "universe_index", return_value={}),
        ):
            result = graph.graph_network(min_degree=0, min_share=0)

        self.assertEqual(result["links"][0]["confidence"], 0.82)

    def test_universe_network_returns_empty_graph_when_universe_is_unavailable(self):
        net = {"nodes": [], "links": [], "macro_communities": []}
        with (
            patch.object(graph, "network", return_value=net),
            patch.object(graph.universe, "universe_index", return_value={}),
            patch.object(graph, "a_share_links", return_value={"links": [], "degrees": {}}),
            patch.object(graph, "_universe_name_index", return_value={}),
            patch.object(graph, "view_companies", return_value={}),
        ):
            graph._universe_layout.cache_clear()
            result = graph.graph_network(
                min_degree=0,
                min_share=0,
                include_universe=True,
            )
            graph._universe_layout.cache_clear()

        self.assertEqual(result["nodes"], [])
        self.assertEqual(result["links"], [])
        self.assertEqual(result["stats"]["universe_mode"], True)
        self.assertEqual(result["stats"]["total_nodes"], 0)


if __name__ == "__main__":
    unittest.main()
