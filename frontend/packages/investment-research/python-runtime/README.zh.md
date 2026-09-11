# @deepseek-ai/dsh-investment-python-runtime

[English](README.md) | 中文

用于注册、验证和租用投研插件所需 Python endpoint（端点）的 Host Service。`ctx.investmentPythonRuntime` 统一负责 backend（后端）身份、路径解析、健康检查、子进程归属、诊断与 teardown（拆除）；业务插件注册完整定义，并使用 lease（租约）中经过验证的 `baseUrl`，不再自行启动 Python 或读取端口。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME`，否则 `~/.dsh` | Host 数据、投研 backend 状态、备份与诊断共用的挂载根目录。 |
| `startupTimeoutMs` | `30000` | managed 启动的最长等待时间。 |
| `healthPollMs` | `250` | 启动期间两次健康探测之间的间隔。 |
| `healthFreshnessMs` | `5000` | 活动 backend 成功健康探测的复用窗口；设为 `0` 可禁用复用。 |
| `healthTimeoutMs` | `2000` | 单次 backend 健康请求的最长等待时间。 |
| `shutdownGraceMs` | `5000` | 传给子进程树终止阶梯的宽限期。 |
| `logTailBytes` | `65536` | 启动错误可附带的诊断日志尾部上限。 |
| `logMaxBytes` | `4194304` | 下次启动时触发单文件轮转的活动 backend 日志大小。 |

## Backend 生命周期

`managed` 是业务插件的默认模式。runtime 会验证 loopback HTTP URL，从本包位置解析 backend 目录而不使用调用方工作目录，检查项目虚拟环境解释器，并探测 `/health`。只有探测明确返回 connection refused 时才会启动 Uvicorn；未知网络失败、已占用 endpoint 或服务身份不匹配都会使启动失败，且不会触碰作出响应的进程。spawn 前已健康的服务归类为 `attached`，通过 `ctx.subprocess` 启动的子进程归类为 `owned`。

`external` 接受 HTTP 或 HTTPS，验证配置的健康身份并返回 `external` lease。它绝不启动、发送信号或停止服务。最后一个 lease 释放时只会停止内存中持有 handle 的 `owned` 进程；attached 与 external 服务继续存活。runtime dispose（释放）会拒绝新工作、等待进行中的获取，再等待所有 owned 进程树完全退出。状态文件只用于诊断，绝不授权按 PID 或端口接管进程。

同一 backend id 的并发获取共享一次启动。活动获取会复用近期成功的健康结果；结果过期后同时到达的请求共享一次健康探测。每次探测都有明确的截止时间；owned 进程退出、凭据更新要求重启、teardown 和非健康就绪结果都会使可复用结果失效。相同定义按引用计数注册；命令、URL、模式、身份或路径定义冲突时明确失败。业务工具只在获取成功后注册，并在释放 lease 前移除。

## 凭据与就绪状态

投研 profile 复用 Models 设置页作为 `DEEPSEEK_API_KEY` 的唯一产品输入。只有在启动 `owned` managed child 时，凭据 provider 才会解析该引用；Runtime 也只会把它转发给显式允许该引用的 backend 定义。凭据值不会复制进 backend `.env`、Runtime state、日志、就绪快照或 Client Remote 数据。`attached` 与 `external` endpoint 不接收本机凭据，其凭据由该服务的 operator 负责。

就绪状态会报告 backend 归属、安全凭据事实、能力等级、工具数、重启要求和诊断日志路径。Key 更新后，活动 owned backend 会标记为 `restart-required`；应用完成 quiescent restart（静默收敛重启）前，新的 LLM 依赖工具调用会在 preflight 阶段失败。非 LLM 操作继续按能力声明保持可用；健康且声明 `llm: none` 的 `industry-chain` 能力无需读取模型凭据，并报告 `industry-full`。

## 项目发现与初始化

源码启动会从本安装包向上查找 `backend/dsh-trading-core`、`backend/market-watch` 与 `backend/industry-chain`。使用 `pnpm run investment:python:init` 按固定顺序初始化三个环境，再用 `pnpm run investment:python:verify` 执行只读检查。industry-chain 的初始化和验证都不会下载种子数据；首次下载仍是独立的用户确认产品操作。verify 会报告每个缺失环境及其 init 命令，不执行安装。不含该仓库布局的部署必须设置业务插件的绝对 `backendProjectDir`；相对路径或不存在的目录会失败。POSIX 解释器为 `<projectDir>/env/bin/python`，Windows 解释器为 `<projectDir>\env\Scripts\python.exe`。

每个 backend 都按严格优先级解析：显式绝对项目／解释器组合最高，其次是源码 checkout 中对应的 backend 与环境，最后是 Electron `Resources/investment-python/runtime.json` sidecar。无效的显式候选会直接失败，不会降级。bundled descriptor 是封闭清单，只能包含位于 `adapter.app:app` 的 `trading-core`、位于 `market_watch.app:app` 的 `market-watch` 与位于 `industry_chain.app:app` 的 `industry-chain`；每个普通文件都必须带 SHA-256 列出，路径必须留在 sidecar 根目录内，缺失、多余、符号链接或被修改的文件都会在 Python 启动前报告安装损坏。打包启动完全离线，绝不安装或修复依赖。

trading backend 会把显式设置的 `ADAPTER_RUNNER` 转发给 owned 子进程。backend scheduler（调度器）与 push（推送）设置仍归 Python 端所有；随附 profile 保持股票分析的对话内推送关闭（`enableInChatPush: false`），也不会把这些设置解释为 profile 组合维度。

## 日志与状态

每个 backend 写入 `$DSH_HOME/investment-research/<id>/backend.log`，超出上限的文件会在下次打开时轮转为 `backend.previous.log`。owned 进程元数据以私有权限原子写入 `runtime.json`，并且仅在其仍与内存中的精确 owned 进程匹配时删除。启动诊断会遮蔽显式转发的环境值。

Host 会为每个 owned managed child 设置 `DSH_INVESTMENT_STATE_DIR=$DSH_HOME/investment-research/<id>`，不区分源码与 bundled 形态。各 backend 的 data、cache、logs、state 和用户配置都从该可写目录派生；industry-chain 的研报、A 股 universe、研报 overlay 与生成的 LLM links 也位于其 `data` 目录。独立启动的源码 backend 在没有该变量时仍保留仓库内默认值。打包应用资源保持只读。

## 实例初始化与迁移

`initializeDshInstance()` 使用私有目录和带版本标记创建完整的空挂载布局。`dryRunDshInstanceMigration()` 以零写入方式返回文件、主动排除项、字节数、复制策略、发布策略和阻塞原因。`migrateDshInstance()` 只把该清单复制到目标内部的 staging 目录，以流式 SHA-256 校验普通文件，再按顶层条目事务发布，并最后发布版本标记。已有空挂载点保留 inode，同时把权限收紧到 `0700`。来源和目标会按规范化后的物理路径判定，并在关键动作前重复核验身份；目标非空、不安全别名、符号链接、特殊文件、不兼容目录版本、输入变化或复制／发布失败都不能授权跨出所选目录，也不会改变来源。

持久清单包含 Host 设置、profile 配置、home patch、成对的会话与附件、JSON/SQLite storage、备份设置和 `.pabackup` 文件，以及每个 backend 的 `data`、`state` 与 `user-config`。可重建的 managed `profiles/**/node_modules` 依赖会被排除。若绝对备份目录的物理位置在来源实例内，配置会改写到目标中的对应位置；外部目录保持原值，必须另行迁移。凭据、日志、缓存、runtime 进程状态、锁、传输事务日志和未完成上传不在清单内。PAB-14 的业务导入导出继续拥有按分类合并、预检、事务提交与回滚语义；实例迁移不会把 `.pabackup` 误解释为完整系统镜像。

静默迁移可以复制已经关闭的 SQLite。在线迁移会按扩展名或文件头识别 SQLite，调用方必须提供 `backupSqlite`，并通过 SQLite backup API 或等价一致性快照实现；活动 WAL、SHM 与 rollback-journal sidecar 会被排除。在线 Host 会话与附件需要共同的静默点或快照屏障，不能逐文件复制，因此迁移器会明确拒绝。应用回滚负责选择兼容的可执行文件或镜像，数据回滚则要求停止应用并恢复迁移前目录快照，两者都不会隐式代替对方。

sidecar 不重新分发 industry-chain 种子数据，应用启动也绝不下载。`industry-chain.data-status` 在不联网的情况下读取本地 `missing`、`downloading`、`ready` 或 `error` 状态；只有用户显式触发 `industry-chain.data-bootstrap` 才会下载固定五文件。backend 会限制文件大小，在临时目录校验 JSON 与最低结构，仅在完整数据集全部通过后发布，并清理失败的临时数据；并发 bootstrap 请求复用同一次下载。

## 浏览器安全数据操作

Host 的 `request-data` Remote 只接受编译期列举的 operation（操作）与各 operation 已知输入键，浏览器不能传入 backend origin、任意 URL 或任意 path。动态报告、策略和任务 id 必须符合受限标识符格式，并在拼接固定路由前经过 `encodeURIComponent`；未知键、非法枚举、越界数值和不安全 id 都会在获取 backend lease 前被拒绝。

白名单覆盖 `market-watch` 的市场观测；`trading-core` 的个人投研数据、分析、简报、回测、统一报告列表／详情、策略假设／状态迁移／运行、影子状态／持仓／净值／运行、自进化状态／归因／运行、个性化匹配／产业影响与后台任务状态／结果；以及 `industry-chain` 的无输入 `GET /data/status`、`POST /data/bootstrap` 数据生命周期路由、图谱统计、公司搜索／详情、实体档案、单公司视图、多层产业链与筛选后的全局网络。两条生命周期 operation 都返回 `{ status, files_completed, files_total, downloaded_bytes, current_file, error }`；bootstrap 是一次非流式长请求，界面可同时轮询 status 展示进度。实体业务名称可以包含 `/`，Host 会把整段编码成一个参数，同时拒绝类似路径穿越的分段和不安全标识符。浏览器不能传入下载 URL 或请求 body。其他写操作的 JSON body 只由 Host 根据已知键构造；报告列表与所有只读状态通过固定 GET 路由读取；系统既不开放任意 backend 访问，也不生成虚构结果。

个性化反馈与五个 `trading-core.local-learning-*` operation 仅限本机。它们只接受不透明对象 id、枚举化动作与表层，以及固定的结构化上下文投影；搜索词、提示词、标题、报告正文、持仓数量与成本、URL、路径和类似凭据的字段在协议中没有入口。非法值会在获取租约前失败。若经过验证的租约属于 `external`，Host 会释放租约并在 `fetch` 前拒绝 operation，因此本地偏好事实不会转发到配置的远程交易服务。`owned` 或 `attached` 本地服务负责生成权威时间并执行保留策略。

## 模型体验

无，因为该 Host 生命周期服务不注册 prompt（提示词）、工具 schema、会话事件或结果。

#### KV 缓存影响

无；backend lease 成功后的一切模型可见贡献都归业务插件所有。

## 已知限制与暂缓事项

- **打包目标是有限集合**：当前 lock 构建 macOS arm64、macOS x64 与 Windows x64 sidecar；其他目标使用源码或显式配置。
- **依赖分发文件哈希属于后续加固**：目标文件已经固定所有安装版本且自身受哈希保护；逐个 wheel／sdist 哈希留给后续发布供应链门禁。
- **状态只用于诊断，不是恢复授权**：重启后的 dsh 实例会报告 stale state（过期状态），但绝不会采用或终止磁盘记录的 PID；独立监管的服务应使用 `external`。
- **只保留一个活动日志和一个历史日志**：轮转仅在打开时按大小触发；长时间运行的子进程不会在运行中轮转。
- **在线 SQLite 备份由部署层提供**：迁移原语会强制使用一致性回调，但不假定具体 SQLite 可执行文件；容器与原生 launcher 必须绑定当前环境可用的备份实现。

持仓同步默认返回五分钟有效的只读预览，commit 必须携带预览 token；账户、数据源或本地持仓变化会拒绝替换。原生动作使用仅宿主可见的凭证和非 Remote 方法，只支持自管本机后台。
