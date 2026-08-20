# DSH 集成边界、原生组合与 Python 运行时设计

## 状态

书面规格待审阅。架构方向已在讨论中确认，但在本文档获得确认前不开始实施。

## 背景

仓库目前把两个 TypeScript dsh 插件放在 Python 后端项目中：

- `backend/dsh-trading-core/dsh-plugin`
- `backend/market-watch/dsh-plugin`

这导致三类职责混在一起：

1. Python 服务同时管理 Node 依赖、TypeScript 源码、Cordis 配置和 npm 生命周期。
2. 本地启动依赖操作系统特有的路径、Python 虚拟环境目录、Shell 权限和 Cordis `file://` URL。
3. 股票分析插件客户端把传输逻辑与 `agent.inject()` 等 dsh 专属 API 混在一起，无法被普通浏览器或 Node 消费者复用。

现有顶层 `frontend/` 是 DeepSeek Harness 源码工作区，不是产品业务插件或客户端的归属边界，本次迁移必须与它保持独立。

## 目标

- 后端应用代码保持纯 Python。
- 在后端服务和上游风格的前端工作区之外，为产品专属 dsh 集成建立独立 TypeScript 工作区。
- 让 macOS 和 Windows 使用等价的启动与验证流程。
- 使用 dsh Profile、插件 Bundle、Cordis Service 和 Agent Preset 作为组合模型，不再建立一套平行的模块启动器。
- 自动启动当前已激活能力所依赖的 Python 服务，同时保留连接外部服务的部署模式。
- 提供一个纯 TypeScript HTTP/SSE 客户端，供 dsh 插件及未来独立 UI 或宿主代理复用。
- 在调整代码归属和物理目录时保持后端 API 行为不变。
- 本机路径和生成配置只保存在本机，不提交开发者绝对路径。

“后端纯 Python”是指后端目录中不包含 TypeScript 源码、`package.json`、npm/pnpm 锁文件、`node_modules` 或 Cordis/dsh 插件清单。只操作 Python 服务自身的少量 `.sh` 和 `.bat` 包装脚本可以保留；涉及 Node 或 dsh 的编排归 `integrations/dsh` 所有。

## 非目标

- 重写任一 Python 服务。
- 在目录迁移阶段修改股票分析或盘中盯盘 API 契约。
- 修改 `frontend/` 下的 DeepSeek Harness 源码。
- 把 Docker 作为主要本地开发方式。
- 在出现第二个真实消费者之前提取共享的 market-watch 客户端。
- 在边界迁移中顺带升级 dsh。

## 架构决策

在 `integrations/dsh` 建立独立 pnpm workspace：

```text
pa-investment-research/
├── backend/
│   ├── dsh-trading-core/                # Python 服务
│   │   ├── adapter/
│   │   ├── adapter_client/              # 现有 Python 客户端保留
│   │   ├── tradingagents/
│   │   ├── config/
│   │   └── requirements.txt
│   └── market-watch/                    # Python 服务
│       └── market_watch/
├── integrations/
│   └── dsh/                             # 产品自有 TypeScript workspace
│       ├── packages/
│       │   ├── python-runtime/
│       │   ├── trading-adapter-client/
│       │   ├── stock-analysis-plugin/
│       │   └── market-watch-plugin/
│       ├── bundles/
│       │   └── investment-research/
│       ├── agent-presets/
│       │   ├── stock-research/
│       │   ├── market-monitor/
│       │   └── investment-full/
│       ├── scripts/
│       │   └── sync-profile.ts
│       ├── package.json
│       ├── pnpm-lock.yaml
│       └── pnpm-workspace.yaml
└── frontend/                            # DeepSeek Harness 源码工作区
```

包名确定为：

- `@pa-investment/trading-adapter-client`
- `@pa-investment/dsh-python-runtime`
- `@pa-investment/dsh-stock-analysis`
- `@pa-investment/dsh-market-watch`
- `@pa-investment/dsh-investment-research`

所有包都是私有 workspace 包。workspace 固定 package manager 版本及所有 dsh 依赖的精确版本。迁移沿用团队当前已验证环境中的 dsh 版本；版本确认是实施前置检查，不借本次迁移升级。若无法可重复地确认现用版本，则暂停实施并单独决定版本。

