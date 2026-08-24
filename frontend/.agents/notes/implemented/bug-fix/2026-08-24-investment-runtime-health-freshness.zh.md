# Agent Note：投研 Runtime 健康结果新鲜度

Status: implemented

[English](2026-08-24-investment-runtime-health-freshness.md) | 中文

## 问题

已处于活动状态的投研 Python backend 每次被获取时，都会重新发起 `/health` 请求。机会发现与持仓分析路由会为相互独立的数据请求获取同一个 backend，因此三个并发请求会在业务请求开始前放大为三次健康探测。健康端点较慢或停滞时，这会叠加重复延迟，而且探测没有 Runtime 自有的截止时间。

## 决策

Runtime 为每个活动 backend 保留最近一次成功健康结果的时间。结果在 `healthFreshnessMs`（默认 `5000`）内可复用；过期后，同时到达的获取会共享一次按 backend 归并的探测。设置 `healthFreshnessMs: 0` 可保留此前每次都探测的行为。每次健康请求会与 Runtime 自有的 `AbortController` 组合，并在 `healthTimeoutMs`（默认 `2000`）后以明确的超时错误失败。两个设置都记录在包的 [README](../../../../packages/investment-research/python-runtime/README.md) 中。

新鲜度带有 generation（代次）。owned 进程退出、要求重启的凭据更新、teardown、dispose 和非健康探测都会让可复用结果失效。在退出或重启失效之前启动的探测，不能恢复旧代次。调用方取消只停止该调用方的等待，不会取消其他获取仍需要的共享探测。

聚焦 Runtime 测试固定了并发共享、过期、新鲜结果复用、超时取消、进程退出失效、重启失效和非健康就绪结果。

## 考虑过的替代方案

**每次获取都探测，只缩短超时。** 这能限制单次请求耗时，但仍保留请求放大，也仍会把健康探测延迟放在每个业务调用之前。

**无限期缓存，直到业务请求失败。** 这能最大限度减少探测，但可能在 owned 进程已退出或凭据要求重启后仍继续租用 backend。

**某个调用方取消时取消共享探测。** 这会让无关的获取一起失败，并在存活调用方重试时再次产生重复探测。

## 结果

对于一个活动 backend，新鲜度窗口内的 `N` 次获取不会增加探测。结果过期时，`N` 次并发获取只增加一次探测，而不是 `N` 次；该探测成功后，窗口内后续获取又会增加零次探测。慢探测现在会在配置的截止时间内失败，并明确报告 backend id 与时长。

Runtime 最多会在 `healthFreshnessMs` 内复用健康结果，但生命周期与就绪失效会立即结束该窗口。本变更不修改 Typert transport、Host protocol、工作台 UI、聊天行为、backend 业务请求或 lease 归属。
