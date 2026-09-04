import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  fileURLToPath(new URL('../src/client/InvestmentShell.module.css', import.meta.url)),
  'utf8',
)
const analysisPageSource = readFileSync(
  fileURLToPath(new URL('../src/client/AnalysisPage.tsx', import.meta.url)),
  'utf8',
)
const researchWorkbenchSource = readFileSync(
  fileURLToPath(new URL('../src/client/ResearchWorkbenchPage.tsx', import.meta.url)),
  'utf8',
)
const investmentShellSource = readFileSync(
  fileURLToPath(new URL('../src/client/InvestmentShell.tsx', import.meta.url)),
  'utf8',
)
const productPagesSource = readFileSync(
  fileURLToPath(new URL('../src/client/ProductPages.tsx', import.meta.url)),
  'utf8',
)
const conversationStyles = readFileSync(
  fileURLToPath(new URL('../../ui-conversation/src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
)
const inputBarStyles = readFileSync(
  fileURLToPath(new URL('../../ui-conversation/src/client/skeleton/InputBar.module.css', import.meta.url)),
  'utf8',
)
const baseStyles = readFileSync(
  fileURLToPath(new URL('../../web/src/base.css', import.meta.url)),
  'utf8',
)
const design = readFileSync(
  fileURLToPath(new URL('../../../../../DESIGN.md', import.meta.url)),
  'utf8',
)

describe('投研工作台主题样式', () => {
  it('只通过语义 token 映射投研专用颜色', () => {
    expect(styles).toContain('--investment-primary: var(--dsw-alias-state-business-primary)')
    expect(styles).toContain('--investment-sidebar: var(--dsw-specific-sidebar-fill)')
    expect(styles).toContain('--dsw-alias-state-warn-tertiary')
    expect(styles).not.toContain('data-ds-dark-theme')
    expect(styles).not.toContain('--dsw-static-')
    expect(styles).not.toContain('--dsw-alias-state-warning-')
  })

  it('主题快捷按钮不在组件样式中创建深浅模式分支', () => {
    expect(styles).toContain('.themeIcon')
    expect(styles).not.toContain('.moonIcon')
    expect(styles).not.toContain('.sunIcon')
  })

  it('让持仓浮窗在应用模态层覆盖完整视口', () => {
    expect(styles).toContain('.drawerBackdrop.importBackdrop { position: fixed; z-index: 1000;')
  })

  it('详情和报告使用同一模态层级，由后打开的 Portal 自然置顶', () => {
    expect(styles).toMatch(/\.detailBackdrop\s*\{[^}]*z-index:\s*1000;/s)
    expect(styles).toMatch(/\.reportBackdrop\s*\{[^}]*z-index:\s*1000;/s)
  })

  it('让停靠态助理悬浮在业务页上方而不压缩工作台', () => {
    expect(styles).toMatch(/\.assistantPanel\s*\{\s*position:\s*fixed;/)
    expect(styles).not.toMatch(/data-investment-assistant-mode='docked'\]\)\s+\.workbench\s*\{[^}]*right:/)
  })

  it('在投研 profile 隐藏通用访问模式入口', () => {
    expect(styles).toContain(':global(body[data-investment-research-ui]) :global([data-access-mode-trigger]) { display: none; }')
  })

  it('让展开的投研导航容器贴齐侧栏左边缘且不叠加左侧内边距', () => {
    expect(styles).toContain(
      '.sidebarRegion:not(.sidebarRegionCompact) { margin-left: calc(-1 * var(--dsh-sidebar-inline-padding));',
    )
    expect(styles).not.toContain('padding-left: calc(8px + var(--dsh-sidebar-inline-padding));')
  })

  it('不使用左侧深色竖条表达选中、错误或警告状态', () => {
    expect(styles).not.toMatch(/box-shadow:\s*inset\s+3px\s+0\s+0/)
    expect(styles).not.toMatch(/border-left:\s*[2-9]px/)
  })

  it('以 14px 根字号和 rem 统一投研及输入框字号', () => {
    expect(baseStyles).toMatch(/html\s*\{\s*font-size:\s*14px;/)
    expect(baseStyles).toContain('font-size: inherit;')
    expect(styles).not.toMatch(/font(?:-size)?:[^;]*\dpx/)
    expect(inputBarStyles).not.toMatch(/font(?:-size)?:[^;]*\dpx/)
    expect(inputBarStyles).toMatch(/\.card\s*\{[^}]*font-size:\s*1rem;/s)
  })

  it('持仓卡片按容器宽度降列，并为名称保留独立布局行', () => {
    expect(styles).toMatch(
      /\.dashboardHoldingList\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*280px\),\s*1fr\)\);/s,
    )
    expect(styles).toMatch(
      /\.dashboardHoldingList button\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    )
    expect(styles).toMatch(/\.dashboardHoldingList button > span:last-child\s*\{[^}]*text-align:\s*left;/s)
  })

  it('自进化看板保留模块边界，但用分隔线代替策略条目的嵌套外框', () => {
    expect(styles).toMatch(/\.evolutionDashboard\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-1\);/s)
    expect(styles).toMatch(/\.evolutionDashboard \.moduleCard\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);/s)
    expect(styles).toMatch(/\.evolutionDashboard \.dataList:has\(> \.strategyEntry\)\s*\{[^}]*border:\s*0;/s)
    expect(styles).toMatch(/\.evolutionDashboard \.strategyEntry\s*\{[^}]*border:\s*0;/s)
    expect(styles).toMatch(/\.evolutionDashboard \.strategyEntry \+ \.strategyEntry\s*\{[^}]*border-top:\s*1px solid var\(--dsw-alias-border-l2\);/s)
  })

  it('持仓弹窗使用清晰的内容底色、表格层级和危险操作语义', () => {
    expect(styles).toMatch(/\.detailDialogBody\s*\{[^}]*background:\s*var\(--dsw-alias-bg-base\);/s)
    expect(styles).toMatch(/\.workbenchOverviewTableWrap\s*\{[^}]*border:\s*1px solid var\(--dsw-alias-border-l2\);[^}]*background:\s*var\(--dsw-alias-bg-base\);/s)
    expect(styles).toMatch(/\.workbenchOverviewTable thead th\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-2\);/s)
    expect(styles).toMatch(/\.workbenchHoldingActions button\[aria-label\^='删除 '\]\s*\{[^}]*color:\s*var\(--dsw-alias-state-error-primary\);/s)
  })

  it('为指定一级路由建立统一的页面与大模块层级', () => {
    expect(styles).not.toContain('--investment-route-canvas')
    expect(styles).toMatch(/\.primaryRouteSurface\s*\{[^}]*display:\s*grid;[^}]*grid-auto-rows:\s*max-content;[^}]*gap:\s*20px;[^}]*background:\s*var\(--dsw-alias-bg-layer-1\);/s)
    expect(styles).toMatch(/\.primaryRouteSurface > \.pageHeader\s*\{[^}]*margin-bottom:\s*0;[^}]*border-bottom:\s*1px solid var\(--dsw-alias-border-l2\);/s)
    expect(styles).toMatch(/\.primaryRouteSurface > \.moduleGrid\s*\{[^}]*gap:\s*20px;/s)
  })

  it('让五个指定一级路由显式接入共享视觉契约', () => {
    const sharedRoot = /className=\{`\$\{css\.pageScroll\} \$\{css\.primaryRouteSurface\}`\}/u
    expect(researchWorkbenchSource).toMatch(sharedRoot)
    expect(analysisPageSource).toMatch(sharedRoot)
    expect(investmentShellSource.slice(investmentShellSource.indexOf('export function OpportunityPage'))).toMatch(sharedRoot)
    const strategySource = productPagesSource.slice(
      productPagesSource.indexOf('export function StrategyResearchPage'),
      productPagesSource.indexOf('export function ShadowValidationPage'),
    )
    const industrySource = productPagesSource.slice(productPagesSource.indexOf('export function IndustryChainPage'))
    expect(strategySource).toMatch(sharedRoot)
    expect(industrySource).toMatch(sharedRoot)
  })

  it('强化五个路由的大模块边界并避免影子验证连续套框', () => {
    expect(styles).not.toContain('.primaryRouteSurface .moduleCard {')
    expect(styles).toMatch(/\.primaryRouteSurface \.strategyCard\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);[^}]*background:\s*var\(--dsw-alias-bg-base\);/s)
    expect(styles).toMatch(/\.primaryRouteSurface \.strategyCard\.reportItemActive\s*\{[^}]*border-color:\s*var\(--investment-primary\);[^}]*background:\s*var\(--investment-selected-surface\);/s)
    expect(styles).toMatch(/\.primaryRouteSurface :is\(\.dashboardPanel, \.analysisOverview > div, \.analysisModuleCard\)\s*\{[^}]*padding:\s*16px;[^}]*border-color:\s*var\(--dsw-alias-border-l2\);[^}]*border-radius:\s*12px;[^}]*box-shadow:\s*none;/s)
    expect(styles).toMatch(/\.primaryRouteSurface :is\(\.marketOverview, \.cardList, \.marketNewsPanel\)\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);/s)
    expect(styles).toMatch(/\.primaryRouteSurface :is\(\.industrySearchPanel, \.industryChainPanel, \.industryImpactPanel\)\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);/s)
    expect(styles).toMatch(/\.primaryRouteSurface \.embeddedShadow\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);[^}]*border-radius:\s*12px;[^}]*box-shadow:\s*none;/s)
    expect(styles).toMatch(/\.primaryRouteSurface \.shadowRunSummary\s*\{[^}]*border:\s*0;/s)
    expect(styles).toMatch(/\.shadowScopeBar \+ \.importNotice\s*\{[^}]*margin-top:\s*12px;/s)
  })

  it('在产品设计规范中固化一级路由模块层级', () => {
    expect(design).toContain('## 一级路由模块层级')
    expect(design).toContain('连续两层相同强度的完整边框')
    expect(design).toContain('至少 `12px`')
    expect(design).toContain('1440px 和 1024px')
  })

  it('把历史遮罩限制在助理浮层边界内', () => {
    expect(styles).toContain(':global([data-shell-overlay]):has(.historyBackdrop) { z-index: 1100; }')
    expect(styles).toMatch(/\.historyBackdrop\s*\{\s*position:\s*fixed;[^}]*top:\s*68px;[^}]*width:\s*min\(410px,/s)
    expect(styles).toMatch(/data-investment-assistant-mode='expanded'\]\) \.historyBackdrop/)
  })

  it('为聊天主界面和输入框上下文控件使用语义 token', () => {
    expect(styles).toContain(':global(body[data-investment-conversation-primary])')
    expect(styles).toContain('.researchContextControls')
    expect(styles).toContain('.researchContextPopover')
    expect(styles).not.toMatch(/\.researchContext(?:Controls|Popover)[^{]*\{[^}]*#[0-9a-f]{3,8}/isu)
  })

  it('模块选择器在两种外观下共享箭头过渡并尊重减少动态效果偏好', () => {
    expect(styles).toContain('.assistantModuleMenuRoot { min-width: 0; max-width: 180px; }')
    expect(styles).not.toMatch(/\.assistantModuleMenuRoot\s*\{[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(
      /\.assistantModuleTrigger\s*\{[^}]*box-sizing:\s*border-box;[^}]*max-width:\s*100%;/u,
    )
    expect(styles).toMatch(
      /\.assistantModuleTrigger > i, \.researchContextTrigger > i \{[^}]*transition: transform 120ms ease;/u,
    )
    const reducedMotion = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotion).toMatch(
      /:is\([^)]*\.assistantModuleTrigger > i[^)]*\.researchContextTrigger > i[^)]*\) \{ transition: none; \}/u,
    )
  })

  it('消费 profile 的隐藏标记并隐藏新对话中的工作区上下文', () => {
    expect(conversationStyles).toContain(":global(body[data-workspace-context-visibility='hidden']) .heroWorkspaceContext")
    expect(conversationStyles).toMatch(
      /:global\(body\[data-workspace-context-visibility='hidden'\]\) \.heroWorkspaceContext\s*\{\s*display:\s*none;/,
    )
  })
})
