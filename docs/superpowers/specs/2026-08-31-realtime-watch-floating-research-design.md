# 实时盯盘悬浮研究窗技术设计

> 状态：已实现，验收完成，待合并
> 对应 PRD：[投研产品 0.1.0-rc.9](../../prd/0.1.0-rc.9/README.md)
> 需求编号：`WATCH-011` 至 `WATCH-023`
> 基线：`public/master@3e2b18f5a3a46c696c9af1679613080bea69318c`

## 1. 设计摘要

本设计把实时盯盘的证券研究详情从页面长流中的第二列/底部区块移到由 Shell 管理的固定右侧悬浮研究窗。实时盯盘页面只负责大盘、筛选和扫描列表；悬浮窗负责当前证券的行情摘要、技术信号和资讯。两者通过显式的证券研究意图连接，首次加载不产生证券级请求。

研究窗与现有 AI 研究助理共用右侧表面。一个轻量协调器保存当前研究证券、研究窗展示状态和 AI 返回目标，确保两个表面互斥。研究窗支持 `closed`、`minimized`、`docked`、`expanded` 四个内部状态，其中后三者分别对应产品所说的收起、标准和近全屏。位置固定，不实现拖动或自由缩放。

数据层新增按证券查询的个股资讯操作，并为技术信号引入可识别的 `ready/preparing/unavailable` 生命周期。指数和扫描保持现有主要响应形状，通过可选元数据表达缓存、来源和警告。后端集中证券市场识别、有限数归一化、扫描最近成功缓存和 K 线失败短缓存，避免错误市场请求、非法 JSON、错误的 `422` 和重复冷任务。

## 2. 需求映射

| 需求 | 满足方式 | 状态 |
|---|---|---|
| `WATCH-011` | 删除扫描成功后的自动选择；证券资源只由显式打开或分析动作触发 | 设计满足 |
| `WATCH-012` | 扫描项改为非嵌套交互结构，主体、详情、智能分析分别可操作 | 设计满足 |
| `WATCH-013` | 新增固定 `ResearchFloatingSurface`，支持四状态并覆盖而非重排页面 | 设计满足 |
| `WATCH-014` | `900px` 响应式模态覆盖层、滚动锁定、安全区与位置恢复 | 设计满足 |
| `WATCH-015` | Shell 级 `RightSurfaceCoordinator` 协调研究窗、AI 和返回目标 | 设计满足 |
| `WATCH-016` | 按键资源控制器、独立区域、代次失效和有界 LRU 缓存 | 设计满足 |
| `WATCH-017` | 新增 `market-watch.security-news`；市场快讯保留独立操作和标签 | 设计满足 |
| `WATCH-018` | 技术信号状态合同、K 线单航班、后台完成状态和自动继续 | 设计满足 |
| `WATCH-019` | 响应边界统一清理非有限数；指数按项保留 | 设计满足 |
| `WATCH-020` | 扫描来源能力表、备用源、最近成功缓存和正确 HTTP 分类 | 设计满足 |
| `WATCH-021` | 集中 `sh/sz/bj` 市场解析，再生成各供应商代码 | 设计满足 |
| `WATCH-022` | 响应时间元数据、请求键、选择代次和缓存状态分离 | 设计满足 |
| `WATCH-023` | `complementary/dialog` 语义、焦点圈、`Escape`、触控和减少动态效果 | 设计满足 |

## 3. 现状、证据与约束

### 3.1 前端现状

`OpportunityPage` 当前同时持有扫描、指数、全市场快讯和技术信号资源。扫描成功后会自动把第一行写入 `selected`，随后触发 `market-watch.tech-signal`。详情操作只存在于扫描列表后的 `.detailCard` 中。

样式在宽视口使用两列 `.opportunityGrid`，但 `max-width: 1160px` 时改为单列。浏览器实测 `1042×889` 视口中，榜单第一项与详情区内容位置相距约 1,429 像素。问题来自信息结构和断点组合，不是简单的滚动条故障。

