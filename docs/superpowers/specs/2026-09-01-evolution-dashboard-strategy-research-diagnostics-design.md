# 自进化看板与策略研究诊断分层设计

## 文档状态

本设计取代以下两份规格中关于自进化页面职责、人工预案确认和双入口作用域切换的产品设计：

- `2026-09-01-evolution-scope-switcher-design.md`
- `2026-09-01-strategy-evolution-nested-workflow-design.md`

旧规格继续作为既有实施和验证记录保留。其中已经落地且仍有价值的安全合同继续沿用，包括安全 `strategy_id` 校验、单策略数据隔离、AI 上下文隔离以及非动作预案不能应用；旧规格中的侧栏作用域切换器、全局人工批量确认和策略研究人工应用流程不再作为目标体验。

本设计以 `public/master` 的自动闭环和全局看板逻辑为优先基线，并保留当前工作树中已实现的单策略读取与上下文隔离能力。

## 背景

当前设计同时把侧栏“自进化”和“策略研究 → 第 4 步”定义成可生成预案并人工确认的操作入口。这样会产生两个问题：

- 同一策略存在两个干预入口，用户需要判断应该在全局页面还是策略研究中操作。
- 远端自动闭环已经能够按调度统一完成影子验证、归因、进化应用、候选验证和推送；页面再提供即时人工应用会绕开统一执行节奏。

远端自进化看板还增加了生命周期分组、策略现状、演化链路和最近自动应用记录。这些信息适合承担全局观测职责，但远端页面没有提供从全局异常定位到单策略诊断的完整路径。

本设计重新划分三个平面：

- 自进化看板是全局观测面。
- 策略研究第 4 步是单策略诊断面。
- 自动闭环是统一执行面，也是新产品流程中唯一获得进化写入授权的执行路径。

## 设计原则

### 观测与控制分离

侧栏“自进化”用于回答“系统整体如何运行、哪些策略发生了什么”；策略研究用于回答“这条策略为什么得到当前判定、现在重新计算会得到什么结果”。看板不承载策略写入操作，策略研究也不绕过自动闭环直接应用进化动作。

### 远端自动闭环优先

当 `CLOSED_LOOP_ENABLED=true` 时，系统继续按远端逻辑自动应用升级、降级、退役和变异，并完成衍生候选验证和推送。人工重新评估不会抢占、拆分或提前执行下一轮闭环。

### 同一判定逻辑

页面展示的预计判定和自动闭环实际执行的判定必须来自同一纯判定函数。人工看到的是当前证据下的预测；自动闭环始终用运行时最新证据重新计算，因此最终动作可能与较早的页面结果不同。

### 策略上下文不回退

从看板进入策略研究后，所有单策略状态、归因和 AI 上下文都绑定同一安全 `strategy_id`。目标策略不存在或不可读取时显示明确错误，不使用全局数据填充单策略区域。

## 信息架构

```text
自动闭环（统一执行面）
  ├─ 影子验证
  ├─ 归因与进化判定
  ├─ 自动应用升级、降级、退役和变异
  ├─ 衍生候选验证
  └─ 推送与执行留痕
          ↓
侧栏：自进化（全局观测面）
  ├─ 闭环运行状态
  ├─ 生命周期分组
  ├─ 策略现状与判定
  ├─ 策略演化链路
  └─ 最近自动进化
          ↓ 点击策略、节点或历史动作
策略研究：第 4 步 · 进化诊断（单策略诊断面）
  ├─ 当前策略进化状态
  ├─ 影子归因与判定依据
  ├─ 相关演化链路与历史
  ├─ AI 解释当前策略
  └─ 重新评估当前策略（只读）
          ↓
下一次统一自动闭环使用最新证据重新判定并执行
```

## 自进化看板

### 页面职责

侧栏仍使用“自进化”短名称。页面是全局只读看板，不显示全局/单策略切换器，不生成预案，不显示“确认并应用”，也不调用人工应用接口。

看板展示：

- 闭环是否启用、数据完成度、上次自动应用时间和下一次计划运行时间。
- 生效、候选、变异、观察、退役和拒绝等生命周期分组及计数。
- 各生效策略的当前预计判定、判定依据、影子净值和归因摘要。
- 生效策略及相关母链组成的演化链路。
- 最近自动进化记录、动作类型、目标策略和原因。

