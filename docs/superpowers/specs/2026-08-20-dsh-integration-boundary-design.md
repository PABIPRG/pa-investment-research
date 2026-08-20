# DSH 投研插件归属、原生组合与 Python 运行时设计

## 状态

书面规格待审阅。架构方向已在讨论中确认，但在本文档获得确认前不开始实施。

## 背景

仓库目前把两个 TypeScript dsh 插件放在 Python 后端项目中：

- `backend/dsh-trading-core/dsh-plugin`
- `backend/market-watch/dsh-plugin`

这导致 Python 服务同时管理 Node 依赖、TypeScript 源码、Cordis 配置和 npm 生命周期，也让 macOS/Windows 路径、虚拟环境、Shell 权限和 `file://` URL 问题散落在后端脚本中。

顶层 `frontend/` 不是普通业务页面目录，而是完整的 DeepSeek Harness workspace。它已经统一管理 `packages/<group>/<pkg>`、Profile Bundle、Cordis 插件、构建、测试和跨平台约束。因此投研相关 JavaScript/TypeScript 逻辑应进入该 workspace 的 `packages`，不再新增顶层 `integrations/dsh`。

## 目标

- `backend/` 保持纯 Python。
- 所有 dsh、Cordis、Node 和 TypeScript 投研逻辑进入 `frontend` workspace。
- 在 `frontend/packages` 中建立独立的投研包族，避免把业务逻辑散入 dsh 核心包。
- 使用 dsh Profile 和可组合 Bundle 加载股票分析、盘中盯盘及未来投研能力。
- 启动某个 Profile 时自动启动其 Bundle 所依赖的 Python 服务。
- 保留连接外部 Python 服务的部署模式。
- 提取纯 TypeScript HTTP/SSE 客户端，供 dsh 插件及未来独立 UI 复用。
- macOS 和 Windows 使用同一组 dsh/pnpm 高层命令。
- 不提交开发者绝对路径、PID、密钥或本机生成配置。

“后端纯 Python”是指后端目录不包含 TypeScript 源码、`package.json`、npm/pnpm 锁文件、`node_modules`、Cordis patch 或 dsh 插件清单。只操作 Python 服务本身的少量 `.sh` 和 `.bat` 包装脚本可以保留；它们不得安装 Node 依赖或启动 dsh。

## 非目标

- 重写任一 Python 服务。
- 在物理迁移阶段修改股票分析或盘中盯盘 API。
- 把投研代码混入 `frontend/packages/core`、`client`、`preset` 等无关 dsh 核心包。
- 当前阶段实现按会话切换投研能力的 Agent Preset。
- 当前阶段新增专属浏览器页面或修改 dsh Web UI。
- 把 Docker 作为主要本地开发方式。
- 在出现第二个真实消费者之前提取独立的 market-watch 客户端。
- 在迁移中顺带升级 dsh。

## 代码归属

目标目录如下：

```text
pa-investment-research/
├── backend/
│   ├── dsh-trading-core/                      # 纯 Python
│   │   ├── adapter/
│   │   ├── adapter_client/
│   │   ├── tradingagents/
│   │   ├── config/
│   │   └── requirements.txt
│   └── market-watch/                          # 纯 Python
│       └── market_watch/
└── frontend/                                  # DeepSeek Harness workspace
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
    └── apps/
        └── cli/                               # 注册 investment-research Profile 模板
```

`investment-research` 是新的 Package Group，必须在 `frontend/packages/README.md` 及该组自己的 README 中登记。Bundle 继续放在现有 `packages/bundle` 组，遵循 dsh 已有 Profile patch-layer 约定。

所有包遵守 `frontend/AGENTS.md` 的现有规则，包名使用统一 scope：

- `@deepseek-ai/dsh-investment-python-runtime`
- `@deepseek-ai/dsh-investment-adapter-client`
- `@deepseek-ai/dsh-investment-stock-analysis`
- `@deepseek-ai/dsh-investment-market-watch`
- `@deepseek-ai/dsh-investment-runtime-bundle`
- `@deepseek-ai/dsh-investment-stock-analysis-bundle`
- `@deepseek-ai/dsh-investment-market-watch-bundle`

本次迁移还会删除 `frontend/pnpm-workspace.yaml` 中关于旧 `packages/dsh-trading-core` 的排除规则和过时注释。新的包直接由现有 `packages/*/*` workspace glob 管理。

## DSH 原生组合

### Bundle 分层

投研能力按职责拆成三个可组合 Bundle：

| Bundle | 负责内容 |
| --- | --- |
| `investment-runtime` | 挂载 Python Runtime Service |
| `investment-stock-analysis` | 注册 trading-core 后端定义并挂载股票分析插件 |
| `investment-market-watch` | 注册 market-watch 后端定义并挂载盘中盯盘插件 |

