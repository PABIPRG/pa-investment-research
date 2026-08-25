# Agent Note：持仓分析读取链路的延迟预算与降级

Status: implemented

## 问题

非聊天的持仓分析页面会并发读取 `/holdings`、`/risk/portfolio` 和 `/risk/alerts`。
过去 `/risk/alerts` 会再次完整计算组合风险，并同步等待 market-watch 最长 10 秒；事件扩展还可能冷调用 industry-chain。
因此上游服务慢或不可用时，风险预警会长期阻塞，同时并发的两个风险接口会重复扫描同一份持仓和影子净值。

## 决策

- `/holdings` 保持直接读取本地持仓，不引入远端依赖。
- 组合风险以持仓文件身份、ctime、mtime、尺寸，影子净值文件 revision 和有效画像为键，保存默认 2 秒的进程内短缓存；同 revision 的并发请求使用 single-flight 共享同一结果或同一异常。
- `/risk/alerts` 复用相同的组合风险缓存，不再单独重复计算。
- market-watch 的风险路由 deadline 默认 350 毫秒，可用 `RISK_EVENT_DEADLINE` 配置。成功结果使用既有 60 秒新鲜缓存；失败时最多复用 `EVENT_STALE_TTL`（默认 900 秒）内旧值，没有旧值则 fail-open，并用 `EVENT_FAILURE_BACKOFF` 做短失败退避。
- stale 与失败退避只由风险预警显式启用；策略假设和个性化调用仍只接受 fresh cache 或本次成功的上游响应，失败返回空列表。
- 响应通过顶层 `degraded` 和 `upstreams.market_watch_events` 明确报告上游来源、旧值、失败原因、缓存年龄和 deadline。降级只影响事件源，不删除组合、影子和画像预警。
- 风险路由只消费已有的 industry-chain 影响缓存，不在持仓分析请求内发起冷扩展；事件直接关联标的仍正常命中。

## 备选方案

- 新增组合接口一次返回三块数据：能进一步减少浏览器请求，但会改变前端契约，发布风险更高。
- 只提高 market-watch 服务容量：不能保证故障场景的尾延迟，也不能消除重复组合风险计算。
- 长时间缓存整个 `/risk/alerts`：可能让反馈计数、画像和影子状态过期，因此只缓存昂贵且确定性的组合风险与事件原始值。

## 结果与边界

- 回归测试用 50 毫秒的假慢上游验证完整 `risk_alerts` 在 300 毫秒预算内返回，并保留组合与画像语义。
- barrier 并发测试验证 `/risk/portfolio` 与 `/risk/alerts` 对同 revision 只执行一次组合风险计算；事件刷新也只发起一次上游请求。
- 同批失败等待者接收同一异常，不会在唤醒后串行重复计算；同尺寸原子替换也会立即改变 revision。
- single-flight 和缓存均为进程内能力；多 worker 部署仍会各自计算一次。
- 默认 350 毫秒 deadline 会让冷启动时的慢事件源更早进入 stale/fail-open，这是用事件数据新鲜度换取持仓分析可用性的有意选择。
