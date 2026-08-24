# @deepseek-ai/dsh-investment-python-runtime

[English](README.md) | 中文

用于注册、验证和租用投研插件所需 Python endpoint（端点）的 Host Service。`ctx.investmentPythonRuntime` 统一负责 backend（后端）身份、路径解析、健康检查、子进程归属、诊断与 teardown（拆除）；业务插件注册完整定义，并使用 lease（租约）中经过验证的 `baseUrl`，不再自行启动 Python 或读取端口。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME`，否则 `~/.dsh` | 仅所有者可读写的日志与 runtime state（运行时状态）根目录。 |
| `startupTimeoutMs` | `30000` | managed 启动的最长等待时间。 |
| `healthPollMs` | `250` | 启动期间两次健康探测之间的间隔。 |
| `shutdownGraceMs` | `5000` | 传给子进程树终止阶梯的宽限期。 |
| `logTailBytes` | `65536` | 启动错误可附带的诊断日志尾部上限。 |
| `logMaxBytes` | `4194304` | 下次启动时触发单文件轮转的活动 backend 日志大小。 |

## Backend 生命周期

`managed` 是业务插件的默认模式。runtime 会验证 loopback HTTP URL，从本包位置解析 backend 目录而不使用调用方工作目录，检查项目虚拟环境解释器，并探测 `/health`。只有探测明确返回 connection refused 时才会启动 Uvicorn；未知网络失败、已占用 endpoint 或服务身份不匹配都会使启动失败，且不会触碰作出响应的进程。spawn 前已健康的服务归类为 `attached`，通过 `ctx.subprocess` 启动的子进程归类为 `owned`。

`external` 接受 HTTP 或 HTTPS，验证配置的健康身份并返回 `external` lease。它绝不启动、发送信号或停止服务。最后一个 lease 释放时只会停止内存中持有 handle 的 `owned` 进程；attached 与 external 服务继续存活。runtime dispose（释放）会拒绝新工作、等待进行中的获取，再等待所有 owned 进程树完全退出。状态文件只用于诊断，绝不授权按 PID 或端口接管进程。

同一 backend id 的并发获取共享一次启动。相同定义按引用计数注册；命令、URL、模式、身份或路径定义冲突时明确失败。业务工具只在获取成功后注册，并在释放 lease 前移除。

## 凭据与就绪状态

投研 profile 复用 Models 设置页作为 `DEEPSEEK_API_KEY` 的唯一产品输入。只有在启动 `owned` managed child 时，凭据 provider 才会解析该引用；Runtime 也只会把它转发给显式允许该引用的 backend 定义。凭据值不会复制进 backend `.env`、Runtime state、日志、就绪快照或 Client Remote 数据。`attached` 与 `external` endpoint 不接收本机凭据，其凭据由该服务的 operator 负责。

就绪状态会报告 backend 归属、安全凭据事实、能力等级、工具数、重启要求和诊断日志路径。Key 更新后，活动 owned backend 会标记为 `restart-required`；应用完成 quiescent restart（静默收敛重启）前，新的 LLM 依赖工具调用会在 preflight 阶段失败。非 LLM 操作继续按能力声明保持可用。

## 项目发现与初始化

源码启动会从本安装包向上查找 `backend/dsh-trading-core` 与 `backend/market-watch`。使用 `pnpm run investment:python:init` 按固定顺序初始化两个环境，再用 `pnpm run investment:python:verify` 执行只读检查。verify 会报告每个缺失环境及其 init 命令，不执行安装。不含该仓库布局的部署必须设置业务插件的绝对 `backendProjectDir`；相对路径或不存在的目录会失败。POSIX 解释器为 `<projectDir>/env/bin/python`，Windows 解释器为 `<projectDir>\env\Scripts\python.exe`。

trading backend 会把显式设置的 `ADAPTER_RUNNER` 转发给 owned 子进程。backend scheduler（调度器）与 push（推送）设置仍归 Python 端所有；随附 profile 保持股票分析的对话内推送关闭（`enableInChatPush: false`），也不会把这些设置解释为 profile 组合维度。

## 日志与状态

每个 backend 写入 `$DSH_HOME/investment-research/<id>/backend.log`，超出上限的文件会在下次打开时轮转为 `backend.previous.log`。owned 进程元数据以私有权限原子写入 `runtime.json`，并且仅在其仍与内存中的精确 owned 进程匹配时删除。启动诊断会遮蔽显式转发的环境值。

## 模型体验

无，因为该 Host 生命周期服务不注册 prompt（提示词）、工具 schema、会话事件或结果。

#### KV 缓存影响

无；backend lease 成功后的一切模型可见贡献都归业务插件所有。

## 已知限制与暂缓事项

- **仓库发现依赖源码布局**：不保留 monorepo 布局的安装部署必须为每个业务插件配置绝对 `backendProjectDir`。
- **状态只用于诊断，不是恢复授权**：重启后的 dsh 实例会报告 stale state（过期状态），但绝不会采用或终止磁盘记录的 PID；独立监管的服务应使用 `external`。
- **只保留一个活动日志和一个历史日志**：轮转仅在打开时按大小触发；长时间运行的子进程不会在运行中轮转。