`CLOSED_LOOP_ENABLED=false` 时，标题、状态徽标和说明必须明确表示闭环未启用；页面不能继续固定宣称“每日自动运行”或“无需人工确认”。看板仍可读取和展示现有数据与历史。

### 页面操作

看板只提供以下操作：

- 刷新全局状态。
- 让 AI 解释当前全局判定。
- 展开生命周期、策略详情和历史记录。
- 从策略、演化节点或历史动作进入策略研究第 4 步。

看板不得直接调用 `evolution-preview`、`evolution-run` 或任何策略状态写入操作。

## 前端组件边界

全局看板和单策略诊断不再复用一个同时包含读取、预案和应用状态的工作区组件，而是拆分为职责单一的两个容器：

- `EvolutionDashboard`：只接收全局 status/attribution，负责闭环状态、生命周期、策略现状、链路和最近记录。
- `StrategyEvolutionDiagnostics`：接收固定 `strategyId`，负责单策略状态、归因、历史、AI 解释和只读重新评估。

生命周期卡片、策略摘要、演化链路节点和指标展示可以复用无业务写入能力的展示组件。侧栏路由只渲染 `EvolutionDashboard`；`StrategyResearchPage` 第 4 步只渲染 `StrategyEvolutionDiagnostics`。现有 `EvolutionWorkspace` 可以在迁移中被拆分或收缩，但不得继续成为同时支持全局和单策略写入的统一容器。

## 看板到策略研究的导航

以下元素均可导航到策略研究：

- 生命周期分组中的策略。
- “策略现状”列表项。
- 演化链路中的父策略或变异子策略。
- 最近自动进化记录中的目标策略。

导航使用受控内部上下文传递 `strategyId`、目标阶段 `evolution` 和来源 `evolution-dashboard`，不接受任意路径或 URL。策略研究打开后直接选择目标策略并进入第 4 步，不要求用户再次搜索。

策略研究提供“返回自进化看板”。同一前端会话中返回时应尽量恢复看板的生命周期筛选和展开状态；恢复信息只保存在页面导航状态中，不写入账号或服务端。

目标策略不存在时，策略研究保留当前页面框架，显示“策略已不存在或不可读取”，并提供返回看板入口；不得回退到全局进化数据。

## 策略研究第 4 步

### 页面职责

第 4 步由“进化复盘与人工确认”调整为“进化诊断”。它固定绑定当前策略，不显示作用域切换器，也不提供手动升级、降级、退役、恢复、变异或立即应用动作。

页面展示：

- 当前策略的生命周期、层级、自动闭环参与状态和当前预计判定。
- 该策略的有效影子天数、净值、收益、回撤、成交和判定阈值依据。
- 与当前策略相关的母策略、变异子策略和生命周期状态。
- 只包含当前策略相关动作的最近自动进化历史。
- 最近一次页面评估时间以及自动闭环下次统一运行时间。

`status: active` 且未归档的策略可以重新评估。候选、退役、拒绝和归档策略允许查看进化历史与已有证据，但不显示可用的重新评估操作；页面解释该策略当前不参与进化判定。

### 重新评估

“重新评估”是只读刷新，不是进化执行命令。它重新读取当前策略的状态和归因，由服务端纯判定逻辑根据最新证据计算预计结果。

重新评估必须满足：

- status 和 attribution 请求携带同一安全 `strategy_id`。
- 不生成预案令牌，不保存当前预案指针。
- 不调用 `evolution-run`，不改变策略或进化记录。
- 不提前应用下一轮升级、降级、退役或变异。
- 页面展示本次 `as_of`，并提示“下一次自动闭环将使用届时最新证据重新判定”。

自动闭环关闭时仍可重新评估，但页面必须说明结果不会自动应用，直到闭环重新启用并运行。

## 自动闭环与写入权限

远端 `evolve_auto()` 及其调度链路保持优先：

1. 按交易日和配置时间启动闭环。
2. 更新影子验证数据。
3. 使用最新数据生成全局进化判定。
4. 有动作时自动应用。
5. 验证新生成的候选策略。
6. 写入执行记录并推送闭环日报。

`CLOSED_LOOP_ENABLED` 继续控制是否注册自动闭环任务，默认值保持远端行为。页面不能自行改变该配置。

产品 UI 不再暴露人工 apply。已有 `evolution-preview` 和手动 `evolution-run` 合同暂时保留用于兼容旧客户端和回归验证，但不作为新页面流程的一部分，也不得因为本设计继续扩展人工写入能力。后续若要停用兼容接口，应另立迁移设计。