现有 `AssistantFloatingSurface` 已提供 `closed/docked/expanded` 模式、固定右侧定位、遮罩、焦点圈和 `Escape` 处理；实际对话滚动区通过 `body[data-investment-assistant-mode]` 定位。新设计复用其交互原则，但不让研究窗直接操纵对话 DOM。

### 3.2 数据链路现状

- **指数**：`briefs.indices_spot()` 直接执行 `float(price)` 和 `float(pct)`。当前响应边界未清理 `NaN` 或正负无穷；注入非有限值可以复现 Starlette 的 `Out of range float values are not JSON compliant`。
- **扫描**：涨幅、换手和成交额可从东财降级到新浪，量比无等价新浪字段，涨跌停当前只使用东财。外部断连会被 `scanner.scan()` 捕获并统一转换为 `ValueError("行情源暂不可用，请稍后再试")`，路由再错误映射为 `422`，同时丢失来源级诊断。
- **K 线**：`_sina_sym()` 先判断 `("6", "5", "9")`，因此 `920223` 在北交所判断前被映射成 `sh920223`；`_secid()` 也将其映射为沪市。实测错误新浪代码返回 0 根 K 线，正确 `bj920223` 返回有效数据；baostock 明确不支持北交所。
- **技术信号**：K 线冷请求超过 `MW_KLINE_COLD_DEADLINE` 后返回 `504`，虽然唯一后台 flight 仍运行。后台返回空或异常时没有终态短缓存，后续请求可能不断启动新冷任务。
- **资讯**：实时盯盘调用不带证券代码的 `market-watch.news-flash`，切股只刷新技术信号；独立 `security-detail` 才调用 `fetch_stock_news(code)`。当前页面位置会让全市场快讯看起来像个股资讯。

### 3.3 必须保持的边界

- 不删除 `stock-detail` 路由，不改变其他模块现有跳转入口。
- 不开放浏览器传入任意后端 URL；所有请求继续经过固定 `InvestmentDataOperation` 白名单。
- 成功态 `indices`、`scan` 和 `tech-signal` 的现有主要字段保持兼容，只添加可选元数据。
- 不引入新数据库；缓存为进程内、有界、可丢失的运行时缓存。
- 不让多个前端轮询生成多个相同 K 线后台任务。
- 不把外部数据源失败转换为虚假的实时成功。

## 4. 总体架构

```text
InvestmentShell
  ├─ OpportunityPage
  │    ├─ MarketOverview
  │    └─ MarketScanList ── open/analyze intent ─┐
  │                                               │
  ├─ RightSurfaceCoordinator                     │
  │    ├─ ResearchFloatingSurface ◀───────────────┘
  │    │    └─ SecurityResearchContent
  │    │         ├─ QuoteSummary
  │    │         ├─ TechnicalSignalRegion
  │    │         └─ NewsRegion
  │    │              ├─ 个股相关
  │    │              └─ 市场快讯
  │    └─ AssistantFloatingSurface
  │
  └─ requestData 固定操作
       └─ market-watch
            ├─ 指数有限数边界
            ├─ 扫描来源/缓存
            ├─ K 线状态与市场映射
            └─ 个股资讯
```

### 4.1 前端责任拆分

#### `OpportunityPage`

保留扫描类型、指数、扫描列表和当前选中高亮。删除常驻详情区和全市场快讯的首屏请求。组件通过回调发出 `openResearch(subject)` 或 `analyzeStock(subject)`，不自行拥有悬浮窗和 AI 状态。

#### `RightSurfaceCoordinator`

由 `InvestmentShell` 持有的轻量状态协调器，不新增跨进程持久化。它负责：

- 保存当前 `ResearchSubject` 和研究窗模式；
- 在 AI 打开时暂停研究窗显示；
- 保存从研究窗或扫描项进入 AI 的返回目标；
- 处理“返回证券详情”和 AI 直接关闭后的最小化恢复入口；
- 保证研究窗和 AI 展开表面不会同时渲染。

