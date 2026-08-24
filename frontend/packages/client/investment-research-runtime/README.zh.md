# @deepseek-ai/dsh-client-investment-research-runtime

[English](README.md) | 中文

此浏览器插件拥有投研 Python 运行时就绪状态的 Client 投影。它挂载生成的 `@deepseek-ai/dsh-investment-python-runtime/remote` contribution，并仅在所有生成方法就绪后发布 `ctx.investmentResearchRuntimeClient`。投研运行时组合包把此 Client 配置项紧接在 Host Runtime 配置项之后；普通 Web 组合包不启用它。

发布的 facade 已冻结且只包含四项操作：

- `getSnapshot()` 返回缓存且对 Client 安全的 `InvestmentReadinessSnapshot`。就绪事实相等时，其引用保持稳定。
- `subscribe(listener)` 注册快照监听器。首批并发订阅者共享一次初始读取。
- `refresh()` 显式读取就绪状态。当前 flight 遇到 Remote 或传输失败时会拒绝；被新刷新取代或在 dispose（资源释放）期间退役的 flight 会直接结算，不发布状态，也不报告陈旧失败。
- `requestRestart()` 转发生成的重启请求，并返回 Host 的 `accepted` 或 `unavailable` 结果。此包本身不调用 Electron，也不重启进程。

facade 在 `credentials/updated('DEEPSEEK_API_KEY')` 与 `connection/reset` 后刷新。其他凭据引用不会触发读取。响应变化时，它替换缓存快照并通过同一真源通知订阅者；响应相等时保留快照引用。初始读取和事件驱动的当前失败只报告一次，后续订阅、事件或显式刷新可以再次读取。

Remote 只返回就绪 DTO 与重启确认。facade 不暴露凭据值、提供方、Host 服务、生成的 Remote namespace 或生命周期控制器。dispose Client 插件会移除两个失效监听器、清空订阅者、撤回 facade 服务并卸载生成的 Remote contribution；进行中的工作在 dispose 后结算时不会发布。

## 模型体验

### 浏览器就绪状态投影

#### 模型看到的内容

无。`ctx.investmentResearchRuntimeClient` 不贡献模型上下文、工具 schema、提示词或独立模型请求；它只向浏览器消费方投影 Host 就绪状态。

#### Token 影响

模型输入与模型输出 token 均为零。

#### KV Cache 影响

无；快照刷新与重启确认不会改变模型请求或已经可复用的前缀。

## 已知限制与暂缓工作

- **不拥有展示** — 此包只发布数据与操作。独立组合的投研设置插件负责面向用户的就绪状态、修复指引与重启控件。
- **按 Profile 提供** — 只有同时包含投研 Runtime Host 配置项和此 Client 配置项的组合才提供 facade；普通 Web 组合包有意不提供投研就绪服务。
- **无轮询或自动重试** — 就绪变化只通过两个失效信号或显式 `refresh()` 到达。当前后台刷新失败后，缓存会保留最后一次成功快照，直至其他触发器再次读取。
