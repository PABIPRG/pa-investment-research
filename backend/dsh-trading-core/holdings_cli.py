# -*- coding: utf-8 -*-
"""持仓 CLI：券商持仓的命令行入口（发现 / 检查 / 拉取 / 同步 / 分析）。

五个子命令，覆盖「接入券商持仓」的完整闭环：

  detect   扫描本机已装券商客户端（同花顺内核 80+ 家 / 通达信内核 60+ 家），
           自动识别券商并生成 .env 建议；--list 列出全部支持券商
  check    环境自检：依赖、配置、客户端进程、数据源可用性
  fetch    从数据源拉取持仓并打印（不落盘）
  sync     拉取持仓并写入本地 store（data/adapter/holdings.json），
           之后 HOLDINGS_PROVIDER 可保持 manual，由产品直接使用
  analyze  拉取持仓并调用本地 /holdings/analyze 触发组合风险分析

用法（在 backend/dsh-trading-core 下）：
  env\\Scripts\\python.exe holdings_cli.py detect
  env\\Scripts\\python.exe holdings_cli.py check
  env\\Scripts\\python.exe holdings_cli.py fetch
  env\\Scripts\\python.exe holdings_cli.py sync
  env\\Scripts\\python.exe holdings_cli.py analyze --mode quick

数据源选择（优先级）：--provider 参数 > HOLDINGS_PROVIDER 环境变量（默认 manual）。
easytrader 数据源需先配置 .env（detect 会自动生成建议）：
  EASYTRADER_BROKER=pingan           # 券商档案 id，见 detect --list
  EASYTRADER_CLIENT_PATH=C:\\平安证券\\同花顺版\\xiadan.exe
且券商客户端已启动并登录。详见 docs/券商接入方案.md。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

# Windows 控制台中文输出
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

TC_BASE = "http://127.0.0.1:8000"


def _pick_provider(args_provider: str | None):
    from adapter.config import settings
    from adapter.holdings_providers import get_provider

    if args_provider:
        settings.holdings_provider = args_provider
    return get_provider()


def cmd_check(args: argparse.Namespace) -> int:
    """逐项自检，打印每一项的通过/失败与修复提示。"""
    from adapter.config import settings

    print("=" * 62)
    print("持仓数据源自检")
    print("=" * 62)

    ok = True

    # 1. 当前配置
    effective = (args.provider or settings.holdings_provider).lower()
    print(f"[1] HOLDINGS_PROVIDER   = {settings.holdings_provider}"
          + (f"（--provider 覆盖为 {effective}）" if args.provider else ""))
    if effective == "easytrader":
        print(f"    EASYTRADER_BROKER      = {getattr(settings, 'easytrader_broker', '') or '(未设置)'}")
        print(f"    EASYTRADER_CLIENT_TYPE = {settings.easytrader_client_type or '(未设置)'}")
        print(f"    EASYTRADER_CLIENT_PATH = {settings.easytrader_client_path or '(未设置)'}")

    # 2. 依赖
    try:
        import easytrader  # noqa: F401

        print("[2] easytrader 依赖     : 已安装")
    except ImportError:
        print("[2] easytrader 依赖     : ✗ 未安装")
        print("    修复: env\\Scripts\\python.exe -m pip install easytrader pywinauto")
        ok = False

    # 3. 客户端进程 + 档案
    if effective == "easytrader":
        from adapter.holdings_providers.easytrader import EasyTraderProvider

        provider = EasyTraderProvider()
        if provider.profile is None:
            print(f"[3] 券商档案            : ✗ {provider._profile_error}")
            ok = False
        else:
            print(f"[3] 券商档案            : {provider.profile.label}（{provider.profile.trader_type}）")
            if provider._client_running():
                print("[4] 客户端进程          : 运行中")
            else:
                print("[4] 客户端进程          : ✗ 未检测到，请先启动并登录券商客户端")
                ok = False

    # 5. 数据源可用性 + 试拉
    try:
        provider = _pick_provider(args.provider)
        print(f"[5] 数据源实例化        : OK（{provider.name}）")
        if provider.is_available():
            print("[6] is_available        : OK")
            holdings = provider.get_holdings()
            print(f"[7] get_holdings        : OK，{len(holdings)} 条持仓")
            for h in holdings:
                print(f"      {h.ticker}  {h.quantity:>10.0f} 股  成本 {h.cost_price}")
            if not holdings:
                print("      （空仓也是合法状态）")
        else:
            print("[6] is_available        : ✗ False（依赖/配置/客户端未就绪）")
            ok = False
    except Exception as exc:
        print(f"[6] 数据源调用          : ✗ {exc}")
        ok = False

    print("=" * 62)
    print("结论: " + ("全部通过 ✓" if ok else "存在未就绪项，按上面提示修复"))
    return 0 if ok else 1


def cmd_detect(args: argparse.Namespace) -> int:
    """扫描本机已安装的券商客户端，或列出全部支持券商。"""
    from adapter.holdings_providers.broker_profiles import (
        describe_supported,
        discover_clients,
        suggest_env,
    )

    if args.list:
        print(describe_supported())
        return 0

    print("正在扫描本机券商客户端（默认 C~H 盘，深度 4）… 首次扫描可能需要十几秒")
    found = discover_clients(roots=args.roots)
    if not found:
        print("\n未发现券商客户端。")
        print("- 若已安装，可扩大扫描: python holdings_cli.py detect --roots D:\\ E:\\")
        print("- 同花顺通用版内置 80+ 券商账号登录，安装它即可覆盖大多数券商")
        return 1

    print(f"\n发现 {len(found)} 个客户端：")
    print("-" * 72)
    for i, c in enumerate(found, 1):
        state = "运行中" if c.running else "未运行"
        ident = c.profile.label if c.matched else f"{c.profile.label}（未识别具体券商）"
        print(f"[{i}] {ident}  [{state}]")
        print(f"    内核: {c.profile.kernel}  下单程序: {c.exe_path}")
        if i == 1 and not args.all:
            print("\n推荐 .env 配置（粘贴到 backend/dsh-trading-core/.env）：")
            print("  " + suggest_env(c).replace("\n", "\n  "))
    if args.all:
        print("\n全部 .env 配置建议：")
        for c in found:
            print(f"  # {c.profile.label}")
            print("  " + suggest_env(c).replace("\n", "\n  "))
    print("-" * 72)
    print("下一步: 配好 .env 后运行 python holdings_cli.py check 验证链路。")
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    """拉取持仓并打印，不写任何文件。"""
    provider = _pick_provider(args.provider)
    print(f"数据源: {provider.name}，正在拉取持仓…")
    holdings = provider.get_holdings()
    payload = [h.model_dump() for h in holdings]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"共 {len(holdings)} 条持仓")
        print(f"{'代码':<8}{'数量(股)':>12}{'成本价':>12}")
        for h in holdings:
            print(f"{h.ticker:<8}{h.quantity:>12.0f}{h.cost_price:>12.2f}")
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    """拉取持仓并写入本地 store（等价于 POST /holdings/save 的效果）。"""
    from adapter.holdings_providers.manual import ManualProvider

    provider = _pick_provider(args.provider)
    print(f"数据源: {provider.name}，正在拉取持仓…")
    holdings = provider.get_holdings()

    manual = ManualProvider()
    saved = manual.save(holdings)
    print(f"已同步 {saved} 条持仓到本地 store（data/adapter/holdings.json）")
    print("产品侧（GET /holdings、POST /holdings/analyze）现在可以直接使用。")
    for h in holdings:
        print(f"  {h.ticker}  {h.quantity:.0f} 股  成本 {h.cost_price}")
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    """拉取持仓 → 调本地 trading-core API 触发组合风险分析。"""
    provider = _pick_provider(args.provider)
    print(f"数据源: {provider.name}，正在拉取持仓…")
    holdings = provider.get_holdings()
    print(f"拉到 {len(holdings)} 条持仓，触发分析（mode={args.mode}）…")

    body = {
        "holdings": [h.model_dump() for h in holdings],
        "mode": args.mode,
        "use_saved": False,
    }
    req = urllib.request.Request(
        f"{TC_BASE}/holdings/analyze",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            task = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        print(f"✗ 无法连接 trading-core（{TC_BASE}）: {exc}")
        print("  修复: 先启动服务 start_all.bat engine，或 product\\start.bat")
        return 1

    task_id = task.get("task_id", "")
    print(f"任务已创建 task_id={task_id}，等待完成…")
    import time

    for _ in range(120):  # quick 秒级，deep 每股要过引擎，最多等 2 分钟
        time.sleep(2)
        with urllib.request.urlopen(f"{TC_BASE}/analyze/{task_id}", timeout=10) as resp:
            status = json.loads(resp.read().decode("utf-8"))
        if status.get("status") in ("done", "failed"):
            break
    if status.get("status") == "failed":
        print(f"✗ 分析失败: {status.get('error')}")
        return 1
    if status.get("status") != "done":
        print("✗ 分析超时未完成，可稍后用 task_id 查询")
        return 1

    with urllib.request.urlopen(f"{TC_BASE}/analyze/{task_id}/result", timeout=15) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    portfolio = (result.get("reports") or {}).get("portfolio") or {}
    print(json.dumps(portfolio, ensure_ascii=False, indent=2)[:3000])
    print("…（完整结果含逐股明细，可查看任务结果接口）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="券商持仓 CLI（check/fetch/sync/analyze）")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--provider",
            choices=["manual", "easytrader", "qmt"],
            default=None,
            help="数据源（默认取 HOLDINGS_PROVIDER 环境变量）",
        )

    p_check = sub.add_parser("check", help="环境自检：依赖/配置/客户端/数据源")
    p_check.add_argument("--provider", choices=["manual", "easytrader", "qmt"], default=None)
    p_check.set_defaults(func=cmd_check)

    p_detect = sub.add_parser("detect", help="扫描本机已装券商客户端 / 列出全部支持券商")
    p_detect.add_argument("--list", action="store_true", help="只列出全部支持券商档案，不扫描")
    p_detect.add_argument("--all", action="store_true", help="打印每个发现客户端的 .env 建议")
    p_detect.add_argument("--roots", nargs="*", default=None, help="自定义扫描根目录（默认 C~H 盘）")
    p_detect.set_defaults(func=cmd_detect)

    p_fetch = sub.add_parser("fetch", help="拉取持仓并打印（不落盘）")
    add_common(p_fetch)
    p_fetch.add_argument("--json", action="store_true", help="以 JSON 输出")
    p_fetch.set_defaults(func=cmd_fetch)

    p_sync = sub.add_parser("sync", help="拉取持仓并写入本地 store")
    add_common(p_sync)
    p_sync.set_defaults(func=cmd_sync)

    p_ana = sub.add_parser("analyze", help="拉取持仓并触发组合风险分析")
    add_common(p_ana)
    p_ana.add_argument("--mode", choices=["quick", "deep"], default="quick")
    p_ana.set_defaults(func=cmd_analyze)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
