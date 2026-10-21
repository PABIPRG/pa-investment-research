# -*- coding: utf-8 -*-
"""研报 LLM 通道：默认复用对话功能的 DeepSeek harness。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import adapter.llm as llm
from adapter.config import _chat_llm_settings
from research_entities.reporting.llm_report import _default_llm_call


class ChatLLMSettingsTest(unittest.TestCase):
    def test_reads_chat_model_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "settings.json").write_text(
                json.dumps(
                    {
                        "llm_provider": "deepseek",
                        "deep_think_llm": "deepseek-chat",
                        "backend_url": "https://api.deepseek.com",
                    }
                ),
                encoding="utf-8",
            )
            payload = _chat_llm_settings(Path(directory))
        self.assertEqual(payload["llm_provider"], "deepseek")
        self.assertEqual(payload["deep_think_llm"], "deepseek-chat")

    def test_missing_or_broken_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(_chat_llm_settings(Path(directory)), {})
            Path(directory, "settings.json").write_text("{not json", encoding="utf-8")
            self.assertEqual(_chat_llm_settings(Path(directory)), {})


class DefaultLLMCallTest(unittest.TestCase):
    def test_default_call_goes_through_deepseek_harness(self):
        calls = []

        def fake_chat_json(system: str, user: str, max_tokens: int = 0) -> dict:
            calls.append((system, user, max_tokens))
            return {"summary": "ok", "sections": []}

        original_chat_json = llm.chat_json
        llm.chat_json = fake_chat_json
        try:
            payload = _default_llm_call("system prompt", "user prompt")
        finally:
            llm.chat_json = original_chat_json
        self.assertEqual(payload["summary"], "ok")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2], 3000)


if __name__ == "__main__":
    unittest.main()
