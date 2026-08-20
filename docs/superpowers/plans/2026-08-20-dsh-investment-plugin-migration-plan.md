# DSH 投资研究插件迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变已批准架构与 Python 业务 API 的前提下，把两个投研 dsh 插件迁入 `frontend` workspace，建立可组合的 Bundle/Profile 和安全的 Python Runtime，以 Electron 作为最终桌面调用入口，再把股票 HTTP/SSE 传输层提取成平台中立客户端。

**Architecture:** 保持 `backend/` 纯 Python；所有 Node、TypeScript、Cordis 与 dsh 组合代码归属 `frontend/packages/investment-research`。`ctx.investmentPythonRuntime` 统一管理 managed/external 后端租约、健康身份、进程所有权、日志与释放；三个 Bundle 由 `investment-research` Profile 按固定顺序组合；Electron 在该 Profile 之后继续应用现有 `apps/electron/electron.patch.yml`，以原生 IPC/目录选择器替换浏览器载体；股票插件最终只保留 dsh 工具注册、进度注入与渲染。

**Tech Stack:** Python 3 + FastAPI/Uvicorn；TypeScript 5、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`；Cordis、Schemastery、Vitest、tsdown；GitHub Actions 的 macOS/Windows 确定性矩阵。

**Spec:** `docs/superpowers/specs/2026-08-20-dsh-integration-boundary-design.md`

**Requirement amendment (2026-08-20):** 用户明确最终调用面必须基于 Electron。因此产品启动命令为 `dsh electron --profile investment-research`；仅用于检查合成配置的命令仍为 `dsh --profile investment-research --dump-default-config`。这是一项入口修正，不新增 Electron 专用 Bundle，也不改变已批准的五层 Profile 顺序。

**Status:** 用户已于 2026-08-20 批准实施。执行须遵守本计划的三 PR 顺序、任务验证与提交边界。

## Global Constraints

- 已批准架构是实施输入，不在执行中重开 Profile/Bundle/Runtime/目录边界设计。
- Electron 是最终产品壳层；不得把浏览器 Web server 入口作为交付入口。`dsh electron` 保持默认 `web` Profile 的向后兼容，投研桌面入口显式使用 `dsh electron --profile investment-research`。
- `investment-research` 仍包含 `@deepseek-ai/dsh-web-app`，因为 Electron 复用 Web 组合层；现有 `electron.patch.yml` 必须在五层 Profile 之后应用并禁用 web-startup、webserver、web-runtime、browser directory picker 与 browser connection，再启用 Electron 原生实现。
- 分成三个独立 PR；前一 PR 合并且门禁通过后才开始下一 PR。不得把阶段二或阶段三改动提前塞入阶段一。
- 阶段一用 `git mv` 保留历史；机械移动提交与行为修改提交分开。
- `backend/` 的最终纯 Python 定义：不得残留 `.ts`、`package.json`、npm/pnpm lock、Cordis patch、dsh 插件目录或 Node 安装/启动逻辑。
- 不创建顶层 `integrations/dsh`，不修改 dsh Web UI，不引入 Agent Preset。
- 新代码默认 TypeScript；用户文档和 Agent Note 同步维护英文、简体中文与 `.i18n.yaml` 三件套，代码、包名、命令、标识符和提交信息使用英文。
- 新包版本与 `frontend/package.json` 同步为 `0.1.0-rc.7`；workspace 内部依赖统一为 `workspace:^`；Host 包只加入 `tsconfig.host.json`。
- function plugin 只导出具名 `name`、`inject`、`Config`、`apply`，不得混用 default export。Runtime 是沿用现有 Service Provider 模式的 class plugin，具名导出并 default export 同一个 `InvestmentPythonRuntime` class。工具注册、定时器、后端注册、租约和子进程全部进入 Cordis Effect 生命周期。
- 产品可见插件必须通过真实 Loader/Cordis 组合测试；新增模型可见行为必须有 keyless snapshot；新/改源码以受影响文件为范围保持每文件 100% coverage。
- Runtime 不在父 Node 进程加载后端 `.env`。Python 子进程沿用后端现有 `load_dotenv`；父环境只显式转发非 secret 的 `ADAPTER_RUNNER`。
- Runtime 不执行依赖安装；缺失虚拟环境时给出对应 `init.sh`/`init.bat` 命令并失败。
- 只有当前 Runtime 创建且仍持有内存 `SubprocessHandle` 的进程才可终止。匹配健康身份的既有服务只附着、不接管；未知服务或端口冲突直接失败，绝不杀进程。
- adapter-client 的批准边界与 `frontend/AGENTS.md` 有一处窄冲突：包规范强制 Cordis peer 和依赖 `dsh-invariants` 的独立 `./invariant` 入口，而架构要求客户端不依赖 Cordis/dsh runtime。按 AGENTS 优先级，package metadata 保留这两个 peer/dev 声明，且只有隔离的 `src/invariant.ts` 可引用它们；客户端主入口及四个实现模块必须通过边界测试证明零 Cordis/dsh/React import、零浏览器全局读取。
- 每个非机械行为 PR 在同一 PR 内增加 implemented Agent Note；不改 archived notes。
- 文档更新先读 `frontend/docs/i18n/terminology.md`，一次完成双语对侧，并逐对运行 `pnpm run verify-translation-pairing --write <english-path>`。
- 每个提交前运行任务列出的最小验证。推送或标记 ready for review 前重新使用 `dsh-pre-push-checks`，以实际 PR base 执行 `pnpm --silent run change-scope --base <verified-base-ref>`。

## 已核实基线

- 根 worktree 当前干净；旧插件分别位于 `backend/dsh-trading-core/dsh-plugin` 和 `backend/market-watch/dsh-plugin`。
- frontend 当前基线为 `0.1.0-rc.7`；旧插件依赖 `0.0.1-rc.1`，迁移时切换到当前 workspace，不携带旧版本。
- 股票权威健康端点 `GET /health` 当前缺服务身份；先固定增加 `service: "trading-core"`。market-watch 已返回 `service: "market-watch"`。
- managed 命令固定为 `<venv-python> -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000 --log-level warning` 和 `<venv-python> -m uvicorn market_watch.app:app --host 127.0.0.1 --port 8100 --log-level warning`。
- `frontend/packages/subprocess/subprocess` 已提供 scrubbed environment、进程树终止与 quiescence；Runtime 复用 `ctx.subprocess`，不另写 `node:child_process` 管理器。
- 新包还需接入 workspace constraints、Knip、base paths、Host aggregate、CLI references、README model-experience allowlist 和生成文档。
- 当前 `dsh electron` 没有 `--profile` 参数，`apps/cli/src/electron.ts` 只启动 Electron app，且 `apps/electron/src/main.ts` 把 Profile 硬编码为 `web`；这是 Electron 投研入口必须补齐的唯一启动链缺口。
- 当前 `apps/electron/electron.patch.yml` 已正确复用 Web composition 并关闭浏览器载体、换入原生 IPC/目录选择器；本计划只让 Electron 主进程选择 Profile，不复制或重写该 patch。

## PR 与提交边界总览

| PR | 目标 | 提交顺序 |
| --- | --- | --- |
| PR 1 | 物理迁移与 workspace 接入 | Python 健康身份 → 纯 `git mv` → workspace 包与测试 → backend 纯 Python → 目录文档与 Agent Note |
| PR 2 | Runtime、Bundle、Profile、Electron 入口、跨平台组合 | Runtime 契约 → 生命周期 → 两业务插件接入 → 三 Bundle → Profile/Electron CLI → snapshot/双 OS CI → 文档与 Agent Note |
| PR 3 | 纯 Adapter Client | HTTP/错误 → SSE → Trading client → 股票插件切换 → snapshot 不变性 → 文档与 Agent Note |

---

# PR 1：物理迁移与 frontend workspace 接入

## Task 1：先固定 Python 健康身份契约

**Files:**

- Create: `backend/dsh-trading-core/tests/__init__.py`
- Create: `backend/dsh-trading-core/tests/test_health_contract.py`
- Create: `backend/market-watch/tests/__init__.py`
- Create: `backend/market-watch/tests/test_health_contract.py`
- Modify: `backend/dsh-trading-core/adapter/app.py`

**Interfaces:**

```json
{"service":"trading-core","status":"ok","runners":{"stock":"fake","holdings":"fake","brief":"fake"}}
```

```json
{"service":"market-watch","ok":true,"port":8100,"ts":0}
```

- [ ] 股票测试先设置 `ADAPTER_RUNNER=fake`、`BRIEF_SCHEDULE_ENABLED=false`，从 `create_app()` 的 `/health` route 直接调用 async endpoint，断言 service、status 和三个 runner 键。
- [ ] market-watch 测试设置 `MW_SCHEDULE_ENABLED=false`，直接调用 `health()`，断言 service 与 ok；不固定动态 `ts`。
- [ ] 运行失败测试：

```sh
cd backend/dsh-trading-core
env/bin/python -m unittest discover -s tests -p 'test_health_contract.py'
```

预期：股票测试因缺 `service` 失败。

```sh
cd backend/market-watch
env/bin/python -m unittest discover -s tests -p 'test_health_contract.py'
```

预期：market-watch 通过。Windows 用 `env\Scripts\python.exe` 执行等价命令。

- [ ] 只给股票 health 增加 `"service": "trading-core"`；不改路径、状态字段、runner 构造或业务 API。
- [ ] 重跑两个测试，预期全部通过。
- [ ] 提交：

```sh
git add backend/dsh-trading-core/adapter/app.py backend/dsh-trading-core/tests backend/market-watch/tests
git commit -m "test: pin investment backend health identities"
```

## Task 2：用纯机械提交保留文件历史

**Files:**

- Move: `backend/dsh-trading-core/dsh-plugin/README.md` → `frontend/packages/investment-research/stock-analysis/README.md`
- Move: `backend/dsh-trading-core/dsh-plugin/cordis.yml` → `frontend/packages/investment-research/stock-analysis/cordis.yml`
- Move: `backend/dsh-trading-core/dsh-plugin/package-lock.json` → `frontend/packages/investment-research/stock-analysis/package-lock.json`
- Move: `backend/dsh-trading-core/dsh-plugin/package.json` → `frontend/packages/investment-research/stock-analysis/package.json`
- Move: `backend/dsh-trading-core/dsh-plugin/src/brief-pusher.ts` → `frontend/packages/investment-research/stock-analysis/src/brief-pusher.ts`
- Move: `backend/dsh-trading-core/dsh-plugin/src/client.ts` → `frontend/packages/investment-research/stock-analysis/src/client.ts`
- Move: `backend/dsh-trading-core/dsh-plugin/src/index.ts` → `frontend/packages/investment-research/stock-analysis/src/index.ts`
- Move: `backend/dsh-trading-core/dsh-plugin/src/render.ts` → `frontend/packages/investment-research/stock-analysis/src/render.ts`
- Move: `backend/dsh-trading-core/dsh-plugin/test/plugin-load.smoke.ts` → `frontend/packages/investment-research/stock-analysis/test/plugin-load.smoke.ts`
- Move: `backend/dsh-trading-core/dsh-plugin/test/plugin.e2e.ts` → `frontend/packages/investment-research/stock-analysis/test/plugin.e2e.ts`
- Move: `backend/dsh-trading-core/dsh-plugin/tsconfig.json` → `frontend/packages/investment-research/stock-analysis/tsconfig.json`
- Move: `backend/market-watch/dsh-plugin/cordis.yml` → `frontend/packages/investment-research/market-watch/cordis.yml`
- Move: `backend/market-watch/dsh-plugin/package.json` → `frontend/packages/investment-research/market-watch/package.json`
- Move: `backend/market-watch/dsh-plugin/src/client.ts` → `frontend/packages/investment-research/market-watch/src/client.ts`
- Move: `backend/market-watch/dsh-plugin/src/index.ts` → `frontend/packages/investment-research/market-watch/src/index.ts`
- Move: `backend/market-watch/dsh-plugin/src/render.ts` → `frontend/packages/investment-research/market-watch/src/render.ts`
- Move: `backend/market-watch/dsh-plugin/test/plugin-load.smoke.ts` → `frontend/packages/investment-research/market-watch/test/plugin-load.smoke.ts`
- Move: `backend/market-watch/dsh-plugin/tsconfig.json` → `frontend/packages/investment-research/market-watch/tsconfig.json`

- [ ] 记录移动前清单与干净状态：

```sh
git ls-files backend/dsh-trading-core/dsh-plugin backend/market-watch/dsh-plugin
git status --short
```

- [ ] 只执行 `git mv`，本步骤不改内容：

```sh
mkdir -p frontend/packages/investment-research
git mv backend/dsh-trading-core/dsh-plugin frontend/packages/investment-research/stock-analysis
git mv backend/market-watch/dsh-plugin frontend/packages/investment-research/market-watch
```

- [ ] 检查：

```sh
git diff --find-renames=50% --summary
git diff --check
```

预期：旧源码和测试显示 rename，无 whitespace error。

- [ ] 提交：

```sh
git add -A backend/dsh-trading-core/dsh-plugin backend/market-watch/dsh-plugin frontend/packages/investment-research
git commit -m "refactor: move investment plugins into frontend"
```

## Task 3：把迁入代码改造成合规 Host workspace 包

**Files:**

- Modify: `frontend/packages/investment-research/stock-analysis/package.json`
- Modify: `frontend/packages/investment-research/stock-analysis/tsconfig.json`
- Create: `frontend/packages/investment-research/stock-analysis/src/invariant.ts`
- Delete: `frontend/packages/investment-research/stock-analysis/package-lock.json`
- Delete: `frontend/packages/investment-research/stock-analysis/cordis.yml`
- Move: `frontend/packages/investment-research/stock-analysis/test/plugin-load.smoke.ts` → `frontend/packages/investment-research/stock-analysis/tests/loader-composition.spec.ts`
- Move: `frontend/packages/investment-research/stock-analysis/test/plugin.e2e.ts` → `frontend/packages/investment-research/stock-analysis/tests/adapter.e2e.ts`
- Create: `frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`
- Create: `frontend/packages/investment-research/stock-analysis/tests/render.spec.ts`
- Create: `frontend/packages/investment-research/stock-analysis/tests/brief-pusher.spec.ts`
- Create: `frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- Modify: `frontend/packages/investment-research/market-watch/package.json`
- Modify: `frontend/packages/investment-research/market-watch/tsconfig.json`
- Create: `frontend/packages/investment-research/market-watch/src/invariant.ts`
- Delete: `frontend/packages/investment-research/market-watch/package-lock.json`
- Delete: `frontend/packages/investment-research/market-watch/cordis.yml`
- Move: `frontend/packages/investment-research/market-watch/test/plugin-load.smoke.ts` → `frontend/packages/investment-research/market-watch/tests/loader-composition.spec.ts`
- Create: `frontend/packages/investment-research/market-watch/tests/client.spec.ts`
- Create: `frontend/packages/investment-research/market-watch/tests/render.spec.ts`
- Create: `frontend/packages/investment-research/market-watch/tests/plugin.spec.ts`
- Modify: `frontend/tsconfig.base.json`
- Modify: `frontend/tsconfig.host.json`
- Modify: `frontend/pnpm-workspace.yaml`
- Modify: `frontend/pnpm-lock.yaml`

