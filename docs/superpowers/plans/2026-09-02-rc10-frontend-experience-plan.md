# rc.10 前端体验实施计划

> **供执行 Agent 使用：** 必须逐任务使用 `superpowers:executing-plans`，每项功能使用 `superpowers:test-driven-development`，完成声明前使用 `superpowers:verification-before-completion`。

**目标：** 在不修改后端或伪造数据的前提下，交付 rc.10 中可由现有接口支持的研究入口、工作台、实时盯盘、策略、自进化和产业链前端体验。

**架构：** 四个用户链路切片共享无视图依赖的研究模块目录和现有投研状态容器。实时盯盘通过路由感知的右侧表面协调与容器密度状态实现 AI 让位；其他页面继续使用悬浮模式。所有切片保留当前有效数据并把动画状态、可访问状态和焦点恢复作为同一交互状态处理。

**技术栈：** TypeScript、React 18、CSS Modules、Vitest、Testing Library、现有 Cordis 客户端插件与投研运行时请求接口。

**规格：** [rc.10 前端体验设计](../specs/2026-09-02-rc10-frontend-experience-design.md)

## 全局约束

- 只修改 `frontend/` 中投研 UI、对应测试和必需的 Agent Note；不修改 `backend/`。
- 不实现 `STRAT-002`、`BT-*`、`SHADOW-*`、`CHAIN-001`、`IMPACT-001`、`RISK-*` 或 `DEMO-*`。
- 不创建 Mock 任务历史、权重来源、分页能力或风险记录。
- 所有新增或更新 Markdown 文档使用中文；Agent Note 仍遵守仓库要求的英文与中文配对格式。
- 动画以 `160–240ms` 的 `opacity` 和 `transform` 为主；`prefers-reduced-motion: reduce` 取消位移、缩放和平滑滚动。
- 不使用共享端口 `3080`；没有独立端口时只运行不启动常驻服务的测试、类型检查和构建。
- 当前没有 Git 提交授权；每个任务以测试和 diff 检查作为本地检查点，不执行 `git commit`。

---

### 任务 1：统一智能分析提示词模板、我的投研和偏好复盘

**文件：**

- 新建：`frontend/packages/client/ui-investment-research/src/client/analysis-modules.ts`
- 修改：`frontend/packages/client/ui-investment-research/src/client/AnalysisPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/ResearchContextControls.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/ResearchWorkbenchPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/PreferenceReviewPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/index.ts`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 测试：`frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/research-context-controls.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/preference-review.client.spec.tsx`

**接口：**

- 产出：`ANALYSIS_MODULES: readonly AnalysisModuleDefinition[]`，作为智能分析提示词模板目录供智能分析和输入控件共同消费。
- 产出：`analysisModule(id: AnalysisTaskKind): AnalysisModuleDefinition`，未知标识抛出错误。
- 产出：`nextPromptTemplateDraft(currentDraft, previousAutomaticPrompt, nextPrompt): string | undefined`，只替换空白或仍为自动提示的草稿。
- 保持：标的仍通过 `ResearchChatContextController` 保存；提示词模板只修改输入草稿，不写入策略上下文、system prompt 或工具权限。

- [ ] **步骤 1：先写共享目录和草稿保护的失败测试**

```ts
expect(ANALYSIS_MODULES.map(item => item.title)).toEqual([
  '个股多智能体分析', '持仓风险分析', '历史决策回测', '市场简报',
])
expect(nextPromptTemplateDraft('我的自定义问题', '旧提示', '新提示')).toBeUndefined()
expect(nextPromptTemplateDraft('旧提示', '旧提示', '新提示')).toBe('新提示')
```

- [ ] **步骤 2：运行测试并确认失败原因来自缺失的共享导出或旧交互**

运行：`pnpm --dir frontend vitest run packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx packages/client/ui-investment-research/tests/research-context-controls.client.spec.tsx packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx packages/client/ui-investment-research/tests/preference-review.client.spec.tsx`

预期：新增断言失败；现有无关断言继续通过。

- [ ] **步骤 3：实现最小共享模块目录**

```ts
export interface AnalysisModuleDefinition {
  readonly id: AnalysisTaskKind
  readonly title: string
  readonly summary: string
  readonly detail: string
  readonly promptTemplate: string
}

export const ANALYSIS_MODULES = Object.freeze([
  { id: 'stock', title: '个股多智能体分析' },
  { id: 'portfolio', title: '持仓风险分析' },
  { id: 'backtest', title: '历史决策回测' },
  { id: 'brief', title: '市场简报' },
]) satisfies readonly AnalysisModuleDefinition[]
```

实际条目同时迁移现有 `eyebrow`、`summary`、`experts`、`tools`、`sources`、`outputs` 和 `promptTemplate` 字段；不得删减详情弹层当前使用的数据。

新增会话级提示词模板状态，只保存模板标识和上一次自动写入的完整文本。它与旧业务页面使用的全局 `assistantModule` 完全分离；切换历史会话时按会话恢复模板，未知会话默认为“普通对话”。

