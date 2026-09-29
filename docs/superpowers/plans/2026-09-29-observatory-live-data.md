# 公开观察室现有数据直读实施计划

基准：Codex Worktree `/Users/xiexin/.codex/worktrees/5460/pa-investment-research`，起始 `public/master` 为 `0aa0efeb69523982be84e776dbc4a46ce907d881`。初始为 detached HEAD；本地实现后已创建特性分支 `codex/observatory-live-data`。

## 体验与数据决定

访客在指定日期查看可信的持仓事实、估算历史和已公开活动。当前持仓由 `holdings.default` 与已有行情批量能力组合；金额与逐只持仓使用同一批报价。历史日期只读取已有持仓快照，不把今日持仓回填过去。现金、初始资金及完整总权益在没有可靠来源时为缺失。历史盈亏沿用 `portfolio_performance` 的资金流估算，调仓造成的市值差额不直接计作收益。

| 动作 | 现有能力 | 状态所有者与副作用 | 决定 |
| --- | --- | --- | --- |
| 当前持仓及估值 | `holdings.default`、`market-watch /quotes/batch` | 持仓属 trading-core；行情属 market-watch；读请求不写业务数据 | 组合 |
| 历史曲线与日历 | `holdings.snapshots`、`portfolio_performance`、历史行情缓存 | trading-core；私有路由会执行 `ensure_legacy_seed` | 复用计算，公开路由避开迁移 |
| 操作时间线 | 既有归档分页索引和公开起点 | trading-core；公开 GET 只读 | 复用 |
| 研究活动 | 报告库摘要 | trading-core；原始参数与正文不可公开 | 扩展严格摘要投影 |
| 日期、刷新、筛选 | 观察室 App 与 Host 固定网关 | 前端查询状态；Host 管理许可与限额 | 扩展独立状态 |

## 安全与验证

公开开关、精确来源、方法及查询校验、速率/并发/超时/响应上限保持在 Host。新增数据只经固定路径和字段白名单投影，不转发私有响应的额外字段。操作与研究均受明确公开起点控制；撤销后新请求不可读。公开 GET 不执行迁移、持仓写入、同步或研究任务。先补零完整快照、行情缺失、汇总一致、调仓、撤销、额外字段和刷新竞态用例，再运行聚焦测试、类型检查、构建与本地真实页面验收。

Linear 关联 PAB-30；当前未发现可用 Linear 连接，因此本地记录关联，不声称已更新远端 issue。部署及生产验证均不在本次授权内。
