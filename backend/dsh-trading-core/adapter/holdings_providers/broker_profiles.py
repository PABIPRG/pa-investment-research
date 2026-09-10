# -*- coding: utf-8 -*-
"""券商客户端 profile 注册表与本机自动发现。

国内券商 PC 交易客户端绝大多数是「贴牌」生态：不自研内核，而是采购
同花顺等厂商的客户端定制。因此按「内核」适配一次，即可覆盖一大批券商。

easytrader 0.23.7 实际支持的交易器（easytrader/api.py use()）：
  ths              同花顺内核贴牌客户端（xiadan.exe），覆盖 80+ 家券商
  universal_client 同花顺通用客户端（内置 80+ 券商账号登录，装一个覆盖大多数）
  yh_client        银河证券专用客户端
  ht_client        华泰证券专用客户端
  wk_client        五矿证券专用客户端
  htzq_client      海通证券专用客户端
  gj_client        国金证券专用客户端
  gf_client        广发证券专用客户端
  miniqmt          迅投 miniQMT（走 xtquant，见 qmt.py，另需券商开通）
  xq               雪球模拟盘
  ⚠ 通达信客户端交易器已从 0.23.x 移除，通达信内核用户请用同花顺版客户端

本模块提供：
  THS_BROKERS / CLIENT_BROKERS  贴牌券商注册表（broker_id → 展示名/目录线索）
  discover_clients()            扫描本机，找出已安装的券商客户端及下单程序路径
  resolve_profile()             按 broker_id 解析 profile（供 Provider/CLI 使用）

券商名单说明：dir_hints 是安装目录名的常见关键词，用于把找到的
xiadan.exe 归属到具体券商；匹配不到时归入通用档（同样可用）。
名单按公开渠道整理，遗漏/更名直接在表尾追加一行即可。
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------- profile

@dataclass(frozen=True)
class BrokerProfile:
    """单个券商客户端的接入档案。"""

    broker_id: str              # EASYTRADER_BROKER 用的 id（小写/下划线）
    label: str                  # 展示名
    kernel: str                 # ths | client
    trader_type: str            # easytrader.use() 参数
    dir_hints: tuple[str, ...]  # 安装目录名关键词（本机发现用）
    processes: tuple[str, ...]  # 运行检测的进程名
    note: str = ""              # 备注（如「需同花顺版客户端」）


def _ths(broker_id: str, label: str, hints: tuple[str, ...], note: str = "") -> BrokerProfile:
    """同花顺内核贴牌券商：easytrader 交易器 'ths'，下单程序恒为 xiadan.exe。"""
    return BrokerProfile(
        broker_id=broker_id,
        label=label,
        kernel="ths",
        trader_type="ths",
        dir_hints=hints,
        processes=("xiadan.exe", "hexin.exe"),
        note=note,
    )


def _client(broker_id: str, label: str, trader_type: str, hints: tuple[str, ...],
            note: str = "") -> BrokerProfile:
    """券商专用客户端条目（easytrader 的 *_client 交易器）。"""
    return BrokerProfile(
        broker_id=broker_id,
        label=label,
        kernel="client",
        trader_type=trader_type,
        dir_hints=hints,
        processes=("xiadan.exe",),
        note=note,
    )


# 同花顺内核贴牌券商（公开渠道整理，按拼音序；遗漏直接追加）
THS_BROKERS: list[BrokerProfile] = [
    _ths("caida", "财达证券", ("财达证券",)),
    _ths("caitong", "财通证券", ("财通证券",)),
    _ths("changcheng", "长城证券", ("长城证券",)),
    _ths("changjiang", "长江证券", ("长江证券",)),
    _ths("chengtong", "诚通证券（原新时代）", ("新时代证券", "诚通证券")),
    _ths("chuancai", "川财证券", ("川财证券",)),
    _ths("datong", "大同证券", ("大同证券",)),
    _ths("debang", "德邦证券", ("德邦证券",)),
    _ths("diyichuangye", "第一创业证券", ("第一创业", "一创证券")),
    _ths("dongbei", "东北证券", ("东北证券",)),
    _ths("donghai", "东海证券", ("东海证券",)),
    _ths("dongwu", "东吴证券", ("东吴证券",)),
    _ths("dongxing", "东兴证券", ("东兴证券",)),
    _ths("founder", "方正证券", ("方正证券",)),
    _ths("guodu", "国都证券", ("国都证券",)),
    _ths("guohai", "国海证券", ("国海证券",)),
    _ths("guojin", "国金证券（同花顺版）", ("国金证券",), "国金专用客户端见 guojin_client"),
    _ths("guorong", "国融证券", ("国融证券",)),
    _ths("guosheng", "国盛证券", ("国盛证券",)),
    _ths("guotou_anxin", "国投证券（原安信）", ("安信证券", "国投证券")),
    _ths("guoxin_new", "国新证券（原华融）", ("华融证券", "国新证券")),
    _ths("guoyuan", "国元证券", ("国元证券",)),
    _ths("hengtai", "恒泰证券", ("恒泰证券",)),
    _ths("hongta", "红塔证券", ("红塔证券",)),
    _ths("huaan", "华安证券", ("华安证券",)),
    _ths("huabao", "华宝证券", ("华宝证券",)),
    _ths("huachuang", "华创证券", ("华创证券",)),
    _ths("huafu", "华福证券", ("华福证券",)),
    _ths("hualin", "华林证券", ("华林证券",)),
    _ths("hualong", "华龙证券", ("华龙证券",)),
    _ths("huaxi", "华西证券", ("华西证券",)),
    _ths("huaxin", "华鑫证券", ("华鑫证券",)),
    _ths("jianghai", "江海证券", ("江海证券",)),
    _ths("jiuzhou", "九州证券", ("九州证券",)),
    _ths("jinyuan", "金元证券", ("金元证券",)),
    _ths("kaiyuan", "开源证券", ("开源证券",)),
    _ths("lianchu", "联储证券", ("联储证券",)),
    _ths("lianmin", "国联民生证券", ("国联证券", "民生证券", "国联民生")),
    _ths("nanjing", "南京证券", ("南京证券",)),
    _ths("pingan", "平安证券（同花顺版）", ("平安证券",), "下载「平安证券同花顺版」，下单程序 xiadan.exe"),
    _ths("ruyin", "瑞银证券", ("瑞银证券",), "部分版本为自研，视客户端而定"),
    _ths("shanxi", "山西证券", ("山西证券",)),
    _ths("shenwan", "申万宏源（同花顺版）", ("申万宏源", "宏源证券")),
    _ths("shengang", "申港证券", ("申港证券",)),
    _ths("shiji", "世纪证券", ("世纪证券",)),
    _ths("shouchuang", "首创证券", ("首创证券",)),
    _ths("taipingyang", "太平洋证券", ("太平洋证券",)),
    _ths("wanlian", "万联证券", ("万联证券",)),
    _ths("xiangcai", "湘财证券", ("湘财证券",)),
    _ths("xingye", "兴业证券", ("兴业证券",)),
    _ths("xibu", "西部证券", ("西部证券",)),
    _ths("caixin", "财信证券", ("财富证券", "财信证券")),
    _ths("yinhe", "中国银河证券（同花顺版）", ("银河证券", "中国银河"), "银河专用客户端见 yinhe_client"),
    _ths("yintai", "银泰证券", ("银泰证券",)),
    _ths("yingda", "英大证券", ("英大证券",)),
    _ths("yongxing", "甬兴证券", ("甬兴证券",)),
    _ths("zhaoshang", "招商证券（同花顺版）", ("招商证券",), "智远一户通为自研，此处指同花顺版"),
    _ths("zheshang", "浙商证券", ("浙商证券",)),
    _ths("zhonghang", "中航证券", ("中航证券",)),
    _ths("zhongjin_fortune", "中金财富", ("中金财富", "中国中金财富")),
    _ths("zhongshan", "中山证券", ("中山证券",)),
    _ths("zhongxin_jiantou", "中信建投（同花顺版）", ("中信建投",)),
    _ths("zhongtai", "中泰证券（原齐鲁）", ("中泰证券", "齐鲁证券")),
    _ths("zhongtian_guofu", "中天国富证券", ("中天国富",)),
    _ths("zhongyin", "中银证券", ("中银国际证券", "中银证券")),
    _ths("zhongyou", "中邮证券", ("中邮证券",)),
    _ths("zhongyuan", "中原证券", ("中原证券",)),
]

# easytrader 提供专用交易器的券商客户端（连接其主程序，同花顺版之外的选择）
CLIENT_BROKERS: list[BrokerProfile] = [
    _client("yinhe_client", "中国银河证券（专用客户端）", "yh_client", ("中国银河", "银河证券双户",)),
    _client("huatai_client", "华泰证券（专用客户端）", "ht_client", ("华泰证券",), "涨乐财富通为手机端"),
    _client("wukuang_client", "五矿证券（专用客户端）", "wk_client", ("五矿证券",)),
    _client("haitong_client", "海通证券（专用客户端）", "htzq_client", ("海通证券",)),
    _client("guojin_client", "国金证券（专用客户端）", "gj_client", ("国金证券",)),
    _client("guangfa_client", "广发证券（专用客户端）", "gf_client", ("广发证券",)),
]

# 通用档：匹配不到具体券商时兜底（同样可用）
GENERIC_THS = BrokerProfile(
    broker_id="ths",
    label="同花顺（通用版/未识别券商）",
    kernel="ths",
    trader_type="universal_client",
    dir_hints=("同花顺软件", "同花顺", "hexin"),
    processes=("xiadan.exe", "hexin.exe"),
    note="通用版内置 80+ 券商账号登录，装一个即可覆盖大多数券商",
)
GENERIC_FALLBACK = BrokerProfile(
    broker_id="ths_fallback",
    label="未识别券商（同花顺内核）",
    kernel="ths",
    trader_type="ths",
    dir_hints=(),
    processes=("xiadan.exe",),
    note="目录名未匹配任何券商档案，按同花顺内核连接",
)

ALL_BROKERS: list[BrokerProfile] = THS_BROKERS + CLIENT_BROKERS + [GENERIC_THS, GENERIC_FALLBACK]

_PROFILE_INDEX: dict[str, BrokerProfile] = {p.broker_id: p for p in ALL_BROKERS}


def resolve_profile(broker_id: str) -> BrokerProfile | None:
    """按 broker_id 解析 profile；未知 id 返回 None。"""
    return _PROFILE_INDEX.get(broker_id.strip().lower())


# ---------------------------------------------------------------- 本机发现

@dataclass
class DiscoveredClient:
    """在本机发现的一个券商客户端。"""

    profile: BrokerProfile
    exe_path: Path            # 下单/主程序路径（连接用）
    main_dir: Path            # 客户端安装目录
    running: bool = False     # 进程是否在运行（discover 时顺带检测）
    matched: bool = True      # False = 未识别具体券商，落在通用/兜底档


# 扫描跳过的目录（无关/超大/权限问题）
_SKIP_DIRS = {
    "windows", "$recycle.bin", "system volume information", "appdata",
    "node_modules", ".git", "programdata", "recovery", "perflogs",
    "users", "python311", "python312", "anaconda3", "miniconda3",
}


def _running_processes() -> set[str]:
    """一次性抓取当前全部进程名（小写），供 running 标记。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout.lower()
        return {line.split('","')[0].strip('"') for line in out.splitlines() if line}
    except Exception:
        return set()


