# 实时盯盘右栏悬浮布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将实时盯盘改为宽屏“左侧紧凑市场扫描、右侧独立市场资讯”，并让证券研究窗标准状态基于视口右侧悬浮、宽度参考市场资讯栏，同时统一其与 AI 助理的缩放控件。

> 2026-09-01 用户澄清：研究窗不挂载到市场资讯容器。本文后续若仍出现“右栏 portal”“dock target”或“只覆盖右栏”，均由本条取代：标准状态 portal 到 owner document 的 `body`，使用 `position: fixed` 和市场资讯栏宽度锚点；可用空间不足时复用近全屏模态。

**Architecture:** `OpportunityPage` 持有页面级市场资讯和右栏挂载锚点，Shell 继续持有证券研究与 AI 的互斥状态。`ResearchFloatingSurface` 在宽屏 `docked` 状态 portal 到右栏锚点，在 `expanded` 或单栏窄屏状态 portal 到 `document.body`；底层市场资讯保持挂载。证券内容不再请求或渲染市场快讯，缩放图标抽成两个悬浮表面共享的纯组件。

**Tech Stack:** TypeScript、React、CSS Modules、Vitest、Testing Library、DSH Web profile

**Spec:** `docs/superpowers/specs/2026-08-31-realtime-watch-floating-research-design.md`

## 全局约束

- 宽屏 `1202×801` 与 `1440×900` 显示双栏；`390×844` 显示单栏近全屏；`1042×889` 不得横向溢出。
- 标准证券研究窗的左边界不得越过右栏左边界；只有用户主动放大才允许覆盖整个工作区。
- 市场资讯是页面级内容，不得出现在证券研究窗的 tablist 中；切股不得重置其请求结果或滚动位置。
- 扫描行主体是唯一详情入口，行内只保留独立“智能分析”操作；不得出现嵌套按钮。
- 证券研究窗固定且不可拖动；深浅主题下必须有可辨识阴影、清晰边界和无需滚动即可看见的关闭按钮。
- 单栏窄屏继续使用近全屏模态、背景滚动锁、焦点圈和关闭后位置恢复。
- 证券研究窗与 AI 助理必须复用同一个缩放 SVG 组件和 `data-icon` 状态标识。
- 不新增依赖，不改变后端与运行时操作合同，不删除既有 `stock-detail` 路由。
- 新建或更新 Markdown 使用中文；代码标识符、命令和路径保持原文。
- 未获得新的提交、推送或 PR 授权前，只修改与验证工作区；若后续获得授权，AI commit message 必须以 `[AI] ` 开头。

---

## 文件结构

### 新建文件

- `frontend/packages/client/ui-investment-research/src/client/SurfaceResizeIcon.tsx`：唯一的展开/收起 SVG 实现。
- `frontend/packages/client/ui-investment-research/src/client/MarketNewsPanel.tsx`：页面级市场资讯请求、状态、重试与列表展示。
- `frontend/packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx`：市场资讯独立加载、错误恢复和保活合同。

### 修改文件

- `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`：创建共享资源与右栏 ref，渲染双栏工作区，压缩扫描行，删除重复详情入口。
- `frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx`：支持 body portal、视口 fixed、资讯栏宽度同步、单栏断点和共享缩放图标。
- `frontend/packages/client/ui-investment-research/src/client/SecurityResearchContent.tsx`：删除市场快讯状态、请求和 tabs，只保留个股相关资讯。
- `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`：双栏、sticky 右栏、overlay root、紧凑行、阴影、关闭按钮和响应式样式。
- `frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx`：更新初始请求、唯一详情入口、页面级市场资讯和字段密度断言。
- `frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx`：删除市场 tab 行为，保留个股资讯隔离、切股和重试测试。
- `frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx`：body portal、宽度同步、断点切换、阴影/关闭与共享图标测试。
- `frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx`：右栏研究窗与 AI 互斥、返回和市场资讯保活集成测试。
- `frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx`：AI 助理共享缩放图标回归。
- `frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`：阴影令牌、视口悬浮和断点样式门禁。
- `docs/prd/0.1.0-rc.9/04-验收发布/01-产品验收与回归矩阵.md`：实现完成后记录增量自动化和真实 profile 证据。

## Task 1：共享缩放图标