每个能力 Bundle 都声明对 Runtime Service 的注入依赖。Profile 如果缺少 `investment-runtime`，对应能力插件保持不可用并由 dsh 的组合检查明确失败，不能静默发布坏工具。

初始完整 Profile 的 Bundle 顺序为：

```text
investment-research Profile
├── @deepseek-ai/dsh-base
├── @deepseek-ai/dsh-web-app
├── @deepseek-ai/dsh-investment-runtime-bundle
├── @deepseek-ai/dsh-investment-stock-analysis-bundle
└── @deepseek-ai/dsh-investment-market-watch-bundle
```

`frontend/packages/boot/app-boot` 的现有 `PROFILE_TEMPLATES` 增加 `investment-research` 条目，因此源码开发和安装后的日常启动都使用原生命令：

`frontend/apps/cli/package.json` 把三个投研 Bundle 声明为 workspace 依赖，确保安装后的 dsh 能从自身依赖闭包解析 Profile 模板中的 Bundle；不得依赖开发机根目录的偶然 hoist。

```sh
# frontend 源码工作区
pnpm dsh --profile investment-research

# 安装后的 dsh
dsh --profile investment-research
```

该 Profile 首次使用时由 dsh 现有流程自动初始化，不引入 `sync-profile.ts`、顶层启动器或另一套 Profile 文件格式。配置展开继续使用：

```sh
dsh --profile investment-research --dump-config
```

### 预留组合能力

股票分析和盘中盯盘 Bundle 相互独立。未来可以通过 Profile 的有序 Bundle 列表组合出仅股票、仅盯盘或其他投研应用，不需要移动源码或复制插件：

```text
仅股票：base + web-app + runtime + stock-analysis
仅盯盘：base + web-app + runtime + market-watch
完整投研：base + web-app + runtime + stock-analysis + market-watch
```

当前只随仓库交付 `investment-research` 完整 Profile。其他组合在出现真实使用场景后再注册为命名 Profile，避免提前维护无消费者的配置。

Profile 中挂载的业务工具对该 Profile 内的 Agent 可见。若未来需要同一 Profile 中不同会话拥有不同投研工具，再单独设计 Agent Preset；本次迁移保持插件注册与 Host Service 分离，为后续按 scope 挂载留出空间，但不引入当前 dsh Preset 根目录和完整模板复制问题。

### 前端加载关系

dsh Web UI 不直接 `import` 投研插件。Host 侧 Cordis Loader 按 Profile/Bundle 挂载投研包，工具注册、执行和渲染结果通过 dsh 现有会话与工具协议进入 Web UI：

```text
dsh Web UI
    ↓ dsh 会话/工具协议
investment-research Profile
    ↓ Cordis Bundle
投研工具插件
    ↓ Python Runtime lease
Python API
```

因此 JavaScript/TypeScript 源码归 `frontend/packages` 管理，但不会侵入 Web UI 组件或业务页面入口。

## Python Runtime Service

`@deepseek-ai/dsh-investment-python-runtime` 提供 Host Service：`ctx.investmentPythonRuntime`。两个能力 Bundle 分别注册 `trading-core` 和 `market-watch` 后端定义；业务插件在注册工具前获取对应后端 lease。

Profile 启动时，股票和盯盘插件会各自获取依赖。并发获取采用 single-flight，同一后端只启动一次。成功获取返回包含已验证 Base URL 的 lease，业务插件把该 URL 传给 API 客户端，不再自行读取端口或环境配置。

释放 lease 会减少引用计数。只有最后一个 lease 被释放或 Runtime Service 被销毁时，才停止自己拥有的 managed 子进程；外部进程永远不会被停止。同一个后端 id 如果被注册为冲突的命令、健康地址或模式，Host 组合必须明确失败。

### 两种后端模式

- `managed`：当前默认。Runtime 定位项目解释器、启动 Python API、等待健康检查、记录日志，并只停止自己拥有的子进程。
- `external`：不启动或停止 Python，只验证配置的 Base URL，使同一工具插件可连接独立管理的服务。

`ADAPTER_RUNNER=fake|engine` 继续作为现有 Python 后端设置。managed 模式把它传给子进程；external 模式由外部服务自行配置。它不是 dsh Profile 或 Bundle 组合维度。

### Managed 生命周期

对于 managed 后端，Runtime：

