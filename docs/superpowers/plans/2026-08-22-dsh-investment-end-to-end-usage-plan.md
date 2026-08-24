# DSH 投研端到端凭据、就绪引导与 Python Sidecar 实施计划

> **供智能体执行者阅读：** 必须使用 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 逐项执行本计划；每个任务先完成 TDD RED，再做最小 GREEN，并在提交前执行列出的 focused 验证。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在不重开 PR2 的 Profile、Bundle、managed/external 与进程所有权设计，也不提前创建或修改 PR3 `adapter-client` 的前提下，让用户只在现有 Models 页面输入一次 `DEEPSEEK_API_KEY`，即可在源码和 Electron packaged 两种形态中安全使用投研能力，并能从投研设置页判断凭据、Runtime、backend 与工具就绪状态。

**架构：** `ctx.credentials` 继续是 Key 的唯一事实源。`InvestmentPythonRuntime` 只在自己即将创建 owned managed child 时解析声明式 allowlist，并把 secret 放入 child-only env；健康的 attached 与 external endpoint 不解析、不注入本机凭据。Runtime 通过不含 secret 的 Typert Remote 发布 readiness 与重启请求；独立的投研 Client facade 挂载该 Remote，独立的投研设置 UI 通过 `settings.section` 展示状态并导航到既有 `models` section。源码解析仍使用仓库内两个 `env`；packaged 解析使用 Electron Resources 中带哈希 descriptor 的固定 Python sidecar。所有 packaged backend 写入都由 `DSH_INVESTMENT_STATE_DIR` 导向 `$DSH_HOME/investment-research/<backend-id>/`。

**技术栈：** Python 3.10、FastAPI/Uvicorn；TypeScript、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`；Cordis、Schemastery、Typert Remote、React、Vitest、tsdown；Electron Forge/Packager；GitHub Actions 的 macOS arm64/x64 与 Windows x64 矩阵。

**架构规格：**

- `docs/superpowers/specs/2026-08-22-dsh-investment-end-to-end-usage-design.md`
- `docs/superpowers/specs/2026-08-20-dsh-integration-boundary-design.md`

**状态：** 2026-08-22 最终自洽审查通过，未发现实质冲突；本计划视为对已批准规格的实施展开，不再重新设计。

## 最终自洽审查结论

| 审查点 | 结论 | 计划中的固定边界 |
| --- | --- | --- |
| credential update、工具 preflight、quiescent restart | 自洽 | `credentials/updated` 只把活动 owned child 标成 `restart-required`；新的 LLM 调用先在 Host 拒绝；用户显式请求 Electron 全应用重启，先等待 Profile/工具/lease/owned process quiescent teardown，再 `app.relaunch()` |
| Models UI 与 readiness UI 的 package/slot 归属 | 自洽，有一处现有 contract 需补齐 | `ui-settings-models` 继续独占 Key 输入；新增投研 facade 与投研 UI package；只给通用 `SettingsSectionOwnerProps` 增加 `openSection(id)`，不向 Models package 写入投研逻辑 |
| owned managed 与 attached/external 隔离 | 自洽 | 健康探测先于凭据解析；只有确定需要 spawn 的 owned 路径调用 `credentials.resolve()`；attached/external readiness 显示 external-managed，不接收本机 Key |
| source/bundled resolver 优先级 | 自洽 | 显式有效绝对目录 > 完整可用的源码 backend+env > 完整有效的 bundled descriptor；显式目录无效时 fail loud，不回退 |
| packaged backend 可写目录 | 自洽 | Resources 永远只读；Host 为 bundled child 显式设置 `DSH_INVESTMENT_STATE_DIR`，Python 的 data/cache/log/state/user config 全部从该根派生；源码未设置变量时保留项目内默认 |
| 与 PR3 `adapter-client` 的先后关系 | 自洽 | PR2 先合并；本计划增量一先落地；既定 PR3 随后按原计划提取 transport，并保留本计划的 Host preflight；增量二最后接入 sidecar。增量二不依赖 PR3 API，但在线性集成中放在 PR3 后可避免并行修改股票插件与发布闭包 |

## 全局约束

- 当前 PR2 分支 `codex/dsh-investment-runtime-profile` 与本地 HEAD `e4d82401c7` 只是计划基线。执行本计划前必须先合并 PR2，再从 PR2 merge commit 新建分支；不得把本计划的实现提交追加到尚未合并的 PR2。
- 不修改、暂存或删除用户未跟踪的根 `AGENTS.md`、`.pnpm-store/`、`docs/research/`；每次提交都使用显式路径 `git add`，提交前用 `git diff --cached --name-only` 检查。
- 用户只在既有 Models 页面保存 `DEEPSEEK_API_KEY`。不得新增第二个 Key 输入、读取或展示 secret，也不得写 backend `.env`。
- `PythonBackendDefinition.credentialEnv` 只包含 ref、目标 env 与角色；不得包含 credential value。Runtime 的错误、日志、state、readiness、invariant snapshot、Cordis dump 与测试 fixture 不得出现 Key。
- keyless Profile 必须继续启动两个 backend、注册股票 9 个工具和盯盘 11 个工具。缺 Key 只改变 capability/readiness 与 LLM preflight，不改变工具树可见性。
- 健康 attached 进程和 external endpoint 的生命周期及凭据由外部部署负责；本地 restart 操作不得尝试停止或更新它们。
- 第一版重启是 Electron 全应用重启。不得实现 backend rolling restart，不得在未知业务请求中强杀 child。
- 源码启动不安装依赖；只有用户显式运行统一初始化命令时才允许创建 venv、执行 `pip install`。
- packaged 启动不得联网、安装依赖、创建 venv、修改 Resources、调用 `xattr` 或绕过签名。
- 增量一不得创建或修改 PR3 `frontend/packages/investment-research/adapter-client`；增量二也不得把 transport 提取夹带进 sidecar 工作。
- 所有新增或更新的 Markdown 规格、计划、Agent Note 与报告使用中文；面向 `frontend` 用户的 package README 按仓库规范同步英文、中文与 `.i18n.yaml`。
- 每个产品可见 Client 插件必须有真实 Loader/Cordis 组合测试和 keyless snapshot；新增或修改源码的 focused coverage 保持每文件 100%。
- 每个增量结束时运行 macOS 与 Windows 等价矩阵；平台专属 packaged 构建必须在对应原生 runner 上完成，不把 Wine 当作 sidecar/native wheel 的最终证明。

## 增量与集成顺序

| 顺序 | 集成单元 | 依赖与提交策略 |
| --- | --- | --- |
| 0 | 已有 PR2 | 先合并；本计划不修改它 |
| 1 | 增量一：源码凭据闭环、readiness、统一初始化/验证 | 从 PR2 merge commit 开始，独立 PR；完成后 keyless 与有 Key 的源码路径都可验证 |
| 2 | 既定 PR3：stock adapter-client | 按既有计划单独实施；迁移股票请求时必须保留本计划在工具 execute 入口的 `assertCapability()`，不得把 preflight 下沉到 transport package |
| 3 | 增量二：Electron packaged Python sidecar | 从包含增量一与 PR3 的主线开始，独立 PR；只扩展资源来源与打包闭包，不改变 PR3 contract |

---

# 增量一：源码模式凭据闭环、readiness、统一 backend 初始化与验证入口

## 任务 1：先固定声明式 credential allowlist 与注册冲突契约

**文件范围：**

- 修改：`frontend/packages/investment-research/python-runtime/src/types.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/runtime.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/index.ts`
- 修改：`frontend/packages/investment-research/python-runtime/package.json`
- 修改：`frontend/packages/investment-research/python-runtime/tests/runtime.spec.ts`
- 修改：`frontend/packages/investment-research/python-runtime/tests/public-api.spec.ts`

**目标接口：**

```ts
export interface ManagedCredentialEnv {
  readonly ref: CredentialRef
  readonly env: string
  readonly role: 'required' | 'enhancement'
}

