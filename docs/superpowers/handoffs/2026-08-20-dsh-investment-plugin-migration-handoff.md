# DSH 投研插件迁移 Handoff

> **历史交接提示：** 本文记录 PR1 实施前状态。PR1 已于 2026-08-21 合入 `master`；开始 PR2 时请改读 [DSH 投研插件迁移 PR2 交接](2026-08-21-dsh-investment-plugin-migration-pr2-handoff.md)。以下正文保留为原始调查记录，不再代表当前进度。

## 交接状态

- 日期：2026-08-20
- 仓库：`/Users/xiexin/project/pa-investment-research`
- 分支：`master`
- 架构规格：已确认
- 实施计划：尚未编写
- 业务代码迁移：尚未开始
- 当前目标：先生成可执行的详细实施计划，再按阶段迁移

本 Handoff 是新对话的入口，不替代架构规格或实施计划。

## 权威文档

首先完整阅读：

1. [DSH 投研插件归属、原生组合与 Python 运行时设计](../specs/2026-08-20-dsh-integration-boundary-design.md)
2. [frontend/AGENTS.md](../../../frontend/AGENTS.md)
3. [frontend/packages/AGENTS.md](../../../frontend/packages/AGENTS.md)
4. [frontend/packages/README.md](../../../frontend/packages/README.md)
5. [frontend/packages/bundle/README.md](../../../frontend/packages/bundle/README.md)
6. [frontend/packages/boot/app-boot/README.md](../../../frontend/packages/boot/app-boot/README.md)
7. [frontend/docs/defensive-patterns.md](../../../frontend/docs/defensive-patterns.md)，在设计子进程生命周期、并发和释放前阅读

若本文与架构规格冲突，以架构规格为准；若架构规格与 `frontend/AGENTS.md` 冲突，以后者为准并先报告冲突。

## 已确认的用户决策

1. 后端必须保持纯 Python。
2. 不创建顶层 `integrations/dsh`，避免 JavaScript/TypeScript 逻辑侵入仓库顶层。
3. 所有投研 dsh、Cordis、Node 和 TypeScript 代码迁入现有 `frontend` DeepSeek Harness workspace。
4. 投研业务实现放在 `frontend/packages/investment-research/*`。
5. Profile 装配包放在现有 `frontend/packages/bundle/*`，但 Bundle 只负责组合，不承载业务实现。
6. 当前通过 dsh Profile/Bundle 组合能力，不在本阶段引入 Agent Preset。
7. 当前自动启动 Profile 所依赖的 Python 服务；同时保留 `external` 模式连接外部服务。
8. 前端/dsh 使用 Profile 加载能力，Web UI 不直接导入业务插件。
9. 文档和后续沟通使用中文；代码标识、命令和包名保持英文。

## 目标目录

```text
backend/
├── dsh-trading-core/                      # 纯 Python
└── market-watch/                          # 纯 Python

frontend/
├── packages/
│   ├── investment-research/
│   │   ├── python-runtime/
│   │   ├── adapter-client/
│   │   ├── stock-analysis/
│   │   └── market-watch/
│   └── bundle/
│       ├── investment-runtime/
│       ├── investment-stock-analysis/
│       └── investment-market-watch/
└── apps/cli/                              # 注册 investment-research Profile 模板
```

不得创建：

```text
integrations/dsh/
```

## 目标包名

- `@deepseek-ai/dsh-investment-python-runtime`
- `@deepseek-ai/dsh-investment-adapter-client`
- `@deepseek-ai/dsh-investment-stock-analysis`
- `@deepseek-ai/dsh-investment-market-watch`
- `@deepseek-ai/dsh-investment-runtime-bundle`
- `@deepseek-ai/dsh-investment-stock-analysis-bundle`
- `@deepseek-ai/dsh-investment-market-watch-bundle`

所有新增包必须遵守 `frontend` 的 `packages/<group>/<pkg>`、ESM、TypeScript aggregate、workspace 依赖、README、JSDoc、invariant、真实组合测试和文档门禁规则。

## Profile 与 Bundle

完整 Profile 的顺序已经确定：