- [ ] **步骤 4：把智能分析收敛为介绍卡和详情**

删除页面内完整表单、任务进度和直接运行按钮。每张卡只提供“查看详情”和“打开助理”，后者新建普通对话并把目录中的 `promptTemplate` 写入草稿，同时在新会话登记模板标识；不得把模板反向映射为 `assistantModule`，也不得用模板改变后端能力或工具权限。

- [ ] **步骤 5：把我的投研输入控件改为“选提示词模板 + 选标的”**

复用目录生成模板菜单，保留“普通对话”。选择模板只更新当前草稿，不调用业务后端；其他业务页面仍使用既有研究专家选择。删除策略选择请求和策略详情弹层；清理遗留策略上下文时只修改对应字段，不清空标的。

- [ ] **步骤 6：归位偏好复盘并添加过渡状态**

工作台页头打开偏好复盘子视图；“我的投研”移除重复入口。容器使用 `data-view` 和 `data-direction` 驱动短距离横向过渡，减少动态效果时即时切换。

- [ ] **步骤 7：运行任务 1 的测试和 diff 检查**

运行：步骤 2 的 Vitest 命令。

运行：`git diff --check`

预期：全部通过；diff 不包含 `backend/` 或 `vendor/`。

### 任务 2：实时盯盘 AI 受控让位与动画

**文件：**

- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 测试：`frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`

**接口：**

- 产出：盯盘根容器的 `data-assistant-layout="closed|docked|overlay"` 和 `data-density="comfortable|compact"`。
- 保持：`MarketNewsPanel` 在 AI 打开和关闭期间实例不卸载。
- 保持：现有证券研究窗和 AI 的互斥及返回路径。

- [ ] **步骤 1：先写不卸载、容器密度和焦点恢复的失败测试**

```ts
expect(newsRequest).toHaveBeenCalledTimes(1)
expect(watchRoot.getAttribute('data-assistant-layout')).toBe('docked')
expect(newsRail.getAttribute('aria-hidden')).toBe('true')
expect(document.activeElement).toBe(aiLauncher)
```

- [ ] **步骤 2：运行聚焦测试并确认旧布局失败**

运行：`pnpm --dir frontend vitest run packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`

预期：新增的让位、挂载次数或减少动态效果断言失败。

- [ ] **步骤 3：实现盯盘专属布局状态**

使用现有 `assistantMode`、当前路由和容器宽度派生有限状态；不把状态写入后端或持久化。隐藏市场资讯时使用 `aria-hidden`、`inert` 或等效保护，并保留组件实例。

- [ ] **步骤 4：实现容器宽度密度与信息优先级**

通过 `ResizeObserver` 观察盯盘主容器。紧凑状态缩小指数卡和留白，并隐藏量比、成交额等次级字段；名称、代码、现价和涨跌幅始终保留。

- [ ] **步骤 5：实现过渡动画和减少动态效果**

```css
[data-assistant-layout='docked'] .marketNewsRail {
  opacity: 0;
  transform: translateX(12px);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .opportunityLayout, .marketNewsRail, .assistantSurface {
    transition-duration: 0.01ms;
    transform: none;
    scroll-behavior: auto;
  }
}
```

- [ ] **步骤 6：恢复滚动、扫描状态、证券选择和焦点**

AI 打开前记录需要恢复的 DOM 状态；关闭完成后恢复，不重新请求市场资讯。窄屏遮罩阻止背景操作。

- [ ] **步骤 7：运行任务 2 测试和 diff 检查**

运行：步骤 2 的 Vitest 命令。

运行：`git diff --check`

预期：全部通过；其他路由仍使用现有悬浮 AI 布局。

### 任务 3：策略研究信息层级与自进化状态展示

**文件：**

- 修改：`frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/evolution-types.ts`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 测试：`frontend/packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx`

**接口：**

- 产出：统一状态映射函数分别呈现参与状态、置信层级和变异来源。
- 保持：现有激活、回测、影子和归档动作，不改变请求参数或准入条件。
- 保持：自进化阈值和计数完全来自后端响应。

- [ ] **步骤 1：先写策略帮助和状态映射的失败测试**

```ts
expect(screen.queryByText('策略生命周期')).toBeNull()
fireEvent.click(screen.getByRole('button', { name: '了解策略生命周期' }))
expect(screen.getByRole('dialog', { name: '策略生命周期' })).toBeTruthy()
expect(screen.getByText('正常运行')).toBeTruthy()
expect(screen.getByText('变异来源')).toBeTruthy()
```

- [ ] **步骤 2：运行聚焦测试并确认旧常驻说明或旧文案导致失败**

运行：`pnpm --dir frontend vitest run packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx`

- [ ] **步骤 3：实现生命周期帮助弹层**

标题旁增加问号按钮；弹层默认关闭，支持 `Escape`、外部关闭和焦点恢复。删除页面级全局回测窗口与刷新区，但不删除策略卡现有动作。

- [ ] **步骤 4：统一前端状态映射并重排首屏**

