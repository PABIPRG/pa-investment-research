# PAB-29 / PAB-30：行情预热与服务冷启动修复

## 任务、范围与基线

主代理为 worktree-writer，唯一写入目录 `/Users/xiexin/.codex/worktrees/investment-startup-recovery/pa-investment-research`，基线为公仓缓存 master `2775c7675df18ae847b0a7919fa28e10b082d691`，分支 `codex/investment-startup-recovery`。子代理仅本地只读。允许修改后端行情生命周期与回归、真实启动验证及对应说明；不修改业务存储、认证或用户界面。随机回环端口和 `/private/tmp/investment-startup-recovery-*` 专属资源；不触碰共享 3080。Linear 当前无连接，关联既有 PAB-29 / PAB-30，不更新外部状态。

2026-10-08 新镜像已拉取成功，实际部署失败发生在 Python backend trading-core 超过 Host 默认 30000ms 启动预算。三源串行预热各允许 8 秒冷导入，叠加 Python 模块导入和必要存储恢复，产生反复退出。用户授权的当次 aly 恢复已通过回滚旧镜像完成并保留当前数据；其健康证据属于当日。本次“继续修复”仅授权本地工作，没有连接 aly 或探测线上接口。

## 现有能力核查与方案

| 用户动作 | 现有入口 / 接口 | 权威状态及副作用 | 缺口 | 决策 | 证据 / 未知 |
|---|---|---|---|---|---|
| 打开工作台与公开观察室 | Host managed runtime → Uvicorn → FastAPI lifespan / health | lifespan 恢复既有数据、启动调度器；Host 验证后端身份后注册工具 | 可选行情预热阻塞必要启动 | Extend | app.py 在 yield 前串行预热；Host 默认 30 秒；保持启动预算和真实恢复顺序 |
| 读取历史与每日收益 | public history → portfolio_performance → price cache → 三源隔离 worker | 持仓快照和实际日线确定估值；内存缓存 300 秒 | 冷进程重建可能短暂超过网关 5 秒；源故障仍需明确失败 | Reuse | 现有隔离、准入、退避和失败语义保留；验证五标的成功、失败及重试 |
| 退出与重新启动 | lifespan finally → close_price_workers → worker closed event / kill / join | 生命周期拥有子进程与 IPC 线程 | 后台预热必须在退出前结清，不能迟到 reopen | Extend | open 与 warm 分离；仅启动路径 reopen；退出先 close 再等后台完成 |

所有健康、预算、估值与测试结果都是确定性事实，不通过模型推断替代。保持既有 worker 所有权、行情回退和 API，不创建新存储或接口。

## 实施与验证计划

1. 先补预热阻塞仍能响应健康、退出中断冷导入、连续生命周期和启动失败清理的回归，记录旧代码失败。
2. 将轻量 reopen 与预热拆开；完成必要恢复后以生命周期任务并行预热三个源。退出先关闭所有 worker，再等待预热任务结束，不能只取消线程协程。
3. 聚焦真实 spawn 与行情故障回归；通过独占回环端口运行真实 Uvicorn / Host 入口和合成账户历史链路，核对估值、失败与恢复；启动验证使用生产默认 30 秒。
4. 复核代码与文档。Linux 完整镜像与实际 aly 冷启动仍需新 CI / 明确远程授权；负责人为本任务代理与仓库维护者，发布前关闭。未通过的门禁明确保留，不把本地测试称为上线成功。

## 方案取舍

仅把串行预热改成并行且继续阻塞 lifespan，仍会与应用导入、恢复争同一启动预算。只增加 Host 超时会掩盖可选依赖阻塞服务。完全取消预热会把所有初次导入转移到用户请求；保留受生命周期管理的后台预热，让健康和活动先可响应。后台任务不能调用 reopen，避免关闭后重启下一源。

本轮不改变已登记的冷重建限制，也不把真实行情失败变为空数组、假估值或未标记的旧行情。完整 Web 本地登录与主要页面、公开观察室播放已验证（见下）；Linux 镜像、远程部署尚未验证。

## 本地验证结果（2026-10-09）

