# rc.10 最终发布门禁与 Deep UAT 记录

## 发布结论

**Ready** — rc.10 当前范围内的 P0、P1 与横切门禁均通过。`RC10-E2E-26～28` 已按产品范围纠正移出本版本，不构成发布阻断。独立 PR 审查发现的 3 个 Important 缺陷已按 TDD 修复并通过定向回归、全量门禁和真实重启 UAT；PAB-5、PAB-7、PAB-9、PAB-13 已先回退为 `In Progress`，待本轮证据回写后再关闭。

## 验收基线与隔离

| 项目 | 结果 |
|---|---|
| 分支 / 基准 | `codex/rc10` / `33b917d0446bdf40df3cca041161e5efab074b23` |
| 前端 | `127.0.0.1:3180` |
| trading-core | `127.0.0.1:8180`，`ADAPTER_RUNNER=fake` |
| market-watch | `127.0.0.1:8280`，确定性只读合同夹具 |
| industry-chain | `127.0.0.1:8380`，真实应用与隔离 seed |
| 隔离状态 | `/private/tmp/pa-rc10-pab13-gate`；本轮修复复验使用 `/private/tmp/pa-rc10-final-uat.V6IeMC` |
| 共享服务 | 未启动、停止或访问 `3080` |
| 产品版本 | 页面与包版本均为 `0.1.0-rc.10` |

本次在同一 worktree 串行集成与验证既有 PAB-5/6/7/9/10/11/12 改动，没有覆盖、暂存、提交或清理来源不明的工作区内容。

## 控制塔状态

| 交付面 | 状态 | 主要证据 |
|---|---|---|
| 策略生命周期 | passed | 首次任务只要执行成功即进入 `active`；`passed/not_passed/insufficient` 与参与状态分离；前端无“人工确认生效” |
| 回测任务历史 | passed | `pending/running/completed/failed/cancelled` 持久化；取消、重跑、重启恢复、报告引用与并发幂等均有测试；真实页面读取正式任务账本 |
| 15 天自动复测 | passed | 14/15/16 天边界、服务时区、错过计划补建和并发幂等通过；`verification_status=not_passed` 按产品设计排除 |
| 影子任务历史 | passed | 单策略/批量、部分成功、取消、重跑、恢复、净值与报告引用通过；旧快照明确降级为历史兼容数据 |
| 产业链权重 | passed | 真实页面同时显示披露 5%/12%、默认 20%/10% 且标明非披露、推断置信度 82% |
| 事件传导 | passed | 上游无分页能力；后端返回 `pagination_supported=false` 与 `max_visible=50`，页面明确“当前最多展示 50 条”并去重 |
| 自进化与演示 | passed | 5 个交易日、正常/观察/升级/淘汰四桶、2 个变异子策略、正式任务与报告均可重复生成 |
| 风险中心增量 | not-tested | 已确认不属于 rc.10；只保留现有风险展示兼容回归 |

## 自动化门禁

自动化只作为支持证据，最终结论同时包含真实浏览器 UAT。

| 门禁 | 状态 | 结果 |
|---|---|---|
| trading-core 全量单元测试 | passed | 213 个用例通过（新增 5 个审查缺陷回归用例） |
| market-watch 全量单元测试 | passed | 115 个用例通过 |
| industry-chain 全量单元测试 | passed | 22 个用例通过 |
| 前端回归 | passed | 36 个测试文件、552 个用例通过 |
| TypeScript 类型检查 | passed | `tsc -b tsconfig.client.json` 退出码 0 |
| UI bundle | passed | ESM 与 Client CJS 构建完成；仅既有弃用警告 |
| 脚本静态检查 | passed | shell `bash -n` 与 Python `py_compile` 通过 |
| 演示数据 | passed | prepare、verify、preflight 全部通过 |

关键日志保存在 `/private/tmp/pa-rc10-pab13-gate/logs`。测试中的显式异常日志来自失败恢复用例，不是未处理失败。

## 独立 PR 审查缺陷复验

| 缺陷 | RED 证据 | 修复与 GREEN | 真实产品证据 |
|---|---|---|---|
| 影子历史重放重复追加平仓 | 同一实际 1 笔的历史连续重放 3 次，台账膨胀为 3 笔；扩展出真实第 2 笔时台账错误为 3 笔 | 写入源头按 `symbol + entry_date + exit_date` 原子合并，新鲜重放覆盖同身份旧记录，同时保留未重放到的历史；2 个定向用例通过 | 归因保持 1 笔、累计 `-10%`，公开 `evolve` 不再误触发 `closed >= 3` 淘汰；扩展历史后恰保留 2 笔真实平仓 |
| 回测终态在进程重启后统一查询 404 | completed 与 running→failed 通过 `/analyze/{task_id}` 及 `/result` 均返回 404 | manager miss 时先保留 shadow 降级读取，再查询 `strategy_backtests`；completed 映射 `done`，failed 保持 `failed`，结果接口沿用 200/409 契约；定向用例通过 | 隔离 8181 实际启动、停止、再次启动后，completed status/result 均 200；recovered-failed status 200、result 409，第二次重启后仍可查 |
| 服务夹具脚本可绕过 demo marker | 对无 marker 的任意 `--demo-root` 直接执行脚本返回 0，覆盖两个哨兵文件并创建额外 seed | 脚本自身在任何 prepare/verify 操作前校验目录、marker 文件与精确内容；无 marker 非零退出且零写入，有 marker prepare/verify 通过 | 隔离 demo 根目录重新执行 prepare、verify、preflight，5 日、四桶、任务、报告、事件与三类权重来源均通过 |

