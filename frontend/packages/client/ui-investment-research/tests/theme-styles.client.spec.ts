import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  fileURLToPath(new URL('../src/client/InvestmentShell.module.css', import.meta.url)),
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
})