- 失败先证：旧串行预热下，真实 lifespan 在受控预热未结束时无法响应 health；退出中取消 warm 等待的旧清理路径也提前返回。两项回归先失败，修复后通过。
- Python 3.10.20：按仓库 darwin-arm64 固定版本约束建立独立验证环境，82 项行情、缓存、公开投影及生命周期测试通过；补齐旧调度器异常测试的 warm mock 后单独 5 项验证通过，避免测试自己遗留全局进程。pip check 通过。测试任务为 fake，但应用、生命周期、存储恢复与行情 spawn 均是真实代码；未执行模型调用。
- Host / Uvicorn / 公开网关：实际 InvestmentBackendManager 默认 30000ms、LocalSubprocessRuntime、真实应用和独立回环 HTTP；45 秒卡死冷导入仍可就绪，退出全部回收。真实 source 编排与缓存下五标的历史 190 / 205 / 220、成本 150、浮盈 70；外部源夹具全部卡死时 history 503、活动 200，已覆盖缓存保持 200，解除故障并退避后扩展历史恢复 235。新旧源 PID 均在 Host 退出后消失。网关 Loader 文件全部 10 项通过。
- 容器契约 15 项、typecheck:startup、git diff --check 通过。新增 CI 步骤使用实际镜像 Python / adapter、只读挂载测试模块、禁网与临时状态；当前机器没有 Docker，未运行该步骤或完整 Linux 镜像。
- 完整真实 engine smoke 移除 60 秒覆盖，保持生产默认 30 秒；本地未运行该 opt-in 三后端 engine smoke，不据此声称全部引擎验收通过。

扩大回归时纠正了旧 HTTP 夹具的两个问题：活动名补全原来默认请求本机 market-watch，导致结果依赖共享服务和等待；现在明确注入合成证券名，断言与夹具一致。地址原来在 bind 后、Uvicorn startup 前输出；现在只在真实 startup 完成后报告地址。没有通过放宽产品启动或网关预算消除失败，也没有更改业务 DTO。

## 产品验收与发布边界

判定：本地 API / 生命周期修复通过；发布证据不完整（Inconclusive）。

| 关注点 | 状态 | 可观察证据 / 限制 |
|---|---|---|
| 真实启动入口 | passed | Node managed runtime 启动真实 Uvicorn，并按实际 health 获取 owned lease；默认 30 秒预算没有覆盖 |
| 估值关键链 | passed | Host HTTP → cache → 五标的源进程 → 权威持仓数量，金额逐项核对；仅外部源用合成夹具 |
| 失败与恢复 | passed | 所有源卡死明确 503，活动可读，缓存未污染，退避重试恢复；冷预热可被退出打断 |
| 连续生命周期 / 取消退出 | passed | 两轮真实 spawn 均完全退出；重复取消不提前结束预热线程；调度器异常仍清理 |
| 完整 Web 本地登录 / 主要页面 | passed | cloud-web 模式、强制登录、三个真实 managed 后端；页面三服务均运行正常，实时盯盘加载真实行情，策略与自进化显示真实空状态 |
| 公开观察室播放 / 断线恢复 | passed | 真实前端与 Host 网关，合成行情夹具；播放日期与汇总金额同步，停止后端保留旧值并报错，重启后自动恢复 |
| 长驻稳定性 | limited | 完整 Web 本轮驻留数分钟，后端 PID 未变、四服务健康通过；未作小时级浸泡验证 |
| 实际行情读取 | passed / limited | 完整 Web 实时盯盘显示四指数与东财 12 条扫描结果；未覆盖全部行情源及端到端历史估值 |
| aly 新版冷启动 | not-tested | 没有本次远程操作授权；不把昨日回滚后的健康结果当当前或候选版证据 |
| Linux 镜像 / 安全扫描 | not-tested | 已接入实际镜像聚焦门禁；待新 CI；发布前由代理与维护者关闭 |

本地验收结束时修复尚未提交或部署；用户随后授权提交 PR。本轮将修复以草稿 PR 交付，不自动等待 CI、合并或部署，aly 操作仍需单独授权。冷 worker 重建仍可能短暂超过 5 秒网关预算，该限制与真实源故障的明确失败语义继续保留，不能宣称历史接口永久 200。


