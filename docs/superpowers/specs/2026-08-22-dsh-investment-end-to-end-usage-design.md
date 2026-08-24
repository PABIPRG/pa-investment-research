# DSH 投研端到端凭据、就绪引导与 Python 交付设计

## 状态

- 日期：2026-08-22
- 状态：核心产品决策已确认，书面规格待新会话复核后编写实施计划
- 前置规格：[DSH 投研插件归属、原生组合与 Python 运行时设计](2026-08-20-dsh-integration-boundary-design.md)
- 当前实现基础：PR2 的 `investment-research` Profile、三个投研 Bundle、`InvestmentPythonRuntime` 与两个 managed Python backend

本规格扩展现有架构，不替代也不重开前置规格。`managed`／`external`、五层 Profile、patch-only Bundle、纯 Python backend、owned／attached 进程所有权和 PR3 adapter-client 边界保持不变。

## 背景

当前源码环境已经可以通过以下入口加载股票分析和盘中盯盘模块：

```sh
cd frontend
pnpm dsh electron --profile investment-research
```

PR2 的真实 managed engine smoke 已证明两个 Python backend 可以由 Profile 启动、通过身份健康检查并在 Profile 释放时退出；Profile 组合会注册股票分析的 9 个工具和盘中盯盘的 11 个工具。

但是「能够启动」还不等于普通用户可以端到端使用：

1. 前端 Models 页面把 `DEEPSEEK_API_KEY` 写入统一的 `ctx.credentials` seam（当前本地提供方为 `$DSH_HOME/.credentials.yaml`）。
2. `dsh-trading-core` 与 `market-watch` 仍分别从各自项目根 `.env` 读取 `DEEPSEEK_API_KEY`。
3. 前端保存的 Key 不会自动进入已经运行的 Python backend；用户必须理解并维护多份配置。
4. backend 健康检查只证明 HTTP 服务和身份正确，不证明模型凭据、行情网络或完整业务调用可用。
5. 源码模式仍要求用户预先创建两个 Python 虚拟环境；打包后的普通桌面用户没有自包含 Python 运行时。

因此产品需要统一凭据入口、明确的投研就绪状态、可执行的首次使用引导，以及源码开发和打包交付两种 managed 解析策略。

## 已确认的产品决策

### 只输入一次 DeepSeek Key

用户继续使用现有 Models 页面和 DeepSeek 首次使用引导输入 Key。投研模块不得新增第二个 Key 输入框，也不得把 Key 复制到两个 backend 的 `.env`。

凭据的唯一逻辑引用为：

```text
DEEPSEEK_API_KEY
```

前端 Agent、股票分析 backend 和盘中盯盘 backend 都引用该凭据。配置只保存引用；值继续由 `ctx.credentials` 的提供方持有。

### 第一版投研 LLM 固定使用 DeepSeek

用户可以为前端对话选择其他模型，但第一版 Python 投研能力仍明确依赖 `DEEPSEEK_API_KEY`。其他前端模型提供方的 Key 不会自动映射为 Python backend 的模型凭据。

盘中盯盘现有的无 LLM 数据模板回退继续保留，但产品就绪状态必须区分「基础盯盘可用」与「完整 DeepSeek 解读可用」。股票分析的真实 engine 调用缺少 DeepSeek Key 时必须给出可执行的配置指引，不能伪装为完整可用。

### 第一版采用 BYOK

第一版采用用户自带 Key（BYOK）。应用不得内置、提交或打包平台公共 Key。

如果未来由平台提供模型额度，应另建服务端凭据代理、用户鉴权、配额、审计和限流方案；不得把平台 Key 放进 Electron 包或下发到用户机器。

### 同时支持源码和打包形态

最终产品支持两种 managed 交付形态，并复用同一个 Runtime 生命周期：

