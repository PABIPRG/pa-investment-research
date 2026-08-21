# -*- coding: utf-8 -*-
"""研报 LLM 抽取层：DeepSeek 直连，从研报正文抽取产业链关系 / 关联公司 / 经营指标。

输出 schema（对齐图谱 view-data-all 结构）：
  materials[].suppliers[] / products[].customers[]（供应链关系）
  related[]（产业关联公司）metrics[]（经营指标）
约束：只抽研报明确提及的；share 无则 null；note 引原文短句作为依据。

复用 dsh-trading-core adapter/llm.py 的 DeepSeek 约定（base_url=https://api.deepseek.com、
model=deepseek-chat），用 requests 直连 POST /chat/completions，不引入 openai 依赖。
"""

import json
import textwrap

import requests

from .config import settings

_MAX_BODY_CHARS = 4000  # 单次提示词携带正文上限（token 控制）
_MAX_TRIES = 2


def _headers() -> dict:
    if not settings.deepseek_api_key:
        raise RuntimeError(
            "IC_DEEPSEEK_API_KEY 未配置：从 dsh-trading-core/.env 复制 DEEPSEEK_API_KEY "
            "到 backend/industry-chain/.env 的 IC_DEEPSEEK_API_KEY"
        )
    return {
        "Authorization": f"Bearer {settings.deepseek_api_key}",
        "Content-Type": "application/json",
    }


_SYSTEM = textwrap.dedent(
    """\
    你是产业链研究助手。根据给定上市公司的研报正文，抽取以下信息，输出严格 JSON：

    {
      "materials": [{"name": "原材料名", "suppliers": [{"name": "供应商公司名", "share": 30, "note": "原文依据"}]}],
      "products": [{"name": "产品或业务名", "customers": [{"name": "下游客户公司名", "share": null, "note": "原文依据"}]}],
      "related": [{"name": "关联公司名", "relation": "同行/上下游/竞争", "note": "原文依据"}],
      "metrics": [{"metric": "指标名", "value": "数值", "unit": "单位", "note": "同比或备注"}]
    }

    规则：
    1. metrics 必须覆盖正文中出现的【所有】财务与经营指标（营收、归母净利润、毛利率、净利率、EPS、市占率、门店数、产能、同比增速、单价等），每个指标一条；value 保留数字与原单位。
    2. materials = 上游原材料及其供应商（公司采购对象）；products = 产品或业务及其下游客户（购买方）。
    3. related = 研报提及的其它公司（同行竞争对手、上下游公司、股东等），relation 填关系类型。
    4. 只抽正文【明确提及】的内容，禁止臆造；没有就返回空数组。
    5. 公司自身不得出现在 suppliers/customers/related 里（自环）。
    6. 供应商/客户/关联公司只写公司名（去掉"公司""集团"等后缀）。
    7. share 是占比百分比，研报明确给出才填，否则 null；note 用原文一句话（≤25 字）作为依据。
    8. 所有字段必须存在（无内容用空数组），只输出 JSON。
    """
)

_USER_TEMPLATE = """\
公司：{name}（代码 {code}）
研报正文（节选，可能多篇拼接，段落间以空行分隔）：

{body}

请输出符合上述 schema 的 JSON。
"""


def _build_user(code: str, name: str, texts: list[str]) -> str:
    joined = "\n\n".join(t for t in texts if t)
    body = joined[:_MAX_BODY_CHARS]
    return _USER_TEMPLATE.format(code=code, name=name, body=body)


def _chat_json(prompt: str) -> dict:
    url = settings.deepseek_base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    last: Exception | None = None
    for attempt in range(_MAX_TRIES):
        try:
            r = requests.post(url, headers=_headers(), json=payload, timeout=180)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            return _normalize(parsed)
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"DeepSeek 抽取失败: {last}")


def _normalize(parsed) -> dict:
    """规整 LLM 输出到图谱对齐结构（容错字段缺失/类型异常）。"""
    def lst(v, default=[]) -> list:
        return v if isinstance(v, list) else default

    def ent(item) -> dict:
        return {
            "name": item.get("name"),
            "share": item.get("share") if isinstance(item.get("share"), (int, float)) else None,
            "note": (item.get("note") or "")[:40],
        }

    out: dict = {"materials": [], "products": [], "related": [], "metrics": []}
    for m in lst(parsed.get("materials")):
        if not isinstance(m, dict) or not m.get("name"):
            continue
        suppliers = []
        for s in lst(m.get("suppliers")):
            if s and s.get("name"):
                suppliers.append(ent(s))
        out["materials"].append({"name": m.get("name"), "suppliers": suppliers})
    for p in lst(parsed.get("products")):
        if not isinstance(p, dict) or not p.get("name"):
            continue
        customers = []
        for cu in lst(p.get("customers")):
            if cu and cu.get("name"):
                customers.append(ent(cu))
        out["products"].append({"name": p.get("name"), "customers": customers})
    for r in lst(parsed.get("related")):
        if isinstance(r, dict) and r.get("name"):
            out["related"].append(
                {
                    "name": r.get("name"),
                    "relation": (r.get("relation") or "")[:30],
                    "note": (r.get("note") or "")[:40],
                }
            )
    for mt in lst(parsed.get("metrics")):
        if isinstance(mt, dict) and mt.get("metric"):
            out["metrics"].append(
                {
                    "metric": (mt.get("metric") or "")[:40],
                    "value": (mt.get("value") or ""),
                    "unit": (mt.get("unit") or ""),
                    "note": (mt.get("note") or "")[:40],
                }
            )
    return out


def extract_relations(code: str, name: str, texts: list[str]) -> dict:
    """从研报正文段落抽取关系，返回规范化 dict。失败抛异常由调用方处理。"""
    prompt = _build_user(code, name, texts)
    return _chat_json(prompt)
