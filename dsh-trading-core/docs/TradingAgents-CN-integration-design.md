# TradingAgents-CN 集成设计方案（落地版：核心抽离 + 无状态 HTTP 服务）

> 状态：待评审（暂不实施）· 用途：个人学习/研究 · 依据：TradingAgents-CN v1.1.0（2025 调研）
> 本文定义最终方案的落地方式与接口清单，不展开备选权衡。评审通过后按第 12 节里程碑实施。

## 1. 目标

把 [TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN) 的多智能体股票分析能力接入 DeepSeek Harness Web GUI，并预留 Flutter 移动端复用：核心抽离为独立 Python 模块，运行成无状态 HTTP 服务；React 前端插件经 Node 宿主插件调用；桌面 localhost 与移动端远程服务器共用同一 `/v1` API。

- 范围：只使用 Apache 2.0 开放核心 `tradingagents/`（入口 `TradingAgentsGraph`），不碰 `app/`、`frontend/`、MongoDB、Redis；个人学习/研究用途。
- 非目标：模拟交易、用户认证、自选股、报告导出、Flutter 客户端本身（本阶段只保证 `/v1` API 稳定可复用）。

## 2. 最终架构

```
桌面：React 插件 → ctx.connection.rpc → Node 宿主插件 ──HTTP/SSE──┐
移动：Flutter App ───────────────────────HTTP/SSE────────────────┼──▶ 核心服务（桌面 localhost / 移动端远程）
```

关键决定（各一行）：
1. 核心 = 独立无状态 HTTP 服务（`POST /v1/analyze` 单次 SSE 流），桌面本地跑、移动端远程跑，同一 API。
2. shim 层取消：Node 宿主插件直调核心服务 HTTP。
3. 无状态：服务端不保留任务注册表与队列；注册表/队列/重试都在宿主插件侧。
4. 浏览器不直接调 Python：桌面经 Node 宿主中转，移动端经远程 HTTP。

## 3. 落地组件

| # | 组件 | 位置 | 形态 | 是否核心改动 |
|---|---|---|---|---|
| 1 | 核心 `dsh-trading-core` | 独立 Python 仓库（抽离自 `tradingagents/`，不在 dsh 仓库内） | pip 包 + HTTP 服务入口 | 否（外部运行时依赖） |
| 2 | 宿主插件 | `packages/trading/dsh-trading-backend` | Cordis 插件（进程管理 + HTTP 客户端 + RPC 通道） | 否 |
| 3 | 前端插件 | `packages/client/ui-trading` | `dsh.client` 客户端插件 | 否（三处注册见 6.1） |
| 4 | 事件 allowlist | `packages/api/remotes/src/remote-events.ts` | 加 3 个事件名 | **唯一核心改动（一行）** |
| 5 | 分发层 | `packages/bundle/trading/`（profile bundle）或 examples cordis.yml 叶 | 用户安装入口 | 否 |

## 4. 核心服务（dsh-trading-core）

### 4.1 部署

- 桌面：宿主插件懒启动 `python -m dsh_trading_core serve --port 8600`；健康检查 30s、崩溃重启（退避 1s/2s/4s，3 次后 `degraded`）、dispose 时 SIGTERM → 3s 强杀。
- 远程（移动端场景）：服务器部署（systemd/docker + 反代 TLS），客户端只连不管理。
- 就绪检查（首次调用）：探测 `TRADING_CORE_URL` 可达 + 健康检查；不可达返回 `UNREACHABLE` / `PYTHON_UNAVAILABLE`（附安装引导），不静默失败；`TRADING_AUTO_SETUP=true` 时宿主自动建 venv 并安装核心包（`TRADING_CORE_PATH` 或 git URL）。

### 4.2 HTTP API（版本化 `/v1`）

Base：`http://127.0.0.1:8600`（可配 `TRADING_CORE_URL`）。JSON 请求/响应，进度走 SSE。

