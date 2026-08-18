# @deepseek-ai/dsh-electron

[English](README.md) | 中文

DeepSeek Harness 的 Electron 桌面应用。它启动随附的 `web` profile，通过自有的 `dsh://app` URL scheme 提供 Host 与现有 Web renderer 的相对路径构建，并用 IPC 承载事件下行流。因此桌面应用与 `dsh web` 使用相同的 profile、客户端插件、会话、设置和 `$DSH_HOME`，但不会打开监听端口。

## 从源码启动

在仓库根目录运行：

```sh
pnpm install
pnpm run build
pnpm dsh electron
```

`electron` 是应用选择器，不是 profile 名称：`dsh --profile electron` 会查找用户 profile，不会启动桌面 runtime。`pnpm dsh electron` 检查已构建的主进程、沙箱化 preload 与 renderer，再通过应用本地的 Electron executable 启动，并且不会重新构建。`pnpm run start:electron` 仍是构建后启动的便捷命令；`pnpm --filter @deepseek-ai/dsh-electron run start` 可直接启动现有产物。

## 打包应用

在仓库根目录可使用桌面打包流程与 Electron Forge maker：

```sh
pnpm run package:electron
pnpm run make:electron
```

`package:electron` 构建自包含的生产部署，并在 `apps/electron/out/` 下生成未压缩应用。`make:electron` 还会运行 Electron Forge 中配置的 maker，在 `apps/electron/out/make/` 下为当前平台与架构生成 ZIP。该 ZIP 未签名；明确分发要求后，在 `forge.config.ts` 中加入签名／公证凭据及其他 Forge maker。

## 运行时结构

- `electron.patch.yml` 禁用 Web server、静态 Web runtime、Web Connection provider、自适应浏览器目录选择器与 client HMR，再挂载原生目录选择器组合和 Electron Connection provider。
- main 与 preload bundle 将 `electron` 模块保留为外部依赖，因为 Electron executable 会在运行时提供该模块。
- ESM main 模块会调度应用启动，但不会在顶层等待 `app.whenReady()`，使 Electron readiness 事件可以在初始模块求值后运行。把 `dsh` scheme 注册为 standard、secure 且支持 Fetch 也发生在该模块求值期间，因为 Electron 只在就绪之前接受特权列表。
- profile 安装锚点从已修复的 profile 依赖目录解析裸插件。Electron 不暴露 Node 内部模块 loader 时，app boot 会使用公开的 Node 解析机制。
- `src/protocol.ts` 按固定顺序路由一个 `dsh://app` 请求：Host 路径、注入了客户端 boot graph 的 index 文档、客户端插件包、渲染资源。它不 import 任何 Electron 模块，因此由主进程传入 `net.fetch` 作为文件读取方。解析到渲染目录之外的路径会被拒绝。
- 由于 renderer 拥有真实 origin，一切按 URL 寻址的能力——一元 RPC、上传以及会话日志 ZIP 下载——都使用普通的 Web 客户端代码。Preload 只暴露两个事件流方法。renderer 启用 context isolation 与 Chromium sandbox，并禁用 Node integration。
- 主进程验证每个 IPC 流请求，并且只接受窗口主 frame 发来的消息。导航被限制在 renderer 文档内；HTTP(S) 链接会在外部打开。

Electron 不暴露 Cordis HMR 所需的 Node loader 内部机制，因此桌面应用不启用客户端插件 HMR，也不会实时监视 profile patch。修改客户端 bundle 后需重新构建并重启 Electron；修改任一 `cordis.patch.yml` 层后需重启。

## 模型体验

桌面载体不改变模型可见内容；它运行相同的 Web profile 与会话协议。

#### KV Cache 影响

无；Electron 层只改变本地传输与应用打包。