| 形态 | Python 来源 | backend 来源 | 用户是否运行 `pip install` |
| --- | --- | --- | --- |
| 源码开发 | 仓库内 `backend/*/env` | 仓库源码 | 是，只在显式初始化时 |
| 打包桌面 | Electron Resources 内的固定 Python sidecar | Electron Resources 内的 backend 与依赖 | 否 |

`external` 模式继续由部署方管理服务端凭据，Host 不向外部 endpoint 发送本机 DeepSeek Key。

## 目标

- 用户只在现有前端 Models 页面配置一次 DeepSeek Key。
- 同一个凭据引用同时服务前端 Agent 和 owned managed 投研 backend。
- 投研 Profile 缺少 Key 时仍能打开 UI，并显示明确、可修复的降级状态。
- 源码 Python 环境或打包 backend 资源缺失时保持现有 fail-loud 边界，由启动前检查或启动错误给出可执行修复动作，不发布半启动的工具树。
- 用户可以区分 Profile 已加载、backend 已健康、凭据已生效和真实业务调用已通过。
- 源码开发者保留显式、可重复执行的 Python 初始化流程。
- 普通桌面用户安装应用后无需自行安装 Python、创建 venv 或下载仓库。
- 凭据不进入 Cordis patch、settings 文档、Runtime state、日志、命令行参数或应用安装包。
- 现有 managed 进程所有权、single-flight、引用计数和 quiescent teardown 语义保持成立。
- macOS 和 Windows 拥有相同的产品流程和等价验证。

## 非目标

- 不在本工作中实现或提前修改 PR3 的 `adapter-client`。
- 不允许 Python backend 直接解析 `$DSH_HOME/.credentials.yaml`。
- 不把 credential provider 退化为全局 `process.env` 同步器。
- 不在应用启动时执行 `pip install`、创建 venv 或修改用户仓库。
- 不让 attached／external 服务继承本机 managed 凭据。
- 不在第一版支持任意前端模型提供方自动驱动 Python engine。
- 不在第一版实现平台托管模型额度。
- 不把行情网络探测放入每次 Profile 启动的阻塞路径。
- 不自动启用外部推送、定时任务、Tushare 或其他可选服务。

## 方案比较

### 方案一：把前端 Key 复制进 backend `.env`

优点是改动小，现有 Python 读取逻辑无需变化。

该方案被拒绝。它产生三份密钥、使轮换和删除发生漂移、把 Host 凭据提供方的优先级与权限语义绕开，并要求前端修改源码目录或应用资源目录。打包应用的 Resources 也可能只读，不能承担用户机密存储。

### 方案二：Host 解析凭据并注入 owned managed 子进程

这是第一版采用的方案。backend 定义只声明凭据引用及目标环境变量；Runtime 在 spawn 前调用 `ctx.credentials.resolve()`，并把值加入仅对子进程生效的环境。父进程的 `process.env`、Cordis 配置和 Runtime state 都不物化该值。

优点是复用现有 credential seam、改动集中、与源码和打包 sidecar 都兼容。代价是 Python 当前在进程启动时读取配置，所以凭据更新后需要安全重启 managed backend 才能生效。

### 方案三：本地模型凭据代理

Host 可以在 loopback 上提供带临时授权的 OpenAI-compatible 代理，Python backend 只持有临时 token，真实 DeepSeek Key 在每次上游请求时由 Host 解析。该方案可立即响应 Key 轮换，也不会把真实 Key 交给 Python child。

该方案暂缓。它需要新增流式代理、上游错误映射、临时授权、端口所有权和滥用防护，是独立子系统；第一版 BYOK 与本地受信任 child 不需要承担这份复杂度。若后续要求无重启轮换或更严格的进程隔离，再单独设计。

## 目标架构

### 凭据数据流

```text
Models 页面中的现有 DeepSeek 输入框
    ↓ credentials.set(DEEPSEEK_API_KEY)
ctx.credentials / $DSH_HOME/.credentials.yaml
    ├── 每次前端模型请求解析 → 前端 Agent
    └── owned managed spawn 前解析 → child-only env
                                   ├── dsh-trading-core
                                   └── market-watch
```

