# DSH 投研插件迁移 PR2 交接

## 交接状态

- 日期：2026-08-21
- 仓库：`/Users/xiexin/project/pa-investment-research`
- PR2 本地分支：`codex/dsh-investment-runtime-profile`
- PR2 基线：`e1707e1af54f2951268a2603106db784e5b52f40`
- PR1：GitHub PR #1 已合并到 `master`
- PR1 标题：`refactor: move investment plugins into frontend workspace`
- 当前阶段：开始 PR2“Python Runtime、Bundle、Profile 与跨平台组合”
- 产品入口：`dsh electron --profile investment-research`

本交接是新对话的入口。已批准架构不重新设计；详细文件、测试、命令和提交边界以实施计划中的 PR2 任务 7–15 为准。

## 必读文档

按以下顺序完整阅读：

1. [已批准架构规格](../specs/2026-08-20-dsh-integration-boundary-design.md)
2. [详细实施计划](../plans/2026-08-20-dsh-investment-plugin-migration-plan.md)，重点阅读“PR 2：Python Runtime、Bundle、Profile 与跨平台组合”
3. [frontend/AGENTS.md](../../../frontend/AGENTS.md)
4. [frontend/packages/AGENTS.md](../../../frontend/packages/AGENTS.md)
5. [frontend/docs/defensive-patterns.md](../../../frontend/docs/defensive-patterns.md)
6. [原始迁移 handoff](2026-08-20-dsh-investment-plugin-migration-handoff.md)，只作为实施前调查记录，不再作为当前状态来源

若文档之间冲突，优先级为：当前用户指令、适用的 `AGENTS.md`、已批准架构规格、详细实施计划、本交接、原始 handoff。发现真实冲突时先报告，不自行改架构。

## PR1 已完成内容

PR1 已把两个投研插件从 Python 后端迁入 frontend workspace：

```text
frontend/packages/investment-research/
├── stock-analysis/
└── market-watch/
```

已完成的主要边界：

- `backend/dsh-trading-core` 和 `backend/market-watch` 不再管理 Node、TypeScript、Cordis 或 dsh 生命周期。
- 两个插件已接入 frontend 的 manifest、TypeScript aggregate、真实 Loader 测试、覆盖率、README 和生成目录。
- 股票分析仍保留现有 HTTP/SSE client；market-watch 仍保留自己的 JSON client。传输层提取属于 PR3，不得在 PR2 提前实施。
- 后端健康响应已有稳定服务身份：`trading-core` 与 `market-watch`。
- PR1 扩展修复关闭了 rescope、archived-agent-note、Knip e2e 和 adapter e2e watchlist 恢复等验收问题。
- PR1 关闭前证据包含：投研聚焦测试每文件 100% coverage、`typecheck`、`build`、`hygiene`、`doc-sync`、两个 Python 后端验证、shell 语法检查及无 `ADAPTER_URL` 的 e2e 自跳过。

PR1 合并提交：

```text
e1707e1af54f2951268a2603106db784e5b52f40
```

## 已批准的 PR2 目标

PR2 交付 Electron 可调用的完整投研 Profile，并使用安全的 Host Runtime 管理 Python 服务：

```text
dsh electron --profile investment-research
  -> CLI 把 Profile 名传给 Electron
  -> Electron 主进程调用 runProfile("investment-research")
  -> app-boot 按固定顺序加载五层 Profile
  -> 现有 electron.patch.yml 禁用浏览器/Web-server carrier
  -> Electron 原生 IPC 与目录选择器生效
  -> 股票 9 个工具和盯盘 11 个工具可见
```