### 依赖规则

```text
DSH Profile: investment-research
├── Host 层
│   ├── python-runtime
│   ├── trading-core 后端定义
│   └── market-watch 后端定义
└── Agent Presets
    ├── stock-research  ─> stock-analysis-plugin ─> trading-core
    ├── market-monitor ─> market-watch-plugin ────> market-watch
    └── investment-full
        ├── stock-analysis-plugin ────────────────> trading-core
        └── market-watch-plugin ──────────────────> market-watch

未来独立 UI 或宿主代理
└── trading-adapter-client ─HTTP/SSE─> dsh-trading-core
```

- `trading-adapter-client` 可以依赖平台中立的 TypeScript 库，但不得依赖 dsh 包、浏览器全局对象、React 或插件生命周期 API。
- `stock-analysis-plugin` 负责 dsh 工具注册、`agent.inject()`、结果渲染，以及把传输层进度映射为 dsh 进度事件。
- `market-watch-plugin` 暂时直接消费 market-watch API，直到真实复用需求出现后再提取独立客户端。
- `python-runtime` 是 Host 层 Cordis Service，负责 Python 进程发现、启动、健康检查、日志、所有权和释放，不包含业务分析逻辑。
- 面向模型的业务插件由 Agent Preset 挂载，不由 Profile 全局挂载。因此一个会话只能看到其所选 Preset 中声明的工具。
- 可选的股票简报推送器不得从 Agent 层插件枚举并通知其他 Preset 的会话。它应迁到显式 Host 层入口；在能够按组合 Preset 精确筛选会话之前保持禁用。
- Python 服务不得导入、安装、构建或启动 TypeScript workspace。
- 本次迁移中 `frontend/` 不依赖产品专属集成包。

## DSH 原生组合

### 部署 Profile 与 Bundle

日常启动使用现有 dsh CLI：

```sh
dsh --profile investment-research
```

本机 Profile 位于 `$DSH_HOME/profiles/investment-research`。其有序 Bundle 列表包含 dsh base、Web 应用 Bundle 和 `@pa-investment/dsh-investment-research`。产品 Bundle 只插入 Host 层条目：Python Runtime Service、后端定义，以及明确属于 Host 层的集成；不会全局插入股票分析或盘中盯盘工具。

`integrations/dsh/scripts/sync-profile.ts` 是幂等的安装/更新命令，不是应用启动器。它使用 dsh 现有的 `plugin --profile` 流程创建或校准 Profile，安装 Web 应用和本地产品 Bundle，并把仓库维护的 Agent Preset 模板实例化到 dsh 用户 Preset 根目录。正常启动、配置展开、patch 优先级、信号处理和 dsh 关闭仍由 dsh 自身负责。

当前 dsh 总是提供自带 Preset 根目录，并把 `$DSH_HOME/.agent-presets` 追加为可写用户根目录，暂不支持由 Bundle 贡献额外 Preset 根目录。因此仓库在 `integrations/dsh/agent-presets` 保存规范模板，`sync-profile.ts` 在 `$DSH_HOME/.agent-presets` 生成本机副本。副本使用 Loader 可解析的包入口，或通过 `pathToFileURL` 生成 URL；提交的模板不得包含开发者绝对路径。若目标副本已被本地修改，同步必须失败并提示处理，不能静默覆盖。

### Agent Preset

初始 Preset 清单如下：

| Preset | 面向模型的业务插件 | Python 依赖 |
| --- | --- | --- |
| `stock-research` | 股票分析 | `trading-core` |
| `market-monitor` | 盘中盯盘 | `market-watch` |
| `investment-full` | 股票分析和盘中盯盘 | `trading-core`、`market-watch` |

创建新 dsh 会话时选择 Preset。Preset 通过现有 Agent scope 链组合工具和提示词贡献，不拥有注册表、持久化、Web 基础设施或进程级全局服务。运行中的会话始终保持创建时的 Preset，遵循 dsh 现有语义。

