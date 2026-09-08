# -*- coding: utf-8 -*-
"""自进化 v2 · P6 假设生成先验单测。

覆盖：
- priors.oos_passed：verification_status / backtest.oos 胜率 → bool|None 结论映射。
- priors.bucket_of：方向×因子族 分桶（族内 kind 归同族，单例 kind 回落自身，非法方向归一）。
- priors.aggregate / render：trial/pass 累计 + 只报样本≥min_trials + 优/慎/平标记 + 少样本按升序留慎用。
- priors.build_hint：扫描 store strategies → 先验文本（无可报返回 ""）。
- generate_hypotheses 注入：仅当传入非空 priors_hint 且 LLM 可用时才把先验附进系统提示；
  缺省 None / 空 / 关 LLM → 系统提示无先验标记（与 v1 逐字节一致）。
- 来源统计与扩展证据一致：构造的 strategy record（含 backtest.oos win_rate）→ 先验文本里的
  计数与 oos_passed 结论一致（字段映射）。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_evolution_priors -v
依赖 adapter.{priors,strategies,genome,config,store,llm}——无网络（chat_json 被替换）。
"""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("ADAPTER_RUNNER", "fake")

from adapter import llm, priors, strategies  # noqa: E402
from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402


def _rec(kind="rsi_reversal", direction="利空", *, vs=None, wr=None):
    r = {"id": "x", "kind": kind, "direction": direction}
    if vs is not None:
        r["verification_status"] = vs
    if wr is not None:
        r["backtest"] = {"out_of_sample": {"win_rate_pct": wr}}
    return r


class OosPassedTest(unittest.TestCase):
    def test_status_passed_true(self):
        self.assertTrue(priors.oos_passed(_rec(vs="passed")))

    def test_status_not_passed_false(self):
        self.assertFalse(priors.oos_passed(_rec(vs="not_passed")))
        self.assertFalse(priors.oos_passed(_rec(vs="rejected")))

    def test_insufficient_falls_back_to_oos_winrate(self):
        self.assertTrue(priors.oos_passed(_rec(vs="insufficient", wr=60.0)))
        self.assertFalse(priors.oos_passed(_rec(vs="insufficient", wr=40.0)))

    def test_no_verdict_none(self):
        self.assertIsNone(priors.oos_passed(_rec()))
        self.assertIsNone(priors.oos_passed(_rec(vs="insufficient")))
        self.assertIsNone(priors.oos_passed(None))


class BucketOfTest(unittest.TestCase):
    def test_family_grouping(self):
        # momentum↔breakout 同属「利好动量」，方向利好 → 同一桶
        self.assertEqual(priors.bucket_of(_rec("momentum", "利好")),
                         priors.bucket_of(_rec("breakout", "利好")))
        # rsi_reversal↔bollinger 同属「利空反弹」
        self.assertEqual(priors.bucket_of(_rec("rsi_reversal", "利空")),
                         priors.bucket_of(_rec("bollinger", "利空")))

    def test_singleton_family_falls_back_to_kind(self):
        # ma_cross 无生态位族 → 回落自身 kind
        self.assertEqual(priors.bucket_of(_rec("ma_cross", "利好"))[1], "ma_cross")

    def test_direction_ok_and_unknown_normalized(self):
        self.assertEqual(priors.bucket_of(_rec("momentum", "利好"))[0], "利好")
        self.assertEqual(priors.bucket_of(_rec("momentum", "随便"))[0], "未知")


class AggregateRenderTest(unittest.TestCase):
    def test_counts_and_rate(self):
        table = priors.aggregate([
            _rec("rsi_reversal", "利空", wr=55.0),   # 过
            _rec("bollinger", "利空", wr=48.0),      # 不过（<50）
            _rec("rsi_reversal", "利空", vs="not_passed"),  # 不过
        ])
        key = "利空·利空反弹"
        self.assertEqual(table[key]["trials"], 3)
        self.assertEqual(table[key]["passed"], 1)
        self.assertEqual(table[key]["pass_rate_pct"], 33.3)

    def test_no_verdict_records_not_counted(self):
        table = priors.aggregate([_rec("rsi_reversal", "利空"), _rec("rsi_reversal", "利空", wr=60.0)])
        self.assertEqual(table["利空·利空反弹"]["trials"], 1)

    def test_render_filters_below_min_trials(self):
        table = priors.aggregate([_rec("rsi_reversal", "利空", wr=60.0)])
        self.assertEqual(priors.render(table, min_trials=3), [])
        self.assertEqual(len(priors.render(table, min_trials=1)), 1)

    def test_render_marks_good_caution_even(self):
        good = {"k": {"trials": 5, "passed": 4, "pass_rate_pct": 80.0}}
        bad = {"k": {"trials": 5, "passed": 1, "pass_rate_pct": 20.0}}
        even = {"k": {"trials": 4, "passed": 2, "pass_rate_pct": 50.0}}  # 居中 → 平
        self.assertIn("标记=优", priors.render(good)[0])
        self.assertIn("标记=慎", priors.render(bad)[0])
        self.assertIn("标记=平", priors.render(even)[0])


