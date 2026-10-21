# -*- coding: utf-8 -*-
"""研究实体命令行入口。

用法（在 backend/dsh-trading-core 下）::

    python -m research_entities.cli registry-check
    python -m research_entities.cli import-universe
    python -m research_entities.cli sources-status
    python -m research_entities.cli refresh --with-akshare
    python -m research_entities.cli resolve "分析一下贵州茅台和白酒行业"
"""

from __future__ import annotations

import argparse
import json
import sys

from .factory import (
    build_refresher,
    build_repository,
    build_service,
    build_sources,
    build_tool_executor,
)
from .registry.entity_types import ENTITY_TYPE_REGISTRY, get_entity_type, validate_entity_type_registry
from .registry.tools import TOOL_REGISTRY, validate_tool_registry
from .reporting import ReportService, render_markdown
from .toolbox import ENTITY_SAMPLES, HANDLERS, summarize_results, validate_toolbox


def _print(payload) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    _print_text(text)


def _print_text(text: str) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(text)


def cmd_registry_check(_args) -> int:
    type_errors = validate_entity_type_registry()
    tool_errors = validate_tool_registry()
    _print(
        {
            "entity_types": len(ENTITY_TYPE_REGISTRY),
            "tools": len(TOOL_REGISTRY),
            "entity_type_errors": type_errors,
            "tool_errors": tool_errors,
        }
    )
    return 0 if not type_errors and not tool_errors else 1


def cmd_import(args) -> int:
    service = build_service(storage=args.storage, with_collections=False)
    with_akshare = True if getattr(args, "with_akshare", False) else None
    results = service.import_sources(
        build_sources(include_universe=True, include_akshare=with_akshare)
    )
    payload = [
        {
            "source_id": item.source_id,
            "source_version": item.source_version,
            "imported": item.imported,
            "warnings": item.warnings,
        }
        for item in results
    ]
    _print(payload)
    return 0 if any(item.imported for item in results) else 1


def cmd_sources_status(args) -> int:
    service = build_service(storage=args.storage)
    sources = service.source_freshness()
    _print(
        {
            "stale_sources": [
                item["source_id"] for item in sources if item["needs_refresh"]
            ],
            "sources": sources,
        }
    )
    return 0


def cmd_refresh(args) -> int:
    service = build_service(storage=args.storage)
    with_akshare = True if getattr(args, "with_akshare", False) else None
    if getattr(args, "no_akshare", False):
        with_akshare = False
    refresher = build_refresher(
        service=service, max_age_hours=getattr(args, "max_age_hours", None)
    )
    result = refresher.refresh(force=args.force, with_akshare=with_akshare)
    _print(result)
    failed = [
        item
        for item in result.get("results", [])
        if item["imported"] == 0 and item["warnings"]
    ]
    return 1 if failed else 0


def cmd_resolve(args) -> int:
    service = build_service(storage=args.storage)
    scope = service.resolve_scope(args.query, persist=not args.no_persist)
    _print(json.loads(scope.model_dump_json()))
    return 0


def _parse_params(pairs: list[str] | None) -> dict:
    params: dict = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise SystemExit(f"--param 需要 key=value 格式: {pair!r}")
        key, value = pair.split("=", 1)
        params[key.strip()] = value.strip()
    return params


def cmd_tool_check(_args) -> int:
    problems = validate_toolbox()
    _print(
        {
            "registered_tools": len(TOOL_REGISTRY),
            "handlers": len(HANDLERS),
            "configured": sum(
                1 for item in TOOL_REGISTRY.values() if item.availability == "configured"
            ),
            "external_service": sum(
                1 for item in TOOL_REGISTRY.values() if item.availability == "external_service"
            ),
            "unconfigured": sum(
                1 for item in TOOL_REGISTRY.values() if item.availability == "unconfigured"
            ),
            "problems": problems,
        }
    )
    return 0 if not problems else 1


def cmd_tool_run(args) -> int:
    executor = build_tool_executor(storage=args.storage)
    params = _parse_params(args.param)
    if args.code:
        params["code"] = args.code
    if args.name:
        params["name"] = args.name
    result = executor.execute_tool(
        args.tool_id,
        entity_ids=args.entity or [],
        params=params,
        request_id=args.request_id,
        authorized=args.authorized,
    )
    _print(json.loads(result.model_dump_json()))
    return 0 if result.status in ("ok", "empty") else 1


def _trim_result(result) -> dict:
    payload = json.loads(result.model_dump_json())
    data = payload.get("data") or {}
    records = data.get("records")
    if isinstance(records, list) and len(records) > 2:
        data["records"] = records[:2]
        data["records_truncated"] = len(records)
    for key in ("chain", "industry_chain", "profile", "raw"):
        value = data.get(key)
        if isinstance(value, (dict, list)) and len(str(value)) > 2000:
            data[key] = "<omitted>"
    return payload


