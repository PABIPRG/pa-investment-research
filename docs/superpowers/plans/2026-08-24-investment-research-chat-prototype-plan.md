# 投研对话交互稿实施计划

> **面向智能体执行者：** 必须使用 `superpowers:executing-plans` 按任务执行，并使用 `superpowers:test-driven-development` 完成测试先行循环。每个步骤使用复选框跟踪。

**目标：** 交付一个可直接打开的单文件投研对话 HTML 交互稿，支持右侧可收起历史记录、新建与管理会话，以及 `localStorage` 持久化。

**架构：** HTML 文件内联 CSS、SVG 图标、演示数据与 JavaScript，不加载外部资源。页面状态集中在一个 `PrototypeState` 对象中，所有用户操作先更新状态、再保存、最后重绘对应区域；Vitest 通过 jsdom 加载真实 HTML 并操作 DOM。

**技术栈：** HTML5、CSS、原生 JavaScript、`localStorage`、Vitest、jsdom。

**规格：** `docs/superpowers/specs/2026-08-24-investment-research-chat-prototype-design.md`

## 全局约束

- 交互稿只有对话模块，不出现其他投研模块导航。
- 交付物必须是单文件 HTML，不发起网络请求。
- “新对话”始终是可见的蓝色主操作。
- 历史记录位于右侧，桌面端在 `288px` 面板与 `48px` 窄轨之间切换，移动端使用右侧抽屉。
- 新建、切换、搜索、重命名、删除、草稿与当前选择保存在 `pa-investment-research.chat-prototype.v1`。

---

### 任务 1：用真实 DOM 固定交互行为

**文件：**

- 新建：`frontend/apps/web/tests/investment-research-chat-prototype.spec.ts`
- 验证目标：`design/prototypes/investment-research-chat.html`

**接口：**

- 消费：浏览器原生 DOM、`localStorage` 与事件 API。
- 产出：对新建会话、自动标题、切换、收起历史面板、重命名和删除行为的可重复测试。

- [ ] **步骤 1：编写失败测试**

```ts
// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const HTML_PATH = resolve(process.cwd(), '../design/prototypes/investment-research-chat.html')

async function loadPrototype() {
  const html = await readFile(HTML_PATH, 'utf8')
  return new JSDOM(html, { runScripts: 'dangerously', url: 'https://prototype.local/' })
}

describe('投研对话交互稿', () => {
  it('新建会话并在首条消息后生成标题和助手回复', async () => {
    const dom = await loadPrototype()
    const { document, localStorage } = dom.window
    document.querySelector<HTMLElement>('[data-action="new-conversation"]')!.click()
    const input = document.querySelector<HTMLTextAreaElement>('#composer-input')!
    input.value = '分析当前持仓风险'
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-action="send"]')!.click()
    await new Promise(resolve => dom.window.setTimeout(resolve, 500))
    expect(document.querySelector('[data-testid="current-title"]')?.textContent).toContain('分析当前持仓风险')
    expect(document.querySelectorAll('[data-role="assistant-message"]')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('pa-investment-research.chat-prototype.v1')!).conversations).toHaveLength(4)
  })

  it('收起历史面板时仍保留主新建按钮', async () => {
    const dom = await loadPrototype()
    const { document } = dom.window
    document.querySelector<HTMLElement>('[data-action="toggle-history"]')!.click()
    expect(document.querySelector('[data-testid="history-panel"]')?.getAttribute('data-collapsed')).toBe('true')
    expect(document.querySelector('[data-action="new-conversation"]')).not.toBeNull()
  })

  it('支持重命名和确认删除当前会话', async () => {
    const dom = await loadPrototype()
    const { document } = dom.window
    const active = document.querySelector<HTMLElement>('.conversation-item[aria-current="true"]')!
    active.querySelector<HTMLElement>('[data-action="rename"]')!.click()
    const rename = document.querySelector<HTMLInputElement>('.conversation-rename')!
    rename.value = '半导体风险复盘'
    rename.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.querySelector('[data-testid="current-title"]')?.textContent).toContain('半导体风险复盘')
    document.querySelector<HTMLElement>('.conversation-item[aria-current="true"] [data-action="delete"]')!.click()
    document.querySelector<HTMLElement>('[data-action="confirm-delete"]')!.click()
    expect(document.querySelectorAll('.conversation-item')).toHaveLength(2)
  })
})
```

