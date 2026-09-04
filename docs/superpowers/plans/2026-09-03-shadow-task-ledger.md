# 影子验证任务账本实施计划
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为影子验证建立可重启查询、支持批量部分成功与主动重跑留痕的持久化任务账本。

**Architecture:** 新增 `shadow_tasks.py` 作为任务与逐策略结果的唯一权威写入模块；`ShadowRunner` 负责任务生命周期和业务计算，`TaskManager` 继续负责实时 transport 与统一报告。`shadow_equity` 保留为兼容日净值视图，历史 API 改读账本并为旧数据提供显式 legacy 降级。

**Tech Stack:** Python、FastAPI、JsonStore、unittest、ReportStore。

**Spec:** `docs/superpowers/specs/2026-09-03-shadow-task-ledger-design.md`

## 全局约束

- 只修改已授权的 trading-core 后端、专项测试和本计划文档。
- 不使用共享端口 3080；服务验证使用隔离状态目录与独立端口。
- 所有生产代码均在对应测试按预期失败后实现。
- 不提交、推送或创建 PR；每个任务以 diff 检查点代替 commit。

---

### 任务 1：任务模型、持久化与重启查询

**Files:**
- Create: `backend/dsh-trading-core/adapter/shadow_tasks.py`
- Create: `backend/dsh-trading-core/tests/test_shadow_tasks.py`
- Modify: `backend/dsh-trading-core/adapter/shadow.py`
- Modify: `backend/dsh-trading-core/adapter/app.py`

**Interfaces:**
- Produces: `create_pending_task`、`claim_task`、`complete_task`、`fail_task`、`recover_tasks`、`get_task`、`list_tasks`。
- Consumes: `JsonStore.mutate` 与 `JsonStore.mutate_document`。

- [ ] 编写任务 pending→running→completed、重建 store 后仍可查询、pending/running→interrupted 的失败测试。
- [ ] 运行 `python -m unittest tests.test_shadow_tasks`，确认因模块或接口缺失而失败。
- [ ] 实现最小任务状态机与查询投影，并接入 `ShadowRunner.prepare_task/run` 和 lifespan 恢复。
- [ ] 重跑测试确认通过，并执行 `git diff --check` 检查点。

### 任务 2：批量 partial 与逐策略结果

**Files:**
- Modify: `backend/dsh-trading-core/adapter/shadow_tasks.py`
- Modify: `backend/dsh-trading-core/adapter/shadow.py`
- Test: `backend/dsh-trading-core/tests/test_shadow_tasks.py`

**Interfaces:**
- Produces: `save_strategy_result`、`list_task_results`、确定性 `aggregate_status`。
- Consumes: `ShadowRunner._run_strategy` 的成功快照或异常。

- [ ] 编写两成功、成功+失败、全失败、全跳过的失败测试，断言 task summary 与逐策略状态。
- [ ] 运行定向测试，确认缺逐策略持久化和 `partial` 聚合而失败。
- [ ] 在批量循环逐条写 `success/failed/skipped`，用真实结果聚合总状态。
- [ ] 重跑定向测试确认通过，并执行 diff 检查点。

### 任务 3：同日幂等与 force/rerun 留痕

**Files:**
- Modify: `backend/dsh-trading-core/adapter/shadow_tasks.py`
- Modify: `backend/dsh-trading-core/adapter/shadow.py`
- Modify: `backend/dsh-trading-core/adapter/analyzer.py`
- Test: `backend/dsh-trading-core/tests/test_shadow_tasks.py`

**Interfaces:**
- Produces: `scope_key`、`find_latest_for_scope`；`prepare_task` 返回 `should_dispatch`。
- Consumes: `TaskManager.start` 对不调度的持久任务进行内存只读投影。

- [ ] 编写非 force 返回同一 task_id 且只执行一次、force 生成新 id/`rerun_of_task_id` 且旧结果仍可查询的失败测试。
- [ ] 运行定向测试确认当前日期快照幂等和覆盖语义不满足要求。
- [ ] 用集合锁实现任务级幂等；最小扩展 TaskManager 处理 `should_dispatch=false`。
- [ ] 重跑测试确认通过，并执行 diff 检查点。

### 任务 4：报告/净值引用与历史 API

**Files:**
- Modify: `backend/dsh-trading-core/adapter/shadow_tasks.py`
- Modify: `backend/dsh-trading-core/adapter/shadow.py`
- Modify: `backend/dsh-trading-core/adapter/app.py`
- Modify: `backend/dsh-trading-core/adapter/task_report_render.py`
- Test: `backend/dsh-trading-core/tests/test_shadow_tasks.py`
- Test: `backend/dsh-trading-core/tests/test_shadow_equity_route.py`

**Interfaces:**
- Produces: `attach_report`、任务详情 API、账本历史与 legacy 投影。
- Consumes: `ReportStore` 以 task_id 生成的统一报告。

- [ ] 编写报告回填、净值引用、按策略过滤任务历史、旧快照 legacy 降级的失败测试。
- [ ] 运行定向测试确认旧 history 展平合同失败。
- [ ] 接入 `attach_report`、详情/历史/状态 API，并保留明确 legacy 兼容。
- [ ] 重跑定向测试确认通过，并执行 diff 检查点。

### 任务 5：阶段验证与 Linear 记录

**Files:**
- Test: `backend/dsh-trading-core/tests/test_shadow_tasks.py`
- Test: `backend/dsh-trading-core/tests/test_shadow_business_rules.py`
- Test: `backend/dsh-trading-core/tests/test_shadow_equity_route.py`

**Interfaces:**
- Consumes: 本计划全部公开合同。
- Produces: PAB-7 后端阶段验证证据。

- [ ] 运行 shadow/task/report 定向测试。
- [ ] 运行 trading-core `unittest discover`；环境性 langgraph 失败单独归因。
- [ ] 使用同一隔离状态目录启停两次服务，验证 completed/failed/interrupted 与报告/净值引用。
- [ ] 运行 `git diff --check`、确认暂存区为空，并把证据更新到 Linear PAB-7，状态保持 In Progress。
