// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { loadMoreActivities, loadObservatorySlice, PublicApiError, type ObservatorySlice } from '../src/api.ts'

vi.mock('../src/api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api.ts')>(),
  loadObservatorySlice: vi.fn(), loadMoreActivities: vi.fn(),
}))
vi.mock('../src/EquityChart.tsx', () => ({ EquityChart: () => createElement('div', { 'data-testid': 'history-chart' }) }))
let container: HTMLDivElement
let root: Root
let requests: Array<NonNullable<Parameters<typeof loadObservatorySlice>[3]>>
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!
const activity = (title: string, cursor: string | null) => ({
  as_of: '2026-09-29', next_cursor: cursor,
  items: title ? [{ public_id: title, title, summary: '公开记录', category: 'operation' as const, status: 'completed' as const, occurred_at: '2026-09-29T10:00:00+08:00' }] : [],
})
const live = {
  availability: 'available' as const, date: '2026-09-29', currency: 'CNY' as const, source: 'current_holdings' as const, holdings_as_of: '2026-09-29',
  summary: { holdings_cost: '100.00', market_value: '120.00', floating_profit_loss: '20.00', cost_return: '0.20000000', cash: null, initial_capital: null, total_equity: null },
  items: [{ ticker: '600519', name: '甲', quantity: '1', cost_price: '100', market_price: '120', market_value: '120.00', profit_loss: '20.00', return_rate: '0.20000000' }],
  freshness: { stale: false, message: null },
}
function state(title: string, cursor: string | null = null): ObservatorySlice {
  return {
    liveLoading: false, historyLoading: false, calendarLoading: false, activitiesLoading: false,
    live, liveError: false,
    history: { from: '2026-09-01', to: '2026-09-29', currency: 'CNY', quality: 'estimated', limitations: [], available_since: '2026-09-01', points: [] }, historyError: false,
    calendar: { month: '2026-09', items: [], days: [], limitations: [] }, calendarError: false,
    activities: activity(title, cursor), activitiesError: false,
  }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  requests = []
  vi.mocked(loadObservatorySlice).mockImplementation((_date, _filters, _signal, progress) => {
    requests.push(progress!)
    return new Promise(() => {})
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(App)) })
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('previews history with a seekable progress bar without reloading every frame', async () => {
  const current = state('持仓记录')
  current.history = { ...current.history!, points: [
    { date: '2026-09-21', value: '100.00', profit_loss: '0.00' },
    { date: '2026-09-22', value: '110.00', profit_loss: '10.00' },
    { date: '2026-09-23', value: '120.00', profit_loss: '20.00' },
  ] }
  await act(async () => { requests[0]!(current, 'history') })
  vi.useFakeTimers()
  await act(async () => { button('播放').click() })
  expect(container.textContent).toContain('预览 2026.09.21')
  expect(container.querySelector('input[aria-label="跳转历史播放日期"]')).not.toBeNull()
  await act(async () => { vi.advanceTimersByTime(1_200) })
  expect(container.textContent).toContain('预览 2026.09.22')
  expect(requests).toHaveLength(1)
  await act(async () => { button('暂停').click() })
  expect(requests).toHaveLength(2)
  expect(container.textContent).toContain('预览 2026.09.22')
})

it('retains the same query result with an explicit stale notice after refresh failure', async () => {
  await act(async () => { requests[0]!(state('原有记录'), 'live'); requests[0]!(state('原有记录'), 'activities') })
  await act(async () => { button('刷新数据').click() })
  expect(requests).toHaveLength(2)
  await act(async () => { requests[1]!({ ...state(''), live: null, liveError: true }, 'live') })
  expect(container.textContent).toContain('¥120.00')
  expect(container.textContent).toContain('可能已过期')
  expect(container.textContent).toContain('原有记录')
})

it('discards an old page after activity scope changes and preserves the new first page', async () => {
  await act(async () => { requests[0]!(state('第一页', 'cursor-one'), 'activities') })
  let finish!: (value: ReturnType<typeof activity>) => void
  vi.mocked(loadMoreActivities).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await act(async () => { button('加载更多').click() })
  await act(async () => { button('刷新数据').click() })
  await act(async () => { requests[1]!(state('新第一页'), 'activities') })
  await act(async () => { finish(activity('旧第二页', null)) })
  expect(container.textContent).toContain('新第一页')
  expect(container.textContent).not.toContain('旧第二页')
})

it('clears expired pagination and reloads after a revoked cursor', async () => {
  await act(async () => { requests[0]!(state('原第一页', 'cursor-one'), 'activities') })
  vi.mocked(loadMoreActivities).mockRejectedValue(new PublicApiError(409, '游标过期'))
  await act(async () => { button('加载更多').click() })
  expect(container.textContent).toContain('记录范围已更新')
  expect(container.textContent).not.toContain('原第一页')
  expect(requests).toHaveLength(2)
})
