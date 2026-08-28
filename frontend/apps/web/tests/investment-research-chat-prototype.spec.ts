// @vitest-environment jsdom

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const HTML_PATH = resolve(process.cwd(), '../design/prototypes/investment-research-chat.html')
const STORAGE_KEY = 'pa-investment-research.chat-prototype.v1'

async function loadPrototype(): Promise<JSDOM> {
  const html = await readFile(HTML_PATH, 'utf8')
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://prototype.local/',
  })
}

describe('投研对话交互稿', () => {
  it('保留左侧七个产品路由并链接到原交互稿页面', async () => {
    const dom = await loadPrototype()
    const { document } = dom.window
    const navigation = document.querySelector('[data-testid="route-navigation"]')

    expect(document.querySelector('[data-testid="route-sidebar"]')?.classList.contains('sidebar'))
      .toBe(true)
    expect(document.querySelector('.brand-sub')?.textContent)
      .toBe('0.1.0-rc.8 · 智能投研系统')
    expect(navigation?.querySelectorAll('a')).toHaveLength(7)
    expect(navigation?.querySelector('[data-route="ai-assistant"]')?.getAttribute('aria-current'))
      .toBe('page')
    expect(navigation?.querySelector('[data-route="opportunity"]')?.getAttribute('href'))
      .toContain('pages/opportunity.html')
    expect(navigation?.querySelector('[data-route="portfolio"]')?.getAttribute('href'))
      .toContain('pages/portfolio.html')
    expect(navigation?.querySelector('[data-route="opportunity"] .nav-badge')?.textContent)
      .toBe('3个高潜力')
    document.querySelector<HTMLElement>('[data-action="open-workspaces"]')?.click()
    expect(document.querySelector('[data-testid="workspace-modal"]')).not.toBeNull()
    dom.window.close()
  })

  it('左侧系统设置和帮助入口保持可交互', async () => {
    const dom = await loadPrototype()
    const { document } = dom.window

    document.querySelector<HTMLElement>('[data-action="open-settings"]')?.click()
    expect(document.querySelector('[data-testid="settings-modal"]')).not.toBeNull()
    document.querySelector<HTMLElement>('[data-action="close-shell-modal"]')?.click()
    document.querySelector<HTMLElement>('[data-action="open-help"]')?.click()
    expect(document.querySelector('[data-testid="help-modal"]')?.textContent)
      .toContain('投研智能体使用指引')
    dom.window.close()
  })

  it('新建会话并在首条消息后生成标题和助手回复', async () => {
    const dom = await loadPrototype()
    const { document, localStorage } = dom.window

    document.querySelector<HTMLElement>('[data-action="new-conversation"]')?.click()
    const input = document.querySelector<HTMLTextAreaElement>('#composer-input')
    expect(input).not.toBeNull()
    input!.value = '分析当前持仓风险'
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-action="send"]')?.click()
    await new Promise(resolve => dom.window.setTimeout(resolve, 500))

    expect(document.querySelector('[data-testid="current-title"]')?.textContent)
      .toContain('分析当前持仓风险')
    expect(document.querySelectorAll('[data-role="assistant-message"]')).toHaveLength(1)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      conversations?: unknown[]
    }
    expect(saved.conversations).toHaveLength(4)
    dom.window.close()
  })

  it('收起历史面板时仍保留主新建按钮', async () => {
    const dom = await loadPrototype()
    const { document } = dom.window

    document.querySelector<HTMLElement>('[data-action="toggle-history"]')?.click()

    expect(document.querySelector('[data-testid="history-panel"]')?.getAttribute('data-collapsed'))
      .toBe('true')
    expect(document.querySelector('[data-testid="history-marker"]')?.textContent)
      .toContain('历史对话')
    expect(document.querySelector('[data-action="new-conversation"]')).not.toBeNull()
    dom.window.close()
  })

  it('支持重命名和确认删除当前会话', async () => {
    const dom = await loadPrototype()
    const { document } = dom.window
    const active = document.querySelector<HTMLElement>('.conversation-item[aria-current="true"]')
    expect(active).not.toBeNull()

    active!.querySelector<HTMLElement>('[data-action="rename"]')?.click()
    const rename = document.querySelector<HTMLInputElement>('.conversation-rename')
    expect(rename).not.toBeNull()
    rename!.value = '半导体风险复盘'
    rename!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.querySelector('[data-testid="current-title"]')?.textContent)
      .toContain('半导体风险复盘')

    document.querySelector<HTMLElement>('.conversation-item[aria-current="true"] [data-action="delete"]')?.click()
    document.querySelector<HTMLElement>('[data-action="confirm-delete"]')?.click()

    expect(document.querySelectorAll('.conversation-item')).toHaveLength(2)
    dom.window.close()
  })
})
