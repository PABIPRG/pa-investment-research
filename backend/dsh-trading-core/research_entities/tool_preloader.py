# -*- coding: utf-8 -*-
"""逻辑 Tool 预挂载。

只做推荐与可用性检查，不执行任何工具、不发起外部调用。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import EntityCollection, PreloadTool
from .registry.entity_types import DYNAMIC_COLLECTION_DEFINITIONS, get_entity_type
from .registry.intents import INTENT_REGISTRY
from .registry.tools import TOOL_REGISTRY


@dataclass
class _Accumulator:
    reasons: list[str] = field(default_factory=list)
    required: bool = False
    entity_ids: list[str] = field(default_factory=list)


class ToolPreloader:
    def __init__(self, tools: dict | None = None) -> None:
        self.tools = tools or TOOL_REGISTRY

    def _compatible_ids(
        self,
        tool_id: str,
        entity_ids: list[str],
        type_by_id: dict[str, str] | None,
    ) -> tuple[list[str], bool]:
        """按工具声明的实体类型过滤实体；返回 (可用实体, 是否受类型约束)。

        未声明支持类型的工具（如持仓类）面向用户集合，不按实体类型过滤。
        没有 id→type 映射时退回旧行为，避免在缺少信息时误删实体。
        """

        definition = self.tools.get(tool_id)
        supported = set(definition.supported_entity_types) if definition else set()
        if not supported:
            return list(entity_ids), False
        if type_by_id is None:
            # 没有映射就无法判断兼容性，保持旧行为而不是把工具全部删掉。
            return list(entity_ids), False
        return [
            entity_id
            for entity_id in entity_ids
            if type_by_id.get(entity_id) in supported
        ], True

    def _intent_matches_types(
        self, tool_ids: list[str], entity_types: list[str]
    ) -> bool:
        """意图只要有一个工具能作用于当前实体类型就保留。

        不用 ``preferred_entity_types`` 做硬过滤：像“事件分析”偏好事件实体，
        但用户对个股问回购/解禁时，公告与解禁工具仍然适用。
        """

        if not entity_types:
            return True
        type_set = set(entity_types)
        for tool_id in tool_ids:
            definition = self.tools.get(tool_id)
            if definition is None:
                continue
            supported = set(definition.supported_entity_types)
            if not supported or supported & type_set:
                return True
        return False

    def preload(
        self,
        *,
        entity_types: list[str],
        intent_codes: list[str],
        entity_ids: list[str],
        entity_ids_by_type: dict[str, list[str]] | None = None,
        dynamic_collection_types: list[str] | None = None,
        collection: EntityCollection | None = None,
    ) -> tuple[list[PreloadTool], list[str]]:
        accumulated: dict[str, _Accumulator] = {}
        warnings: list[str] = []
        type_by_id = (
            {
                entity_id: type_code
                for type_code, ids in entity_ids_by_type.items()
                for entity_id in ids
            }
            if entity_ids_by_type is not None
            else None
        )

        def add(
            tool_id: str,
            reason: str,
            required: bool = False,
            ids: list[str] | None = None,
        ) -> None:
            item = accumulated.setdefault(tool_id, _Accumulator())
            if reason not in item.reasons:
                item.reasons.append(reason)
            item.required = item.required or required
            for entity_id in ids or []:
                if entity_id not in item.entity_ids:
                    item.entity_ids.append(entity_id)

        for type_code in entity_types:
            try:
                definition = get_entity_type(type_code)
            except KeyError:
                warnings.append(f"未知实体类型，未挂载工具: {type_code}")
                continue
            # 按类型挂载时只把该类型的实体传给工具，避免把无关实体串进查询；
            # 未提供映射时退回旧行为（全部实体）。
            type_entity_ids = (
                entity_ids_by_type.get(type_code, [])
                if entity_ids_by_type is not None
                else list(entity_ids)
            )
            if entity_ids_by_type is not None and entity_ids and not type_entity_ids:
                # 该类型没有实际解析出的实体，挂载默认工具只会得到空查询。
                continue
            for tool_id in definition.default_tool_ids:
                add(
                    tool_id,
                    f"{definition.type_name}的默认工具",
                    ids=type_entity_ids,
                )

        for intent_code in intent_codes:
            definition = INTENT_REGISTRY.get(intent_code)
            if definition is None:
                continue
            intent_tool_ids = [
                *definition.required_tools, *definition.optional_tools
            ]
            if not self._intent_matches_types(intent_tool_ids, entity_types):
                # 意图没有任何工具能作用于当前实体，整组不挂载，避免“基金/
                # 指数触发了降级给个股的行情与财务工具”。
                warnings.append(
                    f"意图“{definition.name}”与当前实体类型不兼容，未挂载其工具"
                )
                continue
            # 意图级工具面向整个 Scope，但只挂载与该工具实体类型兼容的实体：
            # 例如主题实体不能触发个股行情/财务工具，避免拿错标的去查空数据。
            intent_tools = [
                (tool_id, True) for tool_id in definition.required_tools
            ] + [(tool_id, False) for tool_id in definition.optional_tools]
            for tool_id, required in intent_tools:
                compatible_ids, type_bound = self._compatible_ids(
                    tool_id, entity_ids, type_by_id
                )
                # 完全没有解析出实体时（如“最近有哪些监管政策”），允许工具
                # 只靠查询参数/关键词执行；只有存在实体但类型不匹配时才跳过。
                if type_bound and not compatible_ids and entity_ids:
                    warnings.append(
                        f"{definition.name}的工具 {tool_id} 与当前实体类型不兼容，未挂载"
                    )
                    continue
                add(
                    tool_id,
                    f"{definition.name}的{'必需' if required else '可选'}工具",
                    required=required,
                    ids=compatible_ids,
                )

        for collection_type in dynamic_collection_types or []:
            definition = DYNAMIC_COLLECTION_DEFINITIONS.get(collection_type)
            if definition is None:
                warnings.append(f"未知动态集合，未挂载工具: {collection_type}")
                continue
            for tool_id in definition.get("default_tool_ids", []):  # type: ignore[union-attr]
                add(str(tool_id), f"{definition['name']}的默认工具")

        tools: list[PreloadTool] = []
        for tool_id, bucket in accumulated.items():
            definition = self.tools.get(tool_id)
            if definition is None:
                warnings.append(f"逻辑工具未注册: {tool_id}")
                tools.append(
                    PreloadTool(
                        tool_id=tool_id,
                        reason="；".join(bucket.reasons),
                        required=bucket.required,
                        entity_ids=list(entity_ids),
                        status="unconfigured",
                        execution_mode="not_executable",
                    )
                )
                continue
            if definition.availability == "unconfigured":
                warnings.append(f"工具未配置: {tool_id}")
            elif definition.availability == "external_service":
                warnings.append(f"工具由兄弟服务提供、未注册为本服务工具: {tool_id}")
            authorized = (
                collection is not None
                and collection.authorization_status == "authorized"
            )
            if definition.requires_authorization and not authorized:
                warnings.append(f"工具需要用户授权后才能执行: {tool_id}")
            tools.append(
                PreloadTool(
                    tool_id=tool_id,
                    reason="；".join(bucket.reasons),
                    required=bucket.required,
                    entity_ids=list(bucket.entity_ids),
                    status=definition.availability,
                    execution_mode="preload_only",
                    requires_authorization=definition.requires_authorization,
                )
            )
        tools.sort(key=lambda item: (not item.required, item.tool_id))
        return tools, list(dict.fromkeys(warnings))