**Preserved function-plugin API:**

```ts
export const name = 'investment-stock-analysis'
export const inject = ['tools', 'agents']
export interface Config {
  adapterBaseUrl?: string
  streamTimeoutMs?: number
  enableInChatPush?: boolean
  pushPollMs?: number
  pushSessions?: string[]
}
export const apply: (ctx: Context, config: Config) => void
```

```ts
export const name = 'investment-market-watch'
export const inject = ['tools']
export interface Config { adapterBaseUrl?: string }
export const apply: (ctx: Context, config: Config) => void
```

- [ ] 先把 mock smoke 改成真实 Loader 测试：临时 Cordis 配置按包名挂载真实 `ToolRuntime` 和插件，断言股票 9 个、盯盘 11 个 schema；dispose 后注册清空。禁止只用手工 `ctx.plugin()` 作为验收。
- [ ] 补 characterization tests：客户端固定 method/path/body 与现有 SSE/JSON 行为；render 固定成功/空字段/中文/错误；brief pusher 固定默认关闭、轮询、allowlist/disposer；plugin 固定 schema、参数映射、错误渲染和具名导出。
- [ ] 先运行：

```sh
cd frontend
pnpm exec vitest run \
  packages/investment-research/stock-analysis/tests \
  packages/investment-research/market-watch/tests \
  --coverage \
  --coverage.include='packages/investment-research/stock-analysis/src/**/*.ts' \
  --coverage.include='packages/investment-research/market-watch/src/**/*.ts'
```

预期：旧脚本不是 Vitest suite、Loader fixture 缺失或 package resolution 失败。

