# -*- coding: utf-8 -*-
"""券商数据 CLI：持仓与成交明细的命令行入口。

子命令，覆盖「接入券商数据」的完整闭环：

  detect        扫描本机已装券商客户端（同花顺内核 80+ 家 / 通达信内核 60+ 家），
                自动识别券商并生成 .env 建议；--list 列出全部支持券商
  check         环境自检：依赖、配置、客户端进程、数据源可用性
  fetch         从数据源拉取持仓并打印（不落盘）
  sync          拉取持仓并写入本地 store（data/adapter/holdings.json），
                之后 HOLDINGS_PROVIDER 可保持 manual，由产品直接使用
  analyze       拉取持仓并调用本地 /holdings/analyze 触发组合风险分析
  trades        读取成交明细并打印（不落盘）
  trades-sync   读取成交明细并**去重合并**进本地 store
  trades-profile 打印本地成交明细的指标（频率/集中度/覆盖度），不读客户端
  trades-clear  清空本地成交明细（需 --yes）

用法（在 backend/dsh-trading-core 下）：
  env\\Scripts\\python.exe holdings_cli.py detect
  env\\Scripts\\python.exe holdings_cli.py check
  env\\Scripts\\python.exe holdings_cli.py fetch
  env\\Scripts\\python.exe holdings_cli.py sync
  env\\Scripts\\python.exe holdings_cli.py analyze --mode quick
  env\\Scripts\\python.exe holdings_cli.py trades --json
  env\\Scripts\\python.exe holdings_cli.py trades-profile

数据源选择（优先级）：--provider 参数 > HOLDINGS_PROVIDER 环境变量（默认 manual）。
easytrader 数据源需先配置 .env（detect 会自动生成建议）：
  EASYTRADER_BROKER=pingan           # 券商档案 id，见 detect --list
  EASYTRADER_CLIENT_PATH=C:\\平安证券\\同花顺版\\xiadan.exe
且券商客户端已启动并登录。详见 docs/券商接入方案.md。

**trades / trades-sync 只能被动读表，因此 Windows 上必然失败**：取成交表要走
「Ctrl+S 另存为」，那会抢前台并可能弹风控验证码，只有经宿主认证的桌面端入口
能触发（见 adapter/holdings_providers/_ths_export.py 开头的实测记录）。这两个
命令在 macOS 上可用（AX 被动遍历），前提是客户端已停在该账户的「历史成交」页。
Windows 上请在桌面端用「同步成交明细」。trades-profile / trades-clear 只动本地
数据，任何平台都能用。

另外，银河 / 华泰 / 五矿 / 海通 / 国金 / 广发这六家的**专用客户端**内核没有同花顺
那套「查询 → 历史成交」左树，本期未接入，read_trades 会直接拒绝——同是
EASYTRADER_PROVIDER=easytrader，能读持仓不代表能读成交。详见
docs/券商接入方案.md §成交明细导入。
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


def _print_trades(items, *, as_json: bool) -> None:
    """成交明细的表格输出。非买卖流水单独标出——它们计入笔数但不计入买卖比。"""
    if as_json:
        print(json.dumps([item.model_dump() for item in items], ensure_ascii=False, indent=2))
        return
    print(f"共 {len(items)} 笔成交")
    print(f"{'成交时间':<21}{'代码':<8}{'名称':<14}{'方向':<12}{'价格':>10}{'数量':>10}{'金额':>12}")
    for item in items:
        side = item.side_label or item.side
        print(f"{item.traded_at:<21}{item.ticker:<8}{item.name:<14}{side:<12}"
              f"{item.price:>10.3f}{item.quantity:>10.0f}{item.amount:>12.2f}")
    unclassified = sum(1 for item in items if item.side == "unclassified")
    if unclassified:
        print(f"其中 {unclassified} 笔是非买卖流水（红股派息/申购等），已如实保留。")


def cmd_trades(args: argparse.Namespace) -> int:
    """读取成交明细并打印，不写任何文件。

    只能被动读表：需要前台的取数路径（Windows 另存为）在命令行里拿不到，
    客户端会以 navigation_required 拒绝，这里把它的提示原样透出。
    """
    from adapter.holdings_providers.base import ProviderUnavailable

    provider = _pick_provider(args.provider)
    print(f"数据源: {provider.name}，正在读取成交明细…")
    try:
        items = provider.get_trades()
    except ProviderUnavailable as exc:
        print(f"✗ {exc}")
        return 1
    _print_trades(items, as_json=args.json)
    return 0


def cmd_trades_sync(args: argparse.Namespace) -> int:
    """读取成交明细并去重合并进本地 store。

    走与产品完全相同的 preview → commit 路径，而不是直接调 trades_store：
    只留一条提交路径，CLI 与界面就不会在「哪些算重复」上产生分歧。
    """
    from adapter import trades_source
    from adapter.holdings_providers.base import ProviderUnavailable
    from adapter.trades_source import EmptyTradesError

    print("正在读取成交明细…")
    try:
        preview = trades_source.preview_trades()
    except (ProviderUnavailable, EmptyTradesError) as exc:
        print(f"✗ {exc}")
        return 1
    print(f"读到 {len(preview['items'])} 笔（本地已有 {preview['previous_count']} 笔）。")
    try:
        result = trades_source.commit_trades(preview["preview_token"])
    except Exception as exc:  # noqa: BLE001 — 冲突/过期都归一句可照做的提示
        print(f"✗ 导入未完成: {exc}")
        return 1
    total = preview["previous_count"] + result["added"]
    print(f"✓ 新增 {result['added']} 笔，重复 {result['duplicates']} 笔（本地合计 {total} 笔）")
    if result["unclassified"]:
        print(f"  其中 {result['unclassified']} 笔是非买卖流水，已如实保留。")
    if result["conflicts"]:
        print(f"  ⚠ {len(result['conflicts'])} 笔键相同但内容不同，已保留原有条目：")
        for conflict in result["conflicts"][:5]:
            print(f"    {conflict['key']} 变化字段: {'、'.join(conflict['changed_fields'])}")
    return 0


def cmd_trades_profile(args: argparse.Namespace) -> int:
    """打印本地成交明细的指标，不读客户端。"""
    from adapter.store import JsonStore
    from adapter.trade_profile import build_profile
    from adapter.trades_store import load_document
    from adapter.schemas import TradeItem

    document = load_document(JsonStore())
    entries = [TradeItem.model_validate(row) for row in document["entries"]]
    if not entries:
        print("本地还没有成交明细。先在桌面端「同步成交明细」，或运行 trades-sync。")
        return 1
    profile = build_profile(entries, document["imports"])
    if args.json:
        print(json.dumps(profile, ensure_ascii=False, indent=2))
        return 0

    frequency = profile["frequency"]
    print(f"成交 {frequency['trades']} 笔，覆盖 {frequency['active_days']} 个交易日"
          f"（买 {frequency['buy_count']} / 卖 {frequency['sell_count']}"
          f" / 其他 {frequency['unclassified_count']}）")
    concentration = profile["concentration"]
    print(f"成交额合计 {concentration['amount_total']:.2f} 元，"
          f"涉及 {concentration['tickers']} 只股票，HHI {concentration['hhi']:.4f}")
    for row in concentration["items"][:10]:
        share = f"{row['share'] * 100:.2f}%" if row["share"] is not None else "—"
        print(f"  {row['ticker']}  {row['name'][:10]:<12}{row['amount']:>14.2f}  {share:>8}")
    coverage = profile["coverage"]
    print(f"覆盖 {coverage['start']} ~ {coverage['end']}"
          f"（{coverage['span_days']} 天，有成交 {coverage['active_days']} 天）"
          f" 状态: {coverage['status']}")
    if coverage["note"]:
        print(f"  {coverage['note']}")
    for gap in coverage["uncovered"]:
        print(f"  未被任何一次读取覆盖: {gap['start']} ~ {gap['end']}")
    for caveat in profile["caveats"]:
        print(f"· {caveat}")
    return 0


def cmd_trades_clear(args: argparse.Namespace) -> int:
    """清空本地成交明细；需要 --yes 显式确认。"""
    from adapter.trades_source import EmptyTradesError
    from adapter import trades_source

    try:
        preview = trades_source.preview_clear()
    except EmptyTradesError as exc:
        print(f"✗ {exc}")
        return 1
    if not args.yes:
        print(f"将删除本地 {preview['will_remove']} 笔成交明细"
              f"（最后一次导入: {preview['last_import_at'] or '无'}）。")
        print("确认请重新运行并加 --yes。")
        return 1
    result = trades_source.commit_trades(preview["preview_token"])
    print(f"✓ 已清空 {result['removed']} 笔成交明细（导入记录保留，便于追溯）。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="券商数据 CLI（check/detect/fetch/sync/analyze/trades/trades-sync/trades-profile/trades-clear）"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # 必须与 holdings_providers.get_provider 支持的名字一致：这里漏一个名字，
    # 用户就没法用 --provider 选中它（mac_ths 曾因为漏登记而只能靠 .env）。
    providers = ["manual", "easytrader", "mac_ths", "qmt", "joinquant"]

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--provider",
            choices=providers,
            default=None,
            help="数据源（默认取 HOLDINGS_PROVIDER 环境变量）",
        )

    p_check = sub.add_parser("check", help="环境自检：依赖/配置/客户端/数据源")
    p_check.add_argument("--provider", choices=providers, default=None)
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

    p_trades = sub.add_parser("trades", help="读取成交明细并打印（不落盘）")
    add_common(p_trades)
    p_trades.add_argument("--json", action="store_true", help="以 JSON 输出")
    p_trades.set_defaults(func=cmd_trades)

    p_tsync = sub.add_parser("trades-sync", help="读取成交明细并去重合并进本地 store")
    add_common(p_tsync)
    p_tsync.set_defaults(func=cmd_trades_sync)

    p_tprof = sub.add_parser("trades-profile", help="打印本地成交明细的指标（不读客户端）")
    p_tprof.add_argument("--json", action="store_true", help="以 JSON 输出")
    p_tprof.set_defaults(func=cmd_trades_profile)

    p_tclear = sub.add_parser("trades-clear", help="清空本地成交明细（需 --yes）")
    p_tclear.add_argument("--yes", action="store_true", help="确认执行删除")
    p_tclear.set_defaults(func=cmd_trades_clear)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
