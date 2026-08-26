// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import type { InvestmentAssistantRequest } from '../src/client/assistant-context.ts'
import {
  InvestmentBrand,
  InvestmentNewSession,
  InvestmentWelcome,
  InvestmentShell,
  InvestmentSidebar,
  type InvestmentShellInjected,
  type InvestmentSidebarInjected,
} from '../src/client/InvestmentShell.tsx'

afterEach(() => { cleanup() })

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'sidebar.brand': { kind: 'single', scope: 'root' },
      'sidebar.newSession': { kind: 'single', scope: 'root' },
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'conversation.hero.welcome': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)

  const rename = vi.fn(async () => ({ ok: true as const, value: { title: 'renamed', seq: 1 } }))
  const listSnapshot = {
    ids: ['session'],
    byId: {},
    current: 'session',
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
  const sessionFace = {
    rename,
    getSnapshot: () => ({ openState: 'open', openError: null }),
    subscribe: vi.fn(() => () => {}),
  }
  const sessionScopes = new Map([
    ['fresh-1', { id: 'fresh-1' }],
    ['fresh-2', { id: 'fresh-2' }],
    ['fresh-3', { id: 'fresh-3' }],
  ])
  const sessions = {
    list: { getSnapshot: () => listSnapshot, subscribe: vi.fn(() => () => {}) },
    open: vi.fn(),
    search: vi.fn(async () => ({ ok: true as const, value: { items: [], hasMore: false } })),
    binding: vi.fn(() => ({ session: sessionFace })),
    scope: vi.fn((sessionId: string) => sessionScopes.get(sessionId)),
  }
  let freshSessionIndex = 0
  const workspaces = {
    connectWorkspace: vi.fn(async () => 'connected'),
    startSession: vi.fn(),
    startFreshSession: vi.fn(async () => `fresh-${++freshSessionIndex}`),
    archiveSession: vi.fn(async () => {}),
  }
  const layout = { closeDetails: vi.fn() }
  const setDraft = vi.fn()
  const conversation = { input: { for: vi.fn(() => ({ setDraft })) } }
  const requestData = vi.fn(async () => ({ status: 'ok' }))
  const setTheme = vi.fn()
  const theme = {
    getTheme: vi.fn(() => ({ active: { colorScheme: 'light' } })),
    setTheme,
  }

  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('layout', layout as never)
  ctx.provide('theme', theme as never)
  ctx.provide('conversation', conversation as never)
  ctx.provide('investmentResearchRuntimeClient', { requestData } as never)
  return { ctx, slots, sessions, workspaces, layout, theme, conversation, setTheme, setDraft, requestData, rename }
}