def _iter_roots(roots: list[str] | None) -> list[Path]:
    if roots:
        return [Path(r) for r in roots]
    found: list[Path] = []
    for letter in "CDEFGH":
        p = Path(f"{letter}:\\")
        if p.exists():
            found.append(p)
        pf = Path(f"{letter}:\\Program Files")
        if pf.exists():
            found.append(pf)
        pf86 = Path(f"{letter}:\\Program Files (x86)")
        if pf86.exists():
            found.append(pf86)
    return found


def discover_clients(
    roots: list[str] | None = None,
    max_depth: int = 4,
) -> list[DiscoveredClient]:
    """扫描本机已安装的券商客户端。

    策略：按目录深度遍历，锚定 xiadan.exe（同花顺内核下单程序），
    找到后沿父目录回溯最多 3 层，用安装目录名与券商注册表的
    dir_hints 匹配归属；匹配不到则归入兜底档。
    专用客户端（银河/华泰等）主程序名各异，不在自动发现范围，
    请按 EASYTRADER_BROKER=<id> 手动配置路径。
    """
    running = _running_processes()
    anchor = "xiadan.exe"
    results: list[DiscoveredClient] = []
    seen: set[str] = set()

    def _match_profile(start: Path) -> BrokerProfile | None:
        """从 exe 所在目录向上最多 3 层，按目录名关键词匹配券商。"""
        cur = start
        for _ in range(3):
            name = cur.name.lower()
            for p in THS_BROKERS:
                if any(h.lower() in name for h in p.dir_hints):
                    return p
            if cur.parent == cur:
                break
            cur = cur.parent
        return None

    def _walk(dir_path: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = list(dir_path.iterdir())
        except (PermissionError, OSError):
            return
        for entry in entries:
            try:
                if entry.is_file():
                    if entry.name.lower() == anchor and str(entry) not in seen:
                        seen.add(str(entry))
                        profile = _match_profile(entry.parent)
                        generic = GENERIC_THS if profile is None else None
                        # 目录名命中「同花顺」字样 → 通用版；否则兜底档
                        if profile is None:
                            parent_name = entry.parent.name.lower()
                            generic = GENERIC_THS if any(
                                h in parent_name for h in GENERIC_THS.dir_hints
                            ) else GENERIC_FALLBACK
                            profile = generic
                        results.append(DiscoveredClient(
                            profile=profile,
                            exe_path=entry,
                            main_dir=entry.parent,
                            running=anchor in running or "hexin.exe" in running,
                            matched=profile.broker_id not in (
                                GENERIC_THS.broker_id, GENERIC_FALLBACK.broker_id,
                            ),
                        ))
                elif entry.is_dir():
                    if entry.name.lower() in _SKIP_DIRS or entry.name.startswith(("$", ".")):
                        continue
                    _walk(entry, depth + 1)
            except (PermissionError, OSError):
                continue

    for root in _iter_roots(roots):
        if root.exists():
            _walk(root, 0)

    # 具体匹配的排前面
    results.sort(key=lambda d: (not d.matched, d.profile.label, str(d.exe_path)))
    return results


def describe_supported() -> str:
    """渲染「全部支持券商」列表（CLI --list 用）。"""
    lines = ["同花顺内核贴牌券商（trader=ths，下单程序 xiadan.exe）："]
    for p in THS_BROKERS:
        lines.append(f"  {p.broker_id:<22} {p.label}" + (f"  [{p.note}]" if p.note else ""))
    lines.append(f"  {GENERIC_THS.broker_id:<22} {GENERIC_THS.label}  [{GENERIC_THS.note}]")
    lines.append("")
    lines.append("专用客户端（easytrader 专用交易器，连接其主程序）：")
    for p in CLIENT_BROKERS:
        lines.append(f"  {p.broker_id:<22} {p.label}  (trader={p.trader_type})"
                     + (f"  [{p.note}]" if p.note else ""))
    lines.append("")
    lines.append(f"共 {len(THS_BROKERS)} 家同花顺内核 + {len(CLIENT_BROKERS)} 家专用客户端档案。")
    lines.append("⚠ easytrader 0.23.x 已移除通达信交易器：通达信内核用户请改用券商的同花顺版客户端。")
    lines.append("名单遗漏时在 broker_profiles.py 表尾追加一行即可。")
    return "\n".join(lines)


def suggest_env(client: DiscoveredClient) -> str:
    """为发现的客户端生成可直接粘贴的 .env 配置。"""
    return "\n".join([
        "HOLDINGS_PROVIDER=easytrader",
        f"EASYTRADER_BROKER={client.profile.broker_id}",
        f"EASYTRADER_CLIENT_TYPE={client.profile.trader_type}",
        f"EASYTRADER_CLIENT_PATH={client.exe_path}",
    ])