| method | path | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| `POST` | `/v1/analyze` | `{ticker, market?, date?, options?, config?}` | **SSE 流**（`started`/`progress`/`done`/`error`） | 核心端点：一次请求一次流，服务端无注册表 |
| `POST` | `/v1/analyze/{runId}/cancel` | – | `{cancelled: true}` | 显式取消；客户端断开同样中断 run |
| `GET` | `/v1/health` | – | `{ok, version}` | 健康检查与版本 |
| `GET` | `/v1/config/defaults` | – | `{config}` | 默认配置（前端表单回填） |
| `POST` | `/v1/config/validate` | `{patch}` | `{ok, errors?}` | 校验请求级 config，不落服务端状态 |

`AnalyzeRequest` 字段：`ticker`（必填，如 `"000001"`/`"NVDA"`，格式待验证）、`market`（`A|HK|US`，默认 `A`）、`date`（`YYYY-MM-DD`，可选）、`options`（`max_debate_rounds?`/`online_tools?`/`deep_think_llm?`/`quick_think_llm?`）、`config`（请求级 LLM/数据源覆盖，**不含密钥**）。

### 4.3 SSE 事件（analyze 流内）

| event | data | 说明 |
|---|---|---|
| `started` | `{runId, ticker, date}` | run 开始 |
| `progress` | `{runId, stage, pct, message}` | `stage`: `fundamental / technical / news / sentiment / debate / final` |
| `done` | `{runId, decision}` | `decision` = `propagate()` 第二返回值 |
| `error` | `{runId, code, message}` | 失败 |

连接结束 = run 结束；客户端断开 = run 中断（重新提交即重跑）。

### 4.4 配置映射

| 环境变量 | 位置 | 映射 |
|---|---|---|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | 服务端 env（桌面由宿主注入） | `llm_provider` + `backend_url`（自定义 OpenAI 兼容端点，复用 DeepSeek key） |
| `TUSHARE_TOKEN`（可选） | 服务端 env | Tushare 数据源 token |
| `TRADING_CORE_URL` | 客户端 | 核心服务地址，默认 `http://127.0.0.1:8600` |
| `TRADING_CORE_TOKEN`（可选） | 客户端 | 远程部署 bearer token |
| `TRADING_PYTHON` / `TRADING_CORE_PATH` / `TRADING_AUTO_SETUP` | 客户端 | 桌面 spawn 与自动安装 |

密钥只存服务端 env，不进 wire、不进前端；请求级 `config` 只覆盖 provider/模型/数据源选择。

### 4.5 并发

单飞 + 队列在客户端（LLM 成本约束）；服务端并发上限 1，饱和返回 429，不排队。

## 5. 宿主插件（dsh-trading-backend）

### 5.1 生命周期（桌面模式）

- 懒启动：首个 RPC 到达时 spawn 核心服务（`TRADING_CORE_URL` 未配置或指向本地时）。
- `ctx.on('dispose')`：SIGTERM → 3s 强杀 → 清理句柄。
- 崩溃重启：指数退避（1s/2s/4s），3 次后 `degraded`；`/v1/health` 判定存活。
- 远程模式：`TRADING_CORE_URL` 指向远程 → 不做进程管理，只做健康检查与调用。

### 5.2 ctx 服务（HTTP 客户端封装）

```ts
interface TradingService {
  analyze(req: AnalyzeRequest): Promise<RunHandle>
  cancel(runId: string): Promise<void>
  health(): Promise<{ ok: boolean; version?: string }>
  defaults(): Promise<ConfigDefaults>
  validate(config: Partial<Config>): Promise<ValidationResult>
}

interface AnalyzeRequest {
  ticker: string
  market?: 'A' | 'HK' | 'US'
  date?: string
  options?: { max_debate_rounds?: number; online_tools?: boolean; deep_think_llm?: string; quick_think_llm?: string }
  config?: Partial<Config>   // 不含密钥
}

interface RunHandle {
  runId: string
  onProgress(cb: (e: ProgressEvent) => void): () => void
  done: Promise<AnalyzeResult>          // decision 结构待验证
  cancel(): Promise<void>
}

interface ProgressEvent { runId: string; stage: string; pct: number; message: string }
interface AnalyzeResult { decision: unknown }
```

内部组件：SSE 客户端（解析事件流、断线处理）、超时（`analyze` 默认 15min 可配）、宿主侧任务注册表 + 单飞队列（5.5）。

### 5.3 RPC 通道（浏览器 ↔ 宿主）