Host 只传递运行 backend 所需的允许列表：

| Credential ref | child 环境变量 | 使用者 | 必需性 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | 两个 backend | 完整投研体验必需 |
| `DEEPSEEK_API_KEY` | `OPENAI_API_KEY` | trading engine 的 OpenAI-compatible 路径 | 同上，值不另存一份 |

`DEEPSEEK_BASE_URL` 不是机密。第一版 backend 继续使用官方默认值；自定义 gateway 的统一设置映射另行增加普通 settings 字段，不与 Key 存储混合。

`TUSHARE_TOKEN`、`SERVERCHAN_SENDKEY`、`WECOM_WEBHOOK_KEY` 等可选凭据不进入第一版默认传播列表。它们应在出现对应产品设置面后逐项声明，不能把整个凭据存储或父进程环境透传给 child。

### Runtime backend 定义

backend 定义增加声明式凭据环境映射，概念形态如下：

```ts
interface ManagedCredentialEnv {
  readonly ref: CredentialRef
  readonly env: string
  readonly role: 'required' | 'enhancement'
}
```

定义只携带引用和目标变量，不携带值。Runtime 对映射做以下校验：

- `env` 必须是合法且不重复的环境变量名。
- 相同 backend id 的注册冲突比较必须包含凭据映射。
- 只有 Runtime 自己即将 spawn 的 owned managed child 才能收到解析值。
- 健康的 attached 进程不重启、不注入、不获得凭据。
- `external` 模式忽略本地注入并显示「凭据由外部服务管理」。
- 错误、日志、state 和 invariant snapshot 只显示 ref、是否配置及来源类型，不显示值。

缺失 `role: 'required'` 的凭据不会阻止 backend 完成身份健康启动，也不会让 keyless Profile 丢失既有 20 个工具；它把对应完整能力标为不可用。LLM-dependent 工具在发出 backend 业务请求前必须通过 Host credential status preflight，并以可执行指引拒绝。`role: 'enhancement'` 缺失时则允许文档规定的模板回退。

除 secret allowlist 外，完整 managed 投研 Profile 还显式传递少量非机密运行设置：

| 环境变量 | 目的 |
| --- | --- |
| `ADAPTER_RUNNER=engine` | trading-core 使用真实 engine；测试可显式覆盖为 `fake` |
| `MW_LLM_ENABLED=true` | Key 可用时启用盯盘解读；缺失时保留模板回退 |
| `DSH_INVESTMENT_STATE_DIR=<backend-state-dir>` | 打包形态把可写数据移出只读 Resources；源码形态可保留现有默认 |

### Python 配置优先级

managed child 中由 Host 显式传入的环境变量必须优先于项目 `.env`。`dsh-trading-core` 已采用 `load_dotenv(..., override=False)`；`market-watch` 当前使用 `override=True`，实现时必须调整为不覆盖 Host 注入值，同时继续保证其 `NO_PROXY` 默认值在行情模块导入前建立。

源码项目 `.env` 保留为独立启动 Python 服务和兼容旧开发流程的后备。产品文档必须说明：通过投研 Profile 启动时，应在前端 Models 页面管理 DeepSeek Key；backend `.env` 不是产品主路径。

### 凭据变更与重启

前端 Agent 继续按操作解析凭据，因此 Key 保存或轮换后下一次模型请求立即使用新值。Python backend 在进程启动时读取配置，第一版采用明确的安全重启语义：