1. 从当前 dsh 安装位置向上解析仓库中的后端目录，或使用明确的 Cordis Config 路径；不依赖调用者当前目录。
2. macOS/Linux 选择 `env/bin/python`，Windows 选择 `env\\Scripts\\python.exe`。
3. 启动前检查 Base URL。若已存在身份匹配的健康服务，则附着使用，但不获取其进程所有权。
4. 若端口已占用但健康检查或服务身份不匹配，则失败且不终止未知进程。
5. 使用明确工作目录和仅对子进程生效的环境启动 API；后端 `.env` 不合并进父 dsh 进程。
6. 在有界超时内等待健康检查。子进程提前退出或超时时，保留相关日志尾部、终止自己拥有的进程并拒绝获取。
7. 使用 `ctx.effect()` 注册异步释放。Profile 关闭、依赖消失或热替换时等待子进程退出，超过宽限期后才升级终止方式。

Runtime 把状态和日志写入 dsh 本机状态目录。旧状态只作为提示；停止前必须重新验证进程身份和健康。错误信息包含后端 id、健康地址及可执行的初始化指令或日志位置，但不得包含密钥和完整子进程环境。

后端虚拟环境缺失时，Runtime 明确提示运行对应 Python 初始化命令，不在 dsh 启动期间隐式安装依赖。

## TypeScript 客户端

`frontend/packages/investment-research/adapter-client` 是平台中立的 HTTP/SSE 客户端：

```text
src/
├── contracts.ts
├── http.ts
├── sse.ts
└── tradingAdapterClient.ts
```

- `contracts.ts` 定义与 Python Adapter 一致的请求、响应、进度事件和标准化错误类型。
- `http.ts` 负责 Base URL、JSON 请求、HTTP 状态映射、超时、取消和错误归一化。
- `sse.ts` 只负责增量 SSE 解码，不了解股票、dsh 或 UI。
- `tradingAdapterClient.ts` 组合前述模块，提供 `analyzeStock`、`analyzeHoldings`、`generateBrief` 和自选管理等领域方法。

该包虽然位于 dsh workspace 并使用 `@deepseek-ai/dsh-*` 命名，但不得依赖 Cordis、dsh 运行时、浏览器全局对象或 React。它接收注入的 `fetch` 和 Base URL，因此未来独立业务前端也可以复用。

股票插件保留 `agent.inject()`、工具注册和渲染；传输逻辑迁入 Adapter Client。盘中盯盘插件暂时保留自己的 JSON 客户端，直到出现第二个真实消费者。

### SSE 契约

- 成功顺序：零个或多个 `stage`、恰好一个 `result`，然后 `done` 或流关闭。
- 失败顺序：零个或多个 `stage`、一个 `error`，然后流关闭。
- 流关闭前既没有 `result` 也没有 `error` 时，返回标准化的不完整流错误。
- 显式 `error` 优先于后续格式错误或尾随数据。
- 取消和超时必须与 HTTP、协议和后端错误区分。

解析器支持 LF/CRLF、任意字节分块、跨分块 UTF-8、多行 `data:`、注释、可选 `event:` 和末尾没有空行的最后一帧。

## 前端 Workspace 约束

新增包必须遵守现有 dsh 仓库规则：

- ESM、严格 TypeScript、`src/` 与 `lib/types` 分离。
- 每个包加入正确的 TypeScript aggregate 和项目引用。
- 工作区包依赖使用 `workspace:^`。
- Cordis function plugin 使用具名导出的 `name`、`inject`、`Config`、`apply`，不得混用 default export。
- 注册、子进程和定时器全部通过 Effect 管理。
- 每个包提供 README、导出 JSDoc 和 `./invariant`。
- 产品可见插件必须有真实 Cordis 组合测试，不能只用手工 `ctx.plugin()` 单元测试。
- 新增模型可见工具或结果时提供 keyless snapshot。
- 非机械变更同步编写 Agent Note。
- 修改 `packages/README.md`、`packages/bundle/README.md` 及中英文对应文档。

## 迁移顺序

每个阶段形成独立、可评审的 Pull Request。前一阶段通过后再开始下一阶段。

### 阶段一：迁移到 frontend 投研包族

使用保留历史的移动：

- `backend/dsh-trading-core/dsh-plugin` → `frontend/packages/investment-research/stock-analysis`
- `backend/market-watch/dsh-plugin` → `frontend/packages/investment-research/market-watch`

随后：

- 按 dsh workspace 规则重写包清单、tsconfig、导出和 workspace 依赖。
- 把新增包加入正确的 TypeScript aggregate、项目引用和构建入口。
- 添加 `investment-research` Package Group README，并更新根 Package 清单。
- 删除后端初始化中的 npm 安装。
- 删除 `frontend/pnpm-workspace.yaml` 中过时的 dsh-trading-core 排除规则。
- 更新仓库内所有旧路径和文档引用。

本阶段只修正物理归属和构建接入，不重构 API 客户端或启动行为。

验收条件：

