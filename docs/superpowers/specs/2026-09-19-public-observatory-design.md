# 公开观察室设计

关联工作项：[PAB-30](https://linear.app/pabiprg/issue/PAB-30/建立免登录公开观察室与只读投研投影)。本设计以已确认的离线交互稿为体验基线，页面域名为 `https://pair-observe.xiexin.dev`，页面免登录且只读。

## 目标与边界

公开观察室让访客按日期查看真实账户的总权益、现金、持仓市值、累计盈亏、持仓和投研活动。公开页面不提供登录、交易、持仓编辑、任务创建、数据同步或重新计算入口，也不把影子账户、仅持仓市值的历史表现或演示数据解释为真实账户权益。

官网 `https://pair-demo.xiexin.dev` 与公开观察室保持两个 Vercel Project。新页面位于 `frontend/apps/public-observatory`，Vercel Root Directory 指向该目录并启用 workspace 外部源码访问；官网最多增加一个跳转入口，不承载观察室资源、构建或运行时配置。

## 体验契约

| 项目 | 约定 |
|---|---|
| 目标用户 | 无账号但需要了解账户公开表现的访客 |
| 主任务 | 选择一个日期，核对该日账户概览、持仓、活动和相邻历史 |
| 首要信息 | 数据日期、总权益、累计盈亏、收益率、现金、持仓市值和数据新鲜度 |
| 主要操作 | 前后切日、回到今天、选择日期或月份、播放历史、筛选活动、展开持仓与运行详情 |
| 成功结果 | 所有卡片来自同一 `snapshot_id` 与 `data_revision`，访客能识别缺失、陈旧和不可用数据 |
| 支持视口 | 1440、1024、768、390 像素；浅色、深色、键盘与减少动态模式 |

页面采用交互稿的单页信息架构：顶部时间切片条、账户概览、权益轨迹、持仓、活动和月度盈亏日历。今天默认每 15 秒刷新；历史日期暂停自动刷新。曲线使用 ECharts 的折线、Tooltip、dataZoom 和键盘点选，不使用 K 线或蜡烛图。日期与月份选择使用共享 UI primitives，不使用浏览器原生日期输入充当最终组件。

## 能力审计与决策

| 能力 | 现有所有者 | 决策 |
|---|---|---|
| Host、Origin、代理信任 | `@deepseek-ai/dsh-host-webserver` | 扩展一个只允许精确公开 Origin 和 GET/HEAD/OPTIONS 的公开读取判断，不修改受保护请求判断 |
| Python 后端生命周期 | `InvestmentPythonRuntime.getRunningBackend()` | 仅借用已有业务 owner 的健康地址，不启动、不保活、不停止后端；浏览器不得选择后端地址或路径 |
| 持仓与成交 | trading-core 的 `holdings` 文档 | 在同一所有者内增加账户权益快照，不建立公开专用账本 |
| 持仓历史表现 | `portfolio_performance.py` | 只复用历史持仓和行情能力，不把缺少现金的结果映射为账户权益 |
| Modal、Button、主题 | client UI primitives 与主题令牌 | 复用并增加 DatePicker、MonthPicker 公共导出 |
| 权益曲线 | `PortfolioPerformanceChart` 的 ECharts 使用方式 | 复用交互和无障碍模式，数据契约改为完整账户权益 |
| 官网 | `frontend/official-site` | 保持独立，只允许添加跳转入口 |
| 公开页面 | 无 | 在 `frontend/apps/public-observatory` 新建独立 Vite 应用 |
| 公开 API | 无 | 新建 Host 公开读取插件和 trading-core 固定 DTO |

## 部署与请求路径

```text
浏览器
  │ https://pair-observe.xiexin.dev
  ▼
Vercel: frontend/apps/public-observatory
  │ 只请求构建时配置的 PUBLIC_API_BASE_URL
  ▼
云端 Web Host: /api/public/performance/v1/*
  │ 精确 Origin、方法、Host、速率与参数校验
  ▼
InvestmentPythonRuntime → trading-core
  │ 固定内部只读路径
  ▼
holdings/account 快照、成交与报告存储
```

Vercel 只托管静态前端，不保存账户数据、不持有后台凭据、不实现账户投影。浏览器使用构建变量 `VITE_PUBLIC_API_BASE_URL` 指向现有云端 Host。云端 Host 的公开插件显式配置 `allowedOrigins`，生产值只包含 `https://pair-observe.xiexin.dev`；预览域名不自动获得生产数据权限。

## 账户权益快照

账户权益快照属于 trading-core 的 holdings/account 所有者，与当前持仓共享原子文档边界。每条快照包含：

- `snapshot_id`：由规范化业务内容生成的稳定标识；
- `data_revision`：严格递增整数；
- `effective_at` 与 `trade_date`：带时区时间和 Asia/Shanghai 交易日期；
- `source`：受控枚举，区分人工账户校准、券商资产同步和系统日终记录；
- `initial_capital`、`cash`、`market_value`、`total_equity`：定点十进制字符串；
- `holdings_snapshot_id`：与该账户快照一致的完整持仓版本；
- `positions`：公开持仓所需事实的不可变副本；
- `freshness`：行情时间、记录时间和陈旧原因。

写入时验证 `cash + market_value = total_equity`，允许最小货币舍入误差；`initial_capital` 必须大于零，金额不得为 NaN 或无穷。普通公开读取不能创建首条快照、补价格、迁移旧持仓或触发券商同步。没有权威账户快照时返回 `availability=unavailable`，页面展示未配置状态。

账户校准和快照采集属于已登录管理能力：人工云端账户必须显式提供初始资金和现金；支持资产查询的券商提供方可以在既有授权同步流程中写入资产事实。后续手工成交只能在存在账户基线时按成交金额与费用更新现金，无法证明完整性的历史导入不得自动升级为精确账户权益。

## 公开 API

公开前缀固定为 `/api/public/performance/v1`，只注册以下 GET/HEAD 路由；OPTIONS 只用于精确 CORS 预检，其他方法返回 405：

- `/overview?date=YYYY-MM-DD`
- `/calendar?month=YYYY-MM`
- `/equity?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `/holdings?snapshot_id=...`
- `/activities?as_of=...&category=...&status=...&cursor=...&limit=...`
- `/activities/{public_id}`

DTO 采用字段白名单，金额为定点十进制字符串，收益率为小数，缺失值为 `null`。`snapshot_id` 和 `data_revision` 贯穿同一页面切片；指定日期没有快照时返回 404，不回退到最近日期。活动使用不透明游标，详情只接受服务端生成的 `public_id`。响应返回 ETag、`Cache-Control: no-store` 和 `Vary: Origin`，错误体只包含稳定代码与用户可读信息。

公开投影不得包含账户标识、KYC、凭据、主机路径、原始导入、Prompt、会话、内部任务参数、堆栈或私有链接。部署端以内容 ID 白名单逐份批准快照，默认无数据；不从历史记录推断许可，不自动发布新增快照。所有投影重新规范化并核对批准内容的哈希，交易日期由已验证时间派生。活动仅显示批准快照的固定摘要，原始成交和研究正文暂不公开；异常新鲜度原因转换为固定文案。

## 安全与失败处理

公开读取拥有独立信任函数，不调用 Web Auth，也不放宽 `/api`、`/plugins`、`/auth` 或 SPA fallback。请求必须同时满足：Host 属于部署信任表；Origin 缺失时仅允许非浏览器 GET/HEAD，存在时必须精确匹配 `allowedOrigins`；云端 Origin 使用 HTTPS；方法和路由在白名单内；查询参数、长度与速率通过校验。

Host 取得已有运行中后端的非持有地址后只拼接代码内固定路径，客户端输入只能进入逐字段编码的查询参数。后端超时或不可用返回 503；限流返回 429；非法输入返回 422；日期无快照返回 404。部分活动读取失败保留已加载内容并标记 partial，概览与持仓不跨 revision 拼接。撤销全部快照后显示未配置并清空页面旧切片；已被访客下载的公开内容不能追溯删除。发布、写入鉴权及资源限额以 [Host 公开网关说明](../../../frontend/packages/host/public-observatory/README.md) 为准。

## 状态矩阵

| 状态 | 页面行为 |
|---|---|
| 首次加载 | 保留稳定布局并显示骨架，控件具有可访问名称 |
| 后台刷新 | 保留上次成功内容，显示更新时间和更新中状态 |
| 未配置 | 说明尚无权威账户快照，不展示推算数字 |
| 空持仓 | 账户概览继续可用，持仓区显示真实空态 |
| 筛选无结果 | 保留筛选条件和清除入口，不替换为全局空态 |
| 部分成功 | 展示已加载活动并标记未完成部分，允许重试 |
| 陈旧 | 保留数据，明确行情时间、记录时间和陈旧原因 |
| 可恢复错误 | 保留旧数据并提供重试；没有旧数据时展示区块错误态 |
| 限流 | 显示稍后重试并遵守 Retry-After，不立即循环请求 |
| 历史日期 | 停止自动刷新，手动刷新保持禁用或解释性状态 |
| 成功 | 所有区块提交同一 revision，屏幕阅读器收到简短更新通知 |

## 验证与回滚

后端聚焦测试覆盖快照原子性、金额恒等式、revision、精确日期、无写副作用、DTO 字段白名单、游标、ETag 和缺失语义。Host 测试覆盖未登录成功、受保护接口仍拒绝、Origin/Host/方法/路由/CORS/限流和 backend 路径固定。前端测试覆盖日期联动、旧请求隔离、自动刷新暂停、筛选、弹层、加载/空/部分/错误/陈旧状态与键盘交互。

真实 UAT 使用独立端口 3198 和隔离状态目录，检查 1440、1024、768、390 像素、浅深主题、键盘、减少动态、长文本、大额负值和无数据状态。生产域名绑定、Vercel Project 创建、环境变量写入和部署必须另行授权。

回滚可以分别移除 Vercel 项目、Host 公开路由和 bundle roster 行；账户快照继续作为私有账户历史保留，不因公开页面回滚而删除。