协调状态放在 Shell 生命周期内，避免把实时盯盘的临时展示细节扩散到 Host 路由协议。`selectedStockCode` 继续承担跨路由证券上下文；悬浮窗模式不写入持久化快照。

#### `ResearchFloatingSurface`

建议新建独立组件文件，负责外壳、头部、模式按钮、焦点和响应式语义。它不直接请求业务数据。桌面标准状态为 `role="complementary"`；近全屏或移动覆盖状态为 `role="dialog"`、`aria-modal="true"`。

#### `SecurityResearchContent`

接收不可变 `ResearchSubject`，并分别管理技术信号、个股资讯和市场快讯。扫描项携带的行情摘要立即显示；证券名称缺失时复用现有 `useSecurityNames`。市场快讯只在用户首次打开该标签时加载，之后在有效缓存期内复用。

#### 按键资源控制器

现有 `useRequestResource` 只保留最后一个请求键的值。新增一个面向证券研究的有界按键资源控制器，提供：

- 请求键序列化和同键 single-flight；
- 最新选择代次校验；
- 每种资源最多 20 个证券键的 LRU 缓存；
- 缓存先展示、后台刷新；
- 组件卸载、切股和关闭时清理定时器；
- 只把与当前请求键一致的值提交到当前视图。

扫描和指数可以继续使用现有资源控制器，避免无关重构。

### 4.2 后端责任拆分

- `quotes`：统一证券市场事实、供应商代码、K 线 single-flight 和终态缓存。
- `scanner`：声明每类扫描的来源能力，管理实时回退和最近成功缓存。
- `briefs` 或共享归一化模块：在指数进入响应前处理非有限数并保留有效项。
- `news`：提供结构化个股资讯结果，区分成功空列表与来源失败。
- `app`：只做输入校验、状态到 HTTP/JSON 的稳定映射，不把上游异常伪装为参数错误。

## 5. 对象与状态设计

### 5.1 研究对象

```ts
interface ResearchSubject {
  readonly code: string
  readonly name?: string
  readonly quote?: {
    readonly price?: number
    readonly pctChange?: number
    readonly volumeRatio?: number
    readonly amountYi?: number
  }
}

type ResearchSurfaceMode = 'closed' | 'minimized' | 'docked' | 'expanded'

interface ResearchSurfaceState {
  readonly subject?: ResearchSubject
  readonly mode: ResearchSurfaceMode
  readonly suspendedByAssistant: boolean
}

interface ResearchReturnTarget {
  readonly subject: ResearchSubject
  readonly restoreMode: 'minimized' | 'docked'
}
```

`ResearchSubject.code` 是缓存和一致性的事实键；名称和行情只是可替换的展示快照。切股先切换事实键，再显示与新键一致的数据。

### 5.2 右侧表面转换

| 事件 | 原状态 | 新状态 |
|---|---|---|
| 打开证券详情 | 任意非 AI 状态 | 对应证券 `docked` |
| 切换证券 | `minimized/docked/expanded` | 模式不变，替换证券键 |
| 最小化 | `docked/expanded` | `minimized` |
| 放大 | `docked` | `expanded` |
| 退出放大 | `expanded` | `docked` |
| 关闭研究 | 任意研究状态 | `closed` |
| 带入智能分析 | 任意研究状态 | 保存返回目标，研究暂停，AI `docked` |
| 从 AI 返回详情 | AI 打开且有返回目标 | AI `closed`，研究 `docked` |
| 直接关闭 AI | AI 打开且有返回目标 | AI `closed`，研究 `minimized` |

移动端的标准状态仍使用 `docked` 事实状态，只由媒体条件派生模态覆盖展示，不额外复制状态机。

### 5.3 数据区域状态

```ts
type ResearchResourcePhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'refreshing'
  | 'stale'
  | 'unavailable'
```