Agent Preset 是完整的 `agent.cordis.yml`，不是继承其他 Preset 的 overlay。因此每个产品 Preset 都包含经过固定和评审的 dsh 基线能力及自身业务插件条目。同步器校验预期 dsh 基线版本和模板指纹；升级 dsh 时必须显式重新生成并评审 Preset，不能悄悄偏离 `standard`。

未来新增能力时，只需新增插件、必要的后端定义，以及在需要暴露该能力的 Preset 中引用它；不需要增加新的启动参数或组合 Shell 脚本。

## Python Runtime Service

`@pa-investment/dsh-python-runtime` 提供带命名空间的 Host Service：`ctx.paPythonRuntime`。后端定义条目注册 `trading-core`、`market-watch` 等稳定 id。Agent 层工具插件注入该 Runtime Service，并在注册工具前通过 Cordis Effect 获取对应后端。

第一个请求某后端的活跃 Preset 会触发获取流程。并发获取采用 single-flight，并共享同一个进程。成功获取会返回包含已验证 Base URL 的 lease，业务插件把该 URL 传给 API 客户端，不再自行发现配置。健康检查通过后插件才能进入 ACTIVE；依赖不可用时 Preset 组合直接失败，不发布无法工作的工具。多个会话和 Preset 共享健康后端。

释放 lease 会减少后端引用计数。只有最后一个 lease 被释放或 Host Service 被销毁时，Runtime 才停止自己拥有的 managed 子进程；它绝不停止附着的外部进程。若同一个后端 id 被注册为不同命令、健康地址或模式，Host 组合必须明确失败。

每个后端定义支持两种模式：

- `managed`：当前默认。Runtime 定位项目解释器、启动 Python API、等待健康检查、记录日志，并只停止自己拥有的子进程。
- `external`：从不启动或停止 Python，只验证配置的 Base URL，使同一套工具插件和 Preset 可以连接独立管理的服务。

`ADAPTER_RUNNER=fake|engine` 继续作为现有 Python 后端设置。managed 模式把它传给子进程；external 模式由外部服务自行配置。它不会升级为 dsh Profile、Preset 或启动器维度。

### Managed 生命周期

对于 managed 后端，Service 按以下流程工作：

1. 从已安装包元数据或已同步的本地 workspace link 解析仓库和后端路径，不依赖调用者当前目录。
2. macOS/Linux 选择 `env/bin/python`，Windows 选择 `env\\Scripts\\python.exe`。
3. 启动前检查配置的 Base URL。若已存在健康服务，则附着使用，但不获取其进程所有权。
4. 若端口已占用但健康检查或服务身份不匹配，则直接失败，不终止未知进程。
5. 使用明确的工作目录和仅对子进程生效的环境启动 API。后端 `.env` 不得合并进父 dsh 进程。
6. 在有界超时内等待健康检查。子进程提前退出或健康检查超时时，保留相关日志尾部、终止自己拥有的子进程并拒绝获取。
7. 通过 `ctx.effect()` 注册异步清理。Profile 关闭、依赖消失或热替换时，等待自己拥有的子进程退出；超过宽限期后才升级终止方式。

Runtime 把进程状态和日志写入本机 dsh 状态目录。绝对路径、PID、密钥和生成的 Profile 均不提交。旧状态只作为提示；执行任何停止操作前必须重新验证进程身份和健康状态。

未知后端 id、解释器缺失、定义格式错误、external 健康失败或 managed 启动失败，都报告为带后端名称的能力获取错误。错误信息包含后端 id、尝试的健康地址，以及可执行的初始化指令或日志位置，但不包含密钥和完整子进程环境。随后由 dsh 现有的 fail-loud 回滚语义处理 Preset 挂载失败。

### 跨平台仓库规则

后端初始化仍由后端负责：创建 Python 环境、安装 `requirements.txt`，并在缺失时从示例生成本地 `.env`；不得执行 npm 或 pnpm。

主要工作流使用 pnpm 和 dsh 命令，不依赖直接执行 Shell 文件。仓库级 `.gitattributes` 把源码和 Shell 脚本统一为 LF，把 Windows batch 文件统一为 CRLF。便捷包装脚本不得包含生命周期或路径逻辑，受支持的主流程无需 `chmod`。