export interface PythonBackendDefinition {
  // 既有字段保持不变
  readonly credentialEnv?: readonly ManagedCredentialEnv[]
}
```

- [ ] **TDD RED：** 在 `runtime.spec.ts` 先增加以下失败用例：非法 env 名、重复目标 env、与 `managedEnv` 冲突、同 id 不同 mapping 的重复注册、相同 mapping 的等价注册；再增加 owned、attached、external 三条路径的 spy，证明只有 refused 后进入 owned spawn 的路径调用 credential resolver。

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/runtime.spec.ts packages/investment-research/python-runtime/tests/public-api.spec.ts --retry=0
```

预期失败：`PythonBackendDefinition` 尚无 `credentialEnv`；manager 尚无 resolver；注册比较尚未纳入 mapping。

- [ ] **最小 GREEN：** 给 `InvestmentBackendManagerOptions` 注入最窄的 `resolveCredential(ref)` facade；注册时规范化并冻结 mapping，校验 env 为 `^[A-Za-z_][A-Za-z0-9_]*$`、目标不重复且不与 `managedEnv` 重名；冲突指纹包含 mapping。保持健康探测在前，只有需要 `ctx.subprocess.spawn()` 的 owned 分支逐个解析唯一 ref，并把解析结果只合并进 spawn 的 `env`。不把值写进 active entry、state、日志或错误。
- [ ] **focused 验证：** 重跑 RED 命令；再运行：

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/{runtime,state,log}.spec.ts --retry=0
pnpm exec tsc -b packages/investment-research/python-runtime/tsconfig.json --pretty false
```

- [ ] **跨平台验证：** path/env 单元用例显式注入 `path.posix` 与 `path.win32`；macOS 和 Windows runner 都运行同一 Vitest 文件。Windows 断言 env key 不因大小写处理而产生重复注入；POSIX 断言 exact key。
- [ ] **提交边界：** 本提交只包含 Runtime credential contract、验证与注入隔离，不改业务插件、UI 或 Python。

```sh
git add frontend/packages/investment-research/python-runtime/src frontend/packages/investment-research/python-runtime/tests/runtime.spec.ts frontend/packages/investment-research/python-runtime/tests/public-api.spec.ts frontend/packages/investment-research/python-runtime/package.json
git commit -m "feat: add investment runtime credential allowlists"
```

## 任务 2：接入 `ctx.credentials`，固定 Key 更新状态与 Host capability preflight

**文件范围：**

- 修改：`frontend/packages/investment-research/python-runtime/src/types.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/runtime.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/index.ts`
- 新建：`frontend/packages/investment-research/python-runtime/src/readiness.ts`
- 新建：`frontend/packages/investment-research/python-runtime/tests/readiness.spec.ts`
- 修改：`frontend/packages/investment-research/python-runtime/tests/runtime.spec.ts`
- 修改：`frontend/packages/investment-research/python-runtime/package.json`

**目标接口：**

```ts
export interface InvestmentCapabilityDefinition {
  readonly backendId: InvestmentBackendId
  readonly toolCount: number
  readonly llm: 'required' | 'enhancement' | 'none'
}

registerCapability(definition: InvestmentCapabilityDefinition): () => void
assertCapability(backendId: InvestmentBackendId, use: 'llm-required' | 'llm-enhancement' | 'non-llm'): void
readiness(): InvestmentReadinessSnapshot
```

- [ ] **TDD RED：** 先写测试覆盖：keyless owned backend 健康但 `stock-full` 不可用、market 为 `market-template-only`；`credentials/updated('DEEPSEEK_API_KEY')` 只把引用它的活动 owned backend 标记 `restart-required`；缺 Key 且 child 从未持有 Key 时 required preflight 拒绝、enhancement 允许模板、non-LLM 允许；一旦进入 `restart-required`，所有可能使用 LLM 的 required/enhancement 新调用都拒绝，只有明确 non-LLM 的工具继续；attached/external 返回 `external-managed` 并绕过本地 Key 判定；snapshot 只出现 ref/source/status，不出现 secret。

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/readiness.spec.ts packages/investment-research/python-runtime/tests/runtime.spec.ts --retry=0
```

预期失败：Runtime 尚未注入 `credentials`、未监听 update event、没有 capability registry/readiness/preflight。

- [ ] **最小 GREEN：** `InvestmentPythonRuntime.static inject` 增加 `credentials`；constructor 将 `ctx.credentials.resolve/describe` 的最窄 facade 传给 manager，并用 effect 订阅 `credentials/updated`。活动 owned child 命中 ref 时只写入布尔/枚举状态 `restart-required`；不缓存新 Key。capability registry 在业务插件完成工具注册后才发布，disposer 在工具撤回时同步撤回。错误消息固定包含 backend id、`DEEPSEEK_API_KEY` ref、打开 Models 的动作提示与 Runtime 日志路径。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests --retry=0
pnpm exec tsc -b packages/investment-research/python-runtime/tsconfig.json --pretty false
```

- [ ] **跨平台验证：** 使用平台无关 fake credential provider 运行同一用例；macOS/Windows 额外断言错误中的日志路径分别规范为 POSIX/Win32，但错误与 snapshot 都不含 secret。
- [ ] **提交边界：** 只提交 Runtime 对 credentials、readiness core 和 preflight 的 Host 能力；不加 Remote、不改工具 execute。

```sh
git add frontend/packages/investment-research/python-runtime
git commit -m "feat: track investment credential readiness"
```

## 任务 3：让两个业务插件声明映射并在 LLM 调用前执行 preflight

**文件范围：**

- 修改：`frontend/packages/investment-research/stock-analysis/src/index.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/tests/runtime-composition.spec.ts`
- 修改：`frontend/packages/investment-research/market-watch/src/index.ts`
- 修改：`frontend/packages/investment-research/market-watch/tests/plugin.spec.ts`
- 修改：`frontend/packages/investment-research/market-watch/tests/runtime-composition.spec.ts`

**固定映射：**

```ts
// trading-core
credentialEnv: [
  { ref: 'DEEPSEEK_API_KEY', env: 'DEEPSEEK_API_KEY', role: 'required' },
  { ref: 'DEEPSEEK_API_KEY', env: 'OPENAI_API_KEY', role: 'required' },
]