- 两个插件从 `frontend` workspace 完成类型检查、构建和现有冒烟测试。
- Git 能识别主要文件为重命名。
- 后端初始化不安装 Node 依赖。
- `backend/` 下不存在 TypeScript、Node 包清单、锁文件、Cordis patch 或 dsh 插件目录。
- 不创建顶层 `integrations/dsh`。

### 阶段二：建立 Bundle、Profile 和 Python Runtime

创建 Runtime Service、三个可组合 Bundle，在 `PROFILE_TEMPLATES` 注册 `investment-research`，并把 Bundle 纳入 CLI 的安装依赖闭包。让两个业务插件在注册工具前获取声明的 Python 后端。

验收条件：

- `pnpm dsh --profile investment-research --dump-config` 显示正确的 Bundle 顺序和后端定义。
- 启动完整 Profile 时自动启动 trading-core 和 market-watch，且并发流程不重复启动。
- 删除任一能力 Bundle 后，对应工具和 Python 依赖均不加载。
- `external` 模式只验证并连接外部服务。
- 端口冲突、虚拟环境缺失、健康失败或子进程失败时，Profile 明确失败，只清理自己拥有的进程。
- macOS 和 Windows 均通过 managed fake-runner 组合测试。
- 包含空格的仓库路径无需修改已提交配置。

### 阶段三：提取 Adapter Client

把股票插件的传输层和契约逻辑迁入 `@deepseek-ai/dsh-investment-adapter-client`，插件只保留 dsh 专属逻辑，Python API 保持不变。

验收条件：

- Adapter Client 不导入 Cordis 或任何 dsh 运行时包。
- 股票插件的真实组合与 keyless snapshot 行为保持一致。
- 单元测试覆盖 LF/CRLF、分块边界、跨分块 UTF-8、多行 data、末尾未终止帧、`404`、`409`、后端 error、网络失败、超时、取消和缺少 result。
- 相关包的类型检查、构建、单元测试、真实组合测试和文档门禁通过。

## 验证矩阵

| 验证项 | macOS | Windows |
| --- | --- | --- |
| Python 解释器发现 | `env/bin/python` | `env\\Scripts\\python.exe` |
| 包含空格的仓库路径 | 必须 | 必须 |
| Profile 配置展开 | 必须 | 必须 |
| Bundle 增删组合 | 必须 | 必须 |
| managed fake-runner | 必须 | 必须 |
| managed engine 启动与健康检查 | 必须 | 必须 |
| external 服务附着 | 必须 | 必须 |
| dsh 优雅释放与旧状态清理 | 必须 | 必须 |

CI 在两个操作系统上运行确定性测试。engine 集成测试可能需要凭据，可作为显式冒烟任务；fake runner 必须不依赖凭据。

## 文档归属

- `backend/dsh-trading-core/README.md` 只记录 Python 初始化、配置、API 启动和验证。
- `backend/market-watch/README.md` 只记录 Python 服务。
- `frontend/packages/investment-research/README.md` 记录投研 Package Group、能力关系和 Python API 依赖。
- 每个投研包 README 记录自身 API、配置、模型体验和限制。
- `frontend/packages/bundle/README.md` 记录三个投研 Bundle 的组合职责。
- dsh 用户文档记录 `investment-research` Profile 的启动、配置展开及 managed/external 切换。
- Python Adapter 附近保留 API/SSE 契约唯一规范来源；TypeScript 客户端链接并通过测试验证。

## 风险与缓解

- **投研逻辑污染 dsh 核心：** 全部业务实现限制在 `packages/investment-research`；Bundle 只负责组合。
- **文件历史丢失：** 使用 `git mv`，阶段一保持机械迁移。
- **Profile 能力耦合：** Runtime、股票和盯盘使用独立 Bundle，完整 Profile 只组合它们。
- **Windows 路径和进程回归：** 使用 Node path/URL API、明确子进程所有权，并在 Windows CI 验证。
- **遗留子进程：** 停止前验证身份，只终止 owned child，退出后清理状态。
- **简报推送跨 Agent：** 当前 Profile 级工具可全局工作；未来迁入 Agent Preset 前必须先按 scope 重构广播行为。
- **契约漂移：** Python 是 API 权威来源，TypeScript 使用 fixture 和 fake-runner 真实组合测试。
- **升级 dsh 导致迁移夹带变化：** 本次固定现有 workspace 版本，升级另行处理。

## 完成标准

满足以下条件时迁移完成：后端目录符合纯 Python 定义；所有投研 TypeScript、Cordis 和 dsh 代码位于 `frontend/packages`；不新增顶层集成 workspace；Profile 通过独立 Bundle 组合能力；managed 模式自动托管 Python，external 模式不接管外部进程；Adapter Client 与 dsh 运行时解耦；macOS 和 Windows 均通过对应验证。