1. `credentials/updated(DEEPSEEK_API_KEY)` 后，活动的 owned managed backend 标记为 `restart-required`。
2. `restart-required` 期间，所有可能使用 LLM 的新工具调用在 Host preflight 阶段被阻止，避免继续使用 child 内的旧 Key；明确不使用 LLM 的状态和模板能力可以按 capability 声明继续工作。
3. 当前版本不在未知业务请求进行期间强杀或无提示滚动重启进程。
4. 投研就绪界面显示「Key 已更新，需要重启投研应用」，并提供一个显式操作。
5. Electron 重启先走现有 Profile quiescent teardown，等待工具、定时器、lease 和 owned 进程树退出，再重新启动 Profile。
6. 新进程在 spawn 前重新解析 Key，不在内存中复用旧 secret。
7. Key 被删除时状态变为 `credential-missing`；完整分析调用立即被 Host preflight 阻止，重启后 backend 进入明确的降级状态。

后续只有在 Runtime 与所有业务 HTTP/SSE 调用都具备统一的 operation drain 边界后，才可以把全应用重启优化为 backend 级 rolling restart。不得先做可能中断活跃分析的自动重启。

## 投研就绪模型

### 状态维度

投研就绪状态不能压缩成一个布尔值。Host 提供不含机密的投影：

| 维度 | 示例状态 |
| --- | --- |
| Profile | `loaded`、`composition-error` |
| Credential | `missing`、`configured`、`read-only`、`restart-required` |
| Runtime asset | `source-env-ready`、`bundled-ready`、`missing`、`invalid`；缺失／损坏可由启动前检查直接终止启动 |
| Backend | `stopped`、`starting`、`healthy-owned`、`healthy-attached`、`external`、`failed` |
| Capability | `stock-full`、`market-template-only`、`market-full`、`unavailable` |
| Optional integration | `not-configured`、`configured`、`failed` |

所有错误必须带后端 id、可执行修复动作和日志位置；不得包含 Key、完整 child env 或未知进程的敏感信息。

### UI 复用与新增范围

现有 `ui-settings-models` 继续独占 Key 的输入、校验、探测、保存、删除和来源徽标。投研 UI 不导入或复制其内部 React 组件，也不跨 package 复用私有实现。

投研侧只增加薄的就绪与引导表面：

- 在 `investment-research` Profile 下注册「投研」设置页，展示上述状态与验证动作。
- 缺少 `DEEPSEEK_API_KEY` 时显示「打开模型设置」，通过现有 settings slot 打开 `models` section。
- 即使用户已经配置 OpenAI、Claude 等其他前端提供方，投研引导仍检查 DeepSeek ref，而不是复用「任一模型可用」的通用 onboarding 判定。
- Key 输入完成后，投研页刷新 credential 状态；若 backend 已启动，则显示明确的重启操作。
- 不在投研页回显、读取或暂存 Key。

### 首次使用流程

源码开发者的目标流程为：

1. 运行统一 backend 初始化入口，或按指引分别创建两个 `env`。
2. 启动 `pnpm dsh electron --profile investment-research`。
3. 首次使用引导检测到 DeepSeek Key 缺失，打开现有 Models 页面完成保存与现有 provider probe。
4. 投研页显示需要重启，用户执行「重启投研应用」。
5. 重启后 Runtime 向两个 owned managed backend 注入 Key，等待身份健康检查。
6. 就绪页显示股票分析 9 个工具、盘中盯盘 11 个工具已注册。
7. 用户依次执行无副作用验证、状态写入验证和真实业务验证。

打包桌面用户省略第 1 步；应用自带 Python 和 backend 资源。

## 源码与打包 Runtime 解析

`managed` 仍是唯一的本地托管模式，不增加 `source`／`bundled` 业务模式。Runtime 只扩展解释器和 backend 资源解析策略，优先级固定为：

1. 配置中显式且有效的绝对 `backendProjectDir`。
2. 从当前安装位置发现的源码仓库 backend 与其 `env`。
3. Electron 打包时写入的只读 bundled runtime descriptor。

显式路径存在但无效时必须失败，不能静默回退到另一份 backend。健康、single-flight、owned／attached、日志、state、release 和 external 语义不因资源来源改变。

