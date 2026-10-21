# -*- coding: utf-8 -*-
"""实体提及抽取。

本版是确定性规则抽取：证券代码正则 + 实体名称/别名词典 + 主题词典 + 动态集合规则。
不调用 LLM，保证离线可测。抽取只负责"原文里提到了什么"，不做最终范围判断。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .models import EntityMention
from .normalizer import infer_exchange, normalize_text, security_kind_for_code
from .ports import IndexTerm

_CODE_RE = re.compile(r"(?<!\d)(\d{6})(?!\d)")

_COLLECTION_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"我的持仓|我持仓|我的仓位|持仓里|当前持仓|我的股票池"), "USER_PORTFOLIO"),
    (re.compile(r"我的自选|我自选|自选股|我关注的"), "USER_WATCHLIST"),
)

_CONDITIONAL_MARKERS = ("如果", "假设", "未来", "预期", "可能", "一旦", "倘若")
_FACT_MARKERS = ("已经", "已宣布", "宣布", "发生", "落地")

# 有些证券简称本身就是常用动词短语（例如“值得买”）。当它被程度副词修饰、
# 且处于句尾时，优先按普通语句理解，避免把“更值得买”误当成公司。
_DEGREE_PREFIXES = set("更最不挺很太真")
_CLAUSE_TAIL = set("吗呢吧了的啊呀嘛？?！!，,。.、 \n")


def _looks_like_predicate(text: str, start: int, end: int) -> bool:
    if start > 0 and text[start - 1] in _DEGREE_PREFIXES:
        if end == len(text) or text[end] in _CLAUSE_TAIL:
            return True
    return False


@dataclass(frozen=True)
class GazetteerEntry:
    entity_id: str | None
    entity_type_code: str | None
    canonical_name: str
    aliases: tuple[str, ...] = ()
    entity_type_candidates: tuple[str, ...] = ()


class Gazetteer:
    """加载 resources/gazetteers.json。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or Path(__file__).with_name("resources") / "gazetteers.json"
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.entities: list[GazetteerEntry] = []
        for item in raw.get("entities", []):
            self.entities.append(
                GazetteerEntry(
                    entity_id=item["entity_id"],
                    entity_type_code=item["entity_type_code"],
                    canonical_name=item["canonical_name"],
                    aliases=tuple(item.get("aliases", [])),
                    entity_type_candidates=(item["entity_type_code"],),
                )
            )
        self.type_only_terms: list[GazetteerEntry] = []
        for item in raw.get("type_only_terms", []):
            self.type_only_terms.append(
                GazetteerEntry(
                    entity_id=None,
                    entity_type_code=None,
                    canonical_name=item["term"],
                    aliases=tuple(item.get("aliases", [])),
                    entity_type_candidates=tuple(item.get("entity_type_candidates", [])),
                )
            )


class _TrieNode:
    __slots__ = ("children", "terms")

    def __init__(self) -> None:
        self.children: dict[str, _TrieNode] = {}
        self.terms: list[IndexTerm] = []


class NameTrie:
    """最长匹配前缀树；同一文本可指向多个实体（例如重名或同名 ETF）。"""

    def __init__(self, terms: Iterable[IndexTerm], type_only: Iterable[GazetteerEntry] = ()) -> None:
        self.root = _TrieNode()
        for term in terms:
            self._insert(term.text, term)
        for entry in type_only:
            for text in (entry.canonical_name, *entry.aliases):
                self._insert(
                    text,
                    IndexTerm(
                        text=text,
                        entity_id="",
                        entity_type_code=entry.entity_type_candidates[0]
                        if entry.entity_type_candidates
                        else "",
                        alias_type="type_only",
                        priority=5,
                        entity_type_codes=entry.entity_type_candidates,
                    ),
                )

    def _insert(self, text: str, term: IndexTerm) -> None:
        text = normalize_text(text)
        if not text:
            return
        key = text.lower()
        node = self.root
        for char in key:
            node = node.children.setdefault(char, _TrieNode())
        # 同一文本同一实体只保留一次；保留更高优先级。
        for existing in node.terms:
            if existing.entity_id == term.entity_id and existing.text == term.text:
                return
        node.terms.append(term)

    def longest_matches(self, text: str) -> list[tuple[int, int, list[IndexTerm]]]:
        """返回 [(start, end, terms)]，同一区间内的多个实体合并在同一项。"""

        lowered = text.lower()
        results: list[tuple[int, int, list[IndexTerm]]] = []
        position = 0
        length = len(lowered)
        while position < length:
            node = self.root
            index = position
            last: tuple[int, list[IndexTerm]] | None = None
            while index < length:
                child = node.children.get(lowered[index])
                if child is None:
                    break
                node = child
                index += 1
                if node.terms:
                    last = (index, node.terms)
            if last is not None:
                results.append((position, last[0], list(last[1])))
                position = last[0]
            else:
                position += 1
        return results