```ts
export function participationLabel(status: EvolutionStrategyStatus): string {
  if (status === 'active') return '正常运行'
  if (status === 'watch') return '观察中'
  if (status === 'retired') return '已淘汰'
  if (status === 'candidate') return '候选'
  if (status === 'rejected') return '已拒绝'
  return '状态未知'
}
```

首屏使用已有闭环状态、数据完成度、策略计数和最近动作；变异只显示来源标记，不重复计入生命周期状态。

- [ ] **步骤 5：为帮助弹层和首屏变化添加过渡样式**

帮助弹层使用淡入和轻微缩放；看板只对新增或改变的值设置过渡。减少动态效果时取消位移与缩放。

- [ ] **步骤 6：运行任务 3 测试和 diff 检查**

运行：步骤 2 的 Vitest 命令。

运行：`git diff --check`

预期：全部通过；测试仍能观察现有后端动作请求。

### 任务 4：产业链聚焦、重新定中心和层级交互

**文件：**

- 修改：`frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 测试：`frontend/packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`

**接口：**

- 保持：现有 `industry-chain` 请求操作和响应解析。
- 产出：节点聚焦与 `setCenter(company)` 明确分离。
- 产出：层级选项只来自当前响应或现有请求参数支持范围。

- [ ] **步骤 1：先写聚焦、重新定中心和失败保留测试**

```ts
fireEvent.click(screen.getByRole('button', { name: /聚焦供应商甲/ }))
expect(chainRequest).toHaveBeenCalledTimes(1)
fireEvent.click(screen.getByRole('button', { name: /将供应商甲设为中心/ }))
expect(chainRequest).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({ code: '600001' }) }))
expect(screen.getByText('原中心企业')).toBeTruthy()
```

- [ ] **步骤 2：运行聚焦测试并确认旧交互失败**

运行：`pnpm --dir frontend vitest run packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`

- [ ] **步骤 3：实现显式重新定中心和真实层级控制**

普通点击只改变选中节点。显式按钮更新请求对象；成功后更新根节点和路径，失败时保留旧图与旧中心。只有现有接口支持的层级进入控件。

- [ ] **步骤 4：实现旧图弱化和新图进入动画**

加载期间用 `data-refreshing` 弱化旧图但保持可读；成功替换时淡入新图；失败移除弱化状态。减少动态效果时即时切换。

- [ ] **步骤 5：运行任务 4 测试和 diff 检查**

运行：步骤 2 的 Vitest 命令。

运行：`git diff --check`

预期：全部通过；没有出现权重来源、三层节点或分页的推断数据。

### 任务 5：决策记录与整体验证

**文件：**

- 新建：`frontend/.agents/notes/implemented/feature/2026-09-02-rc10-frontend-experience.md`
- 新建：`frontend/.agents/notes/implemented/feature/2026-09-02-rc10-frontend-experience.zh.md`
- 生成：`frontend/.agents/notes/implemented/feature/2026-09-02-rc10-frontend-experience.i18n.yaml`
- 检查：`frontend/packages/client/ui-investment-research/README.md`（文件不存在或包级使用方式未改变时不新建）

**接口：**

- 记录：统一研究模块目录、盯盘专属 AI 让位和不伪造后端能力的决策、替代方案及后果。

- [ ] **步骤 1：按实际实现编写中英文 Agent Note**

英文与中文文件均使用规定的 `Problem`、`Decision`、`Alternatives considered` 和 `Consequences` 结构；正文描述最终行为，不复制本计划。

- [ ] **步骤 2：生成配对记录并运行文档检查**

先读取 `frontend/.agents/skills/dsh-doc-standards/SKILL.md`，使用其规定的命令生成 `.i18n.yaml` 并运行窄范围文档检查。

- [ ] **步骤 3：运行全部受影响的投研测试**

运行：`pnpm --dir frontend vitest run packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx packages/client/ui-investment-research/tests/research-context-controls.client.spec.tsx packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx packages/client/ui-investment-research/tests/preference-review.client.spec.tsx packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx packages/client/ui-investment-research/tests/theme-styles.client.spec.ts packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`

- [ ] **步骤 4：运行类型检查、构建和最终 diff 检查**

运行：`pnpm --dir frontend run typecheck:contracts-ready`

运行：`pnpm --filter @deepseek-ai/dsh-client-ui-investment-research bundle`

运行：`git diff --check`

运行：`git status --short`

预期：测试、类型检查、构建和 diff 检查通过；状态只包含计划内前端、规格、计划和 Agent Note 文件。

- [ ] **步骤 5：记录 GUI 验证边界**

若未分配独立端口，不启动服务，并在交付报告中写明“自动化已通过，GUI 待验证”。若后续分配独立端口，则按宽屏、窄桌面、移动和减少动态效果四组视口补充真实页面验证。

- [ ] **步骤 6：等待 Git 操作授权**

不暂存、不提交、不推送、不创建 PR。用户明确授权相应 Git 操作后，再按仓库规则使用 `[AI] ` 前缀和 `codex/` 分支。