`stale` 必须携带旧值和原始 `as_of`；`unavailable` 只能在没有合格旧值时成为红色错误。技术信号后端返回 `preparing` 时，前端使用 `retry_after_ms` 自动继续，直到 `ready`、`unavailable`、切股或关闭。

## 6. 接口与合同

### 6.1 指数 `market-watch.indices`

请求不变。响应保留 `as_of` 和 `items`，增加可选状态字段：

```json
{
  "as_of": "2026-08-31 15:14:26",
  "items": [
    {
      "name": "上证指数",
      "code": "sh000001",
      "price": 3210.12,
      "pct_change": 0.8,
      "as_of": "2026-08-31 15:14:26",
      "stale": false
    }
  ],
  "stale": false,
  "warnings": []
}
```

所有数字在加入响应前通过有限数归一化；无效字段变为 `null`。有效指数不得因另一项异常被删除。顶层 `as_of` 表示本次响应组装时间；每个指数项保留自己的数据时间和 stale 标识。若只有部分指数使用最近成功值，顶层 `stale=true`，对应项的 `as_of` 保持旧事实时间，其他项仍保留本轮时间。

### 6.2 扫描 `market-watch.scan`

请求和主要结果字段不变，增加可选的 `source`、`stale`、`complete` 和 `warnings`：

```json
{
  "kind": "gainers",
  "trade_date": "2026-08-31",
  "as_of": "2026-08-31T15:14:26+08:00",
  "source": "sina",
  "stale": false,
  "complete": true,
  "warnings": ["主行情源不可用，已使用备用源"],
  "items": []
}
```

非法 `kind` 或数值范围继续返回 `422`。上游失败且没有缓存返回 `503`；存在合格缓存时返回 `200`、`stale=true` 和旧 `as_of`。备用源缺少量比等字段时使用 `null`，不伪造数值。

### 6.3 技术信号 `market-watch.tech-signal`

请求体保持 `{code, lookback}`。成功数据保留现有顶层字段并新增 `status`、`stale`：

```json
{
  "status": "ready",
  "code": "920223",
  "name": "荣亿精密",
  "as_of": "2026-08-31 15:14:26",
  "stale": false,
  "bars": 120,
  "last": {},
  "indicators": {},
  "signals": []
}
```

后台仍在运行时返回 HTTP `202`：

```json
{
  "status": "preparing",
  "code": "920223",
  "as_of": "2026-08-31 15:14:26",
  "retry_after_ms": 1500,
  "message": "技术信号正在准备"
}
```

后台已终止且没有数据时返回 HTTP `200` 的领域终态，避免固定运行时把安全状态正文丢失为不透明异常：

```json
{
  "status": "unavailable",
  "code": "920223",
  "as_of": "2026-08-31 15:14:31",
  "reason_code": "source_unavailable",
  "message": "当前数据源未能提供 K 线",
  "retryable": true
}
```

输入错误仍返回 `422`，服务自身不可恢复错误仍返回 `5xx`。DSH 插件渲染器和 Web UI 都必须识别三种领域状态；`ready` 的既有字段保证成功态兼容。

### 6.4 新增个股资讯 `market-watch.security-news`

运行时新增固定操作，映射到 `GET /news/stock?code=<code>&limit=<5..20>`，浏览器不能提供 origin 或路径。

```json
{
  "status": "ready",
  "code": "920223",
  "as_of": "2026-08-31 15:14:26",
  "stale": false,
  "complete": true,
  "items": [
    {
      "title": "公司发布经营数据",
      "source": "东财",
      "time": "2026-08-31 10:00:00",
      "url": "https://example.invalid/article"
    }
  ]
}
```

空列表是合法成功，来源失败是 `unavailable` 或带缓存的 `stale`，二者不能继续由空列表混淆。外部链接仍经过现有 `safeExternalNewsUrl` 白名单显示。

### 6.5 独立证券详情兼容

