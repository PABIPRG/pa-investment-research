# -*- coding: utf-8 -*-
"""演示数据：回灌最近 5 个已结算交易日的影子验证数据（自测/演示专用，非产品功能）。

问题：自进化闭环的影子验证需累积 >= EVOLVE_MIN_DAYS(5) 个交易日的净值才会产生
升级/降级/淘汰等动作；内部演示等不了 5 个交易日，页面长期停在「数据不足」。
本脚本用真实历史行情「假装跑完」这 5 天：逐日 force 重放 ShadowRunner 引擎，
重建最近 5 个已结算交易日的 shadow_equity 净值序列（每 active 策略都有连续 5 天），
再跑一次 evolution.evolve_auto —— 若真实 NAV 越过阈值（promote>=1.03 / demote<=0.95
/ retire<=0.90 等）就真实落动作到 evolution_previews.json，「最近自动进化」时间线即有记录。

约定（非产品功能，全部收敛在本脚本）：
- 不改 schema / API 面 / 前端；不新增 operation；不在 Electron 注册。
- 不改 ShadowRunner 引擎：每天用模块级 `_latest_trade_date` 的临时 patch 让 run() 以
  目标历史日为 trade_date 重放（进程内覆盖，脚本结束即失效）。
- 回灌前先备份 data/adapter/{shadow_equity,shadows,strategies,evolution_previews}.json，
  打印还原命令，可恢复。
- 幂等可重跑：每次先备份再清空重建。

用法（由 scripts/main.sh 的「演示数据」项调用）：
    cd backend/dsh-trading-core && env/Scripts/python.exe _demo_evolution_backfill.py
"""
import io
import os
import shutil
import sys
import time
from datetime import date, datetime, timedelta

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from adapter.config import settings  # noqa: E402
from adapter.store import JsonStore  # noqa: E402

WINDOW_SIZE = 5  # 演示窗口：最近 5 个交易日
_REF_FETCH_SYMBOLS = 6  # 结算日探测最多取的 symbol 数（不重复拉同一只）


def _progress(msg: str) -> None:
    print(f"    {msg}", flush=True)


def _active_strategies(store: JsonStore) -> dict:
    raw = store.all("strategies") or {}
    return {
        sid: s for sid, s in raw.items()
        if isinstance(s, dict) and s.get("status") == "active"
    }


def _calendar_trade_dates(upto: str) -> list:
    """akshare 交易日历 ≤ upto，升序。失败抛清晰错误。"""
    import akshare as ak

    try:
        cal = ak.tool_trade_date_hist_sina()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"akshare 交易日历拉取失败（网络？）：{type(exc).__name__}: {exc}")
    return [d for d in cal["trade_date"].astype(str).tolist() if d <= upto]


def _settled_anchor(symbols: list, cap: str) -> str:
    """最近一个真正有 bar 的交易日（≤ cap），探测若干 symbol 的真实末 bar 反推。

    避开「当日是交易日但 baostock 还没出 bar」导致末位快照变重复平线。
    全失败时退回日历 cap（后续重放自会 mark-to-market 到最近 bar）。
    """
    from adapter.holdings_runner import _a_share_code, _bs_hist

    cap_dt = datetime.strptime(cap, "%Y-%m-%d")
    start = (cap_dt - timedelta(days=25)).strftime("%Y-%m-%d")
    last_dates: list[str] = []
    seen: set[str] = set()
    for sym in symbols:
        if sym in seen or len(last_dates) >= _REF_FETCH_SYMBOLS:
            continue
        seen.add(sym)
        try:
            rows = _bs_hist(_a_share_code(sym), start, cap, fields="date,close")
        except Exception:  # noqa: BLE001 — 探测失败换下一个 symbol
            continue
        if rows:
            last_dates.append(rows[-1]["date"])
    if not last_dates:
        return cap
    return max(last_dates)


def _backup(store: JsonStore) -> tuple:
    base = store.base_dir
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = base / "_backup_evolution_demo" / ts
    dst.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in ("shadow_equity", "shadows", "strategies", "evolution_previews"):
        src = base / f"{name}.json"
        if src.exists():
            shutil.copy2(src, dst / f"{name}.json")
            copied.append(f"{name}.json")
    return dst, copied


def _clear_shadow_collections(store: JsonStore) -> None:
    store.mutate_document("shadow_equity", lambda _: {})
    store.mutate_document("shadows", lambda _: {})


def _dedupe_trades(store: JsonStore, actives: dict) -> int:
    """逐日重放会在每个 run 追加「track_from 以来全部平仓」，末尾去重避免台账重复。"""
    removed = 0
    for sid in actives:
        rows = store.get("shadows", f"trades:{sid}") or []
        if not rows:
            continue
        seen: set = set()
        uniq: list = []
        for t in rows:
            if not isinstance(t, dict):
                removed += 1
                continue
            key = (t.get("symbol"), t.get("entry_date"), t.get("exit_date"))
            if key in seen:
                removed += 1
                continue
            seen.add(key)
            uniq.append(t)
        if len(uniq) != len(rows):
            store.set("shadows", f"trades:{sid}", uniq)
    return removed


def _run_evolution(store: JsonStore) -> dict:
    from adapter import evolution

    return evolution.evolve_auto(store)