class BuildHintTest(unittest.TestCase):
    def test_empty_store_returns_empty(self):
        store = JsonStore(Path(tempfile.mkdtemp()))
        self.assertEqual(priors.build_hint(store), "")

    def test_scan_matches_evidence_field_mapping(self):
        store = JsonStore(Path(tempfile.mkdtemp()))
        # 2 条 rsi_reversal 利空：1 过(backtest.oos 55) + 1 不过(oos 45)；verification_status 空
        store.set("strategies", "s1", {
            "id": "s1", "kind": "rsi_reversal", "direction": "利空",
            "backtest": {"out_of_sample": {"win_rate_pct": 55.0}},
        })
        store.set("strategies", "s2", {
            "id": "s2", "kind": "bollinger", "direction": "利空",
            "backtest": {"out_of_sample": {"win_rate_pct": 45.0}},
        })
        hint = priors.build_hint(store, min_trials=2, max_lines=8)
        # 桶键「利空·利空反弹」，1/2，50.0%
        self.assertIn("利空·利空反弹：过样本外 1/2（50.0%", hint)
        self.assertIn("历史先验", hint)

    def test_respects_min_trials_threshold(self):
        store = JsonStore(Path(tempfile.mkdtemp()))
        store.set("strategies", "s1", {
            "id": "s1", "kind": "rsi_reversal", "direction": "利空",
            "verification_status": "passed",
        })
        self.assertEqual(priors.build_hint(store, min_trials=3), "")


class GenerateHypothesesInjectionTest(unittest.TestCase):
    EVENT = {"id": "e1", "direction": "利好", "type": "新闻", "industries": [],
             "tickers": [{"name": "贵州茅台", "code": "600519"}], "summary": "中报预增"}

    def _capture(self, fake_hyp):
        captured = {}
        import unittest.mock as mock
        fake = mock.MagicMock(return_value=fake_hyp)
        return captured, fake

    def test_hint_injected_into_system_when_given(self):
        import unittest.mock as mock
        captured = {}
        def fake_chat_json(system, block, **kw):
            captured["system"] = system
            return {"hypotheses": [{
                "event_idx": 0, "symbols": ["600519"], "direction": "利好",
                "kind": "momentum", "params": {"n": 10},
                "rationale": "预增动量", "holding_window_days": 20,
            }]}
        saved_key = settings.deepseek_api_key
        settings.deepseek_api_key = "k"  # 让 llm_available() 为真
        try:
            with mock.patch.object(llm, "chat_json", fake_chat_json):
                hyps = strategies.generate_hypotheses([self.EVENT], priors_hint="【先验X】利空·利空反弹 过1/2")
            self.assertEqual(len(hyps), 1)
            self.assertEqual(hyps[0]["kind"], "momentum")
            self.assertIn("【先验X】利空·利空反弹 过1/2", captured["system"])
            self.assertNotIn("【先验X】", strategies._HYPOTHESIS_SYSTEM)  # 模块常量未被改
        finally:
            settings.deepseek_api_key = saved_key

    def test_no_hint_keeps_system_byte_identical(self):
        import unittest.mock as mock
        captured = {}
        def fake_chat_json(system, block, **kw):
            captured["system"] = system
            return {"hypotheses": [{
                "event_idx": 0, "symbols": ["600519"], "direction": "利好",
                "kind": "momentum", "params": {"n": 10},
                "rationale": "x", "holding_window_days": 20,
            }]}
        saved_key = settings.deepseek_api_key
        settings.deepseek_api_key = "k"
        try:
            with mock.patch.object(llm, "chat_json", fake_chat_json):
                strategies.generate_hypotheses([self.EVENT])          # 缺省 None
                self.assertEqual(captured["system"], strategies._HYPOTHESIS_SYSTEM)
            with mock.patch.object(llm, "chat_json", fake_chat_json):
                strategies.generate_hypotheses([self.EVENT], priors_hint="")  # 空串
                self.assertEqual(captured["system"], strategies._HYPOTHESIS_SYSTEM)
        finally:
            settings.deepseek_api_key = saved_key

    def test_llm_unavailable_rule_degrades_ignores_hint(self):
        saved_key = settings.deepseek_api_key
        settings.deepseek_api_key = ""  # llm 不可用 → 规则降级，hint 不应进入任何 LLM 分支
        try:
            hyps = strategies.generate_hypotheses([self.EVENT], priors_hint="【先验】利空 过1/2")
            self.assertEqual(len(hyps), 1)
            self.assertEqual(hyps[0]["kind"], "momentum")  # 利好规则降级
        finally:
            settings.deepseek_api_key = saved_key


if __name__ == "__main__":
    unittest.main()
