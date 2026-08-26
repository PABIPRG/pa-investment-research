// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import {
  InvestmentBrand,
  InvestmentNewSession,
  InvestmentWelcome,
  InvestmentShell,
  InvestmentSidebar,
  type InvestmentShellInjected,
} from '../src/client/InvestmentShell.tsx'
import type { InvestmentUiSnapshot } from '../src/client/state.ts'

afterEach(() => {
  cleanup()
  delete document.body.dataset.investmentWorkbenchActive
  delete document.body.dataset.investmentAssistantMode
})

const UI_SNAPSHOT: InvestmentUiSnapshot = {
  route: 'portfolio',
  historyOpen: false,
  reportsOpen: false,
  assistantMode: 'closed',
  assistantModule: 'general',
  analysisQuery: '',
  backtestQuery: '',
  watchQuery: '',
  chainQuery: '',
  selectedStockCode: '',
  selectedStrategyId: '',
}

function useUi(overrides: Partial<InvestmentUiSnapshot> = {}) {
  const snapshot = { ...UI_SNAPSHOT, ...overrides }
  return (selector: (value: InvestmentUiSnapshot) => unknown) => selector(snapshot)
}

async function bench(options: { emptyFirstRun?: boolean } = {}) {
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
    ids: options.emptyFirstRun === true ? [] : ['session'],
    byId: {},
    current: options.emptyFirstRun === true ? undefined : 'session',
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
  const sessions = {
    list: { getSnapshot: () => listSnapshot, subscribe: vi.fn(() => () => {}) },
    open: vi.fn(),
    search: vi.fn(async () => ({ ok: true as const, value: { items: [], hasMore: false } })),
    binding: vi.fn(() => ({ session: sessionFace })),
    scope: vi.fn(() => ({})),
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: options.emptyFirstRun === true ? [] : [{ workspaceId: 'workspace' }],
        archivedSessionIds: [],
        state: 'idle', phase: 'ready', error: null, baselinesReady: true,
        recentWorkspaceId: options.emptyFirstRun === true ? undefined : 'workspace',
      }),
      subscribe: vi.fn(() => () => {}),
    },
    connectWorkspace: vi.fn(async () => 'connected'),
    startSession: vi.fn(),
    startFreshSession: vi.fn(async () => 'fresh'),
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
  return { ctx, slots, sessions, workspaces, layout, theme, setTheme, setDraft, requestData, rename }
}