## 完整 Web 本地启动与验收补充（2026-10-09）

用户澄清恢复目标为云平台 Web。本轮使用正式 CLI investment-research profile 与真实三后端，不能用公开观察室夹具的成功代替平台验收。

- 环境：Python 3.10.20；三个源码 venv 按 `frontend/config/investment-python-requirements/darwin-arm64.txt` 固定版本约束安装各自正式 requirements。Node 24.15.0；按正式流程执行 `build:lib` 与 `build:web`。可信依赖 node-pty 的本机原生产物已重建。
- 构建发现并修正两处仅回归测试的 TypeScript 类型问题：自定义夹具 module 不属于生产模块联合类型，以及 helper 将运行后端 ID 错限于 trading-core。夹具入口使用显式测试断言，helper 复用真实 manager 返回类型，没有放宽生产接口。完整构建通过，受影响 Loader 回归重新运行 10/10 通过。
- 启动：`DSH_DEPLOYMENT_SURFACE=cloud-web`、`DSH_WEB_AUTH=required`、专属 127.0.0.1:15088，三个后端为 18088 / 18188 / 18288，保持生产 30000ms 启动预算。使用临时账户、本次专属空数据目录，未读取生产持仓或模型密钥，关闭调度与通知。仅为本机回环 HTTP 设置开发 cookie 选项；生产 HTTPS、代理和 Compose 路径未覆盖。
- 冷环境限制：首次新装 venv 启动时 trading-core / market-watch 在模块导入阶段超过 30 秒，industry-chain 正常。faulthandler 显示 pandas 原生模块及 pydantic schema 导入持续推进，独立导入分别约 27.3 / 19.7 秒；未观察到网络等待或死锁，没有证据归因于特定 macOS 安全组件。完成导入预检后，正式 Web 使用相同预算成功启动；因此不能声称“全新依赖环境首次启动必过”。
- 实际健康：执行仓库 `containers/investment-healthcheck.mjs`，仅替换本次四个本地地址，首次就绪及约 4 分钟后均通过。02:08:46 UTC 的健康响应全部 200，真实 runner 包括 tradingagents-cn；三个后端 PID 与 02:04:09 UTC 启动记录一致。
- 浏览器：真实账户登录、跳过未配置模型密钥后进入研究工作台；设置 → 投研中三个正式后端均显示“本应用管理 / 后端运行正常”。实时盯盘 2/2 数据项完成，四个指数及东财 12 条结果真实加载。智能分析入口、策略池空状态、自进化未启用状态均可访问；产业链明确提示首次需下载数据。浏览器检查未记录 error / warn。
- 功能边界：未设置 DeepSeek API Key，未执行完整 AI 分析；没有下载产业链约 80 MB 基础数据，因此未验证公司关系检索。未使用虚构持仓替代该平台的空数据，也未访问 aly。真实 engine opt-in smoke 文件未单独运行，不能将正式产品启动冒称为该脚本已通过。
- 证据：`/private/tmp/investment-startup-recovery-web/evidence/health-initial.json` 保留首次失败；`health-ready.json` 为成功驻留快照；`workbench.jpg`、`readiness.jpg`、`market.jpg` 为浏览器实拍。之前公开观察室的独立验收保存在 `/private/tmp/investment-startup-recovery-local/evidence/acceptance.json`。

本轮交付为已启动的本地完整 Web；不等于新版已部署或云端长驻稳定性已获证实。发布前仍需 Linux 候选镜像检查和获得明确授权后的目标环境验收。

只读复核补充：sidecar 安装使用 `pip --no-compile` 并删除 `__pycache__`，bundled runtime 设置 `PYTHONDONTWRITEBYTECODE=1`；不能默认生产享有本地预导入后的启动条件。现有 Compose CI 等待 healthy，但未断言 `RestartCount=0`，因此发布验收仍须确认准确候选镜像首次启动成功且无重启，不能用反复重启后健康关闭首次冷启动风险。本轮没有扩展修改这些独立门禁。