- [ ] package names 改为 `@deepseek-ai/dsh-investment-stock-analysis`、`@deepseek-ai/dsh-investment-market-watch`，版本 `0.1.0-rc.7`，补 publishConfig/repository/main/types/exports/files/license/`./invariant`。
- [ ] 股票 peer/dev 精确声明 Cordis、dsh-agent、dsh-invariants、dsh-llm、dsh-session、dsh-tools；market 声明 Cordis、invariants、session、tools；Schemastery 放 dependencies；全部 `workspace:^`。
- [ ] tsconfig 使用 `../../../tsconfig.base.json`、`rootDir: src`、`outDir: lib/types`，references 覆盖 peer 源工程与 vendor Cordis/Schemastery；tests 不进入 emit。
- [ ] 每包加 no-op invariant companion，说明阶段一所有注册已由当前 Cordis effect 所有，没有额外跨服务关系。
- [ ] base paths 两组分别加入 `./packages/investment-research/*/src/invariant.ts` 与 `./packages/investment-research/*/src`；Host aggregate 加两个 reference；删除 workspace 旧排除；`pnpm install --lockfile-only` 更新唯一 lock。
- [ ] 只做严格类型与测试可注入性的等价整理；不得提取 client、启动 Python、改工具名称/description/schema/render。
- [ ] 重跑 focused coverage，要求每文件 100%，再运行：

```sh
pnpm run typecheck
pnpm run constraints
pnpm run verify-cordis-config
```

- [ ] 提交：

```sh
git add frontend/packages/investment-research frontend/tsconfig.base.json frontend/tsconfig.host.json frontend/pnpm-workspace.yaml frontend/pnpm-lock.yaml
git commit -m "build: register investment research packages"
```

## Task 4：清除 backend 的 Node/dsh 管理职责

**Files:**

- Modify: `backend/dsh-trading-core/init.sh`
- Modify: `backend/dsh-trading-core/init.bat`
- Modify: `backend/dsh-trading-core/verify.sh`
- Modify: `backend/dsh-trading-core/verify.bat`
- Modify: `backend/dsh-trading-core/start.sh`
- Modify: `backend/dsh-trading-core/start_all.bat`
- Modify: `backend/dsh-trading-core/stop_all.sh`
- Modify: `backend/dsh-trading-core/stop_all.bat`
- Modify: `backend/market-watch/init.sh`
- Modify: `backend/market-watch/init.bat`
- Modify: `backend/market-watch/verify.sh`
- Modify: `backend/market-watch/verify.bat`
- Modify: `backend/market-watch/start.sh`
- Modify: `backend/market-watch/start_all.bat`
- Modify: `backend/market-watch/stop_all.sh`
- Modify: `backend/market-watch/stop_all.bat`
- Modify: `backend/dsh-trading-core/README.md`
- Modify: `backend/dsh-trading-core/docs/前端接入指南.md`
- Modify: `backend/dsh-trading-core/docs/跨环境运行.md`
- Modify: `backend/dsh-trading-core/docs/风险偏好分析框架.md`
- Modify: `backend/market-watch/README.md`

- [ ] 先保存失败输出：

```sh
rg -n 'dsh-plugin|npx @deepseek-ai/dsh|--patch|:3080|:3081' backend
```

- [ ] init 只建 venv、装 requirements、验证 Python import；verify 只跑 health unittest 与 Python import；删除 npm/npx/tsx。
- [ ] start 只启动各自 Uvicorn。股票保留后端参数 `ADAPTER_RUNNER=fake|engine`；删除 dsh 端口、patch、浏览器打开与 Node cwd。
- [ ] stop 只处理 Python 端口 8000/8100；它是手动 backend wrapper，不替代阶段二 Runtime 的 owned-handle 规则。
- [ ] 文档把源码链接改为 frontend 新路径。统一产品命令 `dsh electron --profile investment-research` 标注“阶段二交付”；backend 当前运行步骤只写 Python。
- [ ] 验证：

```sh
rg -n 'dsh-plugin|npx @deepseek-ai/dsh|--patch|:3080|:3081' backend
test -z "$(rg --files backend | rg '(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|cordis\.ya?ml)$|\.tsx?$')"
```

预期：第一条无匹配，第二条成功。另跑两个 backend unittest。

- [ ] 提交：

```sh
git add backend
git commit -m "refactor: keep investment backends Python-only"
```

## Task 5：阶段一目录文档、生成目录与 Agent Note

**Files:**

- Create: `frontend/packages/investment-research/README.md`
- Create: `frontend/packages/investment-research/README.zh.md`
- Create: `frontend/packages/investment-research/README.i18n.yaml`
- Rewrite: `frontend/packages/investment-research/stock-analysis/README.md`
- Create: `frontend/packages/investment-research/stock-analysis/README.zh.md`
- Create: `frontend/packages/investment-research/stock-analysis/README.i18n.yaml`
- Create: `frontend/packages/investment-research/market-watch/README.md`
- Create: `frontend/packages/investment-research/market-watch/README.zh.md`
- Create: `frontend/packages/investment-research/market-watch/README.i18n.yaml`
- Modify: `frontend/packages/README.md`
- Modify: `frontend/packages/README.zh.md`
- Modify: `frontend/packages/README.i18n.yaml`
- Modify: `frontend/docs/tool-catalog.md`
- Modify: `frontend/docs/tool-catalog.zh.md`
- Modify: `frontend/docs/tool-catalog.i18n.yaml`
- Modify: `frontend/docs/config-catalog.md`
- Modify: `frontend/docs/config-catalog.zh.md`
- Modify: `frontend/docs/config-catalog.i18n.yaml`
- Modify: `frontend/docs/module-graph.md`
- Modify: `frontend/docs/module-graph.zh.md`
- Modify: `frontend/docs/module-graph.i18n.yaml`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-research-package-ownership.md`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-research-package-ownership.zh.md`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-research-package-ownership.i18n.yaml`

- [ ] 先跑 `pnpm run doc-sync`，预期因缺 README 配对、目录索引和 generated catalog 漂移失败。
- [ ] 组 README 只描述阶段一已有的 stock/market；包 README 写工具、配置、effect、错误、model-visible behavior、限制和测试，不预先宣称 Runtime/Profile/client 已实现。
- [ ] 更新 packages root，运行：

```sh
pnpm run gen-tool-catalog
pnpm run gen-config-catalog
pnpm run gen-module-graph
```

- [ ] 同步中文；Agent Note 记录 frontend 归属、阶段一不改启动行为、机械 rename 与 package 接入边界。
- [ ] 对上述每个英文源逐一运行 pairing `--write`，再运行 `pnpm run doc-sync` 和 `pnpm run lint`。
- [ ] 提交：

```sh
git add frontend/packages frontend/docs frontend/.agents/notes/implemented/architecture
git commit -m "docs: document investment package ownership"
```

## Task 6：PR 1 验收

- [ ] 从根目录验证纯 Python 与 history follow；从 frontend 运行：

```sh
pnpm run typecheck
pnpm exec vitest run packages/investment-research/stock-analysis/tests packages/investment-research/market-watch/tests \
  --coverage \
  --coverage.include='packages/investment-research/stock-analysis/src/**/*.ts' \
  --coverage.include='packages/investment-research/market-watch/src/**/*.ts'
pnpm run build
pnpm run hygiene
pnpm run doc-sync
```

- [ ] 检查 PR diff 只有阶段一文件，无 Runtime/Bundle/Profile/adapter-client；PR 标题 `refactor: move investment plugins into frontend workspace`。合并且 CI 通过后开始 PR 2。

---

# PR 2：Python Runtime、Bundle、Profile 与跨平台组合

## Task 7：以失败测试定义 Runtime 公共契约与路径解析

**Files:**

- Create: `frontend/packages/investment-research/python-runtime/package.json`
- Create: `frontend/packages/investment-research/python-runtime/tsconfig.json`
- Create: `frontend/packages/investment-research/python-runtime/src/types.ts`
- Create: `frontend/packages/investment-research/python-runtime/src/path.ts`
- Create: `frontend/packages/investment-research/python-runtime/src/health.ts`
- Create: `frontend/packages/investment-research/python-runtime/src/index.ts`
- Create: `frontend/packages/investment-research/python-runtime/src/invariant.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/path.spec.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/health.spec.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/public-api.spec.ts`
- Modify: `frontend/tsconfig.base.json`
- Modify: `frontend/tsconfig.host.json`
- Modify: `frontend/pnpm-lock.yaml`

**Interfaces:**

```ts
import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

export type InvestmentBackendId = 'trading-core' | 'market-watch'
export type InvestmentBackendMode = 'managed' | 'external'

export interface PythonBackendDefinition {
  readonly id: InvestmentBackendId
  readonly service: InvestmentBackendId
  readonly mode: InvestmentBackendMode
  readonly baseUrl: string
  readonly projectDir?: string
  readonly repositoryPath: readonly string[]
  readonly module: 'adapter.app:app' | 'market_watch.app:app'
  readonly healthPath: '/health'
  readonly healthOk: Readonly<Record<string, string | boolean>>
  readonly initCommand: Readonly<{ posix: './init.sh'; windows: 'init.bat' }>
  readonly managedEnv?: Readonly<Record<string, string | undefined>>
}

export interface PythonBackendLease {
  readonly id: InvestmentBackendId
  readonly baseUrl: string
  readonly ownership: 'owned' | 'attached' | 'external'
  release(): Promise<void>
}

