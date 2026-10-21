# -*- coding: utf-8 -*-
"""迁移演练：在空目标副本上完成导出 → 预览 → 提交 → 关联核对（V1.3 §9.3/§9.4）。

演练不写入生产源，也不删除目标已有数据——目标必须是全新的空目录/空库；
发现目标非空时直接拒绝，避免把“演练”做成一次覆盖事故。报告记录数据包摘要、
各域预览数量、提交回执与核对结果，供停写切换前的人工验收留档。

命令行（在 ``backend/dsh-trading-core`` 下执行）::

    ./env/Scripts/python.exe -m adapter.migration_rehearsal \\
        --trading-core-source ./data/prod \\
        --trading-core-target ./data/rehearsal \\
        --notifications-source ./data/prod-notifications.sqlite3 \\
        --notifications-target ./data/rehearsal-notifications.sqlite3 \\
        --report ./data/migration-rehearsal.json
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .data_transfer import CATEGORY_COLLECTIONS
from .product_package import (
    DomainAdapter,
    PackageError,
    PackageJournal,
    ResearchPartnerDomain,
    TradingCoreDomain,
    build_package,
    commit_package_import,
    preview_package_import,
)


class RehearsalError(RuntimeError):
    """演练未通过；``report`` 保留已取得的证据。"""

    def __init__(self, message: str, report: dict[str, Any]) -> None:
        super().__init__(message)
        self.report = report


def _empty_targets(
    target_adapters: Mapping[str, DomainAdapter], scope: list[str]
) -> None:
    for name in scope:
        adapter = target_adapters.get(name)
        if adapter is None:
            raise RehearsalError(
                f"目标实例缺少领域 {name} 的适配器，无法演练",
                {"ok": False, "reason": "missing_target_adapter", "domain": name},
            )
        if not adapter.is_empty():
            raise RehearsalError(
                f"目标领域 {name} 非空；演练只能写入全新的空目标",
                {"ok": False, "reason": "target_not_empty", "domain": name},
            )


def rehearse_package_import(
    source_adapters: Mapping[str, DomainAdapter],
    target_adapters: Mapping[str, DomainAdapter],
    journal: PackageJournal,
    *,
    batch_id: str,
    scope: list[str] | None = None,
    resolutions: Mapping[str, Any] | None = None,
    attachments: list[Mapping[str, Any]] | None = None,
    attachments_dir: str | Path | None = None,
) -> dict[str, Any]:
    """在空目标上跑一遍完整导入，并核对关联；失败抛 ``RehearsalError``。"""

    batch = batch_id or "IMP_" + secrets.token_hex(12)
    report: dict[str, Any] = {
        "kind": "migration-rehearsal",
        "batchId": batch,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "ok": False,
    }
    try:
        package = build_package(
            source_adapters,
            scope=scope,
            attachments=attachments or (),
        )
    except PackageError as exc:
        report["reason"] = "source_export_failed"
        report["error"] = str(exc)
        raise RehearsalError(str(exc), report) from exc
    report["packageDigest"] = package["integrity"]["value"]
    report["source"] = {
        name: {
            "schemaVersion": item["schemaVersion"],
            "consistencyVersion": item["consistencyVersion"],
            "counts": item["counts"],
        }
        for name, item in package["domains"].items()
    }

    selected = list(package["exportScope"]["domains"])
    try:
        _empty_targets(target_adapters, selected)
    except RehearsalError as exc:
        exc.report.update({"packageDigest": report["packageDigest"], "source": report["source"]})
        raise

    preview = preview_package_import(
        package, target_adapters, attachments_dir=attachments_dir
    )
    report["preview"] = {
        "totals": preview["totals"],
        "domains": {
            name: item.get("counts") for name, item in preview["domains"].items()
        },
        "warnings": preview["warnings"],
    }

    receipt = commit_package_import(
        package,
        target_adapters,
        journal,
        batch_id=batch,
        resolutions=resolutions or {},
        attachments_dir=attachments_dir,
    )
    report["result"] = receipt
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    if receipt.get("state") != "committed":
        report["reason"] = receipt.get("state")
        raise RehearsalError(
            f"演练未通过：批次状态为 {receipt.get('state')}", report
        )
    report["ok"] = True
    return report


def _write_report(report: dict[str, Any], path: str | Path) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - 命令行入口
    from .notifications.repository import NotificationRepository
    from .store import JsonStore

    parser = argparse.ArgumentParser(description="产品数据包迁移演练")
    parser.add_argument("--trading-core-source")
    parser.add_argument("--trading-core-target")
    parser.add_argument("--notifications-source")
    parser.add_argument("--notifications-target")
    parser.add_argument("--research-source")
    parser.add_argument("--research-target")
    parser.add_argument("--principal", default="local-user")
    parser.add_argument("--instance", default="local-instance")
    parser.add_argument("--attachments-dir")
    parser.add_argument("--journal", default="./data/product-package-journal.sqlite3")
    parser.add_argument("--report", default="./data/migration-rehearsal.json")
    parser.add_argument("--batch", default=None)
    args = parser.parse_args(argv)

    sources: dict[str, DomainAdapter] = {}
    targets: dict[str, DomainAdapter] = {}
    if args.trading_core_source or args.trading_core_target:
        if not (args.trading_core_source and args.trading_core_target):
            parser.error("trading-core 的源与目标必须同时给出")
        if not (args.notifications_source and args.notifications_target):
            # 通知历史属于 trading-core 域；缺失时不能悄悄导出一个不含通知的“完整包”。
            parser.error("trading-core 演练必须同时给出通知源库与目标库路径")
        if not Path(args.notifications_source).is_file():
            parser.error(f"通知源库不存在：{args.notifications_source}")
        sources["trading-core"] = TradingCoreDomain(
            lambda: JsonStore(Path(args.trading_core_source)),
            notification_repository=NotificationRepository(
                Path(args.notifications_source)
            ),
        )
        targets["trading-core"] = TradingCoreDomain(
            lambda: JsonStore(Path(args.trading_core_target)),
            notification_repository=NotificationRepository(
                Path(args.notifications_target)
            ),
        )
    if args.research_source or args.research_target:
        if not (args.research_source and args.research_target):
            parser.error("research-partner 的源与目标必须同时给出")
        from research_partner.adapters import SqliteBusinessStore

        sources["research-partner"] = ResearchPartnerDomain(
            SqliteBusinessStore(Path(args.research_source)),
            principal_id=args.principal,
            instance_id=args.instance,
        )
        targets["research-partner"] = ResearchPartnerDomain(
            SqliteBusinessStore(Path(args.research_target)),
            principal_id=args.principal,
            instance_id=args.instance,
        )
    if not sources:
        parser.error("至少给出一组源与目标")

    resolutions = {
        "trading-core": {category: "use_import" for category in CATEGORY_COLLECTIONS}
    }
    journal = PackageJournal(args.journal)
    try:
        report = rehearse_package_import(
            sources,
            targets,
            journal,
            batch_id=args.batch or "IMP_" + secrets.token_hex(12),
            resolutions=resolutions,
            attachments_dir=args.attachments_dir,
        )
    except RehearsalError as exc:
        _write_report(exc.report, args.report)
        print(f"演练未通过：{exc}", file=sys.stderr)
        print(f"报告：{args.report}", file=sys.stderr)
        return 1
    finally:
        journal.close()
    _write_report(report, args.report)
    print(f"演练通过，报告：{args.report}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