## TypeScript 客户端设计

可复用客户端结构如下：

```text
integrations/dsh/packages/trading-adapter-client/src/
├── contracts.ts
├── http.ts
├── sse.ts
└── tradingAdapterClient.ts
```

- `contracts.ts`：定义与 Python Adapter 契约一致的请求、响应、进度事件和标准化错误类型。
- `http.ts`：负责 Base URL、JSON 请求、HTTP 状态映射、超时、取消和错误归一化。
- `sse.ts`：仅负责增量 SSE 解码，不了解股票、dsh 或 UI 渲染。
- `tradingAdapterClient.ts`：组合前述模块，对外提供 `analyzeStock`、`analyzeHoldings`、`generateBrief` 和自选管理等领域方法。

公共客户端接收注入的 `fetch` 实现和 Base URL，可在现代浏览器和 Node 中使用，测试也无需依赖真实服务器。它不读取 `.env`，也不决定生产地址；配置由消费者传入。

### SSE 契约

客户端消费 Adapter 现有事件名，不发明平行协议。

- 成功顺序：零个或多个 `stage`、恰好一个 `result`，然后 `done` 或流关闭。
- 失败顺序：零个或多个 `stage`、一个 `error`，然后流关闭。
- 流关闭前既没有 `result` 也没有 `error` 时，返回标准化的不完整流错误。
- 显式 `error` 事件优先于后续格式错误或尾随数据。
- 取消和超时错误必须与 HTTP、协议及后端错误区分。

解析器支持 LF/CRLF、任意字节分块、跨分块 UTF-8 字符、注释、多行 `data:`、可选 `event:`，以及末尾没有空行的最后一帧。

## 错误模型

TypeScript 客户端暴露稳定错误结构：

- `kind`：`http`、`backend`、`protocol`、`timeout`、`cancelled` 或 `network`
- 面向人的错误消息
- 可选 HTTP 状态码
- 可选后端错误码和详情
- 可选原始 cause

`404`、`409` 等预期状态必须在保留响应详情的前提下完成映射。错误和日志不得包含密钥、认证头或完整环境内容。

## 迁移顺序

每个阶段形成独立、可评审的 Pull Request。前一阶段通过验收后才能开始下一阶段。

### 阶段一：修正物理归属

尽可能使用保留历史的移动：

- `backend/dsh-trading-core/dsh-plugin` → `integrations/dsh/packages/stock-analysis-plugin`
- `backend/market-watch/dsh-plugin` → `integrations/dsh/packages/market-watch-plugin`

建立独立 pnpm workspace，更新包名及仓库内所有引用，把 dsh 专属文档迁到集成边界，并从后端初始化流程中删除 npm 安装。本阶段不得重构运行行为或混合客户端实现，只建立正确的所有权边界。

验收条件：

- 两个插件都能从 `integrations/dsh` 构建，并通过现有测试。
- 现有插件冒烟流程与迁移前结果一致。
- 后端初始化不再安装 Node 依赖。
- `backend/` 下不再存在 TypeScript、Node 包清单、锁文件、Cordis patch 或 dsh 插件目录。
- 文档中不再存在废弃仓库路径，也不把仅适用于 Windows 的命令描述成跨平台命令。

### 阶段二：建立 dsh 原生组合与 Python 生命周期

创建 investment-research Bundle、Profile 同步器、三个 Agent Preset 模板和 Host 层 Python Runtime Service。让面向模型的插件在注册工具前获取其声明的 Python 后端，保持后端 HTTP API 不变。

验收条件：

- `dsh --profile investment-research --dump-config` 能看到 Web 应用、产品 Bundle、Python Runtime 和后端定义，但看不到被全局挂载的业务工具。
- 新建 `stock-research`、`market-monitor` 或 `investment-full` 会话时，只暴露对应 Preset 声明的工具。
- 首次需要 managed 后端的 Preset 会自动启动后端；并发请求不会重复启动。
- `external` 模式只做健康验证，不启动或停止配置的服务。
- macOS 和 Windows 都能使用文档命令完成 Profile 同步、Python 发现、Preset 激活和干净关闭。
- 仓库移动或克隆到包含空格的路径后，无需修改任何已提交配置。
- 启动 dsh 不会把后端 `.env` 隐式载入父进程。
- 端口冲突、虚拟环境缺失、后端健康失败或子进程失败时，组合明确失败，并且只清理自己拥有的子进程。
- 重复执行 Profile 同步保持幂等，并拒绝覆盖本地修改过的 Agent Preset。