def cmd_evidence_show(args) -> int:
    executor = build_tool_executor(storage=args.storage)
    bundle = executor.evidence_bundle(args.request_id)
    payload = json.loads(bundle.model_dump_json())
    if not args.full:
        for item in payload.get("items", []):
            data = item.get("data") or {}
            records = data.get("records")
            if isinstance(records, list) and len(records) > 2:
                data["records"] = records[:2]
                data["records_truncated"] = len(records)
            for key in ("chain", "industry_chain", "profile", "raw"):
                value = data.get(key)
                if isinstance(value, (dict, list)) and len(str(value)) > 2000:
                    data[key] = "<omitted>"
    _print(payload)
    return 0 if payload.get("items") else 1


def _trim_report(payload: dict) -> dict:
    for section in payload.get("sections", []):
        for table in section.get("tables", []):
            rows = table.get("rows")
            if isinstance(rows, list) and len(rows) > 5:
                table["rows"] = rows[:5]
                table["rows_truncated"] = len(rows)
    return payload


def _report_service(args) -> ReportService:
    return ReportService(build_repository(getattr(args, "storage", None)))


def cmd_report_build(args) -> int:
    service = _report_service(args)
    report = service.build(
        args.request_id,
        mode="llm" if args.llm else "deterministic",
        persist=not args.no_save,
    )
    if args.format == "markdown":
        _print_text(render_markdown(report))
    else:
        payload = json.loads(report.model_dump_json())
        _print(payload if args.full else _trim_report(payload))
    return 0


def cmd_report_show(args) -> int:
    if not args.report_id and not args.request_id:
        raise SystemExit("report-show 需要 --request-id 或 --report-id")
    service = _report_service(args)
    report = (
        service.get(args.report_id)
        if args.report_id
        else service.latest(args.request_id)
    )
    if args.format == "markdown":
        _print_text(render_markdown(report))
    else:
        payload = json.loads(report.model_dump_json())
        _print(payload if args.full else _trim_report(payload))
    return 0


def cmd_report_list(args) -> int:
    service = _report_service(args)
    _print(
        [
            {
                "report_id": item.report_id,
                "mode": item.mode,
                "created_at": item.created_at.isoformat(),
                "sections": len(item.sections),
                "warnings": len(item.warnings),
            }
            for item in service.list(args.request_id)
        ]
    )
    return 0


