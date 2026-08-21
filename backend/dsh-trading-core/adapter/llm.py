# -*- coding: utf-8 -*-
"""简报/持仓总结 LLM：openai 客户端直连 DeepSeek（绕开 LangChain 重依赖）。

仅给"结构化数据 → 中文 Markdown 简报"这类轻总结用，不走 TradingAgents 引擎层，
避免为一句总结拉起整套 LLM 适配器。模型与超时走 adapter/config.py。
"""

from openai import OpenAI

from .config import settings

_client: OpenAI | None = None


class LLMUnavailable(RuntimeError):
    """未配置可用的 LLM（缺 DEEPSEEK_API_KEY）。"""


def get_client() -> OpenAI:
    global _client
    if _client is None:
        if not settings.deepseek_api_key:
            raise LLMUnavailable("未配置 DEEPSEEK_API_KEY（.env），无法生成总结")
        _client = OpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            timeout=180,  # 简报 LLM 单次生成较长，放宽超时
        )
    return _client


def summarize(
    system: str, user: str, max_tokens: int = 1500, response_format: str | None = None
) -> str:
    """system/user 提示 → 返回模型生成的文本。失败抛异常（上层负责降级）。

    response_format 非 None 时传给 create（DeepSeek 支持 "json_object"），
    返回仍是 str，由调用方自行 json.loads。向后兼容：默认 None 行为不变。
    """
    kwargs = dict(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=max_tokens,
        temperature=0.4,
    )
    if response_format:
        kwargs["response_format"] = {"type": response_format}
    resp = get_client().chat.completions.create(**kwargs)
    return (resp.choices[0].message.content or "").strip()