### 阶段三：提取可复用客户端

把传输层和契约逻辑从股票插件迁到 `trading-adapter-client`。插件中只保留 dsh 专属注入和展示逻辑，在不修改 Python API 的前提下切换到 workspace 客户端。

验收条件：

- 客户端包不导入任何 dsh 包，也不引用 `agent.inject()`。
- 股票插件冒烟流程保持行为等价。
- 单元测试覆盖 LF/CRLF、分块边界、跨分块 UTF-8、多行 data、末尾未终止帧、`404`、`409`、后端 error 事件、网络失败、超时、取消和缺少 result 的关闭。
- 从 workspace 根目录执行类型检查、构建和测试全部通过。

## 验证矩阵

最低支持矩阵如下：

| 验证项 | macOS | Windows |
| --- | --- | --- |
| Python 环境发现 | `env/bin/python` | `env\\Scripts\\python.exe` |
| 包含空格的仓库路径 | 必须 | 必须 |
| Profile 同步 | 必须 | 必须 |
| 需要生成 Cordis 插件 URL 时 | `pathToFileURL` | `pathToFileURL` |
| Preset 工具隔离 | 必须 | 必须 |
| managed fake-runner 冒烟测试 | 必须 | 必须 |
| managed engine 启动与健康检查 | 必须 | 必须 |
| external 服务附着 | 必须 | 必须 |
| dsh 优雅释放与旧状态清理 | 必须 | 必须 |

CI 在两个操作系统上运行静态检查和确定性单元测试。engine 和 dsh 集成测试可能需要环境凭据，可以作为显式冒烟任务；fake runner 流程必须不依赖凭据。

## 文档归属

- `backend/dsh-trading-core/README.md` 只记录 Python 初始化、配置、API 启动和 API 验证。
- `backend/market-watch/README.md` 只记录 Python 服务。
- `integrations/dsh/README.md` 记录 pnpm 设置、Profile 同步、Bundle/Preset 所有权、插件开发、Python 生命周期模式、生成状态及 macOS/Windows 命令。
- API/SSE 契约在 Python Adapter 附近保留唯一规范来源；TypeScript 包链接到该来源，并通过测试验证兼容性。

## 风险与缓解

- **文件历史丢失：** 使用 `git mv`，并保持阶段一为机械迁移，使 Git 能识别重命名。
- **意外升级 dsh：** 在改变运行行为前确认并固定已验证版本。
- **Windows URL/路径回归：** 使用 Node URL/path API，并在 Windows 上测试包含空格的路径。
- **Preset 根目录限制：** 在仓库中维护规范模板，并把受保护副本同步到 dsh 现有用户 Preset 根目录；本次迁移不修改 dsh 核心以增加新的根目录机制。
- **Preset scope 泄漏：** 面向模型的注册保留在 Agent 层；进程级轮询和广播迁到显式 Host 层入口。
- **遗留子进程：** 记录所有权，停止前验证进程身份，退出后清理状态。
- **契约漂移：** Python 保持 API 权威来源；TypeScript 客户端使用契约 fixture 和 fake-runner 冒烟测试验证。
- **范围蔓延到 frontend：** 除非未来独立设计的消费者集成明确需要，否则禁止修改 `frontend/`。

## 完成标准

满足以下条件时迁移完成：后端目录符合上述纯 Python 定义；两个业务插件、产品 Bundle、Python Runtime 和 Agent Preset 都位于 `integrations/dsh`；共享股票分析客户端与 dsh 解耦；没有提交任何机器特定路径；每个 Preset 只暴露其声明的工具；managed 和 external 生命周期流程均能在 macOS、Windows 上通过原生 dsh Profile 工作流验证。