`market-watch.security-detail` 保留。内部改用相同市场识别和资讯服务；技术信号处于 `preparing/unavailable` 时通过 `warnings` 和空技术区降级，不再阻止行情及个股资讯返回。现有成功响应字段不删除。

## 7. 后端详细设计

### 7.1 统一市场识别

引入单一市场解析结果 `sh | sz | bj`，判断顺序固定为：北交所 `4/8/92` → 沪市 `6/5/9` → 深市 `0/1/2/3`。所有供应商映射从该结果生成：

- 新浪：`sh<code>`、`sz<code>`、`bj<code>`；
- 东财：使用对应市场的 `secid`，北交所不得复用沪市前缀；
- baostock：只接受 `sh/sz`，遇到 `bj` 直接声明该来源不支持并进入下一来源。

`_sina_sym`、`_secid`、`_bs_code` 和搜索市场标签不再各自重复排序不同的前缀规则。

### 7.2 K 线状态和失败缓存

保留当前线程池、准入信号量、按 `(code, lookback)` single-flight、fresh cache 和 stale cache。将内部返回升级为带状态的结果：

- fresh 或 stale 数据：`ready`，stale 时继续后台刷新；
- flight 未在前台预算内完成：`preparing`，不抛产品错误；
- flight 成功但无数据或所有来源失败：记录短时失败状态并返回 `unavailable`；
- 失败短缓存默认 30 秒，可配置且容量有界，避免每次轮询重走完整来源链。

后台 future 完成回调必须同时写入成功缓存或失败状态，并释放 single-flight。前端轮询只读取同一后台结果，不增加 worker 数。

### 7.3 扫描来源与缓存

为五种扫描建立明确能力：

| 类型 | 主源 | 备用源 | 备用源限制 |
|---|---|---|---|
| 涨幅榜 | 东财 | 新浪 | 无量比 |
| 量比异动 | 东财 | 无等价源 | 只能使用合格缓存或准确失败 |
| 涨跌停 | 东财 | 新浪涨跌幅双向列表后按规则筛选 | 数据范围可能不完整，标记 `complete=false` |
| 换手异动 | 东财 | 新浪 | 字段可用 |
| 成交额榜 | 东财 | 新浪 | 字段可用 |

最近成功缓存按完整扫描请求键保存，默认 fresh 15 秒、stale 300 秒，均可配置。使用缓存不得修改其 `as_of`。外部请求使用统一会话和明确的环境代理策略；默认行为与当前“直连”意图一致，不依赖 `proxies={}` 的隐式合并语义。

所有来源失败日志记录 `kind`、来源、异常类别、耗时和是否命中缓存。路由只把非法输入转换为 `422`，源失败转换为 `503`。

### 7.4 指数有限数边界

新增共享 `finite_number` 归一化函数，使用 `math.isfinite` 或等价判断，把 `NaN/Inf/-Inf` 转换为 `None`。指数逐行处理，单行字段问题不退出整个循环。进程内按指数代码保存最近一次完整有效项及其事实时间，默认只允许在 300 秒陈旧窗口内补位；没有合格缓存时保留该指数并把异常字段设为 `None`。后端测试直接构造包含非有限数的 DataFrame，并通过 HTTP 客户端验证合法 JSON，而不只测试内部列表。

### 7.5 个股资讯结果

重构 `fetch_stock_news` 的内部实现，使其能区分：成功且有结果、成功但没有相关新闻、来源失败。对外兼容调用可以继续获得列表，新端点使用结构化结果和按证券的短缓存。不得在失败时自动返回全市场快讯。

## 8. 前端交互设计

### 8.1 首次进入与扫描项

首次只运行 `market-watch.indices` 和当前 `market-watch.scan`。扫描项使用 `<article>` 或等价非交互容器，内部提供独立的主体详情按钮、文本“详情”和“智能分析”按钮，避免按钮嵌套。当前证券通过视觉边框和 `aria-current` 或等价状态表达。

### 8.2 悬浮窗尺寸