// market-watch
credentialEnv: [
  { ref: 'DEEPSEEK_API_KEY', env: 'DEEPSEEK_API_KEY', role: 'enhancement' },
]
```

- [ ] **TDD RED：** 先断言两个 definition 的完整 mapping；股票 `analyze_stock`、`analyze_holdings`、`market_brief` 在发 HTTP/SSE 前调用 `assertCapability(..., 'llm-required')`；盯盘 `daily_brief` 调用 enhancement preflight，Key 缺失时仍允许 backend 模板回退；`watch_list`、`watch_add`、`scan_movers` 等明确非 LLM 工具不被阻止。断言 keyless 时仍注册 9+11 个工具。

```sh
cd frontend
pnpm exec vitest run packages/investment-research/{stock-analysis,market-watch}/tests/{plugin,runtime-composition}.spec.ts --retry=0
```

预期失败：definition 没有 mapping，execute 没有 preflight，capability registry 没有 9/11 工具数。

- [ ] **最小 GREEN：** 股票 managed 默认显式传 `ADAPTER_RUNNER=engine`，把测试覆盖改成 plugin config 中的 `backendRunner: 'fake'`，不再读取 ambient `process.env.ADAPTER_RUNNER`；盯盘 managed 显式传 `MW_LLM_ENABLED=true`，实际是否使用 LLM 仍由 Key 是否存在决定。每个插件在工具注册完成后调用 `registerCapability({ toolCount: 9/11, llm: ... })`，并在其 effect disposer 中先撤工具、再撤 capability、再 release lease。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/investment-research/stock-analysis/tests packages/investment-research/market-watch/tests --retry=0
pnpm exec tsc -b packages/investment-research/stock-analysis/tsconfig.json packages/investment-research/market-watch/tsconfig.json --pretty false
```

- [ ] **跨平台验证：** macOS 与 Windows 的 managed fake profile 均以显式 config `backendRunner: fake` 运行；不得依赖 shell env 选择 runner。两个平台都断言 Key 只在 child env，argv 与 dump 中没有 Key。
- [ ] **提交边界：** 只包含业务 definition、preflight、capability 注册及其测试，不迁移 HTTP/SSE；PR3 未来提取 transport 时保留这些 execute 入口检查。

```sh
git add frontend/packages/investment-research/stock-analysis frontend/packages/investment-research/market-watch
git commit -m "feat: gate investment LLM tools on credential readiness"
```

## 任务 4：修正 Python 环境优先级并增加 secret/state-dir 契约测试

**文件范围：**

- 修改：`backend/market-watch/market_watch/config.py`
- 新建：`backend/market-watch/tests/test_config_precedence.py`
- 新建：`backend/dsh-trading-core/tests/test_config_precedence.py`
- 修改：`backend/dsh-trading-core/.env.example`
- 修改：`backend/market-watch/.env.example`
- 修改：`backend/dsh-trading-core/init.sh`
- 修改：`backend/dsh-trading-core/init.bat`
- 修改：`backend/market-watch/init.sh`
- 修改：`backend/market-watch/init.bat`

- [ ] **TDD RED：** 在临时项目副本写入与 process env 不同的假 Key，重新加载 config，断言 Host env 胜出；market-watch 还要断言没有外部 `NO_PROXY` 时补齐行情直连域名，已有 `NO_PROXY` 时不覆盖部署方值。

```sh
backend/dsh-trading-core/env/bin/python -m unittest backend/dsh-trading-core/tests/test_config_precedence.py
backend/market-watch/env/bin/python -m unittest backend/market-watch/tests/test_config_precedence.py
```

Windows 等价命令使用 `env\Scripts\python.exe`。预期失败：market-watch 的 `load_dotenv(..., override=True)` 覆盖 Host env。

- [ ] **最小 GREEN：** market-watch 改成 `override=False`；把必要的 `NO_PROXY` 默认补全与 dotenv precedence 分开实现为 `os.environ.setdefault()`/合并 helper，确保在行情模块导入前执行。两个 `.env.example` 明确标注 Profile 产品路径使用 Models、`.env` 只供 Python 独立启动；初始化脚本完成提示不再要求产品用户复制 Key。
- [ ] **focused 验证：**

```sh
backend/dsh-trading-core/env/bin/python -m unittest discover -s backend/dsh-trading-core/tests -p 'test_*.py'
backend/market-watch/env/bin/python -m unittest discover -s backend/market-watch/tests -p 'test_*.py'
```

- [ ] **跨平台验证：** 在 macOS 与 Windows 原生 Python 3.10 上运行相同 unittest；Windows 测试使用 `patch.dict(os.environ, clear=True)`，不依赖大小写不稳定的外部 shell env。
- [ ] **提交边界：** 只提交 Python 配置 precedence、说明与测试；不写 credential 文件、不改业务 API。

```sh
git add backend/dsh-trading-core backend/market-watch
git commit -m "fix: prefer managed investment child environment"
```

## 任务 5：发布不含机密的 readiness Remote 与明确的 restart request

**文件范围：**

- 修改：`frontend/packages/investment-research/python-runtime/src/index.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/types.ts`
- 新建：`frontend/packages/investment-research/python-runtime/tests/remote.spec.ts`
- 修改：`frontend/packages/investment-research/python-runtime/package.json`
- 修改：`frontend/packages/investment-research/python-runtime/tsdown.config.ts`

**Remote contract：**

```ts
@Remote('readiness')
readiness(): InvestmentReadinessSnapshot

@Remote('request-restart')
requestRestart(): InvestmentRestartResult
```

`InvestmentRestartResult` 只能是 `{ status: 'accepted' }` 或 `{ status: 'unavailable'; reason: string }`；不得承诺 backend rolling restart。

- [ ] **TDD RED：** 先测试 source-launch decorator descriptor、生成 Remote namespace、readiness JSON round-trip、无 `appRestart` 时的 unavailable，以及提供 fake `appRestart` 时只调用一次且先返回 accepted。对整个结果做 secret canary 扫描。

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/remote.spec.ts --retry=0
pnpm run build:lib:host
```

预期失败：Runtime 尚未绑定 Typert Remote，package 未导出 `./remote`/`./types`，Context 尚无 `appRestart`。

- [ ] **最小 GREEN：** 保留 Service 继承，使用 `bindTypertRemote(this, 'investmentPythonRuntime')` 加显式 binding；Remote 方法只读 projection 或请求 launcher restart。`requestRestart()` 不直接 dispose manager，不接触 Electron，不杀 backend；launcher callback 用 microtask/`setImmediate` 延后到 RPC acknowledgement 已可发送后执行。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/{remote,readiness,public-api}.spec.ts --retry=0
pnpm run build:lib:host
pnpm run verify-cordis-api
```

- [ ] **跨平台验证：** contract 与生成物在 macOS/Windows 使用同一命令；restart callback 测试使用 fake scheduler，不调用真实 Electron。平台路径只出现在 readiness 的日志位置且已规范化。
- [ ] **提交边界：** 只发布 Runtime Remote contract；还不接 Electron relaunch 或 Client UI。

