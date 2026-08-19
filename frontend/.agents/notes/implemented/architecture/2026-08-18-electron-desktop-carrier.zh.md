# Agent Note: Electron 桌面载体在无网络服务器的情况下复用 Web profile

Status: implemented

[English](2026-08-18-electron-desktop-carrier.md) | 中文

## Problem

仓库需要一个位于 `apps/` 下的桌面应用，用于启动现有图形客户端，并可在之后生成可分发的 Electron 产物。Web 应用已经持有产品 UI，`web` profile 也已经组合所需的 Host 服务与客户端插件名单，因此桌面应用必须保留这些所有者，不能再创建第二套 frontend 或独立的 Host 组装。它还必须避免向 renderer 代码暴露 Node 或不受限制的 Electron API。

现有 Web 载体假定存在 HTTP listener、同源 Fetch、`/plugins` bundle route、index manifest 注入与 WebSocket 下行。Electron 需要同一套四象限 RPC 协议与客户端插件图，但不能打开监听端口。

## Decision

`apps/electron` 是构建在随附 `web` profile 之上的产品应用。`dsh electron` 应用选择器先检查已构建的 main、preload 与 renderer 产物，再通过应用本地安装的 Electron executable 启动同级应用。main 与 preload bundle 将 `electron` 模块保留为外部依赖，因为该 executable 会在运行时提供此模块。Electron 主进程调用 CLI 包导出的 `runProfile()`，以 Electron 包 manifest 作为安装锚点，并在 profile 之上应用 `electron.patch.yml`。该选择器不是 profile 别名：`dsh --profile electron` 保留通用的具名组合含义。该 overlay 禁用 `web-startup`、`webserver`、`web-runtime`、`client-hmr`、自适应 `directory-picker` 与 Web `connection` 配置行；保留其余 Host 与客户端插件配置行；再插入原生 Host／客户端目录选择器组合和应用持有的 `ElectronConnectionService`。

Profile 启动以生成的 profile 根配置作为宿主模块基准。Cordis 内部模块 loader 可用时，app boot 使用该 loader；否则先通过 `createRequire()` 解析宿主持有的裸包，再导入 file URL。该机制同时覆盖嵌套 include 配置项与之后添加到根 Loader 的配置项。在 Loader 配置项图之外直接插入的子树，只有把裸标识符委派给根 Loader 的公开 `import()` 才能得到同一套解析——[会话的 preset 组装](2026-08-03-per-session-agent-presets.md)在此正是这样挂载的。Cordis HMR 需要 Electron 未暴露的 Node 模块 loader 内部机制，因此 Electron 传入 `watchPatches: false`。两个 `cordis.patch.yml` 层仍会在启动时应用，但其变更需要重启应用。

Connection 协议保持单一实现。renderer 通过[应用自有的 URL scheme](2026-08-18-desktop-application-url-scheme.md) 访问 Host，因此 `ElectronApiClient` 继承 `WebApiClient`，只覆写 `events.mux` 与 `events.host`——它们经 preload 使用固定的回调流；其余请求都走继承来的同源 Fetch 路径。主进程 service 把请求映射到现有 API Proxy Fetch handler、通用 Connection RPC 注册和 ApiProxy 事件 iterable。只有 preload 暴露带版本号的 `__DSH_ELECTRON__` bridge 时，renderer 才会选择该载体；fixture 模式仍然优先。

客户端模块注册表可以在有或没有 Web server 时运行。Web server 存在时，可选注入会安装 `/plugins` 与 index manifest tap。其他载体可通过 `additionalPackages` 配置某个 Host 载体配置行已被禁用的客户端包，再直接读取 `graph()` 与 `bundleFile()`。Electron 以此加入 Connection 客户端 bundle，并从自有 scheme 提供同样的相对 bundle URL 与注入后的 index 文档。renderer 是 `apps/web` 的第二份 Vite 构建，资源路径为相对路径；没有分叉任何 UI 代码。

Preload 只暴露 `openStream` 与 `closeStream`。`BrowserWindow` 启用 context isolation、Chromium sandbox 与 Web security，并禁用 Node integration。主进程只接受该窗口主 frame 的 IPC，验证每个请求，拒绝权限请求和窗口内导航，并且只把 HTTP(S) 链接交给外部打开。Electron readiness 发生在初始模块求值之后，因此 ESM main 模块会调度异步启动，而不会在顶层等待 `app.whenReady()`，并在同一段就绪前窗口内注册该 scheme 的特权。应用持有单实例锁，并在退出时排空 IPC 与 Cordis 配置树。

打包先通过 `pnpm deploy` 创建自包含的生产部署，再调用 Electron Packager，并关闭依赖裁剪，因为该部署已经包含生产依赖闭包。这样可以避免 Electron Packager 的依赖遍历器把 pnpm 隔离的工作区链接当作 npm 布局，而不必把仓库切换到 `node-linker=hoisted`。Electron Forge 7.8.3 在已打包应用上运行 maker；当前配置的 maker 是未签名的逐平台 ZIP，签名、公证与 installer maker 保留为分发配置。打包保持禁用 `asar`，因为客户端模块系统按文件系统路径读取独立构建的插件 bundle。工作区显式记录 pnpm 常规的 hidden-hoist 默认值（`hoistPattern: ['*']`），因为 Forge 要求可见的磁盘 hoist 策略。Forge 的 `@electron/rebuild@3.7.2` 通过 git 依赖指定 Electron 的 node-gyp fork，pnpm 的 `blockExoticSubdeps` 会正确拒绝它；父级定向 override 改为选择 Electron 已发布到 registry 的 `@electron/node-gyp@10.2.0-electron.2`，而不是削弱工作区策略。

## Alternatives considered

- **启动现有 Web server 的回环监听，再让 Electron 指向它**：这会仅为跨越一个进程内应用边界而保留监听 socket、浏览器信任策略、HTTP route 所有权和 WebSocket 生命周期，还会使桌面启动依赖端口分配。
- **交付 `electron` profile 模板**：profile 只会选择当前 Node 进程内的 Cordis 组合，不能选择必须持有桌面主进程的 Electron runtime。将应用选择器分开，可以让 `--profile` 继续专用于用户组合。
- **构建独立 Electron renderer**：这会复制应用外壳与客户端插件名单。对 `apps/web` 做相对路径构建可以保留唯一 UI 所有者。
- **从 preload 暴露 `ipcRenderer` 或通用 channel 方法**：这样页面代码可以触达从未被设计为 renderer capability 的 channel。固定方法使暴露 API 可审计。
- **立即启用 `asar`**：客户端模块注册表仍按文件系统路径读取 bundle 文件。把这些文件放到 archive 抽象背后应另作决策。

## Consequences

- `pnpm dsh electron` 启动已有桌面产物而不重新构建。`pnpm run start:electron` 构建并启动这些产物；`pnpm run package:electron` 创建未压缩应用，`pnpm run make:electron` 在 `apps/electron/out/` 下创建当前平台的 ZIP。
- 桌面与 Web 使用相同的 profile、`$DSH_HOME`、Host 服务、客户端插件与会话数据。载体差异保留在 Connection 和应用组装中。
- Electron 禁用 client HMR 与 profile patch 实时监视。客户端 bundle 变更需要重新构建并重启；profile patch 变更需要重启。
- 无密钥证明覆盖事件流生命周期、进程内 RPC 分发、无 Web server 的客户端模块组合、ESM 生命周期调度、公开裸包回退路径、两个 aggregate TypeScript program、完整工作区构建、真实 Electron renderer DOM 与 Forge 打包。