**Files:**
- Create: `frontend/packages/client/ui-investment-research/src/client/SurfaceResizeIcon.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx:222-235, 663-674`
- Modify: `frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx:410-435`
- Test: `frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx`
- Test: `frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx`

**Interfaces:**
- Consumes: `expanded: boolean`。
- Produces: `SurfaceResizeIcon({ expanded }: { readonly expanded: boolean }): JSX.Element`；根 SVG 使用 `className={css.actionIcon}`，并设置 `data-icon={expanded ? 'surface-collapse' : 'surface-expand'}`。

- [ ] **Step 1: 写共享图标失败测试**

在两份组件测试中分别打开 AI 助理和证券研究窗，加入以下核心断言：

```tsx
expect(screen.getByRole('button', { name: '近全屏展开 AI 助理' })
  .querySelector('[data-icon="surface-expand"]')).not.toBeNull()
expect(screen.getByRole('button', { name: '近全屏展开研究窗' })
  .querySelector('[data-icon="surface-expand"]')).not.toBeNull()
```

把研究窗切到 `expanded` 后断言 `收起研究窗` 内为 `surface-collapse`，且组件源码中不再包含 `□` 或 `◲`。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx
```

Expected: FAIL，找不到 `data-icon="surface-expand"`，研究窗仍渲染文本符号。

- [ ] **Step 3: 实现共享组件并替换两处调用**

创建：

```tsx
import css from './InvestmentShell.module.css'