## RC10 端到端矩阵

状态仅使用 `passed`、`failed`、`not-tested`。

| 用例 | 状态 | 证据 |
|---|---|---|
| RC10-E2E-01 | passed | 真实浏览器依次打开四个分析模块，均进入 AI 研究助理并保留对应模块上下文 |
| RC10-E2E-02 | passed | 四张卡只有介绍、详情与打开助理；未发现直接执行入口 |
| RC10-E2E-03 | passed | Shell 受控让位组件回归通过；真实 1440×900 页面无横向溢出 |
| RC10-E2E-04 | passed | 中等宽度布局回归通过；真实 1024×768 页面无横向溢出 |
| RC10-E2E-05 | passed | 窄屏近全屏、关闭、焦点与滚动恢复组件回归通过；真实 390×844 页面可导航且无横向溢出 |
| RC10-E2E-06 | passed | 事件确认候选与首次自动回测合同通过，任务先持久化再调度 |
| RC10-E2E-07 | passed | 自动事件候选复用同一入池/首测规则，稳定去重键并发下只生成一个任务 |
| RC10-E2E-08 | passed | 三类已完成验证结论均推进 `active`；失败/取消不推进；真实页面无人工确认入口 |
| RC10-E2E-09 | passed | 手动、首次自动、周期复测均保留独立窗口、来源、状态、时间、结果与失败原因 |
| RC10-E2E-10 | passed | 第 14 天不建、满 15 天只建一个、第 16 天不重复；验证未通过参与策略按设计排除 |
| RC10-E2E-11 | passed | `retired/rejected/archived` 不创建自动复测任务 |
| RC10-E2E-12 | passed | 完成首测的参与中策略可进入影子验证；执行未完成或已退出策略被阻止 |
| RC10-E2E-13 | passed | 单策略和批量任务持久化；局部失败聚合为 `partial` 且保留其他逐策略结果 |
| RC10-E2E-14 | passed | 最近、当前策略、全部策略视图合同通过；任务、净值证据、报告引用可互查 |
| RC10-E2E-15 | passed | 服务启动恢复 `pending/running` 为可解释中断；已终止历史在重启后仍可查 |
| RC10-E2E-16 | passed | 2026-08-31～2026-09-04 五个交易日，四桶和变异证据齐全 |
| RC10-E2E-17 | passed | 画像/持仓、事件、产业链、策略、影子、自进化、报告和 AI 入口在同一隔离组合可达 |
| RC10-E2E-18 | passed | 工作台持仓、画像、风险与资讯分区在真实页面清晰呈现 |
| RC10-E2E-19 | passed | “我的投研”上下文与四类分析能力一致，空选择允许开放问题；相关控件回归通过 |
| RC10-E2E-20 | passed | 会话、资料和报告入口语义回归通过，无重复业务入口 |
| RC10-E2E-21 | passed | 正常、观察、升级、淘汰与变异来源的五维文案一致 |
| RC10-E2E-22 | passed | 真实首屏显示闭环状态、5/5 日门槛、四桶计数、生命周期和衍生关系 |
| RC10-E2E-23 | passed | 真实图谱区分披露、默认、推断；默认值明确不是披露占比 |
| RC10-E2E-24 | passed | 真实检索选择浦发银行并重定中心；1/2/3 层、方向与图例可操作 |
| RC10-E2E-25 | passed | 上游不支持分页时采用最多 50 条的有界契约；重复事件被去重，失败状态保留旧数据并可恢复 |
| RC10-E2E-26 | not-tested | 已移出 rc.10：不新增风险重复触发合并 |
| RC10-E2E-27 | not-tested | 已移出 rc.10：不新增风险处理状态与历史 |
| RC10-E2E-28 | not-tested | 已移出 rc.10：不新增风险组合筛选 |
| RC10-E2E-29 | passed | 偏好复盘入口和返回路径回归通过，“我的投研”无重复入口 |

## 横切门禁

| 需求 | 状态 | 证据 |
|---|---|---|
| NF-001 现状与目标分离 | passed | PRD 已纠正 15 天资格规则和风险中心范围，未把移除项写成完成 |
| NF-002 任务持久化 | passed | 回测与影子任务的成功、失败、取消、中断、重启和引用均覆盖 |
| NF-003 时间与调度 | passed | 服务时区边界、14/15/16 天、错过计划补建和并发幂等通过；无偏移时间明确标注服务本地时间 |
| NF-004 状态语义 | passed | 生命周期、验证、置信、来源和任务五维在列表、详情、报告和 AI 合同中分离 |
| NF-005 局部失败 | passed | 批量 `partial`、保留旧数据、可行动错误与重试恢复通过 |
| NF-006 可访问与响应式 | passed | 三档视口、浅色、reduced motion、键盘焦点合同和无页面级横向溢出通过 |
| NF-007 交易隔离 | passed | 运行配置为 fake/paper；源码无委托调用；浏览器未产生订单类请求；隔离状态无订单/成交执行文件 |

