# Agent Note: 投研凭据就绪状态与应用重启

Status: implemented

[English](2026-08-22-investment-credential-readiness.md) | 中文

## 问题

投研 profile 需要让两个 Python 服务使用同一个 DeepSeek 凭据，同时不能建立第二个设置输入、把 secret 持久化到 backend 文件，也不能把本机凭据交给应用不拥有的进程。凭据更新后，新的分析请求也不能继续静默使用运行中 child 捕获的旧值。

## 决策

现有 Models 页面继续作为 `DEEPSEEK_API_KEY` 的唯一产品写入入口。只有在启动 owned managed child 时，凭据 provider 才解析该引用；每个 backend 定义携带显式的引用到环境变量 allowlist。attached 与 external 服务不接收本机凭据。Runtime 日志、状态、错误、就绪 DTO 与 Client service 只公开安全事实，并对跨 stream 边界的转发值进行遮蔽。

Host Runtime 拥有就绪状态与能力 preflight。其快照会报告 backend 归属、凭据生命周期、能力等级、工具数、重启要求和日志路径，但不暴露凭据值。业务工具声明 DeepSeek 是必需、增强或不使用，并在任何依赖 LLM 的 HTTP 或 SSE 工作前立即检查 Runtime。Client 只挂载投研 Remote，通过专属 facade 投影，并渲染独立的投研设置页。缺少凭据时导航到 Models；该页面不包含 Key 输入，也不调用收费工具。

凭据更新会把活动 owned backend 标记为 `restart-required`。Electron 拥有唯一的应用级重启路径：排空 IPC、dispose 完整 Profile、等待 lease 与 owned 进程树，再使用原参数重新启动。新进程会重新解析凭据。attached 与 external 进程既不会被停止，也不会收到本机 Key。

股票 HTTP/SSE adapter 继续留给既定 adapter-client 变更。该变更必须保留业务包工具入口的能力检查与 Runtime 定义；它不接管凭据、就绪状态或重启。

## 考虑过的替代方案

**把 Key 复制进每个 backend `.env`。** 拒绝，因为这会产生多个可写 secret 来源，使轮换、删除与支持诊断含义不清。

**把本机 Key 注入每个可达 endpoint。** 拒绝，因为健康与身份不能证明进程归属。attached 与 external operator 继续负责自己的凭据。

**每次更新后立即重启 child。** 拒绝，因为业务 HTTP/SSE 操作尚未共享完整的 drain owner。应用级 quiescent restart 提供单一、可观察的安全边界。

**把投研 Remote 方法放进全局 Client remotes 包。** 拒绝，因为普通 Web profile 不需要可选 Host Runtime。投研 bundle 拥有自己的 Client facade 与设置页。

## 后果

用户只输入一次 Key，并得到明确的 missing、read-only、configured 与 restart-required 状态。新的 LLM 依赖操作不能继续使用过期 child 凭据，明确声明的非 LLM 操作仍可保持可用。该设计在轮换后增加一次显式重启，并让独立监管服务保持在本机凭据与进程归属之外。packaged Python asset 后续可以替换源码 resolver，而无需改变凭据、preflight 或重启的 owner。