export function SurfaceResizeIcon({ expanded }: { readonly expanded: boolean }) {
  return (
    <svg
      className={css.actionIcon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-icon={expanded ? 'surface-collapse' : 'surface-expand'}
    >
      {expanded
        ? <><path d="M7 2.5V7H2.5" /><path d="m2.5 7 4.5-4.5" /><path d="M9 13.5V9h4.5" /><path d="M13.5 9 9 13.5" /></>
        : <><path d="M6.5 2.5h-4v4" /><path d="m2.5 2.5 4.5 4.5" /><path d="M9.5 13.5h4v-4" /><path d="M13.5 13.5 9 9" /></>}
    </svg>
  )
}
```

删除 `AssistantResizeIcon`，两种表面都调用 `SurfaceResizeIcon`。研究窗按钮文案统一为 `近全屏展开研究窗` / `收起研究窗`。

- [ ] **Step 4: 运行测试并确认通过**

Run: Task 1 Step 2 命令。

Expected: 两份测试全部 PASS；`rg -n '□|◲|AssistantResizeIcon'` 在三个实现文件中无结果。

- [ ] **Step 5: 条件式提交检查点**

Run: `git diff --check`。只有用户明确授权提交时，执行：

```bash
git add frontend/packages/client/ui-investment-research/src/client/SurfaceResizeIcon.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx
git commit -m "[AI] 统一研究窗与 AI 助理缩放控件"
```

## Task 2：将市场资讯从个股详情迁到页面级组件

**Files:**
- Create: `frontend/packages/client/ui-investment-research/src/client/MarketNewsPanel.tsx`
- Create: `frontend/packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/SecurityResearchContent.tsx:1-220, 350-500`
- Modify: `frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx`

**Interfaces:**
- Consumes: `requestData: RequestData`、`resources: ResearchResourceStore`、`active: boolean`。
- Produces: `MarketNewsPanel(props): JSX.Element`；固定请求键为 `market-watch.news-flash` + `{ limit: 12, enrich: false, personal: false }`。
- Produces: 语义区域 `aria-labelledby="market-news-title"`，可观察标题“市场资讯”和说明“全市场快讯”。

- [ ] **Step 1: 写市场资讯归属失败测试**

在新测试文件中创建真实 `createResearchResourceStore()`，渲染 `MarketNewsPanel`，断言：

```tsx
expect(await screen.findByRole('region', { name: '市场资讯' })).not.toBeNull()
expect(requestData).toHaveBeenCalledWith({
  operation: 'market-watch.news-flash',
  input: { limit: 12, enrich: false, personal: false },
})
```

在 `security-research-content.client.spec.tsx` 中将原市场 tab 测试改为：

```tsx
expect(screen.queryByRole('tablist')).toBeNull()
expect(screen.queryByRole('tab', { name: '市场快讯' })).toBeNull()
expect(requestData.mock.calls.some(([request]) => request.operation === 'market-watch.news-flash')).toBe(false)
expect(screen.getByRole('heading', { name: '个股相关资讯' })).not.toBeNull()
```

新组件还要覆盖成功空列表、`unavailable`、传输错误、重试去重和外部链接安全属性。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx
```

Expected: FAIL，新组件不存在，旧详情仍渲染 tablist 和市场快讯标签。

- [ ] **Step 3: 实现页面级市场资讯并精简证券内容**

`MarketNewsPanel` 使用 `useSyncExternalStore` 订阅固定键；`active=true` 时 `resources.read`，点击重试时调用 `resources.revalidate`。成功、空、缓存和失败文案分别为“市场资讯”“当前暂无市场快讯”“缓存 · <事实时间>”“市场资讯暂不可用”。

从 `SecurityResearchContent` 删除 `MARKET_NEWS_KEY`、`selectedTab`、`marketOpened`、`loadMarketNews`、`readMarketNews`、市场资源派生状态和整个 `tablist`；直接渲染一个标题为“个股相关资讯”的 `researchContentRegion`。

- [ ] **Step 4: 运行测试并确认通过**

Run: Task 2 Step 2 命令。

Expected: 两份测试全部 PASS；`rg -n 'market-watch.news-flash|市场快讯.*tab|selectedTab|marketOpened' SecurityResearchContent.tsx` 无结果。

- [ ] **Step 5: 条件式提交检查点**

Run: `git diff --check`。只有用户明确授权提交时，提交主题：

```bash
git add frontend/packages/client/ui-investment-research/src/client/MarketNewsPanel.tsx frontend/packages/client/ui-investment-research/src/client/SecurityResearchContent.tsx frontend/packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx
git commit -m "[AI] 独立实时盯盘市场资讯"
```

## Task 3：构建双栏工作区与紧凑扫描行

**Files:**
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx:1088-1110, 1450-1650`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css:441-480, 1580-1645, 1728-1745`
- Modify: `frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx`
- Modify: `frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `MarketNewsPanel`。
- Produces: `OpportunityPageProps.resources: ResearchResourceStore`、`OpportunityPageProps.researchDockRef: RefObject<HTMLDivElement>`。
- Produces: `.opportunityWorkspace`、`.marketNewsRail`、`.researchDockTarget`、`.stockCardMain` 和 `.stockCardActions` 的稳定 DOM/CSS 边界。

- [ ] **Step 1: 更新初始请求与操作语义失败测试**

为每个 `OpportunityPage` 测试夹具创建：

```tsx
const resources = createResearchResourceStore()
const researchDockRef = createRef<HTMLDivElement>()
```

并传入组件。把初始请求断言改为指数、扫描和页面级市场资讯共 3 个操作，但仍不得包含 `tech-signal`、`security-news` 或 `security-detail`。

把扫描动作测试改为：

```tsx
expect(within(item).queryByRole('button', { name: '详情' })).toBeNull()
expect(within(item).getByRole('button', { name: '打开贵州茅台研究' })).not.toBeNull()
expect(within(item).getByRole('button', { name: '智能分析' })).not.toBeNull()
expect(container.querySelector('button button')).toBeNull()
```

点击智能分析后断言 `onAnalyzeResearch` 增加一次且 `onOpenResearch` 次数不变。加入名称、代码、涨跌幅、现价、量比、成交额均存在的字段断言。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/data-pages.client.spec.tsx packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
```

Expected: FAIL，初始没有市场资讯请求，页面缺少双栏语义，仍存在“详情”按钮。

- [ ] **Step 3: 实现工作区 DOM 和紧凑行**

在 Shell 创建：

```tsx
const opportunityResearchDockRef = useRef<HTMLDivElement>(null)
```

并把 `researchResources` 与该 ref 传给 `OpportunityPage`。`OpportunityPage` 在扫描控制区下渲染：

```tsx
<div className={css.opportunityWorkspace}>
  <section className={css.cardList} aria-labelledby="market-scan-title">...</section>
  <aside className={css.marketNewsRail} aria-label="市场资讯栏">
    <MarketNewsPanel requestData={requestData} resources={resources} active />
    <div ref={researchDockRef} className={css.researchDockTarget} />
  </aside>
</div>
```

扫描项保留 `<article>`，内部是主体按钮与同级智能分析按钮；删除“详情”。桌面主体在两行内排列身份、涨跌幅和三项行情，减小垂直 padding；`<=1023px` 单栏排列，`<=420px` 保持 `44px` 触控目标。

- [ ] **Step 4: 加入 CSS 静态门禁**

在主题测试中断言：

```ts
expect(styles).toContain('.opportunityWorkspace')
expect(styles).toContain('grid-template-columns: minmax(0, 1.5fr) minmax(320px, .9fr)')
expect(styles).toContain('.marketNewsRail')
expect(styles).toContain('.researchDockTarget')
expect(styles).toContain('@media (max-width: 1023px)')
```

同时断言新增颜色、阴影和背景只使用已有 `--dsw-*` 或 `--investment-*` 令牌。

- [ ] **Step 5: 运行测试并确认通过**

Run: Task 3 Step 2 命令。

Expected: 两份测试全部 PASS。

- [ ] **Step 6: 条件式提交检查点**

Run: `git diff --check`。只有用户明确授权提交时，提交主题：

```bash
git add frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
git commit -m "[AI] 优化实时盯盘双栏与扫描密度"
```

## Task 4：把研究窗锚定到右栏并保持窄屏模态

**Files:**
- Modify: `frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx:1145-1195`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css:1475-1500, 1615-1630`
- Modify: `frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx`
- Modify: `frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx`

**Interfaces:**
- Consumes: Task 3 的 `opportunityResearchDockRef`。
- Produces: `ResearchFloatingSurfaceProps.dockTargetRef: RefObject<HTMLElement>`。
- Produces: `SINGLE_COLUMN_QUERY = '(max-width: 1023px)'`；`docked && !singleColumn` portal 到 `dockTargetRef.current`，其他展开状态 portal 到 owner document body。

- [ ] **Step 1: 写 portal 边界和响应式失败测试**

测试夹具增加：

```tsx
const dockTarget = document.createElement('div')
dockTarget.dataset.testid = 'research-dock-target'
document.body.append(dockTarget)
const dockTargetRef = { current: dockTarget }
```

核心断言：

```tsx
expect(within(dockTarget).getByRole('complementary', { name: '000001证券研究窗' })).not.toBeNull()
expect(screen.getByRole('button', { name: '关闭研究窗' })).not.toBeNull()
```

切换媒体条件到单栏后，断言右栏 target 内不再有表面，`document.body` 中存在 `role="dialog"`，背景被 inert；切回宽屏后恢复 `complementary` 且证券代码不变。`expanded` 必须始终 portal 到 body。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx
```

Expected: FAIL，组件没有 `dockTargetRef`，标准表面仍为全局 fixed。

- [ ] **Step 3: 实现 portal 目标切换**

引入 `createPortal`，把状态提示、最小化入口、backdrop 和表面组装成 `surfaceContent`。标准宽屏的表面 portal 到 `dockTargetRef.current`；单栏或 expanded 的 backdrop 与表面 portal 到 owner document body。媒体查询改为 `'(max-width: 1023px)'`，模式事实仍保持 `docked`，只改变派生语义和 portal 目标。

Shell 把 `opportunityResearchDockRef` 传给 `ResearchFloatingSurface`。路由不为 `opportunity` 或 ref 尚未挂载时，使用 owner document body 作为安全回退，但不得把该回退标记为右栏完成态。

- [ ] **Step 4: 实现阴影、边界和常驻关闭 UX**

宽屏标准表面使用：

```css
.researchDockTarget .researchFloatingSurface {
  position: absolute;
  inset: 0;
  width: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
}
```

`.researchDockTarget` 覆盖右栏且默认 `pointer-events: none`；表面恢复 `pointer-events: auto`。头部使用 sticky 或固定 flex 区域，正文滚动仅发生在 `.researchSurfaceBody`，保证关闭按钮始终可见。深浅主题不得使用硬编码阴影颜色。

- [ ] **Step 5: 运行测试并确认通过**

Run: Task 4 Step 2 命令。

Expected: 两份测试全部 PASS；标准表面位于 body 视口层并跟随资讯栏宽度，单栏/expanded 为 body 模态，关闭和焦点恢复通过。

- [ ] **Step 6: 条件式提交检查点**

Run: `git diff --check`。只有用户明确授权提交时，提交主题：

```bash
git add frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx
git commit -m "[AI] 将证券研究窗锚定到市场资讯右栏"
```

## Task 5：增量集成回归与真实 profile UX 验收

**Files:**
- Modify: `frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx`
- Modify: `frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`
- Modify: `docs/prd/0.1.0-rc.9/04-验收发布/01-产品验收与回归矩阵.md`

**Interfaces:**
- Consumes: Task 1～4 的共享图标、页面市场资讯、双栏 DOM 和 dock portal。
- Produces: RC9-E2E-22～24 的自动化与真实 Browser 证据；不改变产品接口。

- [ ] **Step 1: 写市场资讯保活和 AI 往返失败测试**

集成测试记录 `market-watch.news-flash` 调用次数，并给市场资讯滚动容器设置 `scrollTop = 120`。打开证券 A、切换 B、进入 AI、返回、关闭研究窗后断言：

```tsx
expect(operationCalls(requestData, 'market-watch.news-flash')).toHaveLength(1)
expect(marketNewsScroll.scrollTop).toBe(120)
expect(screen.getByRole('region', { name: '市场资讯' })).not.toBeNull()
```

同时断言研究窗与 AI 不会同时存在，AI 返回后证券代码仍为 B，关闭按钮始终存在。

- [ ] **Step 2: 运行聚焦测试并确认失败后修正最小实现**

Run:

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/data-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/market-news-panel.client.spec.tsx \
  packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx \
  packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx \
  packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx \
  packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx \
  packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
```

Expected: 初次运行暴露的仅是集成缺口；逐项修正后全部 PASS。

- [ ] **Step 3: 运行静态和构建门禁**

Run:

```bash
pnpm --dir frontend run typecheck
pnpm --dir frontend run verify-client-theme-styles
pnpm --dir frontend run build:lib
pnpm --dir frontend run build:web
```

Expected: 四条命令均退出 0。若 `product-pages.client.spec.tsx` 仍有公仓基线的 3 个旧断言失败，只按既有证据披露，不混入本任务修复。

- [ ] **Step 4: 启动真实 profile 并执行四视口 UX 验收**

保持现有三后端健康，以隔离 `DSH_HOME` 启动：

```bash
env DSH_HOME=/private/tmp/pa-investment-rc9-layout pnpm --dir frontend dsh --profile investment-research --host 127.0.0.1 --port 3080
```

用真实 Browser 验收：

- `1440×900`：双栏，标准窗基于视口右侧悬浮并参考资讯栏宽度，阴影与关闭按钮在深浅主题可见；左侧连续切股。
- `1202×801`：双栏比例与确认原型一致，首屏扫描密度提高，市场资讯不在个股 tabs 中。
- `1042×889`：临界布局无横向溢出；若按 CSS 规则进入双栏，右栏最小宽度仍可读；若进入单栏，顺序必须为扫描后资讯。
- `390×844`：扫描在上、资讯在下；证券详情近全屏，背景锁定，关闭后 `scrollTop` 恢复。
- 两种表面的展开/收起图标图形一致；智能分析不触发详情；关闭研究窗后市场资讯原位恢复。

- [ ] **Step 5: 更新验收矩阵并做完成前验证**

把命令结果、请求次数、四视口观察、深浅主题、console warning/error 数量和截图路径写入验收矩阵。运行：

```bash
git diff --check
git status --short
```

Expected: 无空白错误；只存在本计划范围内文件和既有未跟踪 `.superpowers/`，不得暂存或清理来源不明文件。

- [ ] **Step 6: 条件式最终提交与 PR 更新**

只有用户明确授权提交、推送和更新 PR 时，先确认 remote/base/head，再执行单一主题提交或按授权 amend；AI commit 与 PR 标题均以 `[AI] ` 开头。禁止直接推送 `public/master`，禁止在未确认历史改写授权时 force push 已推送分支。

## 自检结果

- 规格覆盖：`WATCH-012/013/014/017/024/025/026` 分别映射到 Task 2～5；既有 `WATCH-011/015/016/018/022/023` 由集成回归保护。
- 占位扫描：未发现禁止占位文本或缺少明确测试目标的实现步骤。
- 类型一致性：`SurfaceResizeIcon`、`MarketNewsPanel`、`resources`、`researchDockRef`、`dockTargetRef` 和 `SINGLE_COLUMN_QUERY` 在首次定义后保持同名使用。
- UX 关闭条件：右栏边界、阴影、常驻关闭、市场资讯保活、唯一详情入口、响应式和统一缩放图标均有自动化或真实 Browser 验收步骤。