export interface Config {
  dshHome?: string
  startupTimeoutMs?: number
  healthPollMs?: number
  shutdownGraceMs?: number
  logTailBytes?: number
  logMaxBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    investmentPythonRuntime: InvestmentPythonRuntime
  }
}

export declare class InvestmentPythonRuntime extends Service {
  static inject: readonly ['subprocess']
  static Config: z<Config>
  constructor(ctx: Context, config?: Config)
  register(definition: PythonBackendDefinition): () => void
  acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease>
}

export default InvestmentPythonRuntime
```

- [ ] public API test 断言 Context merge 暴露 `investmentPythonRuntime`，`register()` 返回 disposer，`acquire()` 返回幂等 release lease，Config schema 明示全部 tunable。
- [ ] path test 用 `path.posix`/`path.win32` 表覆盖 `env/bin/python`、`env\\Scripts\\python.exe`、含空格/中文路径、显式 projectDir 优先、从包安装位置向上找 repo backend、完全不读 cwd；managed baseURL 只接受 loopback HTTP，并从 URL 解析 Uvicorn host/port，external 可使用显式远端 HTTP(S) URL。
- [ ] health test 注入 fetch，固定 matching、HTTP 非 2xx、身份不匹配、ECONNREFUSED。只有 ECONNREFUSED 可允许 managed spawn；连接重置/协议错误均为未知占用。
- [ ] 先运行 focused coverage，预期模块不存在：

```sh
pnpm exec vitest run \
  packages/investment-research/python-runtime/tests/path.spec.ts \
  packages/investment-research/python-runtime/tests/health.spec.ts \
  packages/investment-research/python-runtime/tests/public-api.spec.ts \
  --coverage \
  --coverage.include='packages/investment-research/python-runtime/src/types.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/path.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/health.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/index.ts'
```

- [ ] 建 package scaffold；peer/dev 声明 Cordis、invariants、subprocess，dependencies 声明 atomic-write、home-paths、timeout、Schemastery；全部 `workspace:^`。
- [ ] `path.ts` 只用 Node path/fs/import.meta.url；找不到 backend 时同时给出显式 `projectDir` 解法。`health.ts` 返回 `healthy | refused | occupied | unavailable` 判别联合，不把普通网络错当空闲。
- [ ] `index.ts` 导出类型/纯函数与 `InvestmentPythonRuntime extends Service` 签名；不得用空方法让测试假绿。
- [ ] 接入 base paths、Host aggregate、lock，重跑 focused coverage 与 typecheck。
- [ ] 提交：

```sh
git add frontend/packages/investment-research/python-runtime frontend/tsconfig.base.json frontend/tsconfig.host.json frontend/pnpm-lock.yaml
git commit -m "feat: define investment Python runtime contract"
```

## Task 8：实现 single-flight、进程所有权、日志与 quiescent teardown

**Files:**

- Create: `frontend/packages/investment-research/python-runtime/src/log.ts`
- Create: `frontend/packages/investment-research/python-runtime/src/state.ts`
- Create: `frontend/packages/investment-research/python-runtime/src/runtime.ts`
- Modify: `frontend/packages/investment-research/python-runtime/src/index.ts`
- Modify: `frontend/packages/investment-research/python-runtime/src/invariant.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/runtime.spec.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/log.spec.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/state.spec.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/fixtures/fake-handle.ts`

```ts
interface OwnedBackendState {
  readonly version: 1
  readonly id: InvestmentBackendId
  readonly service: InvestmentBackendId
  readonly pid: number
  readonly baseUrl: string
  readonly projectDir: string
  readonly startedAt: string
}
```

- [ ] 先用 fake SubprocessRuntime 写失败测试：同 id 并发 acquire 只 spawn 一次；lease refcount；external 不 spawn；匹配服务 attached 且不 kill；身份不匹配/未知端口不 spawn；同定义重复注册可计数、冲突定义失败。
- [ ] 覆盖 managed 失败：venv 缺失 init 指引、child 早退带 bounded tail、启动超时、健康不匹配、最后 lease release、Context dispose 阻止新 acquire 并 await process tree 退出。
- [ ] state test 固定 `$DSH_HOME/investment-research/<id>/runtime.json`，atomic mode `0600`/dir `0700`；旧 state 只诊断，绝不按其中 pid 杀进程；owned release 清匹配 state。
- [ ] log test 固定 `backend.log`、来源前缀、内存 tail、`logMaxBytes` 前轮转 `.previous.log`、错误不泄露 env value。
- [ ] 实现 per-id registry + single-flight promise + refcount。Schema 默认显式为 startup 30000ms、poll 250ms、grace 5000ms、tail 65536 bytes、log max 4194304 bytes。
- [ ] managed 顺序：health → matching attach → 只有 refused 才 resolve project/venv → `ctx.subprocess.spawn` → deadline poll → atomic state → lease。argv 数组直传，不经 shell。
- [ ] 只显式传 definition 中的 ADAPTER_RUNNER；不读 dotenv。release/dispose 只终止内存 owned handle，使用 handle terminate/waitForExit；不按端口或旧 pid 查杀。
- [ ] invariant 检查 owned entry/live handle、attached 无 handle、lease 非负、single-flight/running 不重叠。
- [ ] 运行：

```sh
pnpm exec vitest run \
  packages/investment-research/python-runtime/tests/runtime.spec.ts \
  packages/investment-research/python-runtime/tests/log.spec.ts \
  packages/investment-research/python-runtime/tests/state.spec.ts \
  --coverage \
  --coverage.include='packages/investment-research/python-runtime/src/runtime.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/log.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/state.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/index.ts' \
  --coverage.include='packages/investment-research/python-runtime/src/invariant.ts'
```

预期：每文件 100%，dispose 后无 open handle。

- [ ] 提交：

```sh
git add frontend/packages/investment-research/python-runtime
git commit -m "feat: manage investment Python backends safely"
```

## Task 9：股票插件通过 Runtime 获取后端

**Files:**

- Modify: `frontend/packages/investment-research/stock-analysis/package.json`
- Modify: `frontend/packages/investment-research/stock-analysis/tsconfig.json`
- Modify: `frontend/packages/investment-research/stock-analysis/src/index.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/src/brief-pusher.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/loader-composition.spec.ts`
- Create: `frontend/packages/investment-research/stock-analysis/tests/runtime-composition.spec.ts`

```ts
export interface Config {
  backendMode?: 'managed' | 'external'
  backendBaseUrl?: string
  backendProjectDir?: string
  streamTimeoutMs?: number
  enableInChatPush?: boolean
  pushPollMs?: number
  pushSessions?: string[]
}

const tradingBackend = (config: Config): PythonBackendDefinition => ({
  id: 'trading-core',
  service: 'trading-core',
  mode: config.backendMode ?? 'managed',
  baseUrl: config.backendBaseUrl ?? 'http://127.0.0.1:8000',
  projectDir: config.backendProjectDir,
  repositoryPath: ['backend', 'dsh-trading-core'],
  module: 'adapter.app:app',
  healthPath: '/health',
  healthOk: { status: 'ok' },
  initCommand: { posix: './init.sh', windows: 'init.bat' },
  managedEnv: process.env.ADAPTER_RUNNER === undefined
    ? {}
    : { ADAPTER_RUNNER: process.env.ADAPTER_RUNNER },
})
```

- [ ] 先改测试：inject 含 runtime；工具注册前收到固定 `trading-core` definition；acquire 失败零工具；dispose 顺序为工具/pusher → lease → unregister。
- [ ] 增 runtime peer/dev/reference。默认 managed、base URL `http://127.0.0.1:8000`；definition 固定 module/health/repo path/init。ADAPTER_RUNNER 不进入 Profile schema。
- [ ] 一个 async effect 内 register/acquire；只把 lease baseURL 交给现有 client。setup 失败回滚；默认 push 仍 false。
- [ ] 重跑 stock coverage 和真实 Loader test，提交：

```sh
git add frontend/packages/investment-research/stock-analysis frontend/pnpm-lock.yaml
git commit -m "feat: acquire the trading backend through runtime"
```

## Task 10：market-watch 插件通过 Runtime 获取后端

**Files:**

- Modify: `frontend/packages/investment-research/market-watch/package.json`
- Modify: `frontend/packages/investment-research/market-watch/tsconfig.json`
- Modify: `frontend/packages/investment-research/market-watch/src/index.ts`
- Modify: `frontend/packages/investment-research/market-watch/tests/plugin.spec.ts`
- Modify: `frontend/packages/investment-research/market-watch/tests/loader-composition.spec.ts`
- Create: `frontend/packages/investment-research/market-watch/tests/runtime-composition.spec.ts`