```sh
git add frontend/packages/investment-research/python-runtime
git commit -m "feat: expose investment readiness remote"
```

## 任务 6：建立 launcher-owned quiescent Electron 全应用重启

**文件范围：**

- 修改：`frontend/packages/boot/cmdline/src/index.ts`
- 修改：`frontend/packages/boot/cmdline/tests/cmdline.spec.ts`
- 修改：`frontend/apps/cli/src/profile-boot.ts`
- 修改：`frontend/apps/cli/tests/process-shutdown.spec.ts`
- 修改：`frontend/apps/electron/src/main.ts`
- 修改：`frontend/apps/electron/tests/main-startup.spec.ts`
- 新建：`frontend/apps/electron/tests/restart.spec.ts`

**launcher seam：**

```ts
export interface AppRestart {
  (): void
}

export interface CmdlineHost {
  readonly args: readonly string[]
  readonly exit: AppExit
  readonly restart?: AppRestart
}
```

- [ ] **TDD RED：** 先固定顺序：Remote 请求只进入 single-flight restart；IPC streams abort/drain；`shutdown.shutdown(0)` 等待整个 Profile fiber dispose；owned process handle 退出；随后 `app.relaunch({ args: process.argv.slice(1) })`；最后 `app.quit()`。并发 restart/before-quit/window-all-closed 只能复用同一个 dispose promise。断言 relaunch args 保留唯一 `--profile investment-research`。

```sh
cd frontend
pnpm exec vitest run packages/boot/cmdline/tests/cmdline.spec.ts apps/cli/tests/process-shutdown.spec.ts apps/electron/tests/{main-startup,restart}.spec.ts --retry=0
```

预期失败：`provideCmdline` 不提供 optional restart，`runProfile` 不能接收 restart callback，Electron 没有 relaunch orchestration。

- [ ] **最小 GREEN：** `provideCmdline` 只在 host 提供时发布 `appRestart`；CLI/headless/web 保持 absent。`RunProfileOptions` 增加 optional restart 并传入。Electron 创建一个 `disposeOnce()` 与 `restartOnce()`：restart 在 RPC 返回后调度，先 await `disposeOnce()`，再 relaunch、quit；普通 quit 也复用 `disposeOnce()`。任何 teardown 错误都 fail loud，不在未完成 quiescence 时 relaunch。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/boot/cmdline/tests apps/cli/tests/process-shutdown.spec.ts apps/electron/tests/{main-startup,restart}.spec.ts --retry=0
pnpm exec tsc -b apps/cli/tsconfig.json apps/electron/tsconfig.json --pretty false
```

- [ ] **跨平台验证：** macOS 与 Windows 都运行 mock-based order test；Windows 断言 relaunch args 不经 shell quoting 重组，macOS 断言应用参数不重复追加。真实 packaged restart 留到增量二 smoke。
- [ ] **提交边界：** 只提交通用 optional restart seam 与 Electron quiescent orchestration；不改 readiness UI。

```sh
git add frontend/packages/boot/cmdline frontend/apps/cli frontend/apps/electron/src/main.ts frontend/apps/electron/tests/main-startup.spec.ts frontend/apps/electron/tests/restart.spec.ts
git commit -m "feat: restart electron after quiescent shutdown"
```

## 任务 7：建立投研专属 Client Remote facade，不污染通用 `api-remotes`

**文件范围：**

- 新建：`frontend/packages/client/investment-research-runtime/package.json`
- 新建：`frontend/packages/client/investment-research-runtime/tsconfig.json`
- 新建：`frontend/packages/client/investment-research-runtime/tsdown.config.ts`
- 新建：`frontend/packages/client/investment-research-runtime/src/index.ts`
- 新建：`frontend/packages/client/investment-research-runtime/src/invariant.ts`
- 新建：`frontend/packages/client/investment-research-runtime/src/client/index.ts`
- 新建：`frontend/packages/client/investment-research-runtime/tests/apply.client.spec.ts`
- 修改：`frontend/tsconfig.client.json`
- 修改：`frontend/packages/bundle/investment-runtime/package.json`
- 修改：`frontend/packages/bundle/investment-runtime/cordis.patch.yml`
- 修改：`frontend/packages/bundle/investment-runtime/tests/bundle.spec.ts`

- [ ] **TDD RED：** 在真实 Client test runtime 中先断言该 package 挂载 `@deepseek-ai/dsh-investment-python-runtime/remote`，发布 `ctx.investmentResearchRuntimeClient` facade，首次订阅时读取 readiness，并在 `credentials/updated('DEEPSEEK_API_KEY')` 与 `connection/reset` 后刷新；dispose 必须撤订阅、撤 Remote contribution 与 service。

```sh
cd frontend
pnpm exec vitest run packages/client/investment-research-runtime/tests/apply.client.spec.ts packages/bundle/investment-runtime/tests/bundle.spec.ts --retry=0
```

预期失败：package 与 bundle row 尚不存在，通用 `api-remotes` 不包含该可选 Remote。

- [ ] **最小 GREEN：** facade package 自己 await `$mount()` 后再 publish service；只暴露 readiness snapshot、refresh、subscribe 与 requestRestart，不暴露 secret 或 Host package 实现。investment-runtime bundle 在 host Runtime row 后插入 Client facade row。不要修改全局 `frontend/packages/api/remotes`，避免普通 web Profile 因可选投研 feature 依赖 Host Runtime。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/client/investment-research-runtime/tests packages/bundle/investment-runtime/tests --retry=0
pnpm exec tsc -b packages/client/investment-research-runtime/tsconfig.json --pretty false
pnpm run verify-client-domain-graph
```

- [ ] **跨平台验证：** Client 测试在 macOS/Windows Node 24 等价运行；不得读取 `process.platform`、Electron API 或 filesystem。bundle dump 在两个平台都包含相同 row 顺序。
- [ ] **提交边界：** 只增加可选 Client facade 与 bundle row；不加 React UI。

```sh
git add frontend/packages/client/investment-research-runtime frontend/packages/bundle/investment-runtime frontend/tsconfig.client.json
git commit -m "feat: add investment readiness client facade"
```

## 任务 8：补齐通用 settings 导航 contract，并新增投研 readiness 设置页

**文件范围：**

- 修改：`frontend/packages/client/ui-settings/src/client/contract/slots.ts`
- 修改：`frontend/packages/client/ui-settings/README.md`
- 修改：`frontend/packages/client/ui-settings/README.zh.md`
- 修改：`frontend/packages/client/ui-settings/README.i18n.yaml`
- 修改：`frontend/packages/client/ui-settings-general/src/client/SettingsRoot.tsx`
- 修改：`frontend/packages/client/ui-settings-general/tests/settings-root.client.spec.tsx`
- 新建：`frontend/packages/client/ui-settings-investment-research/package.json`
- 新建：`frontend/packages/client/ui-settings-investment-research/tsconfig.json`
- 新建：`frontend/packages/client/ui-settings-investment-research/tsdown.config.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/index.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/invariant.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/index.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/InvestmentReadinessSection.tsx`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/InvestmentReadinessSection.module.css`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/store.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/locales.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/tests/apply.client.spec.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/tests/section.client.spec.tsx`
- 新建：`frontend/packages/client/ui-settings-investment-research/README.md`
- 新建：`frontend/packages/client/ui-settings-investment-research/README.zh.md`
- 新建：`frontend/packages/client/ui-settings-investment-research/README.i18n.yaml`
- 修改：`frontend/packages/bundle/investment-runtime/package.json`
- 修改：`frontend/packages/bundle/investment-runtime/cordis.patch.yml`
- 修改：`frontend/packages/bundle/investment-runtime/tests/bundle.spec.ts`
- 修改：`frontend/tsconfig.client.json`

