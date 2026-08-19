# Agent Note: 桌面渲染进程运行在应用自有 URL scheme 上，而非 file 页面加 IPC Fetch 桥

Status: implemented

[English](2026-08-18-desktop-application-url-scheme.md) | 中文

## Problem

[Electron 桌面承载方](2026-08-18-electron-desktop-carrier.md)从 `file:` 文档加载渲染进程，并用 preload IPC 桥替换 Web 承载方的 Fetch。它覆盖 Connection 客户端发出的每一个 Host 请求，也仅止于此。

产品并非只通过该客户端访问 Host。会话日志导出以页面 origin 为基准构造 `/api/session.export`，用普通 `fetch` 发出 `HEAD` 预检，再把 `GET` URL 交给浏览器下载管理器，从而不在 JavaScript 里缓冲 ZIP（[`dsh-session-log-export`](../../../../packages/session-query/session-log-export/README.md)）。在 `file:` 页面上这些路径解析到文件系统根目录，按钮因 `file:///api/session.export` 报 `ERR_FILE_NOT_FOUND`。

这个失败是结构性的，不局限于某一个功能。任何把 URL 交给 Chromium 的能力——下载、`img` 或媒体源、iframe、Service Worker——在 `file:` origin 下都无法工作，IPC 桥再完整也一样，而每一个都需要各自的桌面专用分支。`file:` 页面同样无法承载有意义的 Content-Security-Policy。

## Decision

桌面应用拥有自己的 URL scheme `dsh://app`，在就绪事件之前注册为 standard、secure 且支持 Fetch，并由 `protocol.handle` 提供服务。渲染进程加载 `dsh://app/index.html`，因而拥有真实 origin，Web 承载方自身的 Fetch 与 RPC 代码在桌面上原样运行。没有任何 socket 监听：处理器在进程内应答。

`apps/electron/src/protocol.ts` 中的 `createAppProtocolHandler` 按固定顺序解析一个请求——Host 路径、index 文档、客户端插件包、渲染资源——且不 import 任何 Electron 模块，因此路由可直接单测，由主进程注入 `net.fetch` 作为文件读取方。每一层的路径归属都只有一个所有者：`ElectronConnectionService.owns()` 负责 API 网关与每个已注册 RPC 通道，`ClientModuleRegistry.bundleFile()` 为 Web 包路由与本 scheme 共同解析 `/plugins/<id>/client.js[.map]`。解析结果落在渲染目录之外的请求一律拒绝，因为页面代码可以访问该 scheme。

于是 Electron 不再把客户端 boot graph 改写成 `file:` URL，也不再作为启动参数交给 preload：所服务的 index 文档由 Web 服务器同款的 `injectBootManifest` 注入，graph 保持其相对的 `/plugins/...` URL。

preload 桥只保留一项职责，即 Host 事件下行流，因为推流没有渲染进程可寻址的 URL 形式，而桌面也没有承载 Web WebSocket 的 socket。`ElectronApiClient` 继承 `WebApiClient`，只覆写 `openMux`/`openHost`；一元调用、respond 与通用 RPC 都走继承来的同源 Fetch 路径。被移除的桥接部分——`electronFetch`、`createElectronConnectionRpc`、IPC fetch 通道、请求/响应消息类型以及 base64url manifest 传递——直接删除，不留开关。

## Alternatives considered

- **让导出功能走 Connection 承载方并由主进程保存**：改动最小，但要么在渲染进程内存里缓冲整个会话归档，要么另造一条保存路径，而且下一个按 URL 寻址的能力仍会同样失败。导出控制器今天之所以与承载方无关，正是因为 origin 是真实的。
- **事件流也用 Server-Sent Events 走该 scheme**：Host 已经把 `/api/events.mux` 与 `/api/events.host` 暴露为 SSE，因而可以彻底去掉一套承载方。暂不采纳，因为 IPC 下行流已经跑通并有测试，替换流生命周期是一次独立改动，有其自身的重连语义。
- **在 loopback 上启动 Web 服务器**：此前已否决，现在依旧否决——为跨越一条进程内的应用边界重新引入监听 socket、端口分配与浏览器信任策略。自定义 scheme 无需这些即可提供真实 origin。
- **保留 `file:`，按功能扩充 preload API**：每一个按 URL 寻址的能力都变成一个定制 IPC 方法，页面代码获得一个不断膨胀、从未按渲染能力设计的接口面。

## Consequences

- 会话日志导出在桌面上无需任何 Electron 专用代码即可工作：渲染进程的 `HEAD` 与 `GET` 经 `dsh://app` 抵达 Host，由 Chromium 下载管理器写出 ZIP。
- `asar` 仍然关闭，但理由收窄了：插件包现在经由该 scheme 传输，而不再是文件系统路径脚本，因此把它们打进归档变成打包决定，而非渲染加载问题。
- 主进程不再校验 IPC Fetch 消息及其发送帧；scheme 请求天然同源，窗口仍拒绝离开 index 文档的导航。两条流通道的 IPC 校验保留。
- 渲染文档现在可以表达 Content-Security-Policy。目前尚未设置，因此 DevTools 的不安全 CSP 警告仍在，直到选定一份策略并针对客户端包、内联样式与附件 blob URL 验证通过。
- 无密钥证据覆盖 scheme 路由（Host 路径、注入后的 index、包内容类型、缺失的包、编码目录逃逸、异常 authority、非读方法）、渲染承载方的同源一元 Fetch、IPC 上的流生命周期，以及就绪前的特权注册。桌面运行已端到端验证：恢复的会话可渲染，导出按钮写出包含 `session.jsonl` 的有效 ZIP。