## 真实浏览器 UAT

- 浏览器：隔离的无头 Google Chrome，通过 DevTools Protocol 驱动真实页面。
- 视口：1440×900、1024×768、390×844；浅色模式与 `prefers-reduced-motion: reduce`。
- 页面：工作台、智能分析、实时盯盘、策略研究、自进化、我的投研、产业链，以及 AI 研究助理。
- 响应式：所有取证页 `scrollWidth === innerWidth`，未发现页面级横向溢出。
- 运行日志：浏览器 console error 0、未捕获异常 0、网络加载失败事件 0。
- 失败恢复：主动停止 8180 后，自进化页显示“投研服务暂时不可用，请稍后重试”，同时保留 5/5 日和四桶旧证据；重启并刷新后错误消失。
- 原始结构化证据与截图：`/private/tmp/pa-rc10-pab13-gate/uat`。

market-watch 在本轮使用只读确定性合同夹具，仅覆盖事件、证券检索、跨服务传导和上限契约；实时指数、扫描和快讯没有接入外部行情源，页面如实进入现有可行动降级态。AI 让位的完整数据布局由 552 个前端回归中的 Shell 集成用例覆盖，这是本轮唯一保留的环境边界。

## 旧数据、恢复与幂等

- 旧策略只有最近 `backtest` 快照、没有任务账本时，真实页面显示“历史未留存”，不伪造任务和报告引用。
- 旧影子净值只投影为“历史兼容数据”，明确没有任务编号、精确报告或重跑关系。
- 回测首测、周期复测和并发创建使用稳定去重键；线程并发测试只落一个任务与一个结果标识。
- 服务错过自动复测时间后补建一次启动任务；日常 cron 与启动补建最终由任务级去重收敛。
- 演示状态通过专用 marker 和隔离根目录重建；执行实际覆盖的 Python 服务夹具脚本也独立校验 marker，不能再绕过 shell 护栏。清空隔离夹具是为避免重复数据，不影响默认状态。

## 真实交易负面保证

- trading-core 使用 `ADAPTER_RUNNER=fake`，影子验证为 paper account。
- 生产代码搜索未发现 `place_order`、`submit_order`、`create_order`、`send_order` 或交易执行路由调用。
- QMT 仅有未启用的只读持仓 provider，`xtquant` 不在运行依赖中，没有委托实现。
- 浏览器请求未命中订单、券商、QMT 或交易执行路径。
- 隔离状态目录不存在订单、成交或执行账本文件。

结论：本轮任务与演示没有真实下单能力，也没有触发真实交易。

## 默认状态隔离

原完整 UAT 前后以下默认状态 SHA-256 逐项一致。本轮首次重跑 trading-core 全量测试时，`test_start_returns_prepare_canonical_id_and_dispatches_only_once` 未隔离 `DecisionRecorder`，误把一条可精确识别的 `600519_2026-09-04` 测试决策写入默认 `decisions.json`。该测试已补 mock，测试记录已移除，原有 `600519_2026-09-03` 业务记录完整保留。

JSON 被测试写入时重新序列化，故 `decisions.json` 无法保持旧的逐字节哈希 `a09c…`；清理后的新基线是 `6a34…`。随后使用显式隔离状态目录重跑 213 个 trading-core 用例，前后哈希均为 `6a34…`，证明修复后不再写默认状态。其余四个文件仍与原门禁哈希一致：

```text
ea55f4378f6763677be34a12b4d67bb223ed732d53d662aff6e7811d10a88f61  behavior.json
6a34fa70e68b2a0460023f4a4c5bb20b2b4035449ab8a53590bf5bb76f3a01b0  decisions.json
84d36c090d1e997c222deae096eb48ab4647455855fd5f5d679aee9c397183cd  reports.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  shadow_tasks.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  strategy_backtests.json
```

## 环境清理

- `git diff --check` 退出码 0。
- 默认状态哈希与验收前逐项一致。
- 原完整 UAT 启动的 3180/8180/8280/8380 与隔离 Chrome 已全部停止；本轮复验使用的 8181 也已停止。
- 本轮测试临时创建的 `backend/dsh-trading-core/env` 与 `backend/market-watch/env` 均先用 `readlink` 确认精确指向 `/private/tmp/pa-rc10-pab13-gate/venv310`，随后仅删除符号链接，未删除目标目录。
- trading-core 全量回归最终通过 `DSH_INVESTMENT_STATE_DIR=/private/tmp/pa-rc10-final-uat.V6IeMC/regression-state` 隔离运行；默认决策文件测试前后哈希一致。
- 临时故障 marker 已删除；UAT 结构化证据与截图保留在隔离目录。
- 未提交、未推送、未创建 PR。PAB-5、PAB-7、PAB-9、PAB-13 已同步为 `In Progress` 并记录独立审查缺陷，最终 UAT 证据将在关闭前回写。