- 桌面标准：`top: 68px`、`right: 24px`、`bottom: 24px`，宽度使用约 `clamp(420px, 42vw, 620px)`；
- 桌面近全屏：四边 `16px`，带遮罩；
- 不大于 `900px` 的标准状态：安全区内约 `8px` 边距的模态覆盖层；
- 移动放大状态：使用完整安全视口；
- 最小化：右侧紧凑入口，展示证券名称或代码，不与 AI 启动按钮重叠。

具体像素可在实现时随现有设计令牌微调，但不能改变“不重排主页面、固定右侧、不可拖动”的产品约束。

### 8.3 滚动与焦点

标准桌面悬浮窗自身滚动，主页面仍可滚动。近全屏和移动覆盖层对主工作台设置 `inert` 与 `aria-hidden`，锁定背景滚动并记录触发元素与 `.pageScroll.scrollTop`。退出后先恢复滚动位置，再在下一动画帧恢复焦点。

`Escape` 处理顺序：展开 → 标准；标准 → 关闭；最小化不拦截全局 `Escape`。历史抽屉、报告抽屉或其他更高层模态打开时，由最上层表面处理按键。

### 8.4 技术信号自动继续

收到 `preparing` 后，根据服务端 `retry_after_ms` 安排下一次同键请求，并把间隔限制在 1 至 5 秒。只要当前证券和研究窗仍有效，就继续到 `ready` 或 `unavailable`；切股、关闭或卸载立即清理计时器。传输错误可以有限自动重试，领域终态不可无限重试。

有 stale 数据时技术内容保持可见，标题旁显示“缓存 · <原始时间>”；后台刷新失败只降级标签。没有旧数据时显示中性骨架和“技术信号准备中”。

### 8.5 资讯标签

默认标签“个股相关”立即按当前代码加载。切股后旧证券资讯从当前视图移除，新证券使用同键缓存或进入加载。第二标签“市场快讯”首次打开时加载 `market-watch.news-flash`，并展示“不特指当前证券”。其缓存不进入证券键，也不随切股刷新。

## 9. 异步、恢复与一致性

```text
用户打开证券 A
  → 研究窗立即显示 A 的扫描摘要
  → 并行请求 A 技术信号 + A 个股资讯
  → 技术信号 preparing：复用后端 flight，按建议继续

用户在 A 完成前切换证券 B
  → 当前事实键立即变为 B
  → A 的前端计时器取消
  → A 的晚到结果只允许写入 A 缓存
  → B 区域独立加载

用户再次回到 A
  → 有 A 缓存则立即展示并按需要刷新
  → A flight 尚未完成则复用，不重复启动
```

浏览器缓存只用于本次 Shell 生命周期，不写入本地存储。后端缓存可跨页面请求但不跨进程承诺持久化。两层缓存都必须以服务端事实时间为准。

## 10. 安全、隐私与日志

- 新操作继续通过运行时固定白名单，只接受六位数字证券代码和有界 `limit/lookback`。
- 外部资讯 URL 只允许无凭据的 HTTP(S)，沿用现有安全链接函数。
- 日志不得记录代理凭据、完整响应正文、用户对话或自由文本；只记录来源、证券代码、请求类型和错误类别。
- 悬浮窗不新增交易、委托或高影响动作。
- AI 助理只接收既有结构化证券意图，不把资讯正文或隐藏缓存自动写入提示词。

## 11. 迁移、兼容与回滚

本版本没有持久化模式迁移。新增状态为 Shell 内存状态，关闭应用即清空。新增响应字段均为附加字段；成功态原字段保留。新增 `market-watch.security-news` 是固定操作，不影响现有 `news-flash`。

需要同步更新以下消费者：Web UI、投资运行时操作联合类型与规格、market-watch DSH 插件技术信号渲染、相关测试和接口文档。旧 `stock-detail` 路由保留，回滚悬浮窗时仍可恢复原有导航路径；后端有限数和市场映射修复不依赖悬浮窗，可独立保留。

## 12. 测试设计