**slot contract 变更：**

```ts
export interface SettingsSectionOwnerProps {
  close: () => void
  openSection: (id: string) => void
}
```

- [ ] **TDD RED：** 先让 shell 测试断言 section owner 能从投研页调用 `openSection('models')` 且 settings panel 保持打开；再让新 UI 测试覆盖 missing/configured/read-only/restart-required、source runtime、owned/attached/external、9/11 工具数、stock-full/market-template-only/market-full、错误修复动作与日志路径。断言 UI 不渲染、不持有也不请求 Key value。

```sh
cd frontend
pnpm exec vitest run packages/client/ui-settings-general/tests/settings-root.client.spec.tsx packages/client/ui-settings-investment-research/tests --retry=0
```

预期失败：owner props 无 `openSection`，新 package/section 不存在。

- [ ] **最小 GREEN：** shell 把已有 `openSection` 传给 active section；`ui-settings-models` 不改业务代码。新 UI 只注入 `slots`、`locale`、`investmentResearchRuntimeClient`，注册 `settings.section` id `investment-research`；缺 Key 按钮只调用 `props.openSection('models')`；restart-required 按钮调用 facade 的 `requestRestart()`；真实业务验收以逐项 checklist 展示并要求用户显式从对话执行，不从 UI 自动调用收费的 `analyze_stock`。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/client/ui-settings/tests packages/client/ui-settings-general/tests packages/client/ui-settings-models/tests packages/client/ui-settings-investment-research/tests packages/bundle/investment-runtime/tests --retry=0
pnpm exec tsc -b packages/client/ui-settings/tsconfig.json packages/client/ui-settings-general/tsconfig.json packages/client/ui-settings-investment-research/tsconfig.json --pretty false
pnpm run verify-client-domain-graph
```

- [ ] **跨平台验证：** UI/jsdom 与 bundle 组合在 macOS/Windows Node 24 都跑；只允许文案和 normalized path 差异，不出现平台分叉 UI。键盘 focus、Escape、Models 导航和 restart 按钮均用平台无关测试。
- [ ] **提交边界：** 只包含通用导航 prop、投研 UI package 与 investment-runtime bundle 接入；不把投研 row 放进 `web-app` bundle，不复制 Models 组件。

```sh
git add frontend/packages/client/ui-settings frontend/packages/client/ui-settings-general frontend/packages/client/ui-settings-investment-research frontend/packages/bundle/investment-runtime frontend/tsconfig.client.json
git commit -m "feat: add investment readiness settings"
```

## 任务 9：增加统一的源码 backend 初始化与验证入口

**文件范围：**

- 新建：`frontend/scripts/investment-python.ts`
- 新建：`frontend/scripts/investment-python.spec.ts`
- 修改：`frontend/package.json`

**命令契约：**

```sh
pnpm run investment:python:init
pnpm run investment:python:verify
```

- [ ] **TDD RED：** 先以 fake spawn 测试固定顺序 `dsh-trading-core` → `market-watch`、任一失败立即停止并保留 exit code、路径包含空格/中文、POSIX 调用 `init.sh`/`verify.sh`、Windows 调用 `cmd.exe /d /s /c init.bat|verify.bat`。`verify` 在 env 缺失时输出两个 backend 的绝对目录与对应 init 命令，不尝试安装。

```sh
cd frontend
pnpm exec vitest run scripts/investment-python.spec.ts --retry=0
```

预期失败：统一 driver 和 package scripts 尚不存在。

- [ ] **最小 GREEN：** TypeScript driver 只解析 `init|verify`，从 `frontend` 安装位置稳定解析仓库根，不使用 caller cwd；使用 `spawn` 数组参数，不拼 shell 字符串；`init` 是唯一允许调用 backend 安装脚本的入口，`verify` 只运行既有验证脚本。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run scripts/investment-python.spec.ts --retry=0
pnpm run investment:python:verify
```

- [ ] **跨平台验证：** macOS runner 真实执行 `verify.sh`，Windows runner 真实执行 `verify.bat`；两个 runner 另以临时含空格和中文的 fixture 路径验证 argv，不在 CI 中重复运行昂贵 init。
- [ ] **提交边界：** 只提交统一 driver、测试与 package scripts；不修改 env 内容或自动触发 init。

```sh
git add frontend/scripts/investment-python.ts frontend/scripts/investment-python.spec.ts frontend/package.json
git commit -m "feat: add investment Python setup commands"
```

## 任务 10：完成源码端到端、secret 负向扫描、跨平台矩阵与文档

**文件范围：**

- 修改：`frontend/packages/investment-research/python-runtime/tests/managed-fake-runner.e2e.ts`
- 修改：`frontend/packages/investment-research/python-runtime/tests/profile-composition.e2e.ts`
- 修改：`frontend/apps/electron/tests/investment-profile.e2e.ts`
- 新建：`frontend/packages/investment-research/python-runtime/tests/credential-security.e2e.ts`
- 修改：`frontend/.github/workflows/ci.yml`
- 修改：`frontend/package.json`
- 修改：`frontend/packages/investment-research/python-runtime/README.md`
- 修改：`frontend/packages/investment-research/python-runtime/README.zh.md`
- 修改：`frontend/packages/investment-research/python-runtime/README.i18n.yaml`
- 修改：`frontend/apps/electron/README.md`
- 修改：`frontend/apps/electron/README.zh.md`
- 修改：`frontend/apps/electron/README.i18n.yaml`
- 新建：`frontend/.agents/notes/implemented/architecture/2026-08-22-investment-credential-readiness.md`
- 新建：`frontend/.agents/notes/implemented/architecture/2026-08-22-investment-credential-readiness.zh.md`
- 新建：`frontend/.agents/notes/implemented/architecture/2026-08-22-investment-credential-readiness.i18n.yaml`

- [ ] **TDD RED：** 先扩展 e2e 证明 keyless Profile 保留 20 个工具与投研页面；fake credential 配置后 owned 两 child 收到 allowlist；attached/external 不调用 resolver；update 后 readiness 为 restart-required 且 LLM preflight 拒绝；重启后 full-ready。用 canary `sk-dsh-secret-canary-...` 扫描 argv、Cordis dump、Runtime state/log、snapshot、异常与测试输出。