- [ ] **步骤 2：运行测试并确认因交互稿缺失而失败**

运行：`pnpm exec vitest run apps/web/tests/investment-research-chat-prototype.spec.ts`

预期：失败并报告无法读取 `design/prototypes/investment-research-chat.html`。

### 任务 2：实现单文件 HTML 并完成视觉验证

**文件：**

- 新建：`design/prototypes/investment-research-chat.html`
- 验证：`frontend/apps/web/tests/investment-research-chat-prototype.spec.ts`

**接口：**

- 消费：任务 1 固定的 DOM 选择器、交互行为与存储键。
- 产出：可直接打开的独立 HTML 交互稿。

- [ ] **步骤 1：实现最小可用页面**

在 HTML 内实现以下状态更新入口。所有入口通过 `commit()` 保存并重绘，存储失败时保留内存状态：

```js
const activeConversation = () => state.conversations.find(item => item.id === state.activeConversationId)

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    storageWarning = false
  } catch {
    storageWarning = true
  }
}

function commit() {
  persistState()
  render()
}

function createConversation() {
  const now = new Date().toISOString()
  const conversation = { id: uid(), title: '新对话', titleSource: 'automatic', createdAt: now, updatedAt: now, draft: '', messages: [] }
  state.conversations.unshift(conversation)
  state.activeConversationId = conversation.id
  commit()
}

function selectConversation(id) {
  state.activeConversationId = id
  mobileHistoryOpen = false
  commit()
}

function renameConversation(id, title) {
  const conversation = state.conversations.find(item => item.id === id)
  if (!conversation || !title.trim()) return
  conversation.title = title.trim()
  conversation.titleSource = 'manual'
  conversation.updatedAt = new Date().toISOString()
  commit()
}

function confirmDeleteConversation(id) {
  state.conversations = state.conversations.filter(item => item.id !== id)
  if (state.conversations.length === 0) return createConversation()
  if (state.activeConversationId === id) state.activeConversationId = state.conversations[0].id
  pendingDeleteId = null
  commit()
}

function updateDraft(value) {
  const conversation = activeConversation()
  if (!conversation) return
  conversation.draft = value
  persistState()
}

function sendMessage(text) {
  const conversation = activeConversation()
  const content = text.trim()
  if (!conversation || !content) return
  const now = new Date().toISOString()
  conversation.messages.push({ id: uid(), role: 'user', content, createdAt: now })
  conversation.draft = ''
  conversation.updatedAt = now
  if (conversation.titleSource === 'automatic') conversation.title = content.slice(0, 24)
  commit()
  window.setTimeout(() => {
    conversation.messages.push({ id: uid(), role: 'assistant', content: replyFor(content), createdAt: new Date().toISOString() })
    conversation.updatedAt = new Date().toISOString()
    commit()
  }, 320)
}

function toggleHistory() {
  state.historyCollapsed = !state.historyCollapsed
  commit()
}
```

页面必须包含 `[data-action="new-conversation"]`、`[data-testid="history-panel"]`、`#composer-input`、`[data-action="send"]`、`[data-testid="current-title"]` 和 `.conversation-item`，并使用内联 CSS 实现规格中的桌面、窄桌面和移动布局。

- [ ] **步骤 2：运行聚焦测试并确认通过**

运行：`pnpm exec vitest run apps/web/tests/investment-research-chat-prototype.spec.ts`

预期：3 个测试全部通过，输出无错误与警告。

- [ ] **步骤 3：通过本地静态服务器进行桌面视觉检查**

运行：`python3 -m http.server 4173 --bind 127.0.0.1`

在浏览器打开 `http://127.0.0.1:4173/design/prototypes/investment-research-chat.html`，检查顶栏、主对话区、右侧面板、收起窄轨、新建会话、重命名和删除。

- [ ] **步骤 4：检查移动布局和持久化**

将浏览器视口改为窄屏，确认历史记录变为右侧抽屉、页面无横向溢出；刷新页面，确认当前会话、草稿与面板状态恢复。

- [ ] **步骤 5：运行格式与差异检查**

运行：`git diff --check -- design/prototypes/investment-research-chat.html frontend/apps/web/tests/investment-research-chat-prototype.spec.ts docs/superpowers/plans/2026-08-24-investment-research-chat-prototype-plan.md`

预期：退出码为 0。