```ts
export interface Config {
  backendMode?: 'managed' | 'external'
  backendBaseUrl?: string
  backendProjectDir?: string
}

const marketWatchBackend = (config: Config): PythonBackendDefinition => ({
  id: 'market-watch',
  service: 'market-watch',
  mode: config.backendMode ?? 'managed',
  baseUrl: config.backendBaseUrl ?? 'http://127.0.0.1:8100',
  projectDir: config.backendProjectDir,
  repositoryPath: ['backend', 'market-watch'],
  module: 'market_watch.app:app',
  healthPath: '/health',
  healthOk: { ok: true },
  initCommand: { posix: './init.sh', windows: 'init.bat' },
})
```

- [ ] 先写对称失败测试，固定 id/service `market-watch`、module `market_watch.app:app`、base `http://127.0.0.1:8100`，acquire 后才注册 11 tools。
- [ ] 增 runtime peer/dev/reference，在一个 effect 完成 register/acquire/tool disposer/release/unregister。market client 留在插件内。
- [ ] 重跑 market coverage 和 Loader composition，提交：

```sh
git add frontend/packages/investment-research/market-watch frontend/pnpm-lock.yaml
git commit -m "feat: acquire the market backend through runtime"
```

## Task 11：创建三个可独立增删的 Bundle

**Files:**

- Create: `frontend/packages/investment-research/runtime-bundle/package.json`
- Create: `frontend/packages/investment-research/runtime-bundle/tsconfig.json`
- Create: `frontend/packages/investment-research/runtime-bundle/cordis.patch.yml`
- Create: `frontend/packages/investment-research/runtime-bundle/src/index.ts`
- Create: `frontend/packages/investment-research/runtime-bundle/src/invariant.ts`
- Create: `frontend/packages/investment-research/runtime-bundle/tests/bundle.spec.ts`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/package.json`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/tsconfig.json`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/cordis.patch.yml`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/src/index.ts`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/src/invariant.ts`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/tests/bundle.spec.ts`
- Create: `frontend/packages/investment-research/market-watch-bundle/package.json`
- Create: `frontend/packages/investment-research/market-watch-bundle/tsconfig.json`
- Create: `frontend/packages/investment-research/market-watch-bundle/cordis.patch.yml`
- Create: `frontend/packages/investment-research/market-watch-bundle/src/index.ts`
- Create: `frontend/packages/investment-research/market-watch-bundle/src/invariant.ts`
- Create: `frontend/packages/investment-research/market-watch-bundle/tests/bundle.spec.ts`
- Modify: `frontend/scripts/check-workspace-constraints.ts`
- Modify: `frontend/knip.json`
- Modify: `frontend/tsconfig.host.json`
- Modify: `frontend/pnpm-lock.yaml`

**Patch rows:**

```yaml
- id: investment-python-runtime
  name: '@deepseek-ai/dsh-investment-python-runtime'
```

```yaml
- id: investment-stock-analysis
  name: '@deepseek-ai/dsh-investment-stock-analysis'
```

```yaml
- id: investment-market-watch
  name: '@deepseek-ai/dsh-investment-market-watch'
```

- [ ] 每个 bundle 先写失败测试：name 精确、`dsh.bundle.patch`、patch 只插自己的 row、row name 在 dependencies。业务 bundle 还直接依赖 python-runtime 以闭合 injected peer。
- [ ] 按 patch-only bundle 模式实现三个公开包：`@deepseek-ai/dsh-investment-runtime-bundle`、`...stock-analysis-bundle`、`...market-watch-bundle`。空 index；invariant 说明静态 patch carrier。
- [ ] packageFileExtras 加三个 patch；Knip 为三个目录忽略 YAML-only `@deepseek-ai/.+`；Host aggregate 加 reference。
- [ ] 运行：

```sh
pnpm exec vitest run packages/investment-research/*-bundle/tests/bundle.spec.ts
pnpm run verify-cordis-config
pnpm run constraints
pnpm run knip
```

- [ ] 提交：

```sh
git add frontend/packages/investment-research/*-bundle frontend/scripts/check-workspace-constraints.ts frontend/knip.json frontend/tsconfig.host.json frontend/pnpm-lock.yaml
git commit -m "feat: add investment research bundles"
```

## Task 12：注册 Profile、贯通 Electron 启动参数并闭合安装依赖

**Files:**

- Modify: `frontend/packages/boot/app-boot/src/profile.ts`
- Modify: `frontend/packages/boot/app-boot/tests/profile.spec.ts`
- Modify: `frontend/apps/cli/package.json`
- Modify: `frontend/apps/cli/tsconfig.json`
- Modify: `frontend/apps/cli/src/args.ts`
- Modify: `frontend/apps/cli/src/bin.ts`
- Modify: `frontend/apps/cli/src/electron.ts`
- Modify: `frontend/apps/cli/tests/args.spec.ts`
- Modify: `frontend/apps/cli/tests/built-bin.e2e.ts`
- Modify: `frontend/apps/cli/tests/electron-launch.spec.ts`
- Modify: `frontend/apps/electron/package.json`
- Modify: `frontend/apps/electron/tsconfig.json`
- Create: `frontend/apps/electron/src/args.ts`
- Modify: `frontend/apps/electron/src/main.ts`
- Create: `frontend/apps/electron/tests/args.spec.ts`
- Modify: `frontend/apps/electron/tests/main-startup.spec.ts`
- Modify: `frontend/pnpm-lock.yaml`

**Exact template value:**

```ts
'investment-research': [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-investment-runtime-bundle',
  '@deepseek-ai/dsh-investment-stock-analysis-bundle',
  '@deepseek-ai/dsh-investment-market-watch-bundle',
]
```

**Electron invocation contract:**

```ts
interface ElectronInvocation {
  mode: 'electron'
  profile: string
}

interface ElectronLaunchOptions {
  profile?: string
  appDir?: string
}

export function resolveElectronProfile(argv?: readonly string[]): string
export function runElectronApplication(options?: ElectronLaunchOptions): Promise<number>
```

**End-to-end startup semantics:**

```text
dsh electron --profile investment-research
  -> CLI launches the Electron executable and forwards the selected Profile
  -> Electron main calls runProfile(profile = "investment-research")
  -> app-boot loads base + web-app + runtime bundle + stock bundle + market bundle
  -> electron.patch.yml disables browser/Web-server carriers and enables Electron native IPC
  -> Electron window exposes the 9 stock-analysis tools and 11 market-watch tools
```

这里的 `web-app` 是 Electron 复用的 UI/组合基础层，不代表另外启动浏览器版产品；验收必须证明 webserver 未启动且最终 renderer connection 为 Electron 原生实现。

- [ ] profile.spec 先固定 auto-init 顺序、staged install 三 patch、移除 stock bundle 后 runtime+market 可组合、缺 runtime 时业务插件明确 injection 失败。
- [ ] built-bin config dump 加 investment profile，断言五个 layer 注释顺序、runtime row 在业务 row 前、无 machine-specific file URL。
- [ ] 修改 template；CLI dependencies/references 加三个 bundles；更新 lock。无需改 profile-boot。
- [ ] CLI args 测试先固定：`dsh electron` 解析为 `{ mode: 'electron', profile: 'web' }`；`dsh electron --profile investment-research` 解析为投研 Profile；缺少值、空值和重复 `--profile` 明确失败；父命令位置的 `dsh --profile ... electron` 继续拒绝，避免两套语法。
- [ ] 把 Electron 子命令增加 `--profile <name>`，默认值 `web`；`bin.ts` 把所选 Profile 显式传给 `runElectronApplication({ profile })`。launcher 启动参数固定为 `[appDir, '--profile', profile]`，不通过隐式全局状态或用户 shell 环境传递。
- [ ] 新建 Electron 侧窄参数解析器：从 `process.argv` 中查找唯一的 `--profile <non-empty-name>`，忽略 Electron 自身 executable/appDir 参数，缺省返回 `web`，重复或缺值抛出可诊断错误。`main.ts` 用解析结果替换当前硬编码的 `profile: 'web'`，仍保持 `patchFiles: [ELECTRON_PATCH]`。
- [ ] `electron-launch.spec.ts` 的 fixture 记录子进程 argv，证明 `investment-research` 从 CLI launcher 传入 Electron；Electron `args.spec.ts` 覆盖缺省、显式、重复、缺值；`main-startup.spec.ts` 在导入主进程前设置 argv，断言 `runProfile({ profile: 'investment-research', patchFiles: [ELECTRON_PATCH], ... })`。
- [ ] `apps/electron/package.json` 与 `tsconfig.json` 直接加入三个投研 Bundle 的 runtime dependency/reference，保证以 Electron manifest 为 `installAnchor` 的 pnpm 严格布局与打包产物都能解析 Profile；不能只依赖 CLI 的传递依赖或 workspace hoist。
- [ ] 运行：