```ts
ctx.connection.rpc.handle('/trading', handler, { authority: 'loopback' })
```

端点：`analyze` / `cancel` / `status` / `defaults` / `validate` / `health` / `setup.status` / `setup.guide`。
返回统一 `RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }`（`@deepseek-ai/dsh-host-apiproxy/api` 现成类型）。
错误码：`BAD_REQUEST` / `BUSY` / `NOT_FOUND` / `UNREACHABLE` / `PYTHON_UNAVAILABLE` / `TIMEOUT` / `INTERNAL`。

### 5.4 事件转发（宿主 → 浏览器）

- allowlist（`packages/api/remotes/src/remote-events.ts`）追加 `'trading/progress'`、`'trading/done'`、`'trading/error'`；浏览器 `ctx.remote.$on` 消费。
- M1–M3 先轮询 `status`（零核心改动），M4 再上 allowlist + 事件。

### 5.5 任务注册表（宿主侧）

宿主维护 `Map<runId, RunState>` + 单飞队列；崩溃/断线标记失败，前端提示重试（无状态语义：重新提交即重新分析）。

## 6. 前端插件（ui-trading）

### 6.1 三处注册

1. `package.json`：`@deepseek-ai/dsh-client-ui-trading`，`exports` 含 `./client`，`dsh.client` manifest（`platform: 'web'`），tsdown `clientBundle(...)`。
2. `tsconfig.client.json` aggregate 加 `references` 条目。
3. `packages/bundle/web-app/cordis.patch.yml` 加行 + web-app `package.json` 加依赖。

骨架参考：`packages/client/ui-sidebar`（最小插件）、`docs/cookbook/adding-a-conversation-node.md`。

### 6.2 挂载点

选定：`conversation.input.dock` 表单 + `conversation.session.header.actions` 入口按钮（ui-goal / ui-jobs 同款注册；纯 UI + RPC，无需会话事件）。
备选：`shell.overlay` 浮动面板。不采用会话时间线节点（需宿主发 session 事件，成本高）。

### 6.3 组件与状态

- `TradingDock`：表单（代码/市场/日期 + 提交/取消；未就绪时显示安装引导卡）
- `ProgressCard`：阶段进度条（stage + pct + message）
- `ResultCard`：decision 摘要渲染（结构待验证后定）
- 状态：`createTradingStore()`（tasks / progress / results；actions: `submit` / `cancel` / `clear`）

### 6.4 数据流

```
提交 → store.submit → ctx.connection.rpc.call('/trading', 'analyze', {ticker, date}) → RunHandle 入 store
进度 → ctx.remote.$on('trading/progress', cb) → store.update    // M4；M1–M3 轮询 status
完成 → 'trading/done'（或 status state=done）→ ResultCard
失败 → 'trading/error'（或 status state=error）→ 错误展示 + 重试
```

### 6.5 约束

中文产品文案、CSS Modules + `--dsw-*` token、纯 props 组件、ctx 只出现在 apply/inject。

## 7. 接口清单汇总

| 面 | 位置 | 内容 |
|---|---|---|
| 协议面（客户端 ↔ 核心服务） | 4.2–4.3 | HTTP 端点 / SSE 事件 / 错误码 |
| RPC 面（浏览器 ↔ Node 宿主） | 5.3 | 端点 / RpcResult / 错误码 |
| 服务面（Node 内部） | 5.2 | TS 类型 |
| UI 面（React 内部） | 6.3 | 组件与 store |
| 配置面 | 4.4 | 环境变量表 |

## 8. 配置与密钥

- 桌面用户 `.env`：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`TUSHARE_TOKEN`（可选）、`TRADING_CORE_URL`、`TRADING_PYTHON`、`TRADING_CORE_PATH`、`TRADING_AUTO_SETUP`。
- 远程部署：服务器 env 持 key；客户端配 `TRADING_CORE_URL` + `TRADING_CORE_TOKEN`。

## 9. 分发与安装

