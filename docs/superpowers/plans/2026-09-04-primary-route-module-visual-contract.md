# 一级路由模块视觉契约实施计划

> **面向执行者：** 必须使用 `superpowers:executing-plans` 按任务顺序实施；每一步使用复选框跟踪。当前任务未授权 Git 提交、推送或 PR，因此计划中的交付止于验证完成和保留工作区改动。

**目标：** 让研究工作台、智能分析、实时盯盘、策略研究和产业链统一采用可辨识的路由表面、大模块与内部分组三级视觉层级，并把该规则固化到产品设计规范和回归测试。

**架构：** 在现有 `pageScroll`、`moduleGrid` 和 `moduleCard` 之上增加共享的 `primaryRouteSurface` 作用域，由该作用域统一页面背景、页头分隔、大模块边界和间距。五个路由只组合该作用域并保留各自布局；页面专属选择器仅处理内部套框冲突，不新建业务组件、状态或 token。

**技术栈：** React、TypeScript、CSS Modules、Vitest、Testing Library、现有 `--dsw-alias-*` 语义 token。

**规格：** `docs/superpowers/specs/2026-09-04-primary-route-module-visual-contract-design.md`

## 全局约束

- 只修改研究工作台、智能分析、实时盯盘、策略研究、产业链及其共享视觉规范；不改自进化、我的投研、二级详情页和浮层契约。
- 不改变数据请求、业务状态、路由、按钮行为、AI 能力或后端接口。
- 一级路由画布与自进化保持一致，使用 `--dsw-alias-bg-layer-1`；大模块使用 `--dsw-alias-bg-base + --dsw-alias-border-l2`。
- 大模块默认 `12px` 圆角、`16px` 内边距、同级间距 `20px`。
- 内部静态分组默认不用完整边框；优先使用背景、留白和 `--dsw-alias-border-l1` 单向分隔。
- 状态提示与相邻内容至少保留 `12px` 间距。
- 功能 CSS 不新增颜色字面量、静态色板 token 或主题选择器。
- 每个实现任务先得到失败测试，再做最小实现，再运行相关测试。
- 未获得用户授权，不执行 commit、push、PR、merge 或 worktree 清理。

---

### 任务 1：建立共享路由表面契约

**文件：**
- 修改：`frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`

**接口：**
- 消费：现有 `.pageScroll`、`.pageHeader`、`.moduleGrid`、`.moduleCard`。
- 产出：CSS Module 类 `primaryRouteSurface`，供五个一级路由的根滚动面组合使用。

- [ ] **步骤 1：添加失败的共享视觉契约测试**

在“投研工作台主题样式”中增加断言：