def main() -> int:
    print("=" * 72)
    print("演示数据：回灌最近 5 个已结算交易日的影子验证数据（真实行情重放）")
    print("=" * 72)

    store = JsonStore()
    actives = _active_strategies(store)
    if not actives:
        print("[中止] 当前没有 status=active 的策略（先回测激活几个再演示）。")
        return 1

    # 各 active 策略的 symbol 去重列表（探测结算日用；太多只取前 N 个不同 symbol）
    syms: list[str] = []
    for s in actives.values():
        for sym in (s.get("symbols") or []):
            if sym not in syms:
                syms.append(sym)

    today = date.today().isoformat()
    cal_today = _calendar_trade_dates(today)
    if not cal_today:
        print("[中止] akshare 未返回 ≤ 今天的交易日。")
        return 1
    anchor = _settled_anchor(syms, cal_today[-1])
    cal = _calendar_trade_dates(anchor)
    window = cal[-WINDOW_SIZE:] if len(cal) >= WINDOW_SIZE else cal
    print(f"当前交易日历（≤{anchor}）末位：{cal[-1] if cal else '-'}；"
          f"回灌窗口：{window[0]} → {window[-1]}（共 {len(window)} 天）")
    if len(window) < WINDOW_SIZE:
        print(f"[警告] 可用结算交易日不足 {WINDOW_SIZE} 天（仅 {len(window)}），继续回灌。")
    if len(syms) < _REF_FETCH_SYMBOLS and window[-1] == today:
        print("[提示] 未能用真实 bar 确认当日已结算；末位若恰为今日，回放止于最近 bar，"
              "末位快照可能与前一交易日相同（可收盘后再跑一次）。")

    # 1) 备份
    backup_dir, copied = _backup(store)
    print(f"[1/4] 已备份 {len(copied)} 个数据文件 → {backup_dir}")
    print(f"      {', '.join(copied)}")
    print(f"      （如需还原：cp {backup_dir}/*.json {store.base_dir}/）")

    # 2) 清空重建 shadow 状态（shadow_equity + shadows 含 meta/pos/trades/latest）
    _clear_shadow_collections(store)
    print(f"[2/4] 已清空 shadow_equity/shadows，将重建最近 {len(window)} 日全 active 净值序列")

    # 3) 逐日真实行情重放（ShadowRunner 引擎，进程内临时 patch 交易日）
    import adapter.shadow as shadow_mod

    runner = shadow_mod.ShadowRunner(store)
    t0 = time.time()
    rows: list[dict] = []
    for d in window:
        shadow_mod._latest_trade_date = (lambda day: lambda: day)(d)
        try:
            res = runner.run({"force": True}, _progress)
        except Exception as exc:  # noqa: BLE001
            print(f"[错误] {d} 重放失败：{type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        rows.append(res)
        ok = len([s for s in (res.get("strategies") or {}).values() if s.get("nav")])
        print(f"   → {d} overall_nav={res.get('overall_nav')} "
              f"策略={res.get('signal', {}).get('strategy_count')}（有净值 {ok}）"
              f" 耗时 {time.time() - t0:.1f}s")
    # 末尾台账去重（逐日 run 会重复追加 track_from 以来的全部平仓）
    dup = _dedupe_trades(store, actives)
    if dup:
        print(f"[3/4] 已去重平仓台账 {dup} 条重复记录（由逐日重放追加造成）")
    else:
        print(f"[3/4] 逐日重放完成，平仓台账无重复")
    print(f"      累计耗时 {time.time() - t0:.1f}s")

    # 4) 跑一次全自动进化（数据就绪则 preview→apply 落库；无越界则留空只读）
    try:
        evo = _run_evolution(store)
    except Exception as exc:  # noqa: BLE001
        print(f"[4/4][警告] evolve_auto 失败（数据已回灌，可稍后手动触发）："
              f"{type(exc).__name__}: {exc}", file=sys.stderr)
        evo = None
    else:
        status = evo.get("status")
        applied = evo.get("applied")
        acts = evo.get("actions") or []
        print(f"[4/4] evolve_auto → status={status} applied={applied} 动作数={len(acts)}")
        if applied and acts:
            for a in acts:
                print(f"      · {a.get('strategy_id')} → {a.get('type')}（{a.get('reason')}）")
        elif status == "waiting_data":
            print(f"      {evo.get('data_note')}")

    # 汇总：末次快照各策略 NAV
    print("-" * 72)
    last_snap = store.get("shadow_equity", window[-1]) or {}
    print(f"末次快照 {window[-1]}：overall_nav={last_snap.get('overall_nav')}，"
          f"as_of={last_snap.get('as_of')}")
    strats = last_snap.get("strategies") or {}
    for sid in sorted(strats):
        s = strats[sid]
        nav = s.get("nav")
        nav = f"{nav:.4f}" if isinstance(nav, (int, float)) else nav
        err = s.get("symbol_errors") or {}
        note = f"（{len(err)} 个 symbol 拉数失败）" if err else ""
        print(f"  {sid[:16]:<18s} {s.get('kind', ''):10s} nav={nav}  equity={s.get('equity')} "
              f"平仓={s.get('closed_count')}{note}")
    n_days = len(store.all("shadow_equity") or {})
    print("-" * 72)
    print(f"shadow_equity 现有 {n_days} 个交易日快照（最近 {len(window)} 日已重建）。")
    print("接下来：打开自进化页面查看数据完成度/策略判定；如要还原回灌前状态，执行")
    print(f"    cp {backup_dir}/*.json {store.base_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