```sh
cd frontend
DSH_INVESTMENT_TEST_PYTHON=../backend/dsh-trading-core/env/bin/python pnpm exec vitest run --config vitest.e2e.config.ts packages/investment-research/python-runtime/tests/{managed-fake-runner,profile-composition,credential-security}.e2e.ts apps/electron/tests/investment-profile.e2e.ts --retry=0
```

Windows 把 interpreter 改为任一 Python 3.10 executable，由测试 fixture 创建/使用 backend 环境。预期失败：现有矩阵尚未覆盖 credential/readiness/restart/security。

- [ ] **最小 GREEN：** 只补测试、CI job、scripts 与文档缺口；README 记录 Models 单次输入、源码 init/verify、状态含义、attached/external 责任、restart 操作与用户显式业务 checklist。Agent Note 记录 package ownership、secret fence、quiescent restart 和 PR3 保留点。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm run test:investment-runtime:matrix
pnpm run build:lib:host
pnpm run typecheck:contracts-ready
pnpm run verify-translation-pairing --write packages/investment-research/python-runtime/README.md
pnpm run verify-translation-pairing --write apps/electron/README.md
pnpm run doc-sync
pnpm run verify-agent-note-format
pnpm run verify-agent-note-classification
```

- [ ] **跨平台验证：** CI required matrix 为 `macos-latest` 与 `windows-latest`，两者都运行 source managed fake、profile composition、Electron composition 与 security scan；真实 engine smoke 继续由已有 secret-gated workflow 执行，Key 不写 fixture/artifact。
- [ ] **提交边界：** 该提交只收口增量一的 e2e、CI、README 与 Agent Note；生成文件仅在门禁要求时显式加入。

```sh
git add frontend/packages/investment-research/python-runtime/tests frontend/apps/electron/tests/investment-profile.e2e.ts frontend/.github/workflows/ci.yml frontend/package.json frontend/packages/investment-research/python-runtime/README.md frontend/packages/investment-research/python-runtime/README.zh.md frontend/packages/investment-research/python-runtime/README.i18n.yaml frontend/apps/electron/README.md frontend/apps/electron/README.zh.md frontend/apps/electron/README.i18n.yaml frontend/.agents/notes/implemented/architecture/2026-08-22-investment-credential-readiness.md frontend/.agents/notes/implemented/architecture/2026-08-22-investment-credential-readiness.zh.md frontend/.agents/notes/implemented/architecture/2026-08-22-investment-credential-readiness.i18n.yaml
git commit -m "test: verify investment credential readiness end to end"
```

## 增量一完成门禁

- [ ] 从 PR2 merge commit 比较 scope，并确保 staged/committed files 不包含受保护未跟踪路径。

```sh
git status --short
git diff --check <PR2_MERGE_COMMIT>...HEAD
cd frontend
pnpm --silent run change-scope --base <PR2_MERGE_COMMIT>
pnpm run test:investment-runtime:matrix
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
```

- [ ] 手动源码验收只使用现有 Models 页面输入一次 Key；不编辑 backend `.env`。依次检查 9/11 工具、`watch_list`、`watch_add` 后再 `watch_list`、`get_watchlist`，最后由用户明确确认后运行一次收费的 `analyze_stock` 与一个盯盘工具。
- [ ] 合并增量一后再执行既定 PR3。PR3 把股票 HTTP/SSE 移到 adapter-client 时，必须保留股票插件 execute 入口的 `assertCapability()` 与 runtime definition；PR3 不接管 credentials、readiness 或 restart。

---

# 增量二：Electron packaged Python sidecar

## 任务 11：先让两个 Python backend 支持只读安装目录与统一可写 state 根

**文件范围：**

- 修改：`backend/dsh-trading-core/adapter/config.py`
- 修改：`backend/dsh-trading-core/adapter/store.py`
- 修改：`backend/dsh-trading-core/tradingagents/default_config.py`
- 修改：`backend/dsh-trading-core/tradingagents/config/config_manager.py`
- 修改：`backend/dsh-trading-core/tradingagents/graph/trading_graph.py`
- 修改：`backend/dsh-trading-core/tradingagents/utils/logging_manager.py`
- 修改：`backend/dsh-trading-core/adapter/backtest_runner.py`
- 新建：`backend/dsh-trading-core/tests/test_state_dir.py`
- 修改：`backend/market-watch/market_watch/config.py`
- 修改：`backend/market-watch/market_watch/store.py`
- 新建：`backend/market-watch/tests/test_state_dir.py`

**目录契约：**

```text
$DSH_INVESTMENT_STATE_DIR/
├── data/
├── cache/
├── logs/
├── state/
└── user-config/
```

- [ ] **TDD RED：** 把 backend 源码复制到只读 fixture，设置临时 `DSH_INVESTMENT_STATE_DIR`，执行 import、JsonStore 写入、日志初始化、最小 cache/result 路径解析；断言所有新文件只出现在 state 根，Resources fixture 的文件列表和 hash 完全不变。未设置变量时断言继续使用现有项目内默认。

```sh
backend/dsh-trading-core/env/bin/python -m unittest backend/dsh-trading-core/tests/test_state_dir.py
backend/market-watch/env/bin/python -m unittest backend/market-watch/tests/test_state_dir.py
```

预期失败：store/log/cache 仍从 `settings.root` 或相对 cwd 派生。

- [ ] **最小 GREEN：** 两个 config 各自只解析一次 absolute state root；store 使用 `<root>/data`，TradingAgents cache/result/log helper 从 `<root>/cache|state|logs` 派生；读取随包默认配置仍从 Resources，用户覆盖写入 `<root>/user-config`。禁止 `chdir` 作为修复。源码没有 env 时保持原行为。
- [ ] **focused 验证：**

```sh
backend/dsh-trading-core/env/bin/python -m unittest discover -s backend/dsh-trading-core/tests -p 'test_*.py'
backend/market-watch/env/bin/python -m unittest discover -s backend/market-watch/tests -p 'test_*.py'
```

- [ ] **跨平台验证：** macOS 使用 chmod 只读 fixture；Windows 使用 ACL/只读文件并以“source tree hash 不变 + 所有写入位于 temp state root”作为权威断言。两边都覆盖含空格和中文 state 路径。
- [ ] **提交边界：** 只提交 Python 写路径抽象与测试，不接 Runtime descriptor 或 packaging。

```sh
git add backend/dsh-trading-core backend/market-watch
git commit -m "feat: relocate packaged investment backend state"
```

## 任务 12：固定 bundled descriptor schema、哈希校验与 resolver 优先级

**文件范围：**

- 新建：`frontend/packages/investment-research/python-runtime/src/descriptor.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/path.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/types.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/runtime.ts`
- 新建：`frontend/packages/investment-research/python-runtime/tests/descriptor.spec.ts`
- 修改：`frontend/packages/investment-research/python-runtime/tests/path.spec.ts`
- 修改：`frontend/packages/investment-research/python-runtime/tests/runtime.spec.ts`

**`runtime.json` schema v1：**

```json
{
  "schemaVersion": 1,
  "python": { "version": "3.10.x", "platform": "darwin", "arch": "arm64", "executable": "runtime/bin/python3" },
  "sitePackages": "site-packages",
  "backends": {
    "trading-core": { "projectDir": "backends/dsh-trading-core", "module": "adapter.app:app" },
    "market-watch": { "projectDir": "backends/market-watch", "module": "market_watch.app:app" }
  },
  "files": [{ "path": "...", "sha256": "..." }]
}
```

实际 lock/build 阶段写入 exact Python patch；Runtime 只接受 `3.10` minor、当前 `process.platform/process.arch` 与完整 hash 列表。

- [ ] **TDD RED：** 覆盖固定优先级：有效显式绝对 projectDir；完整的 source project+env；从 package install ancestors 找到 `investment-python/runtime.json`。显式路径无效必须失败且 spy 证明不读 descriptor。再覆盖 schema/version/platform/arch/module/path traversal/绝对路径/缺文件/hash mismatch/可执行文件缺失。

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/{path,descriptor,runtime}.spec.ts --retry=0
```

