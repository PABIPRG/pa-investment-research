# Agent Note: 机会发现首屏数据路径具有明确时延预算

Status: implemented

[English](2026-08-24-opportunity-first-paint-data-budget.md) | 中文

## Problem

非聊天的“机会发现”路由在首次渲染时请求带事件富化和个性化的快讯。该同步路径可能等待全部配置来源以及最长 60 秒的可选 LLM，尽管页面只渲染新闻标题。冷 K 线读取也会无前台 deadline 地顺序尝试三个 provider，并发请求还可能重复相同的外部工作。

## Decision

`OpportunityPage` 使用 `enrich=false` 和 `personal=false` 请求基础快讯。页面把该数据明确标为基础资讯，并显式报告部分来源或 stale cache 响应。切换扫描类型不会改变新闻请求键；只有页面刷新或新闻区域重试才会重新请求资讯。完整来源聚合、事件富化和个性化排序继续作为显式 `news-flash` 能力存在，不进入首屏工作。

market-watch 后端为基础新闻设置 1.5 秒总体 deadline、15 秒 fresh TTL、5 分钟 stale 窗口和单个刷新 flight。冷请求在 deadline 到达时返回已经完成的快速来源；stale 请求立即返回，同时让唯一 refresh 继续。显式完整档使用独立 cache，并在可选事件与 LLM 工作前使用 10 秒来源 deadline。

K 线读取按代码与 lookback 共享 single-flight，使用 60 秒 fresh TTL、30 分钟 stale 窗口和 2.5 秒冷请求前台 deadline。stale 命中会直接返回并继续刷新。冷请求超时会返回 HTTP 504 和明确的后台刷新说明，不会宣称该股票没有数据。可选名称行情查询使用独立的 0.3 秒预算。

## Alternatives considered

**首屏仍运行富化，只用渐进 UI 隐藏。** React 区域相互独立无法让一个尚未完成的慢新闻请求提前产出标题。后端操作本身必须提供带时延预算的基础档。

**LLM 较慢时在富化响应字段中静默返回规则结果。** 这会悄悄改变调用方请求的能力。基础档与完整档保持显式区分，完整富化继续使用其已经文档化的降级行为。

**在 deadline 到达时取消 provider 线程。** Python 无法安全停止已经进入阻塞调用的线程。有限的前台等待、provider 超时、TTL/stale cache 和 single-flight 会约束用户延迟与来源压力，线程则自然结束。

## Consequences

- “机会发现”路由最晚在配置的 1.5 秒来源预算后展示基础新闻，不再等待完整来源或 LLM 富化。
- 部分结果与 stale 响应保持可用且可见；来源失败不会清除已有缓存。
- 冷技术信号请求会在 2.5 秒内得到 K 线，或在共享刷新继续时收到明确且可重试的超时。
- fake clock、HTTP session、source 和并发测试会在无外部网络、无 LLM 的条件下锁定 deadline、stale 行为与 single-flight 来源调用次数。
