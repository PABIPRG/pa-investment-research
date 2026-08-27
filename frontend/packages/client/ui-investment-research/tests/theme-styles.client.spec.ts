import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  fileURLToPath(new URL('../src/client/InvestmentShell.module.css', import.meta.url)),
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

  it('让停靠态助理悬浮在业务页上方而不压缩工作台', () => {
    expect(styles).toMatch(/\.assistantPanel\s*\{\s*position:\s*fixed;/)
    expect(styles).not.toMatch(/data-investment-assistant-mode='docked'\]\)\s+\.workbench\s*\{[^}]*right:/)
  })

  it('在投研 profile 隐藏通用访问模式入口', () => {
    expect(styles).toContain(':global(body[data-investment-research-ui]) :global([data-access-mode-trigger]) { display: none; }')
  })

  it('以 14px 根字号和 rem 统一投研及输入框字号', () => {
    expect(baseStyles).toMatch(/html\s*\{\s*font-size:\s*14px;/)
    expect(baseStyles).toContain('font-size: inherit;')
    expect(styles).not.toMatch(/font(?:-size)?:[^;]*\dpx/)
    expect(inputBarStyles).not.toMatch(/font(?:-size)?:[^;]*\dpx/)
    expect(inputBarStyles).toMatch(/\.card\s*\{[^}]*font-size:\s*1rem;/s)
  })

  it('把历史遮罩限制在助理浮层边界内', () => {
    expect(styles).toContain(':global([data-shell-overlay]):has(.historyBackdrop) { z-index: 1100; }')
    expect(styles).toMatch(/\.historyBackdrop\s*\{\s*position:\s*fixed;[^}]*top:\s*68px;[^}]*width:\s*min\(410px,/s)
    expect(styles).toMatch(/data-investment-assistant-mode='expanded'\]\) \.historyBackdrop/)
  })

  it('消费 profile 的隐藏标记并隐藏新对话中的工作区上下文', () => {
    expect(conversationStyles).toContain(":global(body[data-workspace-context-visibility='hidden']) .heroWorkspaceContext")
    expect(conversationStyles).toMatch(
      /:global\(body\[data-workspace-context-visibility='hidden'\]\) \.heroWorkspaceContext\s*\{\s*display:\s*none;/,
    )
  })
})