@dataclass
class _Span:
    start: int
    end: int
    raw_text: str
    candidate_entity_ids: list[str]
    entity_type_candidates: list[str]
    dynamic_collection_types: list[str]
    priority: int
    resolution_reason: str | None = None


class MentionExtractor:
    """从用户原文抽取实体提及。"""

    def __init__(self, gazetteer: Gazetteer | None = None) -> None:
        self.gazetteer = gazetteer or Gazetteer()

    def build_trie(self, terms: Iterable[IndexTerm]) -> NameTrie:
        return NameTrie(terms, self.gazetteer.type_only_terms)

    def extract(self, text: str, trie: NameTrie) -> list[EntityMention]:
        if not text:
            return []
        spans: list[_Span] = []
        spans.extend(self._code_spans(text))
        code_ranges = [(span.start, span.end) for span in spans]

        for start, end, terms in trie.longest_matches(text):
            if any(start < code_end and end > code_start for code_start, code_end in code_ranges):
                continue
            entity_ids = sorted({term.entity_id for term in terms if term.entity_id})
            type_codes: list[str] = []
            type_only_codes: list[str] = []
            priority = 0
            for term in terms:
                if term.alias_type == "type_only":
                    for code in term.entity_type_codes or (term.entity_type_code,):
                        if code and code not in type_only_codes:
                            type_only_codes.append(code)
                else:
                    if term.entity_type_code and term.entity_type_code not in type_codes:
                        type_codes.append(term.entity_type_code)
                priority = max(priority, term.priority)
            if not type_codes and not type_only_codes:
                continue
            if entity_ids and _looks_like_predicate(text, start, end):
                continue
            reason = None
            if type_only_codes and not entity_ids:
                reason = "type_only_term"
                if any(marker in text[max(0, start - 16):start] for marker in _CONDITIONAL_MARKERS):
                    reason = "scenario_context"
                elif any(marker in text[max(0, start - 16):start] for marker in _FACT_MARKERS):
                    reason = "fact_context"
            spans.append(
                _Span(
                    start=start,
                    end=end,
                    raw_text=text[start:end],
                    candidate_entity_ids=entity_ids,
                    entity_type_candidates=type_codes or type_only_codes,
                    dynamic_collection_types=[],
                    priority=priority or (5 if type_only_codes else 10),
                    resolution_reason=reason,
                )
            )

        for pattern, collection_type in _COLLECTION_RULES:
            for match in pattern.finditer(text):
                if any(
                    match.start() < span.end and match.end() > span.start
                    for span in spans
                    if span.start < match.end() and span.end > match.start()
                ):
                    continue
                spans.append(
                    _Span(
                        start=match.start(),
                        end=match.end(),
                        raw_text=match.group(0),
                        candidate_entity_ids=[],
                        entity_type_candidates=[],
                        dynamic_collection_types=[collection_type],
                        priority=60,
                    )
                )

        spans.sort(key=lambda span: (span.start, -span.priority, -(span.end - span.start)))
        selected: list[_Span] = []
        for span in spans:
            if any(span.start < kept.end and span.end > kept.start for kept in selected):
                continue
            selected.append(span)
        selected.sort(key=lambda span: span.start)

        mentions: list[EntityMention] = []
        for index, span in enumerate(selected, start=1):
            mentions.append(
                EntityMention(
                    mention_id=f"MENTION_{index:03d}",
                    raw_text=span.raw_text,
                    normalized_text=normalize_text(span.raw_text),
                    start_offset=span.start,
                    end_offset=span.end,
                    candidate_entity_ids=span.candidate_entity_ids,
                    resolved_entity_id=None,
                    entity_type_candidates=span.entity_type_candidates,
                    confidence=None,
                    resolution_status="pending",
                    candidates=[],
                    resolution_reason=span.resolution_reason,
                    dynamic_collection_types=span.dynamic_collection_types,
                )
            )
        return mentions

    def _code_spans(self, text: str) -> list[_Span]:
        spans: list[_Span] = []
        for match in _CODE_RE.finditer(text):
            code = match.group(1)
            kind = security_kind_for_code(code)
            exchange = infer_exchange(code)
            if kind == "stock":
                types = ["ENTITY_01_01", "ENTITY_02_01"]
            elif kind == "fund":
                types = ["ENTITY_01_02"]
            elif kind == "bond":
                types = ["ENTITY_01_04"]
            else:
                # 指数与股票代码可能重叠，保留多个候选让实体库裁决。
                types = ["ENTITY_01_01", "ENTITY_01_03", "ENTITY_01_02"]
            spans.append(
                _Span(
                    start=match.start(),
                    end=match.end(),
                    raw_text=code,
                    candidate_entity_ids=[],
                    entity_type_candidates=types,
                    dynamic_collection_types=[],
                    priority=100,
                    resolution_reason=f"code_match:{exchange}" if exchange else "code_match",
                )
            )
        return spans
