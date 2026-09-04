# 影子验证任务账本设计
## 背景与目标

rc.10 要求影子验证以任务为审计单位，保留最近摘要、当前策略历史、全量历史、逐策略结果、报告与净值证据。当前实现只把 `shadow_equity/{trade_date}` 展平为历史，同日重跑会覆盖快照，`TaskManager` 的 transport 状态在重启后丢失。

本设计新增持久化影子任务账本。旧 `shadow_equity` 继续作为按交易日读取的兼容净值视图，不再承担任务历史真相源。

## 能力图

| 用户动作 | 现有入口/接口 | 权威状态与副作用 | 重叠或缺口 | 决策 | 证据 |
|---|---|---|---|---|---|
| 启动单策略或批量影子验证 | `POST /shadow/run`、`TaskManager.start`、`ShadowRunner.run` | 内存 transport task；写持仓、交易、每日净值、报告 | 无持久任务行和范围/来源 | 扩展 | `adapter/analyzer.py`、`adapter/shadow.py` |
| 查询最近运行 | `GET /shadow/status` | `shadows/latest` 覆盖式摘要 | 不能区分失败、部分成功和重跑 | 扩展 | `adapter/app.py` |
| 查询当前策略/全部历史 | `GET /shadow/history` | `shadow_equity` 的日期×策略展平 | 缺 task_id、状态、时间、来源、报告 | 扩展 | `adapter/app.py` |
| 同日幂等与主动重跑 | `ShadowRunner.run(force)` | 非 force 按日期跳过；force 覆盖同日净值 | 无作用域幂等；旧任务不可追溯 | 扩展 | `adapter/shadow.py` |
| 报告归档 | `ReportStore.save_task_result`、runner `attach_report` | `reports/{task_id}` 持久化 | 账本没有报告引用 | 复用 | `adapter/report_store.py`、`adapter/analyzer.py` |
| 重启恢复 | lifespan + `backtest_tasks.recover_tasks` | 回测任务恢复；影子任务无恢复 | pending/running 重启后不可查询 | 组合 | `adapter/app.py`、`adapter/backtest_tasks.py` |
| 原子 JSON 写入 | `JsonStore.mutate`、`mutate_document` | 文件锁、临时文件替换 | 无影子任务集合 | 复用 | `adapter/store.py` |

## 权威对象

### `shadow_tasks/{task_id}`

- `task_id`：32 位小写十六进制任务编号。
- `source`：`manual` 或 `scheduled`。
- `scope`：`single` 或 `batch`。
- `strategy_ids`：本次计划处理的稳定策略编号数组。
- `trade_date`：验证交易日。
- `force`：是否显式强制重跑。
- `rerun_of_task_id`：强制重跑关联的同作用域最近任务；首次运行为空。
- `status`：`pending/running/completed/partial/failed/cancelled/interrupted`。
- `created_at/started_at/completed_at/ended_at`：本地既有格式时间；`ended_at` 与终态时间兼容同值。
- `error`：总任务错误或空。
- `summary`：`total/success/failed/skipped` 计数。
- `result_ids`：逐策略结果键数组。
- `report_ids`：正式报告编号数组。本阶段统一任务报告为一个 task_id，数组保留扩展性。
- `request_params`：可审计的原始请求，不持久化 `_cancel_event`。

### `shadow_task_results/{task_id}:{strategy_id}`

- `task_id/strategy_id`。
- `status`：`success/failed/skipped`。
- `reason`：失败或跳过原因。
- `started_at/completed_at`。
- `report_id`：统一任务报告引用；报告落盘后回填。
- `equity_ref`：`{collection: "shadow_equity", key: trade_date, task_id}`。
- `snapshot`：该次运行不可变的策略净值摘要，确保同日兼容视图更新后仍能审计旧结果。

## 状态与幂等

1. `prepare_task` 在提交 worker 前写 `pending`。
2. worker 原子 claim 为 `running`。
3. 全成功为 `completed`；成功与失败/跳过混合为 `partial`；全失败为 `failed`；全跳过为 `completed`，但 summary 明确 `skipped=total`。
4. 非 force 使用 `trade_date + scope + strategy_ids` 生成幂等键；已有任务时返回原 task 引用且不重复调度。
5. force 始终创建新 task_id，并记录同作用域同交易日最近任务为 `rerun_of_task_id`。
6. 启动恢复把遗留 `pending/running` 置为 `interrupted`，保留已落逐策略结果，不自动重放市场计算。

## 报告与净值证据

`TaskManager` 继续在 runner 返回后生成统一影子报告。`attach_report` 同时回填任务 `report_ids` 与所有逐策略结果的 `report_id`。逐策略 `snapshot` 是不可变证据；`equity_ref` 指向兼容日净值视图并携带 task_id，消费者不得仅凭日期把覆盖后的快照冒充旧任务证据。

## API 投影

- `GET /shadow/status`：最新真实任务摘要；无新账本时兼容旧 `shadows/latest` 并标记 `legacy=true`。
- `GET /shadow/history`：真实任务摘要列表，可按 `strategy_id` 过滤；旧快照只作为 `legacy=true` 降级行，不能伪造 task_id。
- `GET /shadow/tasks/{task_id}`：完整任务及逐策略结果。
- 通用 `/analyze/{task_id}` 与 `/result` 在内存任务不存在时，对 shadow task 提供持久化只读回退。

## 确定性边界

任务编号、来源、范围、时间、状态、幂等键、计数、恢复结果、报告与净值引用全部由确定性代码维护。影子验证与本设计均不调用模型推断；报告正文只呈现确定性运行结果，不成为状态真相源。

## 风险与验证

- 并发幂等必须在 `mutate_document` 单锁中完成。
- TaskManager 对“复用既有任务且不调度”的返回要显式处理，避免再次 claim 已完成任务。
- 取消与完成竞态必须让持久终态优先。
- 用隔离 `DSH_HOME` 启停两次验证 completed/failed/interrupted 可查询；旧快照兼容行必须带 `legacy=true`。