```sh
pnpm exec vitest run \
  packages/boot/app-boot/tests/profile.spec.ts \
  apps/cli/tests/args.spec.ts \
  apps/cli/tests/electron-launch.spec.ts \
  apps/electron/tests/args.spec.ts \
  apps/electron/tests/main-startup.spec.ts
pnpm run build
pnpm exec vitest run apps/cli/tests/built-bin.e2e.ts -t 'investment-research'
```

`built-bin.e2e.ts` 只用根命令验证可重复的配置 dump；Electron 进程传参由上述 launcher/main tests 验证，不在无显示器的单测 lane 打开 BrowserWindow。

- [ ] 提交：

```sh
git add frontend/packages/boot/app-boot frontend/apps/cli frontend/apps/electron frontend/pnpm-lock.yaml
git commit -m "feat: launch the investment profile in Electron"
```

## Task 13：keyless snapshot 与 macOS/Windows managed 矩阵

**Files:**

- Create: `frontend/packages/investment-research/python-runtime/tests/fixtures/fake-project/uvicorn/__main__.py`
- Create: `frontend/packages/investment-research/python-runtime/tests/fixtures/fake-project/fake_service.py`
- Create: `frontend/packages/investment-research/python-runtime/tests/managed-fake-runner.e2e.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/profile-composition.e2e.ts`
- Create: `frontend/packages/investment-research/python-runtime/tests/managed-engine.smoke.ts`
- Create: `frontend/apps/electron/tests/investment-profile.e2e.ts`
- Create: `frontend/examples/headless-agent/investment-research.cordis.snapshot.yml`
- Create: `frontend/examples/headless-agent/tests/fixtures/investment-adapters.ts`
- Create: `frontend/examples/headless-agent/tests/snapshots/investment-research/input.json`
- Create: `frontend/examples/headless-agent/tests/snapshots/investment-research/session.jsonl`
- Create: `frontend/examples/headless-agent/tests/snapshots/investment-research/stream-json.expected.jsonl`
- Modify: `frontend/examples/headless-agent/tests/headless.snapshot.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/.github/workflows/ci.yml`
- Create: `frontend/.github/workflows/investment-engine-smoke.yml`

- [ ] managed e2e 在带空格 temp project 创建真实 venv，复制 stdlib-only fake uvicorn/service；用真实 LocalSubprocessRuntime 验证 fake env、health、log/state、release 端口关闭、state 清理、无残留树。
- [ ] profile composition 用两个 project/port 由真实 Loader 挂载 runtime+stock+market，调用至少一个股票和一个盯盘工具；另测 external attach、未知 identity、bundle 删除、Profile dump。
- [ ] Electron composition e2e 不打开窗口：用真实 Loader 合成 `investment-research` 五层 Profile，再按生产顺序应用 `apps/electron/electron.patch.yml`；断言 web-startup、webserver、web-runtime、browser directory picker 与 browser connection 被禁用，Electron connection/native directory picker 生效，runtime+stock+market 仍加载且 20 个投研工具可见。该测试同时证明 Electron 复用 Web 组合层，而不是启动 Web server。
- [ ] 测试从 `DSH_INVESTMENT_TEST_PYTHON` 获取建 venv 的解释器；普通 unit lane未设置时 skip，矩阵设置后不得 skip。
- [ ] keyless snapshot 用 llm-replay 固定一次股票与一次盯盘工具调用；测试内启 deterministic fake HTTP/SSE adapters；固定 schema、progress 与 Markdown。先用已提交 replay fixture 做 keyless refresh，再只读 replay：

```sh
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'investment research'
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'investment research'
```

只有评审明确要求更换模型 transcript 时才运行仓库现有 `pnpm run test:snapshot:record -- -t 'investment research'`；普通实现与阶段三纯重构不得 record。

- [ ] root 增 `test:investment-runtime:matrix`。CI 增 `investment-runtime-matrix`，OS 为 macos-latest/windows-latest，Node 24 + Python 3.10 + immutable install + build + 该脚本；纳入 all-checks-passed needs。
- [ ] 手动 engine workflow 同为 macOS/Windows：分别在两个 backend 创建名为 `env` 的 venv 并用该 venv Python 安装各自 requirements；设置 `ADAPTER_RUNNER=engine`、关闭两个 scheduler，执行 `DSH_INVESTMENT_ENGINE_SMOKE=1 pnpm exec vitest run packages/investment-research/python-runtime/tests/managed-engine.smoke.ts`，通过 Profile managed 启动到健康后 dispose；不发业务请求、不需凭据。
- [ ] engine workflow 的 macOS shell 安装段固定为：

```sh
python -m venv ../backend/dsh-trading-core/env
../backend/dsh-trading-core/env/bin/python -m pip install -r ../backend/dsh-trading-core/requirements.txt
python -m venv ../backend/market-watch/env
../backend/market-watch/env/bin/python -m pip install -r ../backend/market-watch/requirements.txt
```

Windows PowerShell 安装段固定为：

```powershell
python -m venv ..\backend\dsh-trading-core\env
..\backend\dsh-trading-core\env\Scripts\python.exe -m pip install -r ..\backend\dsh-trading-core\requirements.txt
python -m venv ..\backend\market-watch\env
..\backend\market-watch\env\Scripts\python.exe -m pip install -r ..\backend\market-watch\requirements.txt
```
- [ ] 本机当前 OS 运行：

```sh
DSH_INVESTMENT_TEST_PYTHON=python3 pnpm run test:investment-runtime:matrix
```

Windows PowerShell：

```powershell
$env:DSH_INVESTMENT_TEST_PYTHON = 'python'
pnpm run test:investment-runtime:matrix
```

矩阵脚本必须包含 `apps/electron/tests/investment-profile.e2e.ts`；两个 OS 都只测试 Electron 配置合成和 Runtime 生命周期，不要求 CI 桌面会话。

- [ ] 提交：

```sh
git add frontend/packages/investment-research/python-runtime/tests frontend/apps/electron/tests/investment-profile.e2e.ts frontend/examples/headless-agent frontend/package.json frontend/.github/workflows
git commit -m "test: cover investment runtime across platforms"
```

## Task 14：Runtime/Profile/Bundle 文档与 Agent Note

**Files:**