- 交付：profile bundle（`packages/bundle/trading/`，`dsh --profile trading`）或 examples cordis.yml 叶；用户按需启用，不装不影响既有功能。
- 桌面三步：`pip install dsh-trading-core`（或 `TRADING_AUTO_SETUP=true` 自动建 venv）→ `.env` 配置 → 启动 dsh（宿主自动拉起核心服务）。
- 远程：服务器部署核心服务 + 反代 TLS + `TRADING_CORE_TOKEN`；桌面与移动端共用同一 `/v1` API。
- 运行行为一览：

| 场景 | 行为 | 需要配置 |
|---|---|---|
| 桌面（默认） | 宿主自动拉起本地核心服务并调用 | 无（零配置） |
| 桌面 + `TRADING_AUTO_SETUP=true` | 自动建 venv + 安装核心包后拉起 | 核心包来源（`TRADING_CORE_PATH` 或 git URL） |
| 桌面指向远端 | 不做进程管理，只健康检查与调用 | `TRADING_CORE_URL`（+ `TRADING_CORE_TOKEN`） |
| 移动端 | 直连远端服务器 | `TRADING_CORE_URL` + `TRADING_CORE_TOKEN` |

- 就绪状态机：`unconfigured` → `setup-required` → `ready` / `degraded`；前端非 `ready` 显示安装引导卡。
- 许可：核心为 Apache 2.0 开放核心的抽离/再分发，保留原 LICENSE 与版权声明；不嵌入 `app/`、`frontend/` 代码；商用需遵守 TradingAgents-CN 授权条款。

## 10. 错误处理

- 服务不可达/未安装 → `UNREACHABLE` / `PYTHON_UNAVAILABLE` + 安装引导。
- 分析超时/死循环 → 桌面 kill 进程重启，远程断开流，返回 `TIMEOUT`。
- 断线：客户端重新提交即重跑（不自动重试，LLM 重跑成本由用户确认）。
- 取消：显式 `cancel` 或客户端断开。
- 安全：localhost 默认无鉴权；远程必须 token + 反代 TLS。
- 沙箱：宿主 spawn 的核心服务不受 bash 工具文件沙箱约束；数据缓存写入工作区/服务端缓存目录（外部可丢弃资源）。

## 11. 落地前待验证项（M1 范围）

- [ ] `tradingagents/` 核心 import 面与最小依赖（是否拉入 chromadb/chainlit 等重依赖），裁剪后独立包可安装、可起服务。
- [ ] `propagate(ticker, date)` 对 A 股代码格式（`000001` vs `000001.SZ`）与 `date` 必填性。
- [ ] `decision` 返回结构（决定 `analyze.done` 的 result 定义与 ResultCard 渲染）。
- [ ] DeepSeek 兼容端点在 `DEFAULT_CONFIG` 的确切键名与 `llm_provider` 取值。
- [ ] 首次分析耗时与 token 成本（决定默认超时、并发上限、队列深度）。
- [ ] 数据源：akshare 免费可用性 vs tushare token 必要性。
- [ ] SSE 消费：Node `fetch`/`ReadableStream` 解析；Dart `http` 流式读取（Flutter 复用验证）。
- [ ] 远程部署安全（token、TLS）、移动网络长连接稳定性、断线重跑成本。
- [ ] allowlist 改动后 typecheck 与 web 构建。
- [ ] Windows/macOS/Linux venv 与 spawn 差异；Python ≥3.10。

## 12. 里程碑（实施顺序）

| 里程碑 | 交付 | 验证 |
|---|---|---|
| M1 核心抽离与服务原型 | `dsh-trading-core` 独立包 + HTTP 服务 + SSE `analyze` 流 | `curl` 手动跑通一次 analyze 流 |
| M1.5 用户安装路径 | pip 安装 + `.env` 全流程 | 干净环境从零装一次 |
| M2 宿主插件 | spawn/健康/重启 + HTTP 客户端 + `/trading` RPC | GUI 内 RPC 冒烟 |
| M3 前端插件 | `ui-trading`：dock 表单 + 进度 + 结果 | `dev:web` 刷新验证 |
| M4 事件化与增强 | allowlist + `ctx.remote.$on`；冻结 `/v1` API | `dev:web` + typecheck |
| M5（后续）Flutter 客户端 | 消费同一 `/v1` API | 移动端联调 |

每个里程碑独立可回退；M1 不依赖 harness，风险最低，建议先行。