```ts
it('为指定一级路由建立统一的页面与大模块层级', () => {
  expect(styles).toMatch(/\.primaryRouteSurface\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-1\);/s)
  expect(styles).toMatch(/\.primaryRouteSurface > \.pageHeader\s*\{[^}]*border-bottom:\s*1px solid var\(--dsw-alias-border-l2\);/s)
  expect(styles).not.toContain('.primaryRouteSurface .moduleCard {')
  expect(styles).toMatch(/\.primaryRouteSurface > \.moduleGrid\s*\{[^}]*gap:\s*20px;/s)
})
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```bash
cd frontend
node_modules/.bin/vitest run packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
```

预期：新增测试失败，提示 `primaryRouteSurface` 规则不存在。

- [ ] **步骤 3：实现共享 CSS 作用域**

在 `InvestmentShell.module.css` 的共享模块样式之后增加：

```css
.primaryRouteSurface {
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 20px;
  background: var(--dsw-alias-bg-layer-1);
}
.primaryRouteSurface > .pageHeader {
  margin-bottom: 0;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.primaryRouteSurface > .moduleGrid { gap: 20px; }
.primaryRouteSurface .strategyCard {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  box-shadow: none;
}
.primaryRouteSurface .strategyCard.reportItemActive {
  border-color: var(--investment-primary);
  background: var(--investment-selected-surface);
}
```

共享规则覆盖 `.primaryRouteSurface > .pageHeader` 和 `.primaryRouteSurface > .moduleGrid`；大模块必须使用明确的页面类，不得用 `.primaryRouteSurface .moduleCard` 后代选择器跨越内部卡片与浮层。

- [ ] **步骤 4：运行测试并确认绿灯**

运行与步骤 2 相同的命令。预期：主题样式测试通过。

### 任务 2：接入五个一级路由根表面

**文件：**
- 修改：`frontend/packages/client/ui-investment-research/src/client/ResearchWorkbenchPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/AnalysisPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx`
- 修改：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`
- 修改：`frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx`
- 修改：`frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx`
- 修改：`frontend/packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx`
- 修改：`frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx`

**接口：**
- 消费：任务 1 的 `primaryRouteSurface`。
- 产出：五个路由真实滚动根均组合 `pageScroll` 与 `primaryRouteSurface`；智能分析的外层 `routeSurface` 不替代其真实页面根。

- [ ] **步骤 1：添加失败的 DOM 契约测试**

在各页面现有渲染测试中，对路由主标题最近的滚动根断言共享类已挂载。使用 CSS Module 导出的类，不断言哈希后的字面类名：

```ts
const page = screen.getByRole('heading', { name: '策略研究' }).closest(`.${css.pageScroll}`)
expect(page).toHaveClass(css.primaryRouteSurface)
```

其余四页分别使用“研究工作台”“智能分析”“实时盯盘”“产业链”主标题定位。

- [ ] **步骤 2：运行五个目标测试并确认红灯**

```bash
cd frontend
node_modules/.bin/vitest run \
  packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx \
  packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx \
  packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx \
  packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx \
  packages/client/ui-investment-research/tests/data-pages.client.spec.tsx
```

预期：新增类名断言失败，现有行为测试仍通过。

- [ ] **步骤 3：组合共享路由类**

将五个页面的真实滚动根从：

```tsx
<div className={css.pageScroll}>
```

调整为：

```tsx
<div className={`${css.pageScroll} ${css.primaryRouteSurface}`}>
```

实时盯盘保留原有 `ref`、`data-assistant-layout`、`data-density` 与局部 CSS 自定义属性；智能分析若自身不持有 `pageScroll`，在 `InvestmentShell` 的既有 `routeSurface` 中增加共享作用域，并确认没有产生嵌套滚动根。

- [ ] **步骤 4：运行目标测试并确认绿灯**

运行与步骤 2 相同的命令。预期：五个共享类断言和原有行为测试全部通过。

### 任务 3：校准研究工作台与智能分析的大模块

**文件：**
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`
- 测试：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx`

**接口：**
- 消费：`primaryRouteSurface`。
- 产出：工作台和智能分析的大模块使用二级边界，内部静态分组避免同强度套框；可点击卡片保留交互边界。

- [ ] **步骤 1：为页面专属层级添加失败测试**

在主题样式测试中断言：工作台的大业务容器和智能分析的能力容器在共享作用域内使用 `border-l2`；内部静态说明区使用 `bg-layer-1` 或单向 `border-l1`，不使用第二层 `border-l2` 完整边框。

- [ ] **步骤 2：运行主题样式测试并确认红灯**

```bash
cd frontend
node_modules/.bin/vitest run packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
```

- [ ] **步骤 3：实现最小页面专属规则**

复用现有工作台与智能分析类，在 `.primaryRouteSurface` 作用域中：

```css
.primaryRouteSurface :is(.dashboardPanel, .analysisOverview > div, .analysisModuleCard) {
  padding: 16px;
  border-color: var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  box-shadow: none;
}
```

`.dashboardPanel`、`.analysisOverview > div` 和 `.analysisModuleCard` 是现有组件类。按钮、能力卡、持仓卡等独立可操作项继续保留完整边界和焦点反馈。

- [ ] **步骤 4：运行主题与页面测试**

```bash
cd frontend
node_modules/.bin/vitest run \
  packages/client/ui-investment-research/tests/theme-styles.client.spec.ts \
  packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx \
  packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx
```

预期：全部通过，页面行为无变化。

### 任务 4：校准实时盯盘、策略研究与产业链

**文件：**
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`
- 测试：`frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`
- 测试：`frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx`

**接口：**
- 消费：`primaryRouteSurface` 与原有页面专属容器。
- 产出：三个页面的大模块采用统一边界，影子验证状态提示具有稳定上间距，内部证据不形成连续同强度套框。

- [ ] **步骤 1：添加失败的策略与页面层级测试**

新增样式断言：

```ts
expect(styles).toMatch(/\.shadowScopeBar \+ \.importNotice\s*\{[^}]*margin-top:\s*12px;/s)
expect(styles).toMatch(/\.primaryRouteSurface \.embeddedShadow\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);/s)
```

同时为实时盯盘的大盘、扫描和资讯容器，以及产业链图谱和事件影响容器断言二级模块边界。影子运行摘要和静态证据区应断言使用背景或单向分隔，而不是与父模块相同的二级完整边框。

- [ ] **步骤 2：运行相关测试并确认红灯**

```bash
cd frontend
node_modules/.bin/vitest run \
  packages/client/ui-investment-research/tests/theme-styles.client.spec.ts \
  packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx \
  packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/data-pages.client.spec.tsx
