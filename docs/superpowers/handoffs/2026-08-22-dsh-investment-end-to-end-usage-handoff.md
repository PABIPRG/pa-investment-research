# DSH 投研端到端使用设计交接

## 交接状态

- 日期：2026-08-22
- 仓库：`/Users/xiexin/project/pa-investment-research`
- 当前分支：`codex/dsh-investment-runtime-profile`
- 当前 HEAD：`cfdb2c6a69`
- 当前阶段：PR2 本地实现与主要验证已经完成；端到端凭据、就绪引导和打包 Python sidecar 尚未实施
- 本交接目标：在新会话复核新规格，然后使用 `superpowers:writing-plans` 编写分阶段实施计划

## 必读顺序

1. [端到端凭据、就绪引导与 Python 交付设计](../specs/2026-08-22-dsh-investment-end-to-end-usage-design.md)
2. [已批准的投研集成边界规格](../specs/2026-08-20-dsh-integration-boundary-design.md)
3. [PR2 交接](2026-08-21-dsh-investment-plugin-migration-pr2-handoff.md)
4. [凭据 Service Definition](../../../frontend/packages/credentials/credentials/README.zh.md)
5. [本地凭据提供方](../../../frontend/packages/credentials/credentials-local/README.zh.md)
6. [Models 设置与首次使用引导](../../../frontend/packages/client/ui-settings-models/README.zh.md)
7. 根目录、`frontend/`、`frontend/packages/`、`frontend/packages/client/` 下适用的 `AGENTS.md`

新规格扩展既有架构，不得重开五层 Profile、三个 patch-only Bundle、`managed`／`external`、owned／attached 安全边界或 PR3 adapter-client 设计。

## 已确认决策

- 用户只在现有 Models 页面输入一次 `DEEPSEEK_API_KEY`。
- 前端 Agent、股票分析和盘中盯盘复用同一个 credential ref。
- 不新增投研专属 Key 输入框，不把 Key 复制到 backend `.env`。
- 第一版采用 BYOK，不在 Electron 包中内置平台公共 Key。
- 即使前端选择其他模型，第一版完整投研 LLM 仍要求 DeepSeek Key。
- owned managed child 可以接收 Host allowlist 注入；attached／external 不接收本机 Key。
- 最终同时支持源码仓库环境和 Electron 随附 Python sidecar；两者复用同一 managed 生命周期。
- Key 更新后的第一版安全语义是明确提示并执行全应用 quiescent restart；backend 级 rolling restart 延后。

## 现状证据

- 本地已有：
  - `backend/dsh-trading-core/env`，Python 3.10.6。
  - `backend/market-watch/env`，Python 3.10.6。
  - 两边 import 自检通过。
- `investment-research` Profile 可由以下命令启动：

```sh
cd frontend
pnpm dsh electron --profile investment-research
```

- managed engine smoke 最近两次通过、一次间歇超时；最后一次结果为 `1 passed`，无残留 uvicorn／Vitest 进程。实施计划应保留稳定性验证，不把单次通过当成充分证据。
- Profile 组合静态断言股票分析 9 个工具、盘中盯盘 11 个工具。
- 当前 frontend Models 页面通过 `api.credentials.set()` 写入 `DEEPSEEK_API_KEY`；本地提供方把值保存在 `$DSH_HOME/.credentials.yaml`。
- 当前两个 Python backend 仍读取各自 `.env`；`market-watch` 使用 `load_dotenv(..., override=True)`，会覆盖 Host 注入值，是计划必须关闭的优先级缺口。
- 当前根 `scripts/init.sh` 尚未接入 backend 初始化；`scripts/main.sh` 只登记 `market-watch-init`，没有统一投研 backend 初始化／验证入口。

## 工作区保护

当前工作区存在以下用户未跟踪内容，不属于本工作，禁止暂存、修改或删除：

```text
.pnpm-store/
AGENTS.md
docs/research/
```

两个 backend 的 `env/` 被 Git 忽略，只是本机运行环境，不得提交。

## 新会话应完成的工作

1. 读取全部必读文档并检查当前分支、HEAD、工作区和 PR2 状态。
2. 对新规格做一次自洽审查，重点检查：
   - credential update 与 quiescent restart 的边界；
   - 通用 Models UI 与投研 readiness UI 的 package／slot 归属；
   - owned managed 注入与 attached／external 隔离；
   - source 与 bundled resolver 的优先级；
   - 与既定 PR3 adapter-client 的先后关系。
3. 若没有实质冲突，先请用户确认书面规格，然后使用 `superpowers:writing-plans` 生成中文详细实施计划。
4. 计划至少拆成两个独立增量：
   - 源码模式凭据闭环、readiness 和统一初始化／验证入口；
   - Electron packaged Python sidecar。
5. 计划必须逐任务写明 RED、最小 GREEN、文件范围、验证命令和提交边界。
6. 未经用户批准，不开始实现，不修改 PR3 adapter-client，不把新工作塞进当前 PR2 提交序列。

## 新会话开场提示

复制以下内容到新会话：

> 请完整阅读 `docs/superpowers/handoffs/2026-08-22-dsh-investment-end-to-end-usage-handoff.md`、其中链接的端到端设计、原已批准架构规格、PR2 交接、凭据与 Models 设置文档，以及适用的 `AGENTS.md`。先检查当前分支、HEAD、工作区和 PR2 状态，不要修改 `.pnpm-store/`、根 `AGENTS.md` 或 `docs/research/`。请使用 `superpowers:brainstorming` 对新规格做最后自洽审查；确认无实质冲突后，等待我批准规格，再用 `superpowers:writing-plans` 编写中文详细实施计划。计划需拆分源码凭据闭环与 packaged Python sidecar，严格写明 TDD、文件范围、验证命令和提交边界；不要开始实现，也不要提前修改 PR3 adapter-client。