def cmd_tool_matrix(args) -> int:
    if args.import_sources:
        build_service(storage=args.storage, with_collections=False).import_sources(
            build_sources(include_universe=True)
        )
    executor = build_tool_executor(storage=args.storage)
    type_codes = args.type or sorted(ENTITY_TYPE_REGISTRY)
    output: list[dict] = []
    all_results = []
    for type_code in type_codes:
        definition = get_entity_type(type_code)
        sample = ENTITY_SAMPLES.get(type_code, {"entity_id": None, "params": {}})
        requests = []
        for tool_id in definition.default_tool_ids:
            if tool_id not in TOOL_REGISTRY:
                continue
            requests.append(
                {
                    "tool_id": tool_id,
                    "entity_ids": [sample["entity_id"]] if sample.get("entity_id") else [],
                    "params": dict(sample.get("params") or {}),
                }
            )
        if args.max_tools:
            requests = requests[: args.max_tools]
        results = [
            executor.execute_tool(
                item["tool_id"],
                entity_ids=item["entity_ids"],
                params=item["params"],
                authorized=args.authorized,
            )
            for item in requests
        ]
        all_results.extend(results)
        output.append(
            {
                "entity_type": type_code,
                "type_name": definition.type_name,
                "sample_entity": sample.get("entity_id"),
                "sample_params": sample.get("params"),
                "tools": [
                    _trim_result(item) if not args.full else json.loads(item.model_dump_json())
                    for item in results
                ],
            }
        )
    _print(
        {
            "summary": summarize_results(all_results),
            "entity_types": output,
        }
    )
    return 0 if not any(item.status == "error" for item in all_results) else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="research_entities", description="研究实体 Schema v1.0")
    parser.add_argument(
        "--storage",
        choices=["sqlite", "memory"],
        default=None,
        help="覆盖 RESEARCH_ENTITIES_STORAGE（默认 sqlite）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("registry-check", help="校验实体类型与工具注册表")
    check.set_defaults(func=cmd_registry_check)

    import_cmd = sub.add_parser("import-universe", help="导入本地词典与证券名称表")
    import_cmd.add_argument(
        "--with-akshare",
        action="store_true",
        help="同时导入 akshare 的 A 股/基金/指数/可转债名称表（需要联网）",
    )
    import_cmd.set_defaults(func=cmd_import)

    sources_status = sub.add_parser("sources-status", help="查看主数据来源的新鲜度")
    sources_status.set_defaults(func=cmd_sources_status)

    refresh = sub.add_parser("refresh", help="刷新已过期的实体主数据")
    refresh.add_argument("--force", action="store_true", help="忽略新鲜度，强制重新导入")
    refresh.add_argument(
        "--max-age-hours",
        type=float,
        default=None,
        help="覆盖所有来源的过期阈值（小时）",
    )
    akshare_group = refresh.add_mutually_exclusive_group()
    akshare_group.add_argument(
        "--with-akshare", action="store_true", help="强制包含 akshare 证券名录"
    )
    akshare_group.add_argument(
        "--no-akshare", action="store_true", help="本次不导入 akshare 证券名录"
    )
    refresh.set_defaults(func=cmd_refresh)

    resolve = sub.add_parser("resolve", help="把自然语言问题解析为研究 Scope")
    resolve.add_argument("query", help="研究问题原文")
    resolve.add_argument("--no-persist", action="store_true", help="只输出，不写 Scope/审计")
    resolve.set_defaults(func=cmd_resolve)

    tool_check = sub.add_parser("tool-check", help="校验工具注册表与处理器映射")
    tool_check.set_defaults(func=cmd_tool_check)

    tool_run = sub.add_parser("tool-run", help="执行单个工具")
    tool_run.add_argument("tool_id", help="逻辑工具 ID，例如 quote_history")
    tool_run.add_argument("--entity", action="append", help="实体 ID，可重复")
    tool_run.add_argument("--code", help="证券/基金/指数/债券代码")
    tool_run.add_argument("--name", help="名称或检索关键词")
    tool_run.add_argument("--param", action="append", help="附加参数 key=value，可重复")
    tool_run.add_argument("--request-id", help="审计关联的请求 ID")
    tool_run.add_argument("--authorized", action="store_true", help="声明用户已授权用户事实类工具")
    tool_run.set_defaults(func=cmd_tool_run)

    evidence_show = sub.add_parser("evidence-show", help="按 request_id 查看已落库的工具证据")
    evidence_show.add_argument("--request-id", required=True, help="研究请求 ID")
    evidence_show.add_argument("--full", action="store_true", help="输出完整证据数据（默认截断）")
    evidence_show.set_defaults(func=cmd_evidence_show)

    report_build = sub.add_parser("report-build", help="根据已落库证据生成研究报告")
    report_build.add_argument("--request-id", required=True, help="研究请求 ID")
    report_build.add_argument(
        "--llm", action="store_true", help="启用模型分析（默认只生成确定性证据汇总）"
    )
    report_build.add_argument(
        "--format", choices=["json", "markdown"], default="json", help="输出格式"
    )
    report_build.add_argument("--no-save", action="store_true", help="只输出，不写入报告库")
    report_build.add_argument("--full", action="store_true", help="输出完整表格（默认截断）")
    report_build.set_defaults(func=cmd_report_build)

    report_show = sub.add_parser("report-show", help="查看已保存的研究报告")
    report_show.add_argument("--request-id", help="查看该请求最新的报告")
    report_show.add_argument("--report-id", help="按报告 ID 精确查看")
    report_show.add_argument(
        "--format", choices=["json", "markdown"], default="json", help="输出格式"
    )
    report_show.add_argument("--full", action="store_true", help="输出完整表格（默认截断）")
    report_show.set_defaults(func=cmd_report_show)

    report_list = sub.add_parser("report-list", help="列出某请求生成过的报告")
    report_list.add_argument("--request-id", required=True, help="研究请求 ID")
    report_list.set_defaults(func=cmd_report_list)

    tool_matrix = sub.add_parser("tool-matrix", help="按实体类型逐个执行默认工具")
    tool_matrix.add_argument("--type", action="append", help="只跑指定实体类型，可重复")
    tool_matrix.add_argument("--max-tools", type=int, help="每个实体类型最多执行几个工具")
    tool_matrix.add_argument(
        "--import", dest="import_sources", action="store_true", help="执行前先导入本地词典与证券表"
    )
    tool_matrix.add_argument("--authorized", action="store_true", help="声明用户已授权")
    tool_matrix.add_argument("--full", action="store_true", help="输出完整 records（默认截断）")
    tool_matrix.set_defaults(func=cmd_tool_matrix)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