预期失败：resolver 只有 explicit/source，无 descriptor parser 与 hash gate。

- [ ] **最小 GREEN：** parser 使用封闭 schema，所有 descriptor path 必须是 normalized relative path 且解析后仍在 sidecar root；启动前逐项 SHA-256 校验。`ResolvedBackendPaths` 增加 `source: 'source' | 'bundled'` 与 bundled `pythonPath/sitePackages/stateDir`。source candidate 只有 project 与 platform interpreter 都存在时才胜出；显式 candidate 一旦给出则无效即失败。bundled child env 显式设置 `PYTHONPATH=<site-packages>` 与 `DSH_INVESTMENT_STATE_DIR=<dshHome>/investment-research/<id>`。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/{path,descriptor,runtime,readiness}.spec.ts --retry=0
pnpm exec tsc -b packages/investment-research/python-runtime/tsconfig.json --pretty false
```

- [ ] **跨平台验证：** 单元测试显式覆盖 darwin arm64/x64 与 win32 x64 descriptor、`path.posix/path.win32`、反斜线 traversal、PE executable name 与 POSIX executable；真实 hash/exec smoke 在任务 14。
- [ ] **提交边界：** 只提交 descriptor/resolver/runtime source 支持；不创建 sidecar 产物，不改 Electron package。

```sh
git add frontend/packages/investment-research/python-runtime
git commit -m "feat: resolve bundled investment Python runtimes"
```

## 任务 13：建立可重现 sidecar lock、构建器与离线自检

**文件范围：**

- 新建：`frontend/config/investment-python-runtime-lock.json`
- 新建：`frontend/scripts/build-investment-python-sidecar.ts`
- 新建：`frontend/scripts/build-investment-python-sidecar.spec.ts`
- 新建：`frontend/scripts/smoke-investment-python-sidecar.ts`
- 新建：`frontend/scripts/smoke-investment-python-sidecar.spec.ts`
- 修改：`frontend/package.json`
- 修改：`frontend/.gitignore`

**lock 要求：** 每个 `darwin-arm64`、`darwin-x64`、`win32-x64` 条目固定 Python 3.10 exact patch、python-build-standalone release URL、archive SHA-256、archive 内 executable 路径；两个 requirements 文件也记录 SHA-256。不得使用 `latest`、浮动 URL 或未校验下载。

- [ ] **TDD RED：** 先以本地 fixture archive 测试：target 选择、download cache hash、解包 traversal、缺 target、错误 archive hash、requirements 漂移、离线 cache miss、native import failure、descriptor 文件清单稳定、第二次构建 byte-for-byte 相同。构建输出不得包含 backend `.env`、`env/`、`data/`、logs、`__pycache__`、`.pyc`、tests 或 secret canary。

```sh
cd frontend
pnpm exec vitest run scripts/{build-investment-python-sidecar,smoke-investment-python-sidecar}.spec.ts --retry=0
```

预期失败：lock、builder 与 smoke 不存在。

- [ ] **最小 GREEN：** TypeScript builder 只接受 `--target`、`--output`、`--cache`、`--offline`；下载只在显式 build 阶段发生。使用 lock 中 standalone Python 创建目标 `site-packages`，以 `python -m pip install --require-hashes` 安装由两个 backend requirements 归并并锁定的依赖；复制白名单源码；删除构建噪声；生成 sorted `runtime.json` 与 SHA-256。smoke 用 sidecar 自己的 Python 执行两个 module import、FastAPI health contract 与 native dependency import。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run scripts/{build-investment-python-sidecar,smoke-investment-python-sidecar}.spec.ts --retry=0
pnpm run investment:sidecar:build -- --target "$(node -p "process.platform+'-'+process.arch")"
pnpm run investment:sidecar:smoke -- --root .cache/investment-python/current
```

产物目录必须在 `.gitignore` 中；不得提交 archive、Python binary 或生成 sidecar。

- [ ] **跨平台验证：** macOS arm64/x64 与 Windows x64 原生 runner 各自构建自己的 target，运行 import/health/native smoke；不允许跨平台复用 site-packages。builder 的纯单元测试在所有平台运行。
- [ ] **提交边界：** 提交 lock、builder、smoke、tests 与 scripts，不提交生成产物。

```sh
git add frontend/config/investment-python-runtime-lock.json frontend/scripts/build-investment-python-sidecar.ts frontend/scripts/build-investment-python-sidecar.spec.ts frontend/scripts/smoke-investment-python-sidecar.ts frontend/scripts/smoke-investment-python-sidecar.spec.ts frontend/package.json frontend/.gitignore
git commit -m "build: create reproducible investment Python sidecars"
```

## 任务 14：把 sidecar 纳入 Electron package/make、签名与真实产物 smoke

**文件范围：**

- 修改：`frontend/apps/electron/src/packaging.ts`
- 修改：`frontend/apps/electron/forge.config.ts`
- 修改：`frontend/apps/electron/package.json`
- 修改：`frontend/apps/electron/tests/tsdown-config.spec.ts`
- 新建：`frontend/apps/electron/tests/packaging.spec.ts`
- 新建：`frontend/apps/electron/tests/packaged-investment-sidecar.e2e.ts`
- 修改：`frontend/.github/workflows/ci.yml`
- 新建：`frontend/.github/workflows/investment-sidecar.yml`

- [ ] **TDD RED：** 先让 packaging pure helper 测试断言 `package`/`make` 在 pnpm deploy 后构建当前 target sidecar，并以 `extraResource` 放到最终 `Resources/investment-python`；普通 app source/staging 不混入 sidecar cache。产物 e2e 从 packaged `resourcesPath` 读取 descriptor，运行 keyless Profile（stock 以显式 fake runner），断言 20 个工具、两个 healthy-owned、`bundled-ready`、state 只写 `$DSH_HOME`、dispose 后无残留进程。

```sh
cd frontend
pnpm exec vitest run apps/electron/tests/{packaging,tsdown-config}.spec.ts --retry=0
```

预期失败：packager 没有 extraResource，package/make 不构建 sidecar，也没有产物 smoke。

