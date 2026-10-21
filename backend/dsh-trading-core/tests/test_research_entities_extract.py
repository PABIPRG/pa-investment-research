# -*- coding: utf-8 -*-
"""确定性抽取测试：不调用 LLM，不访问网络。"""

from __future__ import annotations

import unittest

from research_entities.extractor import Gazetteer, MentionExtractor

from tests.research_entities_fixtures import build_service


class MentionExtractionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = build_service()
        cls.trie = cls.service._trie()

    def extract(self, text):
        return MentionExtractor(Gazetteer()).extract(text, self.trie)

    def test_six_digit_code_offsets_point_into_original_text(self):
        query = "帮我看看 600519 最近一年的走势"
        mentions = self.extract(query)
        code = [item for item in mentions if item.raw_text == "600519"]
        self.assertEqual(len(code), 1)
        mention = code[0]
        self.assertEqual(query[mention.start_offset:mention.end_offset], "600519")
        self.assertIn("ENTITY_01_01", mention.entity_type_candidates)
        self.assertEqual(mention.resolution_reason, "code_match:SH")

    def test_alias_match_uses_longest_term(self):
        mentions = self.extract("半导体设备景气度怎么样")
        texts = [item.raw_text for item in mentions]
        self.assertIn("半导体设备", texts)
        self.assertNotIn("半导体", texts)

    def test_industry_alias_is_extracted(self):
        mentions = self.extract("白酒行业最近表现如何")
        self.assertTrue(any(item.raw_text == "白酒" for item in mentions))
        industry = next(item for item in mentions if item.raw_text == "白酒")
        self.assertEqual(industry.entity_type_candidates, ["ENTITY_03_01"])

    def test_dynamic_collection_is_marked_without_entity_id(self):
        mentions = self.extract("我的持仓里面哪只最稳")
        collection = next(item for item in mentions if item.dynamic_collection_types)
        self.assertEqual(collection.dynamic_collection_types, ["USER_PORTFOLIO"])
        self.assertEqual(collection.candidate_entity_ids, [])
        self.assertIsNone(collection.resolved_entity_id)

    def test_type_only_term_is_unresolved_with_type_candidates(self):
        mentions = self.extract("如果降息会怎样")
        term = next(item for item in mentions if item.raw_text == "降息")
        self.assertEqual(term.resolution_reason, "scenario_context")
        self.assertEqual(
            set(term.entity_type_candidates), {"ENTITY_04_04", "ENTITY_04_01"}
        )
        self.assertIsNone(term.resolved_entity_id)

    def test_ambitious_etf_name_keeps_both_candidates(self):
        mentions = self.extract("沪深300ETF 怎么买")
        etf = next(item for item in mentions if item.raw_text == "沪深300ETF")
        self.assertEqual(
            set(etf.candidate_entity_ids),
            {"FUND:CSI300ETF:510300", "FUND:CSI300ETF:159919"},
        )

    def test_mentions_are_non_overlapping_and_deterministic(self):
        query = "分析600519贵州茅台和白酒行业，近一年"
        first = self.extract(query)
        second = self.extract(query)
        self.assertEqual(
            [(item.mention_id, item.start_offset, item.end_offset) for item in first],
            [(item.mention_id, item.start_offset, item.end_offset) for item in second],
        )
        for index, item in enumerate(first):
            self.assertEqual(query[item.start_offset:item.end_offset], item.raw_text)
            for other in first[index + 1:]:
                self.assertFalse(
                    item.start_offset < other.end_offset
                    and item.end_offset > other.start_offset,
                    f"overlap: {item.raw_text} / {other.raw_text}",
                )

    def test_common_verb_phrase_is_not_treated_as_company_name(self):
        mentions = self.extract("沪深300ETF和贵州茅台哪个更值得买")
        self.assertNotIn("值得买", [item.raw_text for item in mentions])

    def test_company_name_still_extracted_in_normal_context(self):
        mentions = self.extract("分析值得买这家公司的财报")
        self.assertIn("值得买", [item.raw_text for item in mentions])

    def test_english_and_digit_terms_are_case_insensitive(self):
        mentions = self.extract("hbm 和 cpo 有什么区别")
        texts = {item.raw_text.lower() for item in mentions}
        self.assertIn("hbm", texts)
        self.assertIn("cpo", texts)


if __name__ == "__main__":
    unittest.main()