```text
investment-research
├── @deepseek-ai/dsh-base
├── @deepseek-ai/dsh-web-app
├── @deepseek-ai/dsh-investment-runtime-bundle
├── @deepseek-ai/dsh-investment-stock-analysis-bundle
└── @deepseek-ai/dsh-investment-market-watch-bundle
```

日常入口：

```sh
cd frontend
pnpm dsh --profile investment-research
```

配置验证入口：

```sh
cd frontend
pnpm dsh --profile investment-research --dump-config
```

实现时需要：

- 在 `frontend/packages/boot/app-boot/src/profile.ts` 的 `PROFILE_TEMPLATES` 注册 `investment-research`。
- 在 CLI 安装依赖闭包中声明三个 Bundle，避免依赖开发机偶然 hoist。
- 每个 Bundle 的 `package.json` 声明 `dsh.bundle.patch`。
- 每个 Bundle 的 Cordis 装配中引用的插件必须出现在该 Bundle 的 `dependencies`。
- Bundle 目录主要包含 `package.json`、`cordis.patch.yml`、README 和必要的装配测试；业务逻辑留在 `packages/investment-research`。

## Python Runtime 决策

Host Service 名称：

```text
ctx.investmentPythonRuntime
```

后端 id：

- `trading-core`
- `market-watch`

模式：

- `managed`：默认；自动定位解释器、启动、健康检查、记录日志和释放 owned child。
- `external`：只验证 Base URL，不启动或停止外部进程。

必须满足：

- macOS/Linux 使用 `env/bin/python`。
- Windows 使用 `env\\Scripts\\python.exe`。
- 并发获取同一后端采用 single-flight，只启动一次。
- 已存在且身份匹配的健康服务可以附着，但不获得其进程所有权。
- 端口被未知服务占用时失败，不终止未知进程。
- 后端 `.env` 只进入 Python 子进程，不合并到父 dsh 进程。
- 释放使用 `ctx.effect()`，只停止 owned child。
- 缺少虚拟环境时提示初始化，不在 dsh 启动期间自动安装依赖。
- `ADAPTER_RUNNER=fake|engine` 保持 Python 配置，不成为 Profile 维度。

## 当前代码位置

股票分析插件：

```text
backend/dsh-trading-core/dsh-plugin/
├── src/index.ts
├── src/client.ts
├── src/render.ts
├── src/brief-pusher.ts
├── test/plugin-load.smoke.ts
├── test/plugin.e2e.ts
├── package.json
├── package-lock.json
├── tsconfig.json
└── cordis.yml
```

盘中盯盘插件：

```text
backend/market-watch/dsh-plugin/
├── src/index.ts
├── src/client.ts
├── src/render.ts
├── test/plugin-load.smoke.ts
├── package.json
├── tsconfig.json
└── cordis.yml
```

这两处尚未迁移。

## 已确认的现存问题

- 两个 `cordis.yml` 都提交了 Windows `file:///C:/...` 绝对路径。
- 两个后端的 `init.sh` / `init.bat` 仍会执行插件 `npm install`。
- 两个后端的验证脚本仍进入 `dsh-plugin` 运行 Node 冒烟测试。
- 后端 README 和跨环境文档仍引用旧 `dsh-plugin` 路径与 `npx @deepseek-ai/dsh --patch` 方式。
- market-watch 启动脚本和 Windows 启动脚本仍直接管理 dsh patch。
- `frontend/pnpm-workspace.yaml` 仍有排除旧 `packages/dsh-trading-core` 的过时规则和注释。
- 股票插件的 `src/client.ts` 混合了 HTTP/SSE 与 dsh 专属 `agent.inject()`，不能直接作为纯客户端迁移。
- 股票插件的可选简报推送会枚举 Agent；未来若改为 Agent Preset，必须先处理 scope 隔离。当前 Profile 级加载下可以保留为显式配置，默认仍应关闭。

## 迁移阶段

### 阶段一：物理迁移和 frontend workspace 接入