describe('ui-investment-research apply', () => {
  it('keeps the business workbench mounted while the global assistant changes display mode', () => {
    const props = {
      requestData: vi.fn(async () => ({ items: [] })),
      navigate: vi.fn(), setHistory: vi.fn(), setReports: vi.fn(), setModuleDraft: vi.fn(), selectStrategy: vi.fn(),
      startSession: vi.fn(), openSession: vi.fn(), searchSessions: vi.fn(), renameSession: vi.fn(),
      archiveSession: vi.fn(), prepareAssistant: vi.fn(), toggleTheme: vi.fn(),
    }
    const view = render(createElement(InvestmentShell, {
      ...props,
      useInvestmentUi: useUi({ route: 'portfolio' }),
    } as never))
    expect(document.body.dataset.investmentWorkbenchActive).toBe('')

    view.rerender(createElement(InvestmentShell, {
      ...props,
      useInvestmentUi: useUi({ route: 'analysis', assistantMode: 'docked' }),
    } as never))
    expect(document.body.dataset.investmentWorkbenchActive).toBeUndefined()
    expect(view.getByTestId('analysis-workbench')).toBeTruthy()
    expect(view.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
  })

  it('searches real securities by name and opens the selected stock detail route', async () => {
    const navigate = vi.fn()
    const toggleTheme = vi.fn()
    const requestData = vi.fn(async () => ({
      items: [{ code: '600519', name: '贵州茅台', market: '沪市' }],
    }))
    const view = render(createElement(InvestmentShell, {
      useInvestmentUi: useUi({ route: 'assistant' }),
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
    expect(navigate).toHaveBeenCalledWith('stock-detail', { stockCode: '600519' })
  })

  it('loads an independent stock detail page and hands the resolved security to the assistant', async () => {
    const prepareAssistant = vi.fn()
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
      useInvestmentUi: useUi({ route: 'stock-detail', selectedStockCode: '600519' }),
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

    fireEvent.click(view.getByRole('button', { name: '带入智能分析' }))
    expect(prepareAssistant).toHaveBeenCalledWith({ kind: 'stock', code: '600519', name: '贵州茅台' })
  })

  it('presents six first-level business entries and keeps shadow validation inside strategy research', () => {
    const navigate = vi.fn()
    const view = render(InvestmentSidebar({
      wide: true,
      useInvestmentUi: useUi({ route: 'portfolio' }),
      navigate,
    } as never))

    const routes = view.getAllByRole('button')
    expect(routes.map(route => route.getAttribute('aria-label'))).toEqual([
      '研究工作台', '智能分析', '实时盯盘', '策略研究', '自进化', '我的投研', '产业链',
    ])
    expect(routes[5]?.getAttribute('aria-current')).toBe('page')
    expect(view.queryByText('工作区')).toBeNull()
    fireEvent.click(routes[3]!)
    expect(navigate).toHaveBeenCalledWith('framework')
  })

  it('imports pasted holdings through the backend and refreshes portfolio risk data', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.holdings') return { items: [] }
      if (request.operation === 'trading-core.risk-portfolio') return { summary: { n_positions: 0 }, breaches: [] }
      if (request.operation === 'trading-core.risk-alerts') return { items: [] }
      if (request.operation === 'trading-core.holdings-save') return { saved: 2 }
      return {}
    })
    const view = render(createElement(InvestmentShell, {
      useInvestmentUi: useUi({ route: 'portfolio' }),
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

    expect(await view.findByText(/尚未保存持仓/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '导入持仓' }))
    const dialog = view.getByRole('dialog', { name: '导入持仓' })
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(view.container.contains(dialog)).toBe(false)
    fireEvent.change(view.getByRole('textbox', { name: '持仓导入内容' }), {
      target: { value: '股票代码,数量,成本价\n600519,100,1500\n000858,200,135' },
    })

    expect(view.getByText('导入预览')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '替换并导入 2 条' }))

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
    expect(await view.findByText('已导入 2 条持仓，持仓与风险数据已刷新。')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings')).toHaveLength(2)
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-portfolio')).toHaveLength(2)
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-alerts')).toHaveLength(2)
    })
  })

  it('keeps stock analysis, historical backtest and global search inputs independent', () => {
    const setModuleDraft = vi.fn()
    const prepareAssistant = vi.fn()
    const requestData = vi.fn(async () => ({ items: [] }))
    const view = render(createElement('div', null,
      createElement(InvestmentShell, {
        useInvestmentUi: useUi({ route: 'analysis' }),
        requestData,
        navigate: vi.fn(),
        setHistory: vi.fn(),
        setReports: vi.fn(),
        setAssistantMode: vi.fn(),
        setAssistantModule: vi.fn(),
        setModuleDraft,
        selectStrategy: vi.fn(),
        startSession: vi.fn(),
        openSession: vi.fn(),
        searchSessions: vi.fn(),
        renameSession: vi.fn(),
        archiveSession: vi.fn(),
        prepareAssistant,
        toggleTheme: vi.fn(),
      } as never),
      createElement(InvestmentWelcome, { disabled: false, onPrompt: vi.fn() } as never),
    ))
    expect(view.getByText('AI 研究助理')).toBeTruthy()
    expect(view.getByTestId('analysis-workbench')).toBeTruthy()
    expect(view.queryByText('探索未至之境')).toBeNull()
    expect(view.queryByText('预览版')).toBeNull()

    const globalSearch = view.getByRole('combobox', { name: '搜索 A 股代码或名称' })
    const analysisInput = view.getByRole('textbox', { name: '个股分析股票代码' })
    const backtestInput = view.getByRole('textbox', { name: '历史回测股票代码' })
    fireEvent.change(globalSearch, { target: { value: '贵州茅台' } })
    expect((analysisInput as HTMLInputElement).value).toBe('')
    expect((backtestInput as HTMLInputElement).value).toBe('')
    fireEvent.change(analysisInput, { target: { value: '600519' } })
    fireEvent.change(backtestInput, { target: { value: '000001' } })
    expect((globalSearch as HTMLInputElement).value).toBe('贵州茅台')
    expect(setModuleDraft).toHaveBeenCalledWith('analysisQuery', '600519')
    expect(setModuleDraft).toHaveBeenCalledWith('backtestQuery', '000001')

    fireEvent.click(view.getAllByRole('button', { name: '查看模块详情' })[0]!)
    expect(view.getByRole('dialog', { name: '个股多智能体分析' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '用此模块打开 AI 助理' }))
    expect(prepareAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prompt' }),
      'stock',
    )
  })

  it('exposes one global report entry on every module and opens the report center', async () => {
    const setReports = vi.fn()
    const closed = render(createElement(InvestmentShell, {
      useInvestmentUi: useUi({ route: 'framework' }),
      requestData: vi.fn(async () => ({ items: [] })),
      navigate: vi.fn(), setHistory: vi.fn(), setReports, setModuleDraft: vi.fn(), selectStrategy: vi.fn(),
      startSession: vi.fn(), openSession: vi.fn(), searchSessions: vi.fn(), renameSession: vi.fn(),
      archiveSession: vi.fn(), prepareAssistant: vi.fn(), toggleTheme: vi.fn(),
    } as never))
    fireEvent.click(closed.getByRole('button', { name: '投研报告' }))
    expect(setReports).toHaveBeenCalledWith(true)
    closed.unmount()

    const requestData = vi.fn(async () => ({ items: [] }))
    render(createElement(InvestmentShell, {
      useInvestmentUi: useUi({ route: 'assistant', reportsOpen: true }),
      requestData,
      navigate: vi.fn(), setHistory: vi.fn(), setReports: vi.fn(), setModuleDraft: vi.fn(), selectStrategy: vi.fn(),
      startSession: vi.fn(), openSession: vi.fn(), searchSessions: vi.fn(), renameSession: vi.fn(),
      archiveSession: vi.fn(), prepareAssistant: vi.fn(), toggleTheme: vi.fn(),
    } as never))
    expect(await screen.findByRole('dialog', { name: '投研报告' })).toBeTruthy()
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.reports', input: { limit: 100 } })
    })
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
    expect(document.body.dataset.workspaceContextVisibility).toBe('hidden')
    expect(document.title).toBe('投研智能体')

    await fiber.dispose()
    expect(document.body.dataset.investmentResearchUi).toBeUndefined()
    expect(document.body.dataset.workspaceContextVisibility).toBeUndefined()
  })

  it('routes profile actions to the real runtime services', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const shell = (b.slots.entries('shell.overlay')[0]!.inject as unknown as () => InvestmentShellInjected)()

    await expect(shell.requestData({ operation: 'market-watch.overview' })).resolves.toEqual({ status: 'ok' })
    expect(b.requestData).toHaveBeenCalledWith({ operation: 'market-watch.overview' })
    shell.prepareAssistant({ kind: 'portfolio' })
    expect(b.setDraft).toHaveBeenCalledWith(expect.stringContaining('investment_context 工具读取 portfolio 上下文'))
    expect(b.setDraft.mock.calls[0]?.[0]).not.toContain('{')

    await shell.startSession()
    expect(b.workspaces.startFreshSession).toHaveBeenCalledOnce()
    expect(b.workspaces.startFreshSession).toHaveBeenLastCalledWith(
      undefined,
      { fallbackToHostCwd: true },
    )
    expect(b.setDraft).toHaveBeenLastCalledWith('')

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

  it('bootstraps a first conversation without exposing a Workspace requirement', async () => {
    const b = await bench({ emptyFirstRun: true })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    await waitFor(() => {
      expect(b.workspaces.startFreshSession).toHaveBeenCalledWith(
        undefined,
        { fallbackToHostCwd: true },
      )
    })
    await fiber.dispose()
  })
})
