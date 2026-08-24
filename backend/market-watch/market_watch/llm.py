# -*- coding: utf-8 -*-
"""LLM 轻总结：openai 客户端直连 DeepSeek（复用 trading-core 的模式）。

仅给"结构化数据 → 中文 Markdown 摘要/解读/简报"这类轻任务用。
开关与模型走 market_watch/config.py（MW_LLM_ENABLED / MW_LLM_MODEL）。
所有调用方必须先判 settings.llm_available()；失败由上层降级，不让一次 LLM 错误挂死盯盘。
"""

import json
import logging
import re

from openai import OpenAI

from .config import settings

logger = logging.getLogger("market_watch.llm")

_client: OpenAI | None = None


class LLMUnavailable(RuntimeError):
    """未配置可用的 LLM（缺 DEEPSEEK_API_KEY 或 MW_LLM_ENABLED=false）。"""


def get_client() -> OpenAI:
    global _client
    if _client is None:
        if not settings.deepseek_api_key:
            raise LLMUnavailable("未配置 DEEPSEEK_API_KEY（.env），无法使用 LLM")
        _client = OpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            timeout=60,  # 解读/摘要/简报单次生成，放宽超时但不死等
        )
    return _client


def chat(system: str, user: str, max_tokens: int = 1500) -> str:
    """system/user 提示 → 返回模型生成的文本。失败抛异常（上层负责降级）。"""
    resp = get_client().chat.completions.create(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=max_tokens,
        temperature=0.4,
    )
    return (resp.choices[0].message.content or "").strip()


def chat_json(system: str, user: str, max_tokens: int = 1200) -> dict:
    """system/user 提示 → 结构化 JSON 对象（response_format=json_object）。

    供事件抽取等结构化任务用；失败抛异常（上层负责降级）。
    返回已解析的 dict；DeepSeek 偶尔包 ```json 围栏时自动剥掉。
    """
    resp = get_client().chat.completions.create(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=max_tokens,
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise ValueError("LLM 返回空 JSON")
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.IGNORECASE).strip()
    return json.loads(text)