## 后端判定与数据契约

### 共享纯判定函数

`status` 和 `evolve_auto()` 必须复用同一策略判定函数。该函数只根据策略、影子净值、成交、样本外验证结果和配置阈值返回：

- 当前策略行为描述。
- 预计决策类型。
- 判定原因。
- 对应动作列表。

判定函数本身不写库。只有 `evolve_auto()` 在统一闭环上下文中应用返回动作。

### 全局状态

不携带 `strategy_id` 的 status/attribution 保持远端全局语义，并返回看板所需的：

- `closed_loop_enabled`
- `closed_loop_time`
- `last_applied_at`
- `counts`
- `lifecycle`
- `per_strategy`
- `recent_applied`

### 单策略状态

携带 `strategy_id` 时：

- status 的当前判定只描述目标策略。
- attribution 的整体指标和策略列表只使用目标策略有效证据。
- `per_strategy` 只包含目标策略。
- `recent_applied` 只包含与目标策略相关的动作。
- `lifecycle` 只包含目标策略及为解释演化链路所需的父子节点。
- 不因目标策略不是 active 而返回全局数据；候选、退役或拒绝策略返回可用的只读历史和“不参与当前判定”说明。

安全标识继续匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`。非法标识在存储和网络 I/O 前拒绝；不存在的策略返回 `404`。

### 一致性说明

页面重新评估是观察快照，不锁定下一次自动闭环。若自动闭环恰好在读取期间写入，前端在本轮请求结束后重新读取一次状态即可。由于页面没有确认或应用按钮，短暂的最终一致性不会导致错误写入。

## AI 上下文

全局看板发送 `{ kind: 'evolution' }`，用于解释闭环状态、生命周期分布和全局判定。

策略研究发送 `{ kind: 'evolution', strategyId }`。`investment_context` 只读取 evolution status 和 attribution；最近自动应用及相关链路由 scoped status 返回，不再读取旧 preview。两条请求都绑定同一编码后的 `strategy_id`，工具结果继续回显该标识。

AI 只解释证据、阈值、预计判定和历史动作，不能调用 apply、修改策略状态或改变自动闭环配置。非 evolution 领域携带 `strategy_id` 继续在 I/O 前拒绝。

## 状态与异常处理

- 看板状态读取失败时保留最后一次成功快照，显示错误、数据时间和重试入口。
- 单策略重新评估失败时保留上一次成功结果，不混入其他策略或全局数据。
- 闭环关闭时显示未启用状态，重新评估结果标记为只读预测。
- 策略在导航后消失时显示不可读取状态并允许返回看板。
- 候选、退役、拒绝和归档策略显示只读历史，不提供重新评估按钮。
- 自动闭环与页面读取并发时，以后完成的状态刷新为准；页面不维护待确认预案，因此不再需要处理 GET 覆盖 POST 或令牌失效竞态。
- 页面模式、看板筛选和展开状态只保存在当前前端会话，不新增服务端偏好。

## 响应式与可访问性

- 看板在宽屏展示并列状态卡片，在窄容器中按生命周期、策略现状、链路和历史顺序纵向排列。
- 策略行、链路节点和历史动作使用可访问按钮或链接，名称包含策略名称与标识。
- 第 4 步持续显示当前策略名称、状态和返回看板入口。
- `1280px`、`650px`、`500px` 下页面 `scrollWidth === clientWidth`。
- 键盘可以完成看板展开、策略跳转、重新评估和返回。
- `prefers-reduced-motion` 下不使用平滑滚动或位移动效。

## 非目标

- 不在看板或策略研究中增加手动升级、降级、退役、恢复或变异。
- 不允许页面立即应用重新评估结果。
- 不提供动作级审批、部分应用或人工批量确认。
- 不通过页面修改自动闭环开关、运行时间或进化阈值。
- 不修改远端自动闭环的动作规则和候选验证顺序。
- 不在本设计中删除旧 preview/run 兼容接口。
- 不增加多策略人工干预入口。

## 测试要求

### 后端

- `status.per_strategy` 和 `evolve_auto()` 复用同一判定函数并产生一致的预计决策。
- 单策略 status/attribution/recent history 只返回目标策略及必要链路数据。
- 单策略重新读取不修改策略、预案、指针或执行记录。
- 只有启用的调度闭环会调用自动应用路径。
- 闭环关闭时不注册或执行闭环任务。
- 旧 preview/run 的 blocked、empty、pending 和作用域校验兼容测试继续通过。

### 前端

- 自进化看板只请求全局 status/attribution，不请求 preview/run。
- 看板没有作用域切换器、生成预案或确认按钮。
- 生命周期、策略现状、链路和最近动作都能导航到正确策略的第 4 步。
- 第 4 步重新评估只发起携带相同 `strategy_id` 的 status/attribution。
- 重新评估前后没有 evolution-run 或策略写入调用。
- 候选、退役、拒绝和归档策略以只读方式展示。
- 闭环启用和关闭时页面标题、状态和说明文案正确。
- 全局与单策略 AI intent 和上下文保持隔离。
- 返回看板不意外修改其他策略研究状态。

### 浏览器

- 完成“看板 → 策略研究第 4 步 → 重新评估 → 返回看板”的真实旅程。
- 覆盖 active 与至少一种非 active 策略的跳转和只读状态。
- 验证重新评估前后没有策略状态写入。
- 验证闭环关闭时不会误导为正在自动运行。
- 在 `1280px`、`650px`、`500px` 下无横向溢出。
- 控制台无未解释 error/warn。

## 预计实施范围

合并远端自动闭环与看板时，预计涉及：

- `backend/dsh-trading-core/adapter/config.py`
- `backend/dsh-trading-core/adapter/app.py`
- `backend/dsh-trading-core/adapter/evolution.py`
- `backend/dsh-trading-core/adapter/scheduler.py`
- `backend/dsh-trading-core/adapter/schemas.py`
- `backend/dsh-trading-core/tests/test_closed_loop.py`
- `backend/dsh-trading-core/tests/test_config_precedence.py`
- `backend/dsh-trading-core/tests/test_evolution.py`
- `backend/dsh-trading-core/docs/API-接口文档.md`
- `backend/dsh-trading-core/docs/前端接入指南.md`
- `frontend/packages/client/ui-investment-research/src/client/evolution-types.ts`
- `frontend/packages/client/ui-investment-research/src/client/EvolutionDashboard.tsx`
- `frontend/packages/client/ui-investment-research/src/client/EvolutionWorkspace.tsx`
- `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`
- `frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx`
- `frontend/packages/client/ui-investment-research/src/client/StrategyEvolutionDiagnostics.tsx`
- `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- `frontend/packages/client/ui-investment-research/src/client/assistant-intent.ts`
- `frontend/packages/client/ui-investment-research/src/client/index.ts`
- `frontend/packages/client/ui-investment-research/src/client/state.ts`
- `frontend/packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`
- `frontend/packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx`
- `frontend/packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts`
- `frontend/packages/client/ui-investment-research/tests/state.client.spec.ts`
- `frontend/packages/investment-research/python-runtime/src/data.ts`
- `frontend/packages/investment-research/python-runtime/tests/data.spec.ts`
- `frontend/packages/investment-research/stock-analysis/src/client.ts`
- `frontend/packages/investment-research/stock-analysis/src/index.ts`
- `frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`
- `frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- `docs/prd/0.1.0-rc.7/04-验收发布/03-回归测试矩阵.md`
- `docs/prd/0.1.0-rc.7/04-验收发布/04-需求追踪矩阵.md`

远端另外包含回测窗口和行情稳定性更新；这些更新不属于本设计本身，但完整合并 `public/master` 时仍需独立保留和验证。实施前必须重新确认 worktree、分支、继承修改处理方式和允许修改范围。

## 完成标准

- 侧栏自进化成为全局只读看板，不再存在人工预案入口或作用域切换器。
- 看板展示远端闭环状态、生命周期、策略现状、演化链路和最近自动应用。
- 看板中的策略上下文能够进入策略研究对应策略的第 4 步。
- 策略研究第 4 步固定单策略，只提供诊断、AI 解释和只读重新评估。
- 重新评估不写入，所有进化动作继续由统一自动闭环应用。
- 页面预计判定与自动闭环复用同一判定逻辑。
- 闭环关闭时页面不会误导用户认为自动运行仍在执行。
- 全局和单策略数据、导航与 AI 上下文均保持明确隔离。
- 后端、前端、调度、AI、浏览器和既有 KYC 回归完成。
- 合并和实施不覆盖、暂存或清理来源不明的继承修改。