- 使用 `git mv` 把两个插件迁到 `frontend/packages/investment-research`。
- 先保持运行行为不变，重写 package manifest、tsconfig、workspace 依赖和测试入口。
- 添加 Package Group README，并更新 packages 清单和中英文文档。
- 删除后端 npm 安装、Node 验证和旧插件路径引用。
- 删除 `frontend/pnpm-workspace.yaml` 的旧排除项。

### 阶段二：Bundle、Profile 与 Python Runtime

- 实现 Runtime Service 和 managed/external 生命周期。
- 创建三个可组合 Bundle。
- 注册 `investment-research` Profile。
- 让两个插件通过 Runtime lease 获取已验证 Base URL。
- 用 fake runner 完成无凭据真实组合测试。

### 阶段三：提取纯 Adapter Client

- 把股票 HTTP/SSE 逻辑迁入 `adapter-client`。
- dsh 插件只保留工具注册、`agent.inject()`、进度映射和渲染。
- 覆盖 SSE 分块、UTF-8、LF/CRLF、错误、超时和取消测试。

## frontend 强制约束

实施前必须遵守：

- 每个 npm 包名为 `@deepseek-ai/dsh-<name>`。
- 新组更新 `frontend/packages/README.md`；现有 bundle 组更新自己的 README。
- workspace 包依赖使用 `workspace:^`。
- function plugin 使用具名导出的 `name`、`inject`、`Config`、`apply`，不能混用 default export。
- 所有注册、定时器和子进程都进入 Cordis Effect 生命周期。
- 每个包加入正确的 TypeScript aggregate 和项目引用。
- 产品可见插件必须有真实 Loader/Cordis 组合测试。
- 新增模型可见行为需要 keyless snapshot。
- 覆盖率门禁是 `test:coverage`，不是普通 `test`。
- 非机械行为变更需要同一 PR 内的 Agent Note。
- 文档按 frontend 的中英文配对规则维护。
- 修改生命周期、并发和子进程前阅读 `frontend/docs/defensive-patterns.md`。

## 实施前仍需核实

这些是实施计划的前置调查，不是重新讨论架构：

1. 当前团队实际验证通过的 dsh 精确版本，以及现有 frontend workspace 版本是否就是部署基线。
2. trading-core 与 market-watch 的权威健康端点和服务身份字段。
3. 两个 Python 服务的准确启动模块、端口和关闭行为。
4. 现有插件测试中哪些可以机械迁移，哪些必须改造成 frontend 的真实组合测试。
5. Bundle 是否可以保持纯 patch-only 包；若需要运行时代码，必须说明由哪个职责要求。
6. 新包需要加入的 host aggregate、tsdown 输入、模块图、配置目录和文档生成器。

## 新对话的第一项工作

不要直接移动代码。先使用 `superpowers:writing-plans`，基于已批准规格创建详细实施计划：

```text
docs/superpowers/plans/2026-08-20-dsh-investment-plugin-migration-plan.md
```

计划必须：

- 把三个阶段拆成可独立验证和提交的任务。
- 列出每一步的精确文件路径。
- 遵守测试驱动开发，先写失败测试再实现行为。
- 包含 macOS/Windows 路径和子进程测试。
- 区分机械 `git mv` 与行为修改，避免一次提交混合两者。
- 明确每个阶段运行的最小充分验证命令。
- 在开始实施前交给用户批准。

## 推荐的新对话开场提示

复制以下内容到新对话：

> 请阅读 `docs/superpowers/handoffs/2026-08-20-dsh-investment-plugin-migration-handoff.md`、其中链接的架构规格，以及 `frontend/AGENTS.md` 和 `frontend/packages/AGENTS.md`。架构已经批准，不要重新设计，也不要立即改代码。先使用 writing-plans skill 编写中文详细实施计划，精确到文件、测试、命令和提交边界，交我批准后再执行。

## 相关提交

- `348e6cbc44`：初版边界设计
- `a68f2e5778`：改为 dsh 原生组合
- `cdcd1991fd`：设计文档中文化
- `f6624b4565`：最终改为 `frontend/packages` 投研包族

Handoff 提交会追加在上述提交之后。
