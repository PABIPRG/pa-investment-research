# @deepseek-ai/dsh-client-ui-investment-research

`investment-research` Profile 专用的投研工作台 UI。该包保留正式产品壳的会话、消息、输入、附件、工具、审批和工作区能力，只替换侧栏中的业务导航，并通过 `shell.overlay` 增加顶部搜索、业务页面和历史对话抽屉。

当前已接入两个真实数据页面：

- “机会发现”通过 Host 白名单调用 `market-watch` 的市场扫描、技术信号和实时资讯接口。
- “持仓分析”通过 Host 白名单调用 `trading-core` 的持仓、组合风险和风险预警接口。

浏览器不能传入后端地址、端口或任意路径。所有请求都使用稳定的 operation 名称，由 Host 映射到固定接口并管理后端租约。投研框架、项目组合、投研任务和知识库在对应数据模型完成前显示“真实能力接入中”，不生成演示数据。

历史对话抽屉直接使用正式 Session 与 Workspace 服务，支持标题和消息内容搜索、打开、重命名和归档。页面中的“在智能助手中分析”会返回共享会话页并预填输入框，由用户确认后再发送，因此不会绕过现有模型选择、附件、审批或发送策略。

## Model Experience

### Investment workbench

#### What the model sees

模型不会直接看到页面读取的行情、持仓或风险 JSON。只有用户在共享输入框中确认并发送的内容，才会沿用 `ctx.conversation` 的正式上下文组装路径进入模型请求。

#### Token effect

浏览和刷新业务页面不消耗模型 token。“深度分析”按钮只预填一段简短提示词；用户发送后，其 token 影响与普通会话输入相同。

#### KV Cache effect

业务页面本身不创建模型请求，因此不影响 KV Cache。用户发送预填提示词后，缓存行为与同一会话中的其他消息一致。

## Known Limitations and Deferred Work

- 当前页面按后端现有响应做容错展示，没有在浏览器复制后端业务规则。
- Host 返回错误时页面显示可重试的真实错误状态，不回退到交互稿假数据。
- 投研框架、项目组合、投研任务和知识库需要先完成与正式 Workspace、Goal、Workflow、文件和会话产物的统一建模。