- Create: `frontend/packages/investment-research/python-runtime/README.md`
- Create: `frontend/packages/investment-research/python-runtime/README.zh.md`
- Create: `frontend/packages/investment-research/python-runtime/README.i18n.yaml`
- Create: `frontend/packages/investment-research/runtime-bundle/README.md`
- Create: `frontend/packages/investment-research/runtime-bundle/README.zh.md`
- Create: `frontend/packages/investment-research/runtime-bundle/README.i18n.yaml`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/README.md`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/README.zh.md`
- Create: `frontend/packages/investment-research/stock-analysis-bundle/README.i18n.yaml`
- Create: `frontend/packages/investment-research/market-watch-bundle/README.md`
- Create: `frontend/packages/investment-research/market-watch-bundle/README.zh.md`
- Create: `frontend/packages/investment-research/market-watch-bundle/README.i18n.yaml`
- Modify: `frontend/packages/investment-research/README.md`
- Modify: `frontend/packages/investment-research/README.zh.md`
- Modify: `frontend/packages/investment-research/README.i18n.yaml`
- Modify: `frontend/packages/investment-research/stock-analysis/README.md`
- Modify: `frontend/packages/investment-research/stock-analysis/README.zh.md`
- Modify: `frontend/packages/investment-research/stock-analysis/README.i18n.yaml`
- Modify: `frontend/packages/investment-research/market-watch/README.md`
- Modify: `frontend/packages/investment-research/market-watch/README.zh.md`
- Modify: `frontend/packages/investment-research/market-watch/README.i18n.yaml`
- Modify: `frontend/packages/bundle/README.md`
- Modify: `frontend/packages/bundle/README.zh.md`
- Modify: `frontend/packages/bundle/README.i18n.yaml`
- Modify: `frontend/packages/boot/app-boot/README.md`
- Modify: `frontend/packages/boot/app-boot/README.zh.md`
- Modify: `frontend/packages/boot/app-boot/README.i18n.yaml`
- Modify: `frontend/apps/cli/reference/README.md`
- Modify: `frontend/apps/cli/reference/README.zh.md`
- Modify: `frontend/apps/cli/reference/README.i18n.yaml`
- Modify: `frontend/apps/electron/README.md`
- Modify: `frontend/apps/electron/README.zh.md`
- Modify: `frontend/apps/electron/README.i18n.yaml`
- Create: `frontend/docs/subsystems/investment-research.md`
- Create: `frontend/docs/subsystems/investment-research.zh.md`
- Create: `frontend/docs/subsystems/investment-research.i18n.yaml`
- Modify: `frontend/docs/subsystems/README.md`
- Modify: `frontend/docs/subsystems/README.zh.md`
- Modify: `frontend/docs/subsystems/README.i18n.yaml`
- Modify: `frontend/scripts/gen-cordis-catalog.ts`
- Modify: `frontend/scripts/type-equiv.manifest.json`
- Modify: `frontend/scripts/verify-package-readme-model-experience.ts`
- Modify: `frontend/docs/config-catalog.md`
- Modify: `frontend/docs/config-catalog.zh.md`
- Modify: `frontend/docs/config-catalog.i18n.yaml`
- Modify: `frontend/docs/module-graph.md`
- Modify: `frontend/docs/module-graph.zh.md`
- Modify: `frontend/docs/module-graph.i18n.yaml`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-python-runtime-profile.md`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-python-runtime-profile.zh.md`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-python-runtime-profile.i18n.yaml`

- [ ] SERVICE_PAGE 加 `investmentPythonRuntime: 'investment-research.md'`；subsystem 页以 `ts public-api` 固定 Runtime，并在 type-equiv manifest 登记。
- [ ] README/model allowlist：runtime 为 none；bundles 为 indirect；stock/market 保留完整 model-visible section，不进 allowlist。
- [ ] CLI/app-boot/Electron 文档把 `dsh electron --profile investment-research` 写为唯一产品启动命令，并明确 `dsh electron` 仍默认 `web`；配置诊断命令单列为 `dsh --profile investment-research --dump-default-config`。同时记录五层顺序、Electron patch 覆盖关系、source checkout/显式 projectDir、managed/external、init 指引、log/state、push 默认 false。
- [ ] 运行 `gen-cordis-api`、`gen-config-catalog`、`gen-module-graph`，同步中文并逐对 pairing `--write`。Agent Note 记录复用 subprocess、拒绝 pid/port 接管、Profile 只组合 Bundle，以及 Electron 选择 Profile 后再叠加原生 patch 的依据。
- [ ] 运行 `pnpm run doc-sync && pnpm run lint && pnpm run build && pnpm run hygiene`，提交：

```sh
git add frontend/packages frontend/apps/cli/reference frontend/apps/electron/README.md frontend/apps/electron/README.zh.md frontend/apps/electron/README.i18n.yaml frontend/docs frontend/scripts frontend/.agents/notes/implemented/architecture
git commit -m "docs: document the investment runtime profile"
```

## Task 15：PR 2 验收

- [ ] 运行投研包 focused coverage、真实 Loader/Profile、Electron args/main/composition、built CLI config dump、snapshot、当前 OS matrix、build/hygiene/doc-sync。
- [ ] 启动链签收：`dsh electron --profile investment-research` 把 Profile 名从 CLI 传到 Electron 主进程；主进程以该 Profile 调用 `runProfile`，随后应用且只应用现有 `electron.patch.yml`；`dsh electron` 仍选择 `web`。
- [ ] GitHub Actions 确认 macOS/Windows matrix 都实际执行；手动 engine smoke 两个 OS 通过。
- [ ] 故障注入：错误 service 占用 8000 时 dsh 失败且占用进程存活；匹配独立服务 attached release 后存活；删 venv 后只给 init 指引且未安装。
- [ ] PR diff 无 adapter-client 提取；标题 `feat: add the investment research runtime profile`。合并且 CI 通过后开始 PR 3。

---

# PR 3：提取平台中立 Adapter Client

## Task 16：先定义错误分类、HTTP 与 SSE 失败矩阵

**Files:**

- Create: `frontend/packages/investment-research/adapter-client/package.json`
- Create: `frontend/packages/investment-research/adapter-client/tsconfig.json`
- Create: `frontend/packages/investment-research/adapter-client/src/contracts.ts`
- Create: `frontend/packages/investment-research/adapter-client/src/http.ts`
- Create: `frontend/packages/investment-research/adapter-client/src/sse.ts`
- Create: `frontend/packages/investment-research/adapter-client/src/index.ts`
- Create: `frontend/packages/investment-research/adapter-client/src/invariant.ts`
- Create: `frontend/packages/investment-research/adapter-client/tests/http.spec.ts`
- Create: `frontend/packages/investment-research/adapter-client/tests/sse.spec.ts`
- Create: `frontend/packages/investment-research/adapter-client/tests/boundary.spec.ts`
- Modify: `frontend/tsconfig.base.json`
- Modify: `frontend/tsconfig.host.json`
- Modify: `frontend/pnpm-lock.yaml`

**Error contract:**

```ts
export type AdapterClientErrorCode =
  | 'HTTP_ERROR'
  | 'BACKEND_ERROR'
  | 'PROTOCOL_ERROR'
  | 'INCOMPLETE_STREAM'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'

export class AdapterClientError extends Error {
  constructor(
    readonly code: AdapterClientErrorCode,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) { super(message) }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue
}

export interface AdapterByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

export interface AdapterResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: { getReader(): AdapterByteReader } | null
  text(): Promise<string>
}

export type AdapterFetch = (
  url: string,
  init: Readonly<{
    method: string
    headers?: Readonly<Record<string, string>>
    body?: string
    signal?: AbortSignal
  }>,
) => Promise<AdapterResponse>
```

- [ ] boundary test 逐文件解析 imports：主入口、contracts/http/sse/trading client 不得匹配 Cordis、任何 dsh runtime 或 React；不得读取 window、document、`globalThis.fetch`。只允许 invariant.ts 的 Cordis/invariants imports，并断言主 dependencies 为空。
- [ ] HTTP tests 固定 injected fetch/baseURL、JSON 成功、404、409、非 JSON error body、网络失败、caller cancel、deadline timeout。404/409 保留 status 且 code 为 HTTP_ERROR；取消与超时必须不同 code。
- [ ] SSE tests 覆盖 LF、CRLF、CR 与 LF 分落不同 byte chunk、任意 chunk 边界、中文 UTF-8 字符跨 chunk、多行 data 以换行合并、comment、可选 event、空 data、末尾无终止空行、result、显式 error、缺 result。
- [ ] 先运行：

```sh
pnpm exec vitest run \
  packages/investment-research/adapter-client/tests/http.spec.ts \
  packages/investment-research/adapter-client/tests/sse.spec.ts \
  packages/investment-research/adapter-client/tests/boundary.spec.ts \
  --coverage \
  --coverage.include='packages/investment-research/adapter-client/src/contracts.ts' \
  --coverage.include='packages/investment-research/adapter-client/src/http.ts' \
  --coverage.include='packages/investment-research/adapter-client/src/sse.ts' \
  --coverage.include='packages/investment-research/adapter-client/src/index.ts'
```

预期：模块不存在。

- [ ] package scaffold 遵守 AGENTS：peer/dev 只声明 Cordis/invariants 并提供隔离 invariant；主 dependencies 为空，不引入 Schemastery、dsh runtime 或 React。
- [ ] http.ts 要求构造时注入 fetch，不 fallback；本地 AbortController 区分 timeout/cancel，不依赖 dsh-timeout；response body 只读一次，错误 details bounded。
- [ ] sse.ts 用 streaming TextDecoder 保留跨 chunk UTF-8，再在文本 buffer 识别三种换行；dispatch 最后未终止 frame。只产平台中立 frame/event，不调用 agent。
- [ ] invariant 说明主库 pure transport；接入 paths/Host/lock。重跑 focused 100% coverage 与 typecheck。
- [ ] 提交：

```sh
git add frontend/packages/investment-research/adapter-client frontend/tsconfig.base.json frontend/tsconfig.host.json frontend/pnpm-lock.yaml
git commit -m "feat: add the investment adapter transport core"
```

## Task 17：实现 Trading Adapter Client 完整 API

**Files:**

- Create: `frontend/packages/investment-research/adapter-client/src/tradingAdapterClient.ts`
- Create: `frontend/packages/investment-research/adapter-client/tests/tradingAdapterClient.spec.ts`
- Modify: `frontend/packages/investment-research/adapter-client/src/index.ts`

**Public API:**

```ts
export interface TradingAdapterClientOptions {
  readonly baseUrl: string
  readonly fetch: AdapterFetch
  readonly streamTimeoutMs: number
}

export interface TradingAdapterClient {
  analyzeStock(input: AnalyzeStockInput, options?: StreamOptions): Promise<AnalysisResult>
  analyzeHoldings(input: AnalyzeHoldingsInput, options?: StreamOptions): Promise<AnalysisResult>
  generateBrief(input: GenerateBriefInput, options?: StreamOptions): Promise<AnalysisResult>
  setWatchlist(input: SetWatchlistInput, signal?: AbortSignal): Promise<JsonValue>
  getWatchlist(signal?: AbortSignal): Promise<JsonValue>
  setHoldings(input: SetHoldingsInput, signal?: AbortSignal): Promise<JsonValue>
  getLatestBrief(signal?: AbortSignal): Promise<JsonValue>
  setRiskProfile(input: SetRiskProfileInput, signal?: AbortSignal): Promise<JsonValue>
  getRiskProfile(signal?: AbortSignal): Promise<JsonValue>
}

