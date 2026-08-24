# Agent Note: 投研 Python Runtime 与 Electron profile 组合

Status: implemented

[English](2026-08-20-investment-python-runtime-profile.md) | 中文

## 问题

投研函数插件需要两个 Python HTTP 服务，但插件激活不能从端口或 PID 安全推断进程归属。产品启动还需要复用现有 Electron renderer 与原生 carrier，而不能复制 Web 组合，也不能把进程逻辑放进纯 patch bundle。[投研包归属决策](2026-08-20-investment-research-package-ownership.md)继续把 HTTP/SSE 映射与模型可见渲染留在业务包；本决策拥有与之并列的生命周期与应用组合。

## 决策

`@deepseek-ai/dsh-investment-python-runtime` 提供 Host service `ctx.investmentPythonRuntime`。业务插件注册完整 backend 定义，并在注册工具前获取经过验证的 URL lease。按 backend 的获取采用 single-flight，lease 使用引用计数。只有身份感知健康探测明确报告 connection refused 后，`managed` 才能通过现有 [`ctx.subprocess`](../../../../packages/subprocess/subprocess/README.md) service 启动 Uvicorn。已经健康的 managed endpoint 会以 attached 方式连接。`external` 验证 HTTP(S) endpoint，不启动或停止它。

进程授权只来自本 Runtime 实例收到的实时 `SubprocessHandle`。最后一次 lease 释放与 Runtime dispose 只会终止并等待这些 owned handle。作出响应的端口、`runtime.json` 中的 PID 或 stale state 都不能授权采用、发送信号或清理。未知网络失败、已占用 endpoint 与服务身份不匹配都会使启动失败，同时让对方进程继续存活。`$DSH_HOME/investment-research/<id>/` 下的日志与仅 owner 可读写的状态用于诊断，不是恢复授权。

三个投研 bundle 保持纯 patch 且可以独立组合。`investment-runtime` 插入 Host service；`investment-stock-analysis` 与 `investment-market-watch` 各自插入一个业务插件。随附 `investment-research` profile 固定按 base、web-app、investment-runtime、investment-stock-analysis、investment-market-watch 排列五层。移除某个能力 bundle 会移除该插件的工具与 lease，不会移除另一项能力或 Runtime。

Electron 先选择 profile，再叠加原生特化。`dsh electron --profile investment-research` 把 profile 名传给 main 进程；main 进程为这五层调用 `runProfile`，然后且只再应用现有 `electron.patch.yml`。该 patch 禁用 Web server、静态 Web runtime、Web connection、自适应 directory picker 与 client HMR，再插入原生 connection 与 directory-picker 行。`dsh electron` 继续默认使用 `web`。配置检查保持为独立的非产品命令：`dsh --profile investment-research --dump-default-config`。

源码 checkout 从已安装 Runtime 包向上发现两个 backend 目录。不含该仓库布局的部署必须配置绝对 `backendProjectDir`。虚拟环境缺失时给出平台对应的 `./init.sh` 或 `init.bat` 指引，不执行安装。Python scheduler 与外部 push 配置仍归 backend 所有；股票分析的对话内 push 默认为 false。

## 考虑过的替代方案

**从健康端口、PID 文件或进程扫描推断归属。** 拒绝，因为身份不能证明当前 dsh 实例创建了该进程。采用操作会把 stale 诊断与端口复用转化为终止无关工作的授权。

**直接从每个业务插件或能力 bundle 启动 Python。** 拒绝，因为两个消费方会重复健康策略、路径解析、日志保留、single-flight 与 teardown。纯 patch bundle 也会变成生命周期实现，而非组合层。

**添加顶层投研启动器或同步另一种 profile 格式。** 拒绝，因为现有 profile 模板、bundle manifest、模块 fallback 与 `runProfile` 路径已经拥有安装与组合。

**把 Web profile 复制为 Electron 专用投研树。** 拒绝，因为 renderer 与 Host 行会发生漂移。先选择普通 profile，再应用现有原生 patch，可以保留一套 Web 组合与一个 Electron 特化点，并符合 [Electron carrier 决策](2026-08-18-electron-desktop-carrier.md)。

## 验证

包级覆盖固定 URL 与路径验证、身份感知健康分类、注册冲突、single-flight、引用计数、owned/attached/external release、受限日志、状态匹配、取消、启动失败与 quiescent dispose。真实 Loader 测试固定 bundle 移除与 external attach；无密钥 replay 固定组装后的二十个投研工具。macOS 与 Windows CI 从包含空格和中文字符的路径运行真实 managed fake backend，手动 engine workflow 则初始化两个 backend 虚拟环境，并检查组合后的二十工具 profile。CLI 与 Electron 测试固定 argv 转发、五层组合包、Web carrier 移除与原生行。

## 后果

该设计复用进程 seam 与 profile 机制，让每次终止都有内存 owner，并保持业务包和 bundle 狭窄。代价是要求 backend 提供身份 endpoint，并在源码布局之外显式给出项目目录。独立监管的服务必须使用 `external`；stale state 有意不足以自动恢复。Electron 继续依赖 Web renderer 组合，但不依赖其监听传输。