```

- [ ] **步骤 3：实现页面专属层级规则**

在 `.primaryRouteSurface` 作用域中将真实大模块边界调整为 `border-l2` 和 `bg-base`。影子验证至少包含：

```css
.primaryRouteSurface .embeddedShadow {
  border-color: var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  box-shadow: none;
}
.shadowScopeBar + .importNotice { margin-top: 12px; }
.primaryRouteSurface .shadowRunSummary {
  border: 0;
  background: var(--dsw-alias-bg-layer-1);
}
```

纸面持仓、净值证据和历史记录保留各自标题与数据语义，通过背景、留白和 `border-l1` 分隔组织。实时盯盘不得破坏 `data-assistant-layout` 的让位布局；产业链不得改变图谱节点的聚焦和重新定中心逻辑。

- [ ] **步骤 4：运行相关测试并确认绿灯**

运行与步骤 2 相同的命令。预期：全部通过。

### 任务 5：固化长期设计约束

**文件：**
- 修改：`DESIGN.md`
- 修改：`frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`

**接口：**
- 消费：已实现的 `primaryRouteSurface`。
- 产出：`DESIGN.md` 中“一级路由模块层级”规范，以及验证规范与实现一致的静态契约。

- [ ] **步骤 1：添加失败的文档契约测试**

在主题样式测试中读取根目录 `DESIGN.md`，断言包含以下稳定标题和关键词：

```ts
expect(design).toContain('## 一级路由模块层级')
expect(design).toContain('连续两层相同强度的完整边框')
expect(design).toContain('至少 `12px`')
expect(design).toContain('1440px 和 1024px')
```

- [ ] **步骤 2：运行测试并确认红灯**

```bash
cd frontend
node_modules/.bin/vitest run packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
```

- [ ] **步骤 3：更新设计规范**

在 `DESIGN.md` 的“信息架构与页面层级”之后增加“一级路由模块层级”，准确写入规格第 9 节的六条约束，并说明本轮五个路由是首批强制使用共享契约的页面。

- [ ] **步骤 4：运行测试并确认绿灯**

运行与步骤 2 相同的命令。预期：文档与样式契约测试通过。

### 任务 6：构建、真实产品 UAT 与交付

**文件：**
- 检查：本计划涉及的全部文件
- 不新增生产代码

**接口：**
- 消费：任务 1–5 的实现。
- 产出：自动化和真实渲染证据；验证用前后端服务保持运行。

- [ ] **步骤 1：运行目标测试与主题检查**

```bash
cd frontend
node_modules/.bin/vitest run \
  packages/client/ui-investment-research/tests/theme-styles.client.spec.ts \
  packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx \
  packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx \
  packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx \
  packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/data-pages.client.spec.tsx
pnpm run verify-client-theme-styles
```

预期：所有目标测试通过；主题检查没有新增违规。若检查存在基线问题，只能报告与本次差异无关且有证据的既有失败。

- [ ] **步骤 2：运行类型检查和构建**

```bash
cd frontend
pnpm --filter @deepseek-ai/dsh-ui-investment-research typecheck
node_modules/.bin/tsdown --config packages/client/ui-investment-research/tsdown.config.ts
CI=true pnpm run build:web
```

预期：三个命令退出码均为 `0`。

- [ ] **步骤 3：启动独立验证服务**

继续使用当前 worktree 已分配的前端端口 `3180` 和后端端口 `8017`、`8117`、`8217`。若服务已运行，确认其读取当前构建产物；若未运行，使用 `/private/tmp/pa-investment-bc17-dsh-home/verification.cordis.yml` 启动并等待：

```text
http://127.0.0.1:3180/    → 200
http://127.0.0.1:8017/health → 200
http://127.0.0.1:8117/health → 200
http://127.0.0.1:8217/health → 200
```

- [ ] **步骤 4：执行真实产品 UAT**

从侧栏依次进入研究工作台、智能分析、实时盯盘、策略研究和产业链。对每页记录浅色与深色、1440px 与约 1024px 的模块层级；适用页面补查 768px 与 390px。重点确认：

```text
路由表面与大模块可辨
大模块之间为 20px 节奏
内部无连续同强度套框
影子验证成功提示与范围栏至少 12px
焦点、筛选、刷新、空态和错误状态未退化
无意外页面级横向滚动
```

- [ ] **步骤 5：最终差异与服务检查**

```bash
git diff --check
git status --short
lsof -nP -iTCP:3180 -sTCP:LISTEN
lsof -nP -iTCP:8017 -sTCP:LISTEN
lsof -nP -iTCP:8117 -sTCP:LISTEN
lsof -nP -iTCP:8217 -sTCP:LISTEN
```

只报告本轮修改和已验证事实，不提交代码；保持四个监听服务运行，并把 `http://127.0.0.1:3180/` 交给用户继续验收。
