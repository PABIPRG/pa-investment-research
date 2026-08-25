// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
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
  const sessions = {
    list: { getSnapshot: () => listSnapshot, subscribe: vi.fn(() => () => {}) },
    open: vi.fn(),
    search: vi.fn(async () => ({ ok: true as const, value: { items: [], hasMore: false } })),
    binding: vi.fn(() => ({ session: sessionFace })),
    scope: vi.fn(() => ({})),
  }
  const workspaces = {
    connectWorkspace: vi.fn(async () => 'connected'),
    startSession: vi.fn(),
    startFreshSession: vi.fn(async () => 'fresh'),
    archiveSession: vi.fn(async () => {}),
  }
  const layout = { closeDetails: vi.fn() }
  const setDraft = vi.fn()
  const conversation = { input: { for: vi.fn(() => ({ setDraft })) } }
  const requestData = vi.fn(async () => ({ status: 'ok' }))

  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('layout', layout as never)
  ctx.provide('conversation', conversation as never)
  ctx.provide('investmentResearchRuntimeClient', { requestData } as never)
  return { ctx, slots, sessions, workspaces, layout, setDraft, requestData, rename }
}

describe('ui-investment-research apply', () => {
  it('searches real securities by name and opens the selected stock detail route', async () => {
    const navigate = vi.fn()
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
    } as never))

    const input = view.getByRole('combobox', { name: '搜索 A 股代码或名称' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '茅台' } })

    const option = await view.findByRole('option', { name: /贵州茅台/ })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-search', input: { query: '茅台', limit: 8 },
    })
    fireEvent.click(option)
    expect(navigate).toHaveBeenCalledWith('stock-detail', '600519')
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
    expect(prepareAssistant).toHaveBeenCalledWith(expect.stringContaining('贵州茅台（600519）'))
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
    shell.prepareAssistant('分析贵州茅台')
    expect(b.setDraft).toHaveBeenCalledWith('分析贵州茅台')

    await shell.startSession()
    expect(b.workspaces.startFreshSession).toHaveBeenCalledOnce()

    await shell.openSession('session' as never)
    expect(b.sessions.open).toHaveBeenLastCalledWith('session')

    await shell.renameSession('session' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('renamed')
    await shell.archiveSession('session' as never)
    expect(b.workspaces.archiveSession).toHaveBeenCalledWith('session')
  })
})
