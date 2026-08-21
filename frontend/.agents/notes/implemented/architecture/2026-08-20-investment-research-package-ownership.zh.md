# Agent Note: investment-research 包持有 frontend 工具集成

Status: implemented

[English](2026-08-20-investment-research-package-ownership.md) | 中文

## Problem

A 股研究和盯盘功能需要一个 frontend 归属位置，使它们把既有 Python endpoint 操作暴露给 harness，同时不让 frontend 包负责后端进程所有权或领域执行。两项集成具有不同的流式与同步传输行为，但都需要工作区包标识、Loader 组合、Cordis dispose 和面向模型的工具注册。

## Decision

`packages/investment-research/stock-analysis` 和 `packages/investment-research/market-watch` 是 Host 工作区函数插件。股票分析包注册 9 个工具，将其 endpoint 的 HTTP 启动 SSE 任务映射为注入的进度和渲染结果，并持有可选的对话内简报轮询器。盯盘包注册 11 个工具，将同步 JSON endpoint 操作映射为渲染结果。每个包都持有自己的 endpoint 客户端和包内展示代码。

frontend 持有工具注册、endpoint 基础 URL 配置、请求映射、面向模型的渲染以及 Cordis effect dispose。Python endpoint 仍是外部运行的进程。frontend 代码不会启动、停止、监管、打包、profile 或以其他方式管理它们，两个包也不会引入共享适配器客户端。

## 包的所有权

机械包名为 `@deepseek-ai/dsh-investment-stock-analysis` 和 `@deepseek-ai/dsh-investment-market-watch`。它们的包 manifest、Host TypeScript 引用、工作区发现、不变式、Loader 组合和生成的依赖关系图，使它们成为普通 frontend 工作区。其发布的函数插件 API 保持为 `name`、`inject`、`Config` 和 `apply`。

## Alternatives considered

- **让面向 endpoint 的 Node 插件继续由后端持有**：这会使其 Cordis 注册、工作区依赖、Loader 组合和 dispose 行为留在 frontend 包层级之外。工作区包为 harness 提供这些职责的直接所有者。
- **将 Python 进程管理放入每个插件**：这会把传输集成与 endpoint 启动、监管、配置和关闭混合。既有 endpoint 进程仍由其自身持有，工具调用则通过正常失败路径报告 endpoint 不可用。

## Consequences

- 包可按名称加载到 frontend 组合中，并且其注册会随 Cordis effect 移除。
- 部署会提供可访问的 endpoint URL，并将 Python 进程与 frontend 包分开运行。
- 股票分析和盯盘客户端有意保持独立，因为其当前 endpoint 协议（包括 SSE 与同步 JSON）具有不同的包内行为。
