# Agent Note: 机会发现首屏数据路径具有明确时延预算

Status: implemented

[English](2026-08-24-opportunity-first-paint-data-budget.md) | 中文

## Problem

非聊天的“机会发现”路由在首次渲染时请求带事件富化和个性化的快讯。该同步路径可能等待全部配置来源以及最长 60 秒的可选 LLM，尽管页面只渲染新闻标题。冷 K 线读取也会无前台 deadline 地顺序尝试三个 provider，并发请求还可能重复相同的外部工作。

## Decision

`OpportunityPage` 使用 `enrich=false` 和 `personal=false` 请求基础快讯。页面把该数据明确标为基础资讯，并显式报告部分来源或 stale cache 响应。切换扫描类型不会改变新闻请求键；只有页面刷新或新闻区域重试才会重新请求资讯。完整来源聚合、事件富化和个性化排序继续作为显式 `news-flash` 能力存在，不进入首屏工作。

market-watch 后端为基础新闻设置 1.5 秒总体 deadline、15 秒 fresh TTL、5 分钟 stale 窗口和单个刷新 flight。冷请求在 deadline 到达时返回已经完成的快速来源；flight 会保持所有权，直到每个带 timeout 的来源结束，而且只有完整刷新才能替换已有 stale 值。财联社改为直接调用带签名的 HTTP 接口，不再进入 akshare 的无界重试 helper。显式完整档使用独立 cache，并在可选事件与 LLM 工作前使用 10 秒来源 deadline。

K 线读取按代码与 lookback 共享 single-flight，使用 60 秒 fresh TTL、30 分钟 stale 窗口和 2.5 秒冷请求前台 deadline。4 个准入许可同时限制运行和排队的 refresh key；超过容量的冷 key 快速返回 HTTP 503，stale 值仍可继续使用。baostock 的全局 socket 在短生命周期子进程中运行，超过独立 deadline 后由父进程终止。冷请求超时会返回 HTTP 504 和明确的后台刷新说明，不会宣称该股票没有数据。可选名称行情查询使用独立的 0.3 秒预算和有界准入。

## Alternatives considered

**首屏仍运行富化，只用渐进 UI 隐藏。** React 区域相互独立无法让一个尚未完成的慢新闻请求提前产出标题。后端操作本身必须提供带时延预算的基础档。

**LLM 较慢时在富化响应字段中静默返回规则结果。** 这会悄悄改变调用方请求的能力。基础档与完整档保持显式区分，完整富化继续使用其已经文档化的降级行为。

**在 deadline 到达时遗弃 provider 线程。** Python 无法安全停止已经运行的线程，而且这样会在真实来源调用仍占资源时过早释放逻辑 flight。固定 worker 容量和 HTTP timeout 让 news 调用自然结束；唯一没有可靠 timeout 的 socket API baostock 改在可终止子进程中运行。

## Consequences

- “机会发现”路由最晚在配置的 1.5 秒来源预算后展示基础新闻，不再等待完整来源或 LLM 富化。
- 部分结果与 stale 响应保持可用且可见；来源失败不会清除已有缓存。
- 冷技术信号请求会在 2.5 秒内得到 K 线，或在共享刷新继续时收到明确且可重试的超时。
- 应用关闭时停止准入，并在 provider deadline 后 join 有界的 news、K 线和名称行情 worker。
- fake clock、HTTP session、source、进程隔离、准入和并发测试会在无外部网络、无 LLM 的条件下锁定 deadline、stale 行为与来源调用次数。