### 源码形态

- POSIX：`backend/<id>/env/bin/python`。
- Windows：`backend/<id>\\env\\Scripts\\python.exe`。
- 环境缺失时给出统一初始化入口以及现有 `init.sh`／`init.bat` 后备命令。
- dsh 启动不安装依赖。

### 打包形态

Electron Resources 随附固定版本的 Python sidecar、backend 源码和预安装依赖，概念布局如下：

```text
resources/
└── investment-python/
    ├── runtime/
    ├── site-packages/
    ├── backends/
    │   ├── dsh-trading-core/
    │   └── market-watch/
    └── runtime.json
```

打包流水线而不是首次启动负责：

- 固定 Python minor、架构和依赖版本。
- 为 macOS arm64／x64 与 Windows x64 生成对应 sidecar。
- 验证 native wheels、动态库和 Uvicorn import。
- 把整个应用和 native 资源纳入 macOS codesign／notarization；不得在产品启动时通过 `xattr` 绕过 Gatekeeper。
- 生成带文件哈希和服务模块信息的 `runtime.json`，供 Runtime 启动前校验。

安装目录是只读资源。打包工作必须审计两个 backend 的所有写路径，并让它们接受 `DSH_INVESTMENT_STATE_DIR`；数据、缓存、日志、state 和用户配置统一落入 `$DSH_HOME/investment-research/<backend-id>/`。不得依赖当前工作目录，也不得写回 Resources。源码形态在没有该变量时保留现有项目内数据目录，避免破坏独立 Python 启动流程。

## 端到端验收

### 自动化层级

1. **Credential contract：** 验证定义只保存 ref；缺失、环境遮蔽、受管文件、删除和轮换都不泄露值。
2. **Runtime unit：** 验证 owned child 收到允许列表；attached／external 不收到；冲突比较包含映射；日志和 state 脱敏。
3. **Profile composition：** keyless 时五层仍能组合、20 个工具仍可见并显示投研引导；配置 Key 后重启，完整能力变为 ready。
4. **Managed fake：** macOS／Windows 验证 source env、包含空格与中文路径、spawn、健康、释放和无残留树。
5. **Managed engine：** 两个 OS 使用真实依赖，验证 credential 注入、健康和无业务请求 dispose；CI Key 使用 secret，不写 fixture。
6. **Packaged sidecar：** 对产物而非源码目录运行 import、健康、工具注册、退出和 native 签名检查。
7. **Security：** grep 与故障注入证明 Key 不出现在 argv、Cordis dump、Runtime state、日志、错误、snapshot 或测试产物。

### 用户可见验收

应用必须提供一份可以逐项打勾的验证：

1. `trading-core` 显示 `healthy-owned`、`service=trading-core`。
2. `market-watch` 显示 `healthy-owned`、`service=market-watch`。
3. 股票分析显示 9 个工具，盘中盯盘显示 11 个工具。
4. `watch_list` 成功，证明盯盘读取链路可用。
5. `watch_add` 后再次 `watch_list` 成功，证明状态写入链路可用。
6. `get_watchlist` 成功，证明股票 backend 轻量链路可用。
7. 用户显式执行 `analyze_stock`，真实 engine 返回结果，证明 DeepSeek Key、行情和 SSE 全链路可用。
8. 用户显式执行 `scan_movers` 或 `daily_brief`，结果标明是否使用 LLM 回退。

自动健康检查不得替代第 7 项；真实业务验证也不得在用户未确认时自动产生模型费用。

## 错误与降级