describe('ui-investment-research apply', () => {
  it('searches real securities by name and opens the selected stock detail route', async () => {
    const navigate = vi.fn()
    const toggleTheme = vi.fn()
    const requestData = vi.fn(async () => ({
      items: [{ code: '600519', name: '贵州茅台', market: '沪市' }],
    }))
    const view = render(createElement(InvestmentShell, {
      useInvestmentUi: (selector: (snapshot: unknown) => unknown) => selector({
        route: 'assistant', historyOpen: false, stockQuery: '',
      }),
      requestData,
      navigate,
      setHistory: vi.fn(),
      startSession: vi.fn(),
      openSession: vi.fn(),
      searchSessions: vi.fn(),
      renameSession: vi.fn(),
      archiveSession: vi.fn(),
      prepareAssistant: vi.fn(),
      toggleTheme,
    } as never))

    fireEvent.click(view.getByRole('button', { name: '切换深色或浅色模式' }))
    expect(toggleTheme).toHaveBeenCalledOnce()

    const input = view.getByRole('combobox', { name: '搜索 A 股代码或名称' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '茅台' } })

    const option = await view.findByRole('option', { name: /贵州茅台/ })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-search', input: { query: '茅台', limit: 8 },
    })
    fireEvent.click(option)
    expect(navigate).toHaveBeenCalledWith('stock-detail', '600519')
    expect(input.getAttribute('value')).toBe('')
  })

  it('clears a submitted security code and does not refill it from route state', () => {
    const navigate = vi.fn()
    let snapshot = { route: 'dashboard', historyOpen: false, stockQuery: '' }
    const props = {
      useInvestmentUi: (selector: (value: unknown) => unknown) => selector(snapshot),
      requestData: vi.fn(async () => ({ items: [] })),
      navigate,
      setHistory: vi.fn(),
      startSession: vi.fn(),
      openSession: vi.fn(),
      searchSessions: vi.fn(),
      renameSession: vi.fn(),
      archiveSession: vi.fn(),
      prepareAssistant: vi.fn(async () => {}),
    } as never
    const view = render(createElement(InvestmentShell, props))
    const input = view.getByRole('combobox', { name: '搜索 A 股代码或名称' })

    fireEvent.change(input, { target: { value: '600519' } })
    fireEvent.submit(input.closest('form')!)
    expect(navigate).toHaveBeenCalledWith('stock-detail', '600519')
    expect(input.getAttribute('value')).toBe('')

    snapshot = { route: 'stock-detail', historyOpen: false, stockQuery: '600519' }
    view.rerender(createElement(InvestmentShell, props))
    expect(input.getAttribute('value')).toBe('')
  })

  it('opens a fresh assistant panel without leaving the current business route', async () => {
    const prepareAssistant = vi.fn(async (_request: InvestmentAssistantRequest) => {})
    const view = render(createElement(InvestmentShell, {
      useInvestmentUi: (selector: (snapshot: unknown) => unknown) => selector({
        route: 'strategy', historyOpen: false, stockQuery: '',
      }),
      requestData: vi.fn(async () => ({ items: [] })),
      navigate: vi.fn(),
      setHistory: vi.fn(),
      startSession: vi.fn(),
      openSession: vi.fn(),
      searchSessions: vi.fn(),
      renameSession: vi.fn(),
      archiveSession: vi.fn(),
      prepareAssistant,
    } as never))

    fireEvent.click(view.getByRole('button', { name: '打开投研助理' }))
    const panel = await view.findByRole('dialog', { name: '投研助理面板' })
    await waitFor(() => { expect(prepareAssistant).toHaveBeenCalledOnce() })
    expect(prepareAssistant.mock.calls[0]?.[0]).toMatchObject({
      intent: 'overall.research',
      context: { scope: 'overall', module: 'overall', currentRoute: 'strategy' },
    })
    expect(panel.textContent).toContain('整体投研')
    expect(document.body.dataset.investmentAssistantOpen).toBe('')

    fireEvent.click(view.getByRole('button', { name: '关闭投研助理' }))
    expect(view.queryByRole('dialog', { name: '投研助理面板' })).toBeNull()
  })

  it('loads an independent stock detail page and hands the resolved security to the assistant', async () => {
    const prepareAssistant = vi.fn((_request: InvestmentAssistantRequest) => {})
    const requestData = vi.fn(async () => ({
      code: '600519',
      name: '贵州茅台',
      as_of: '2026-08-25 09:30:00',
      quote: { price: 1450, pct_change: 1.2, turnover: 0.5, volume_ratio: 1.1, amount_yi: 12.3 },
      fund_flow_yi: 1.25,
      technical: {
        bars: 120,
        last: { open: 1430, high: 1460, low: 1420, close: 1450 },
        indicators: {
          ma: { ma20: 1410, ma60: 1390 },
          support_resistance: { support: 1380, resistance: 1480 },
        },
        signals: ['MA 多头排列'],
      },
      news: [{ title: '公司发布经营数据', source: '东财', time: '10:00' }],
    }))
    const view = render(createElement(InvestmentShell, {
      useInvestmentUi: (selector: (snapshot: unknown) => unknown) => selector({
        route: 'stock-detail', historyOpen: false, stockQuery: '600519',
      }),
      requestData,
      navigate: vi.fn(),
      setHistory: vi.fn(),
      startSession: vi.fn(),
      openSession: vi.fn(),
      searchSessions: vi.fn(),
      renameSession: vi.fn(),
      archiveSession: vi.fn(),
      prepareAssistant,
    } as never))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'market-watch.security-detail', input: { code: '600519', lookback: 120 },
      })
    })
    expect(await view.findByRole('heading', { name: '贵州茅台 · 600519' })).toBeTruthy()
    expect(view.getByText('MA 多头排列')).toBeTruthy()
    expect(view.getByText('公司发布经营数据')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: '在智能助手中分析' }))
    await waitFor(() => { expect(prepareAssistant).toHaveBeenCalledOnce() })
    const assistantRequest = prepareAssistant.mock.calls[0]?.[0]
    expect(assistantRequest?.question).toContain('贵州茅台（600519）')
    expect(assistantRequest?.context.module).toBe('stock-detail')
    expect(assistantRequest?.context.moduleData.backendSnapshot).toHaveProperty('security')
  })

  it('presents the eight capability domains with the research dashboard first', () => {
    const navigate = vi.fn()
    const view = render(InvestmentSidebar({
      wide: true,
      useInvestmentUi: (selector: (snapshot: unknown) => unknown) => selector({
        route: 'dashboard', historyOpen: false, stockQuery: '',
      }),
      useSessions: (selector: (snapshot: unknown) => unknown) => selector({ current: undefined }),
      useWorkspaces: (selector: (snapshot: unknown) => unknown) => selector({ items: [] }),
      navigate,
      selectWorkspace: vi.fn(),
    } as never))

    const routes = view.getAllByRole('button')
    expect(routes).toHaveLength(8)
    expect(routes[0]?.getAttribute('aria-label')).toBe('研究工作台')
    expect(routes[0]?.getAttribute('aria-current')).toBe('page')
    fireEvent.click(routes[1]!)
    expect(navigate).toHaveBeenCalledWith('analysis')
  })

  it('edits holdings through the backend and refreshes portfolio risk data', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.holdings') return { items: [] }
      if (request.operation === 'trading-core.risk-portfolio') return { summary: { n_positions: 0 }, breaches: [] }
      if (request.operation === 'trading-core.holdings-save') return { saved: 2 }
      return {}
    })
    const view = render(createElement(InvestmentShell, {
      useInvestmentUi: (selector: (snapshot: unknown) => unknown) => selector({
        route: 'portfolio', historyOpen: false, stockQuery: '',
      }),
      requestData,
      navigate: vi.fn(),
      setHistory: vi.fn(),
      startSession: vi.fn(),
      openSession: vi.fn(),
      searchSessions: vi.fn(),
      renameSession: vi.fn(),
      archiveSession: vi.fn(),
      prepareAssistant: vi.fn(),
    } as never))

    expect(await view.findByText('还没有持仓')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '添加持仓' }))
    const dialog = view.getByRole('dialog', { name: '编辑持仓' })
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(view.container.contains(dialog)).toBe(false)
    fireEvent.click(view.getByRole('button', { name: '＋ 添加一行' }))
    fireEvent.click(view.getByRole('button', { name: '＋ 添加一行' }))
    fireEvent.change(view.getByRole('textbox', { name: '第 1 行股票代码' }), { target: { value: '600519' } })
    fireEvent.change(view.getByRole('textbox', { name: '第 1 行持仓数量' }), { target: { value: '100' } })
    fireEvent.change(view.getByRole('textbox', { name: '第 1 行持仓成本' }), { target: { value: '1500' } })
    fireEvent.change(view.getByRole('textbox', { name: '第 2 行股票代码' }), { target: { value: '000858' } })
    fireEvent.change(view.getByRole('textbox', { name: '第 2 行持仓数量' }), { target: { value: '200' } })
    fireEvent.change(view.getByRole('textbox', { name: '第 2 行持仓成本' }), { target: { value: '135' } })
    fireEvent.click(view.getByRole('button', { name: '保存持仓' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save',
        input: {
          holdings: [
            { ticker: '600519', quantity: 100, cost_price: 1500 },
            { ticker: '000858', quantity: 200, cost_price: 135 },
          ],
        },
      })
    })
    expect(await view.findByText('已保存 2 条持仓，组合风险正在刷新。')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings')).toHaveLength(2)
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-portfolio')).toHaveLength(2)
    })
  })

  it('renders an investment welcome without shared DeepSeek branding and prefills a reviewed prompt', () => {
    const onPrompt = vi.fn()
    const view = render(InvestmentWelcome({ disabled: false, onPrompt } as never))
    expect(view.getByText('今天想研究什么？')).toBeTruthy()
    expect(view.queryByText('探索未至之境')).toBeNull()
    expect(view.queryByText('预览版')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /个股研究/ }))
    expect(onPrompt).toHaveBeenCalledWith('分析贵州茅台近期基本面、估值与主要风险')
  })

  it('registers the profile surfaces at explicit shadow and list priorities', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const sidebar = b.slots.entries('sidebar.workspaces')[0]!
    const brand = b.slots.entries('sidebar.brand')[0]!
    const newSession = b.slots.entries('sidebar.newSession')[0]!
    const shell = b.slots.entries('shell.overlay')[0]!
    const welcome = b.slots.entries('conversation.hero.welcome')[0]!
    expect(sidebar.component).toBe(InvestmentSidebar)
    expect(brand.component).toBe(InvestmentBrand)
    expect(brand.options.priority).toBe(-100)
    expect(newSession.component).toBe(InvestmentNewSession)
    expect(newSession.options.priority).toBe(-100)
    expect(sidebar.options.priority).toBe(-100)
    expect(shell.component).toBe(InvestmentShell)
    expect(welcome.component).toBe(InvestmentWelcome)
    expect(welcome.options.priority).toBe(-100)
    expect(shell.options).toMatchObject({ id: 'investment-research-shell', order: -100 })
    expect(document.body.dataset.investmentResearchUi).toBe('')
    expect(document.title).toBe('投研智能体')

    await fiber.dispose()
    expect(document.body.dataset.investmentResearchUi).toBeUndefined()
  })

  it('routes profile actions to the real runtime services', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const sidebar = (b.slots.entries('sidebar.workspaces')[0]!.inject as unknown as () => InvestmentSidebarInjected)()
    const shell = (b.slots.entries('shell.overlay')[0]!.inject as unknown as () => InvestmentShellInjected)()

    await sidebar.selectWorkspace('workspace' as never)
    expect(b.workspaces.connectWorkspace).toHaveBeenCalledWith('workspace')
    expect(b.sessions.open).toHaveBeenCalledWith('connected')

    await expect(shell.requestData({ operation: 'market-watch.overview' })).resolves.toEqual({ status: 'ok' })
    expect(b.requestData).toHaveBeenCalledWith({ operation: 'market-watch.overview' })
    const assistantRequest = {
      intent: 'stock.research',
      question: '分析贵州茅台',
      context: {
        schema: 'investment-research-context/v1',
        scope: 'module',
        module: 'stock-detail',
        moduleLabel: '个股详情',
        currentRoute: 'stock-detail',
        overallData: {},
        moduleData: { backendSnapshot: { security: { code: '600519', name: '贵州茅台' } } },
        unavailable: [],
      },
    } as const
    await shell.prepareAssistant(assistantRequest)
    expect(b.workspaces.startFreshSession).toHaveBeenCalledOnce()
    expect(b.sessions.scope).toHaveBeenLastCalledWith('fresh-1')
    expect(b.conversation.input.for).toHaveBeenLastCalledWith({ id: 'fresh-1' })
    expect(b.setDraft).toHaveBeenCalledWith(expect.stringContaining('"intent": "stock.research"'))
    expect(b.setDraft).toHaveBeenCalledWith(expect.stringContaining('"name": "贵州茅台"'))
    await shell.prepareAssistant({ ...assistantRequest, intent: 'portfolio.risk', question: '分析组合风险' })
    expect(b.workspaces.startFreshSession).toHaveBeenCalledTimes(2)
    expect(b.sessions.scope).toHaveBeenLastCalledWith('fresh-2')
    expect(b.conversation.input.for).toHaveBeenLastCalledWith({ id: 'fresh-2' })
    expect(b.setDraft).toHaveBeenLastCalledWith(expect.stringContaining('"question": "分析组合风险"'))

    await shell.startSession()
    expect(b.workspaces.startFreshSession).toHaveBeenCalledTimes(3)

    await shell.openSession('session' as never)
    expect(b.sessions.open).toHaveBeenLastCalledWith('session')

    await shell.renameSession('session' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('renamed')
    await shell.archiveSession('session' as never)
    expect(b.workspaces.archiveSession).toHaveBeenCalledWith('session')

    shell.toggleTheme()
    expect(b.setTheme).toHaveBeenCalledWith('dark')
    b.theme.getTheme.mockReturnValue({ active: { colorScheme: 'dark' } })
    shell.toggleTheme()
    expect(b.setTheme).toHaveBeenLastCalledWith('light')
  })
})