| 层级 | 覆盖需求 | 关键场景 |
|---|---|---|
| Python 单元 | `WATCH-019` 至 `WATCH-021` | 非有限数、来源能力、扫描缓存、`920223` 映射、K 线失败短缓存 |
| Python API 合同 | `WATCH-017` 至 `WATCH-022` | 指数合法 JSON、扫描 `422/503/stale`、技术三状态、个股资讯代码 |
| 运行时 TypeScript | `WATCH-017`、`WATCH-018` | 新固定操作校验、GET 参数、`202` JSON、租约释放 |
| 资源控制器 | `WATCH-016`、`WATCH-018`、`WATCH-022` | 同键 single-flight、LRU、A→B、A→B→A、轮询取消 |
| React 组件 | `WATCH-011` 至 `WATCH-018`、`WATCH-023` | 初始零证券请求、动作结构、四状态、标签、局部错误、缓存 |
| Shell 集成 | `WATCH-013` 至 `WATCH-015`、`WATCH-023` | AI 互斥、返回目标、直接关闭、焦点恢复、既有助手回归 |
| 浏览器 GUI | `WATCH-012` 至 `WATCH-015`、`WATCH-023` | `1440×900`、`1042×889`、`390×844`、深浅主题、滚动和触控 |
| 真实 profile 烟测 | 全部 P0 | 三后端启动、扫描、`920223`、个股/市场资讯语义和故障注入 |

实现采用测试驱动顺序：先为当前错误行为添加失败测试，再修改最小责任单元；每项根因修复单独验证，避免把数据源、状态合同和布局变化混成一个不可定位的测试结果。

## 13. 取舍与替代方案

### 采用：固定右侧悬浮研究窗

该方案在当前窄桌面和移动端都能保持详情可达性，同时保留扫描列表上下文。它可复用既有 AI 右侧表面原则，并允许独立滚动和近全屏阅读。

### 未采用：继续单栏堆叠

改动最小，但无法消除榜单首项与详情之间的长滚动，也不能解决详情操作不可见的问题。

### 未采用：固定分栏或 sticky 详情

宽桌面有效，但在 `1042px` 及移动端会持续压缩榜单和详情；为了兼容窄屏仍需第二套覆盖层逻辑。

### 未采用：可拖动浮窗

增加拖动边界、遮挡、触控、位置持久化和可访问性成本，对当前“快速查看与分析”任务没有必要价值。用户已明确要求不拖动。

### 未采用：研究窗和 AI 同时并排

当前视口无法稳定容纳两个右侧表面，也会形成焦点和对话滚动区冲突。用户已确认二者共用区域并互斥。

## 14. 风险与关闭条件

| 风险 | 严重度 | 处理与关闭条件 |
|---|---|---|
| AI 对话区使用全局 body 定位，可能与新表面 z-index 或滚动锁冲突 | 高 | Shell 集成测试证明互斥、焦点、历史/报告抽屉和三个视口均正常 |
| 外部行情源不稳定导致真实网络烟测波动 | 高 | 单元与合同测试使用确定性故障注入；真实烟测只验证合同和可诊断降级，不把外部成功作为唯一门禁 |
| 北交所供应商覆盖不同 | 高 | 每个供应商映射独立测试；不支持源明确跳过；`920223` 支持源集成测试通过 |
| 技术状态合同影响 DSH 插件消费者 | 中 | 成功态保留字段，插件增加三状态测试，运行时验证 `202` 正文透传 |
| `InvestmentShell.tsx` 已较大，继续内联会提高回归风险 | 中 | 只抽出研究悬浮窗和按键资源控制器，不做无关页面重构；组件测试覆盖边界 |
| 缓存状态被误认为实时 | 中 | 所有 stale 合同保留原始 `as_of`，产品和组件测试检查缓存标签 |

当前没有未决产品问题。用户已于 2026-08-31 确认本文档；后续以本设计和配套实施计划作为编码与验收基线。
