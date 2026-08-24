# @deepseek-ai/dsh-electron

[English](README.md) | 中文

DeepSeek Harness 的 Electron 桌面应用。它启动所选 profile（默认为 `web`），通过自有的 `dsh://app` URL scheme 提供 Host 与现有 Web renderer 的相对路径构建，并用 IPC 承载事件下行流。因此桌面应用复用所选 profile 的客户端插件、会话、设置和 `$DSH_HOME`，同时由原生 patch 移除 Web 监听 carrier（载体）。

## 从源码启动

在仓库根目录运行：

```sh
pnpm install
pnpm run build
pnpm dsh electron
pnpm dsh electron --profile investment-research
```

`electron` 是应用选择器，不是 profile 名称：`dsh --profile electron` 会查找用户 profile，不会启动桌面 runtime。`pnpm dsh electron` 检查已构建的主进程、沙箱化 preload 与 renderer，再通过应用本地的 Electron executable 启动默认 `web` profile，并且不会重新构建。`pnpm dsh electron --profile investment-research` 是五层投研 profile 的产品入口；配置诊断应单独使用 `pnpm dsh --profile investment-research --dump-default-config`。`pnpm run start:electron` 仍是构建后启动的便捷命令；`pnpm --filter @deepseek-ai/dsh-electron run start` 可直接启动现有产物。

## 投研 backend 部署

随附业务行默认使用 `managed`：股票分析使用 `http://127.0.0.1:8000`，盘中盯盘使用 `http://127.0.0.1:8100`，源码启动会在本仓库中发现其项目。打包或移动后的部署应为每一行设置绝对 `backendProjectDir`；独立监管的 endpoint 使用 `backendMode: external` 与 `backendBaseUrl`，此模式验证身份，但绝不启动或停止进程。这些字段写入 `$DSH_HOME/profiles/investment-research/cordis.patch.yml`；请注意，配置行 patch 会替换其完整 `config`。

managed 虚拟环境缺失时，启动会给出项目目录与 `./init.sh` 或 `init.bat` 指引并失败，绝不会执行安装。Runtime 日志与诊断状态位于 `$DSH_HOME/investment-research/<backend-id>/`，状态绝不授权按 PID 接管。股票分析的对话内简报投递默认 `enableInChatPush: false`；Python scheduler 与外部投递设置仍归 backend 所有。路径、保留策略与归属细节见 [Runtime 包约定](../../packages/investment-research/python-runtime/README.md)。

## 投研使用流程

源码启动先运行一次 `pnpm run investment:python:init`，需要检查环境时运行 `pnpm run investment:python:verify`。在现有 Models 设置页只保存一次 DeepSeek Key，不要把它复制到任一 backend `.env`。投研设置页会显示两个 backend 的状态、9 个股票工具、11 个盯盘工具、凭据就绪状态、能力等级及各自日志路径。attached 或 external 服务自行管理凭据，绝不会收到本机 Key。

Key 更新后，页面会请求一次明确的应用重启。Electron 会先排空 IPC、dispose Profile，并等待工具、lease 与 owned 进程树退出，再使用相同 profile 参数重新启动。重启完成前，新的 LLM 依赖调用会被拒绝，不会继续使用 child 中的旧凭据。

验收由用户显式执行：在对话中检查 `watch_list`，运行 `watch_add` 后再次运行 `watch_list`，再运行 `get_watchlist`；随后明确确认一次收费的 `analyze_stock` 及一个盯盘数据工具。设置页只列出这些步骤，绝不自动调用。

## 打包应用

在仓库根目录可使用桌面打包流程与 Electron Forge maker：

```sh
pnpm run package:electron
pnpm run make:electron
```

`package:electron` 构建自包含的生产部署及当前平台原生 Python sidecar，并在 `apps/electron/out/` 下生成未压缩应用。sidecar 会复制到 `Resources/investment-python`，构建缓存与 staging 目录不会进入产物。`make:electron` 还会运行 Electron Forge 中配置的 maker，在 `apps/electron/out/make/` 下为当前平台与架构生成 ZIP。可对最终资源目录运行 `pnpm run investment:sidecar:smoke -- --root <Resources/investment-python>`。该 ZIP 未签名；正式签名／公证仍是发布门禁，手动 `Investment packaged sidecar` workflow 则执行 arm64／x64／Windows 原生产物 smoke 与 macOS ad-hoc 签名验证。

## 运行时结构

- main 进程解析唯一的 `--profile <name>` 参数（缺省为 `web`），把该 profile 传给 `runProfile`，然后且只再应用 `electron.patch.yml`。对于 `investment-research`，profile 会先按 base → web-app → investment-runtime → investment-stock-analysis → investment-market-watch 组合；Electron patch 随后禁用 Web server、静态 Web runtime、Web Connection provider、自适应浏览器目录选择器与 client HMR，再挂载原生目录选择器组合和 Electron Connection provider。
- main 与 preload bundle 将 `electron` 模块保留为外部依赖，因为 Electron executable 会在运行时提供该模块。
- ESM main 模块会调度应用启动，但不会在顶层等待 `app.whenReady()`，使 Electron readiness 事件可以在初始模块求值后运行。把 `dsh` scheme 注册为 standard、secure 且支持 Fetch 也发生在该模块求值期间，因为 Electron 只在就绪之前接受特权列表。
- profile 安装锚点从已修复的 profile 依赖目录解析裸插件。Electron 不暴露 Node 内部模块 loader 时，app boot 会使用公开的 Node 解析机制。
- `src/protocol.ts` 按固定顺序路由一个 `dsh://app` 请求：Host 路径、注入了客户端 boot graph 的 index 文档、客户端插件包、渲染资源。它不 import 任何 Electron 模块，因此由主进程传入 `net.fetch` 作为文件读取方。解析到渲染目录之外的路径会被拒绝。
- 由于 renderer 拥有真实 origin，一切按 URL 寻址的能力——一元 RPC、上传以及会话日志 ZIP 下载——都使用普通的 Web 客户端代码。Preload 只暴露两个事件流方法。renderer 启用 context isolation 与 Chromium sandbox，并禁用 Node integration。
- 主进程验证每个 IPC 流请求，并且只接受窗口主 frame 发来的消息。导航被限制在 renderer 文档内；HTTP(S) 链接会在外部打开。

Electron 不暴露 Cordis HMR 所需的 Node loader 内部机制，因此桌面应用不启用客户端插件 HMR，也不会实时监视 profile patch。修改客户端 bundle 后需重新构建并重启 Electron；修改任一 `cordis.patch.yml` 层后需重启。

## macOS 原生插件启动

经 GUI 客户端复制或下载的源码 checkout 可能把 `com.apple.quarantine` 传播到已安装的原生依赖。如果 macOS 报告无法验证 `pty.node`，请完成该对话框并退出本次启动，不要把文件移到废纸篓。确认该插件来自本 lockfile 与可信 checkout 后，重新在不带 quarantine 的 checkout 中安装依赖，或依据组织策略由管理员只清除已验证本地依赖的属性。`xattr -p com.apple.quarantine <path-to-pty.node>` 是只读诊断命令。应用绝不会自动清除 quarantine。

该提示发生在共享本地 subprocess provider 提前加载 `node-pty` 时，并非 Python backend 健康检查或虚拟环境失败。可分发的 macOS 应用必须签名并公证应用与原生插件；当前 Forge ZIP 未签名，因此清除开发 checkout 的 quarantine 不是生产分发修复。

## 模型体验

桌面载体不改变模型可见内容；它运行相同的 Web profile 与会话协议。

#### KV Cache 影响

无；Electron 层只改变本地传输与应用打包。