export function createTradingAdapterClient(options: TradingAdapterClientOptions): TradingAdapterClient
```

- [ ] 从旧股票 client 的 endpoint 建 fixture 表，先固定每个 method 的 path/method/body；三个 stream method 固定 start task → consume SSE → onStage → result。显式 error 抛 BACKEND_ERROR；正常结束无 result 抛 INCOMPLETE_STREAM。
- [ ] 顺序测试：progress 可多次；result 只能一次并终止；error 优先；cancel/timeout 都取消 reader；reader lock 在 finally 释放。
- [ ] 先运行 focused coverage，预期 trading module 缺失。
- [ ] 实现 contracts/client。公开类型不得复用 dsh-session JsonValue，在 contracts.ts 定义本地递归 JsonValue；timeout 全由 options 输入。
- [ ] 重跑 adapter-client 全包 coverage，要求每文件 100%；boundary test 仍通过。
- [ ] 提交：

```sh
git add frontend/packages/investment-research/adapter-client
git commit -m "feat: implement the trading adapter client"
```

## Task 18：股票插件切换到纯客户端并证明行为不变

**Files:**

- Modify: `frontend/packages/investment-research/stock-analysis/package.json`
- Modify: `frontend/packages/investment-research/stock-analysis/tsconfig.json`
- Modify: `frontend/packages/investment-research/stock-analysis/src/index.ts`
- Delete: `frontend/packages/investment-research/stock-analysis/src/client.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/loader-composition.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/runtime-composition.spec.ts`
- Modify: `frontend/pnpm-lock.yaml`

- [ ] 先把 stock tests import 指向 adapter-client，并 spy：插件显式把 `globalThis.fetch` 作为参数传入；`agent.inject()` 只存在 plugin progress callback；render 输入与阶段二 snapshot 相同。
- [ ] 运行 stock tests，预期仍用本地 client 而失败新断言。
- [ ] 增 adapter-client peer/dev/reference；删旧 client。index 只传 lease baseURL、Config timeout、explicit fetch、onStage；不把 Context、ToolRunContext、Agent 或 render 传给 client 包。
- [ ] 运行：

```sh
pnpm exec vitest run packages/investment-research/adapter-client/tests packages/investment-research/stock-analysis/tests \
  --coverage \
  --coverage.include='packages/investment-research/adapter-client/src/**/*.ts' \
  --coverage.include='packages/investment-research/stock-analysis/src/**/*.ts'
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'investment research'
pnpm exec vitest run apps/electron/tests/investment-profile.e2e.ts
```

预期：coverage 100%、真实 Loader 与 Electron composition 通过、snapshot 无 diff。若修 bug 导致确切输出变化，先说明差异，只能用 refresh 更新 replay 结果，不以 record 掩盖重构漂移。

- [ ] 提交：

```sh
git add frontend/packages/investment-research/stock-analysis frontend/pnpm-lock.yaml
git commit -m "refactor: use the shared trading adapter client"
```

## Task 19：adapter-client 文档、catalog 与 Agent Note

**Files:**

- Create: `frontend/packages/investment-research/adapter-client/README.md`
- Create: `frontend/packages/investment-research/adapter-client/README.zh.md`
- Create: `frontend/packages/investment-research/adapter-client/README.i18n.yaml`
- Modify: `frontend/packages/investment-research/README.md`
- Modify: `frontend/packages/investment-research/README.zh.md`
- Modify: `frontend/packages/investment-research/README.i18n.yaml`
- Modify: `frontend/packages/investment-research/stock-analysis/README.md`
- Modify: `frontend/packages/investment-research/stock-analysis/README.zh.md`
- Modify: `frontend/packages/investment-research/stock-analysis/README.i18n.yaml`
- Modify: `frontend/scripts/verify-package-readme-model-experience.ts`
- Modify if generated output changes: `frontend/docs/config-catalog.md`
- Modify if generated output changes: `frontend/docs/config-catalog.zh.md`
- Modify if generated output changes: `frontend/docs/config-catalog.i18n.yaml`
- Modify if generated output changes: `frontend/docs/module-graph.md`
- Modify if generated output changes: `frontend/docs/module-graph.zh.md`
- Modify if generated output changes: `frontend/docs/module-graph.i18n.yaml`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-adapter-client.md`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-adapter-client.zh.md`
- Create: `frontend/.agents/notes/implemented/architecture/2026-08-20-investment-adapter-client.i18n.yaml`

- [ ] adapter README 记录 injected fetch/baseURL、API、SSE、错误 code、cancel/timeout、非浏览器绑定、限制；model allowlist 标记 none，说明 model-visible 渲染归 stock plugin。
- [ ] stock README 链到 adapter client，工具/render/lifecycle 仍归自身；组 README 加 adapter-client，不把 market client 误写为已提取。
- [ ] Agent Note 记录纯主入口与 mandatory invariant companion 隔离、progress 留在 plugin、错误分类和缺 result 决策。
- [ ] 运行 gen-config-catalog/gen-module-graph，同步中文、逐对 pairing `--write`，再运行 doc-sync/lint。
- [ ] 提交：

```sh
git add frontend/packages/investment-research frontend/docs frontend/scripts/verify-package-readme-model-experience.ts frontend/.agents/notes/implemented/architecture
git commit -m "docs: document the investment adapter client"
```

## Task 20：最终验证、占位项扫描与 PR 3 评审

- [ ] 单元/组合/snapshot：

```sh
pnpm exec vitest run \
  packages/investment-research/adapter-client/tests \
  packages/investment-research/stock-analysis/tests \
  packages/investment-research/market-watch/tests \
  --coverage \
  --coverage.include='packages/investment-research/adapter-client/src/**/*.ts' \
  --coverage.include='packages/investment-research/stock-analysis/src/**/*.ts' \
  --coverage.include='packages/investment-research/market-watch/src/**/*.ts'
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'investment research'
pnpm exec vitest run \
  apps/cli/tests/args.spec.ts \
  apps/cli/tests/electron-launch.spec.ts \
  apps/electron/tests/args.spec.ts \
  apps/electron/tests/main-startup.spec.ts \
  apps/electron/tests/investment-profile.e2e.ts
```

- [ ] 产品/发布面：

```sh
pnpm run typecheck
pnpm run build
pnpm run hygiene
pnpm run doc-sync
```

- [ ] 主客户端边界负面扫描，预期无输出：

```sh
rg -n "@deepseek-ai/cordis|@deepseek-ai/dsh-|from 'react'|from \"react\"|globalThis\.fetch|\bwindow\b|\bdocument\b" \
  packages/investment-research/adapter-client/src/contracts.ts \
  packages/investment-research/adapter-client/src/http.ts \
  packages/investment-research/adapter-client/src/sse.ts \
  packages/investment-research/adapter-client/src/tradingAdapterClient.ts \
  packages/investment-research/adapter-client/src/index.ts
```

- [ ] 从根重跑 backend 纯 Python，确认无顶层 integrations/dsh。
- [ ] 扫描新增实现/活跃文档中的未解决占位符；逐条清除本迁移新增命中：

```sh
rg -n 'T[B]D|PLACEHOLD[E]R|X[X]X|FIXM[E]' \
  frontend/packages/investment-research \
  frontend/docs/subsystems/investment-research* \
  frontend/.agents/notes/implemented/architecture/2026-08-20-investment-*
```

- [ ] 对照规格与 2026-08-20 Electron 入口修正，签收目录、五层 Profile、三 Bundle、Electron 参数贯通及 patch 覆盖、single-flight、health、owned-only kill、external、log/state、双 OS、SSE 矩阵、Loader、snapshot、双语文档。
- [ ] PR 3 diff 只含 adapter extraction 及直接文档/测试；标题 `refactor: extract the investment adapter client`。

## 完成定义

- [ ] 三个 PR 按顺序合并，各自 CI 通过，无跨阶段偷跑。
- [ ] backend 纯 Python检查通过，两个健康身份稳定。
- [ ] 七个核心/迁入 package 与三个 Bundle 满足 workspace、build、publish、invariant、README、coverage。
- [ ] `dsh --profile investment-research --dump-default-config` 展开五层固定顺序；`dsh electron --profile investment-research` 以 Electron 启动同一组合并叠加原生 patch；业务 Bundle 可独立移除，缺 Runtime 明确失败。
- [ ] managed/external、匹配附着、未知端口、owned-only termination、state/log、quiescent dispose 在 macOS/Windows 有实际证据。
- [ ] adapter-client 主入口零 Cordis/dsh/React/浏览器全局，SSE/HTTP/error 全矩阵通过。
- [ ] 股票与盯盘真实 Loader、Electron composition 通过，阶段三 snapshot 不变；默认 `dsh electron` 的 `web` 行为不回归。
- [ ] typecheck、focused 100% coverage、build、hygiene、doc-sync 全绿，活跃双语配对全部记录。