- 缺 Key：UI 可打开；状态显示 `credential-missing`；完整分析在请求前拒绝并链接 Models 页面。
- Key 无效：复用现有 provider probe 的错误分类；不得把完整上游响应或 Key 写入日志。
- Key 更新：前端立即生效；Python 标记 `restart-required`，LLM-dependent 工具阻止新调用，不悄悄继续使用或声称使用新 Key。
- source env 缺失：显示 backend 目录和平台命令，不自动安装。
- packaged runtime 缺失或哈希不符：报告安装损坏并建议重新安装，不尝试联网修复。
- 行情网络失败：backend 保持健康，但 capability diagnostics 显示数据源失败；不能误报为凭据失败。
- market-watch 缺 LLM：基础行情与规则能力保持可用，LLM 解读明确标为模板回退。
- attached／external：状态说明生命周期与凭据由外部部署负责；本地「重启投研应用」不得停止它。

## 实施分段与边界

该目标应拆成独立、可评审的增量，不混入尚未合并的 PR2：

### 增量一：源码模式凭据闭环与就绪引导

- 复用现有 Models Key 输入和 `ctx.credentials`。
- 为 owned managed child 增加声明式 allowlist 注入。
- 修正 backend 环境优先级。
- 增加不含密钥的 readiness Remote、投研设置页和首次使用引导。
- Key 更新后采用明确的全应用安全重启。
- 增加统一 backend 初始化／验证入口。

本增量不得创建或修改 PR3 adapter-client，也不得把 HTTP／SSE 客户端迁移夹带进来。

### 增量二：打包 Python sidecar

- 为支持平台构建可重现的 Python/backend Resources。
- 扩展 managed 资源解析器与 manifest 校验。
- 接入 Electron package／make、签名、公证和产物 smoke。
- 普通用户首次启动不运行安装命令。

### 延后增量

- backend 级无中断 rolling restart。
- Host 本地模型凭据代理。
- 非 DeepSeek provider 映射。
- 平台托管额度。
- Tushare、ServerChan、WeCom 等可选凭据的产品设置面。

实施计划必须保持每个增量的 TDD、文件范围、验证命令和提交边界，并明确它与既定 PR3 的先后关系；未经用户批准不得改变现有 PR2／PR3 路线。

## 风险与缓解

- **Key 泄漏到日志或 state：** Runtime 只公开 ref 与状态；测试对 argv、日志、state、dump 和 snapshot 做负向扫描。
- **market-watch `.env` 覆盖 Host Key：** 统一改为显式环境优先，并为 `NO_PROXY` 单独保留默认注入测试。
- **轮换后前后端使用不同 Key：** readiness 明确标记 `restart-required`，安全重启后才恢复 full-ready。
- **重启中断活跃分析：** 第一版不自动滚动重启；全应用重启沿用 quiescent teardown。
- **attached／external 泄漏本机 Key：** 注入决策绑定 owned spawn，而不是 backend id 或 URL。
- **打包体积和 native 兼容性：** sidecar 按 OS／arch 构建，锁定版本并在实际产物上 smoke。
- **首次启动偷偷联网安装：** package pipeline 预构建全部依赖；Runtime 缺资源即失败。
- **通用 Models UI 被投研逻辑污染：** Key 编辑继续归通用页面；投研 package 只通过 slot 和 Remote 增加自己的状态与导航。

## 完成标准

满足以下条件时，普通用户可以被称为「端到端可用」：

- 只在现有 Models 页面输入一次 DeepSeek Key。
- 产品不要求用户编辑 backend `.env`。
- 源码和打包形态都能通过同一个 `investment-research` Profile 启动。
- 两个 backend 的来源、所有权、健康和凭据状态在 UI 中可见且不泄密。
- managed child 使用 Host 当前解析到的 Key；attached／external 不接收本机 Key。
- 用户可以从 UI 完成 Key 配置、必要重启、健康诊断和显式真实业务验证。
- 股票 9 个工具与盯盘 11 个工具均可见；真实 `analyze_stock` 与至少一个盯盘数据工具成功。
- macOS 和 Windows 的源码矩阵、真实 engine smoke 与 packaged sidecar smoke 都通过。
- 应用关闭后没有 owned Python 进程树残留。