五层顺序固定为：

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@deepseek-ai/dsh-investment-runtime-bundle
@deepseek-ai/dsh-investment-stock-analysis-bundle
@deepseek-ai/dsh-investment-market-watch-bundle
```

`web-app` 是 Electron 复用的 UI 和组合基础层，不表示启动浏览器版产品。PR2 必须证明 Web server carrier 被 Electron patch 禁用。

## PR2 目录归属

业务实现与 Runtime 位于投研包族：

```text
frontend/packages/investment-research/
├── python-runtime/
├── stock-analysis/
└── market-watch/
```

三个纯组合 Bundle 位于现有 Bundle 组：

```text
frontend/packages/bundle/
├── investment-runtime/
├── investment-stock-analysis/
└── investment-market-watch/
```

不得把 Bundle 放到 `frontend/packages/investment-research/*-bundle`，也不得把业务逻辑写入 Bundle。

## PR2 任务与提交边界

严格按详细计划的任务 7–15 顺序执行。每个行为任务先记录 RED，再做最小实现并取得 GREEN。

1. 任务 7：定义 Runtime 公共接口、健康判断和跨平台路径解析。
   - 提交：`feat: define investment Python runtime contract`
2. 任务 8：实现 single-flight、引用计数、owned/attached/external、日志、状态和 quiescent teardown。
   - 提交：`feat: manage investment Python backends safely`
3. 任务 9：股票插件通过 Runtime lease 获取 `trading-core`。
   - 提交：`feat: acquire the trading backend through runtime`
4. 任务 10：market-watch 插件通过 Runtime lease 获取 `market-watch`。
   - 提交：`feat: acquire the market backend through runtime`
5. 任务 11：创建三个可独立增删的 patch-only Bundle。
   - 提交：`feat: add investment research bundles`
6. 任务 12：注册 Profile，贯通 CLI 到 Electron 的 `--profile`，闭合 CLI/Electron 安装依赖。
   - 提交：`feat: launch the investment profile in Electron`
7. 任务 13：增加 keyless snapshot、真实 Loader/Profile/Electron composition 以及 macOS/Windows managed 矩阵。
   - 提交：`test: cover investment runtime across platforms`
8. 任务 14：补齐 Runtime、Bundle、Profile、CLI/Electron 文档和 Agent Note。
   - 提交：`docs: document the investment runtime profile`
9. 任务 15：执行 PR2 验收、故障注入和独立审查。

PR2 标题固定为：

```text
feat: add the investment research runtime profile
```

## Runtime 安全边界

- `managed` 是默认模式；`external` 只验证和连接外部服务，绝不启动或停止它。
- 同一后端并发 acquire 使用 single-flight，只启动一次。
- 已存在且健康身份匹配的服务只 attached，不获得进程所有权。
- 只有 health 明确返回 connection refused 时才允许 managed spawn；未知占用、连接重置或身份不匹配均明确失败。
- 只终止当前 Runtime 在内存中持有的 owned `SubprocessHandle`；不得按端口、旧 PID 或状态文件杀进程。
- Python 后端 `.env` 不加载进父 Node 进程；只显式向 owned child 传递允许的 `ADAPTER_RUNNER`。
- 缺少虚拟环境时给出对应 `init.sh` 或 `init.bat` 指引，不在 dsh 启动时安装依赖。
- 注册、lease、定时器、子进程与释放全部进入 Cordis Effect 生命周期；dispose 必须等待子进程树退出。
- macOS/Linux 使用 `env/bin/python`；Windows 使用 `env\\Scripts\\python.exe`；路径测试覆盖空格和中文。

## 明确排除范围

以下内容属于 PR3 或后续 UI 工作，不得进入 PR2：

- 不创建或实现 `frontend/packages/investment-research/adapter-client`。
- 不从股票插件提取 HTTP/SSE 传输层。
- 不修改股票或 market-watch Python 业务 API。
- 不修改 dsh Web UI，也不创建投研专属浏览器页面。
- 不引入 Agent Preset。
- 不创建顶层 `integrations/dsh`。
- 不升级 dsh、Cordis 或无关依赖。
- 不重开已批准的 Profile、Bundle、Runtime 或目录边界设计。

未来自定义 UI 与本方案兼容：PR2 提供 Electron 壳层、Profile 组合和 Python Runtime；PR3 的平台中立 Adapter Client 才是独立 UI 复用股票 HTTP/SSE 能力的正式边界。

## 新对话开始步骤

1. 读取上述必读文档和根目录、frontend、packages 的 `AGENTS.md`。
2. 使用 `superpowers:executing-plans` 执行已有计划，不重新编写计划。
3. 检查分支、提交和工作区；不得提交、删除或覆盖用户已有的未跟踪文件。
4. 确认 PR1 合并提交 `e1707e1af5` 是当前分支祖先。
5. 从任务 7 开始：先创建并运行失败测试，保存 RED 证据后才能写 Runtime 实现。
6. 每个任务保持计划规定的文件、测试、命令和提交边界；每次提交前运行对应 focused gate 和 `git diff --check`。
7. PR2 完成后使用 `superpowers:requesting-code-review` 和 `superpowers:verification-before-completion`，所有 Critical/Important 关闭且验收证据新鲜后再推送和创建 Draft PR。

当前本地仓库根存在用户自己的未跟踪 `AGENTS.md`。它不属于 PR2，不得暂存、修改或删除。

## 新对话开场提示

复制以下内容到新对话：

> 请完整阅读 `docs/superpowers/handoffs/2026-08-21-dsh-investment-plugin-migration-pr2-handoff.md`、其中链接的已批准架构规格、详细实施计划 PR2 任务 7–15，以及适用的 `AGENTS.md`。PR1 已合并，架构不重新设计。请使用 `superpowers:executing-plans` 从任务 7 开始执行，严格遵守 TDD、文件范围、验证命令和提交边界；不要提前实施 PR3 的 adapter-client，也不要修改我未跟踪的文件。请先报告基线检查和任务 7 的 RED 计划，再开始实现。