- [ ] **最小 GREEN：** `packaging.ts` 在临时目录构建 sidecar并传给 `@electron/packager`；finally 清理 staging 和 sidecar temp。macOS packaging 把 sidecar executable/dylib 纳入同一次 hardened-runtime codesign，再做 notarization/staple；Windows 保持文件 hash 与 Authenticode 发布步骤。任何 sidecar build、hash、sign 或 smoke 失败都阻止 artifact 发布。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run apps/electron/tests/{packaging,tsdown-config}.spec.ts --retry=0
pnpm run package:electron
pnpm exec vitest run --config vitest.e2e.config.ts apps/electron/tests/packaged-investment-sidecar.e2e.ts --retry=0
```

- [ ] **跨平台验证：** required artifact matrix：`macos-14` arm64、`macos-13` x64、`windows-latest` x64。每项对实际 packaged Resources 运行 descriptor/hash/import/health/tools/state/dispose smoke；macOS 额外 `codesign --verify --deep --strict` 与 `spctl`/notarization validation，Windows 额外验证 PE/native DLL 装载和签名。没有签名 secret 的 PR job 运行 ad-hoc codesign 与全部非公证 gate；release job 使用 secret 做正式签名/公证。
- [ ] **提交边界：** 只提交 Electron packaging、artifact tests 与 CI workflow；不提交 out/make/cache 产物。

```sh
git add frontend/apps/electron/src/packaging.ts frontend/apps/electron/forge.config.ts frontend/apps/electron/package.json frontend/apps/electron/tests frontend/.github/workflows/ci.yml frontend/.github/workflows/investment-sidecar.yml
git commit -m "build: package investment Python with electron"
```

## 任务 15：验证 packaged restart、损坏降级、安全扫描并完成交付文档

**文件范围：**

- 修改：`frontend/apps/electron/tests/packaged-investment-sidecar.e2e.ts`
- 新建：`frontend/apps/electron/tests/packaged-investment-restart.e2e.ts`
- 新建：`frontend/apps/electron/tests/packaged-investment-corruption.e2e.ts`
- 修改：`frontend/packages/investment-research/python-runtime/README.md`
- 修改：`frontend/packages/investment-research/python-runtime/README.zh.md`
- 修改：`frontend/packages/investment-research/python-runtime/README.i18n.yaml`
- 修改：`frontend/apps/electron/README.md`
- 修改：`frontend/apps/electron/README.zh.md`
- 修改：`frontend/apps/electron/README.i18n.yaml`
- 新建：`frontend/.agents/notes/implemented/architecture/2026-08-22-investment-python-sidecar.md`
- 新建：`frontend/.agents/notes/implemented/architecture/2026-08-22-investment-python-sidecar.zh.md`
- 新建：`frontend/.agents/notes/implemented/architecture/2026-08-22-investment-python-sidecar.i18n.yaml`

- [ ] **TDD RED：** 在复制的 packaged fixture 中测试：Key 更新→restart-required→显式 restart→旧 Profile quiescent→新进程重新解析 Key→full-ready；篡改任一 backend/native file 后启动前报 `invalid`，指向重装，不联网修复；删除 descriptor/runtime 后报 `missing`；整个 app/resources/DSH_HOME test fixture 扫描 secret canary，允许的唯一出现位置是测试进程内 fake credential provider。

```sh
cd frontend
pnpm exec vitest run --config vitest.e2e.config.ts apps/electron/tests/packaged-investment-{sidecar,restart,corruption}.e2e.ts --retry=0
```

预期失败：前一任务只覆盖首次 packaged 启停，尚无 restart/corruption/security 完整验收。

- [ ] **最小 GREEN：** 只修补 e2e 暴露的 packaged integration 缺口；不改变 resolver 优先级或进程所有权。README 记录 Resources layout、只读/可写边界、source/bundled 优先级、重装错误、平台支持与发布 smoke。Agent Note 记录 lock、descriptor、signing、state-root 与不可联网修复的不变量。
- [ ] **focused 验证：**

```sh
cd frontend
pnpm exec vitest run --config vitest.e2e.config.ts apps/electron/tests/packaged-investment-{sidecar,restart,corruption}.e2e.ts --retry=0
pnpm run verify-translation-pairing --write packages/investment-research/python-runtime/README.md
pnpm run verify-translation-pairing --write apps/electron/README.md
pnpm run doc-sync
pnpm run verify-agent-note-format
pnpm run verify-agent-note-classification
```

- [ ] **跨平台验证：** 三个 packaged target 都运行 restart/corruption/security 测试；重启后的新 PID/新 backend handles 必须不同，旧 owned tree 必须退出。macOS/Windows 的 DSH_HOME 均使用含空格和中文的临时路径。
- [ ] **提交边界：** 只提交 packaged 验收、README 与 Agent Note，不提交产物。

```sh
git add frontend/apps/electron/tests/packaged-investment-sidecar.e2e.ts frontend/apps/electron/tests/packaged-investment-restart.e2e.ts frontend/apps/electron/tests/packaged-investment-corruption.e2e.ts frontend/packages/investment-research/python-runtime/README.md frontend/packages/investment-research/python-runtime/README.zh.md frontend/packages/investment-research/python-runtime/README.i18n.yaml frontend/apps/electron/README.md frontend/apps/electron/README.zh.md frontend/apps/electron/README.i18n.yaml frontend/.agents/notes/implemented/architecture/2026-08-22-investment-python-sidecar.md frontend/.agents/notes/implemented/architecture/2026-08-22-investment-python-sidecar.zh.md frontend/.agents/notes/implemented/architecture/2026-08-22-investment-python-sidecar.i18n.yaml
git commit -m "test: verify packaged investment runtime delivery"
```

## 增量二完成门禁

- [ ] 对包含增量一与 PR3 的 merge base 运行 scope gate；确认没有修改 `frontend/packages/investment-research/adapter-client`，没有提交 sidecar binary/cache/out。

```sh
git status --short
git diff --name-only <INCREMENT_2_BASE>...HEAD
git diff --check <INCREMENT_2_BASE>...HEAD
cd frontend
pnpm --silent run change-scope --base <INCREMENT_2_BASE>
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run test:investment-runtime:matrix
pnpm run package:electron
```

- [ ] 在 macOS arm64/x64 和 Windows x64 的 actual artifact job 中全部通过 sidecar、restart、corruption、security 与进程残留检查后，才能称 packaged 增量完成。
- [ ] 最终用户验收：安装应用后不安装 Python、不运行 pip、不编辑 backend `.env`；只在 Models 输入一次 DeepSeek Key，重启一次投研应用，readiness 显示 bundled-ready、两个 healthy-owned、9+11 工具；用户明确触发后完成真实 `analyze_stock` 和至少一个盯盘数据工具。

## 明确延后

- backend 级 rolling restart 与 operation drain 优化。
- Host 本地模型凭据代理。
- 非 DeepSeek provider 自动映射。
- 平台托管额度。
- Tushare、ServerChan、WeCom 等可选凭据的产品设置面。
- 对既定 PR3 adapter-client 的任何重设计；本计划只要求 PR3 保留 Host preflight 边界。
