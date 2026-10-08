// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { loadCalendar, loadHistory, loadMoreActivities, loadObservatorySlice, PublicApiError, type ObservatorySlice } from '../src/api.ts'

vi.mock('../src/api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api.ts')>(),
  loadObservatorySlice: vi.fn(), loadMoreActivities: vi.fn(), loadHistory: vi.fn(), loadCalendar: vi.fn(),
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
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-29T06:00:00Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  requests = []
  vi.mocked(loadHistory).mockResolvedValue({ ...state('').history!, to: '2026-09-28', points: [
    { date: '2026-09-21', value: '100.00', profit_loss: '0.00' },
    { date: '2026-09-22', value: '110.00', profit_loss: '10.00' },
    { date: '2026-09-23', value: '120.00', profit_loss: '20.00' },
  ] })
  vi.mocked(loadCalendar).mockResolvedValue(state('').calendar!)
  vi.mocked(loadObservatorySlice).mockImplementation((_date, _filters, _signal, progress) => {
    return new Promise((resolve) => {
      const finished = new Set<string>()
      requests.push((slice, part) => {
        progress!(slice, part)
        finished.add(part)
        if (finished.has('live') && finished.has('activities')) resolve(slice)
      })
    })
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('synchronizes all summary amounts with each playback date and waits for a slow frame', async () => {
  await act(async () => { requests[0]!(state('持仓记录'), 'live') })
  await act(async () => { button('播放').click() })
  expect(container.textContent).toContain('预览 2026.09.21')
  expect(container.querySelector('input[aria-label="跳转历史播放日期"]')).not.toBeNull()
  const summary = () => container.querySelector('[aria-label="持仓概览"]')!.textContent
  expect(summary()).toContain('截至 2026.09.21')
  expect(summary()).not.toContain('¥120.00')
  await act(async () => { vi.advanceTimersByTime(5_000) })
  expect(container.textContent).toContain('预览 2026.09.21')
  const frame = state('持仓记录')
  frame.live = { ...live, date: '2026-09-21', summary: { ...live.summary, holdings_cost: '80.00', market_value: '100.00', floating_profit_loss: '20.00', cost_return: '0.25' } }
  await act(async () => { requests[1]!(frame, 'live') })
  for (const value of ['¥80.00', '¥100.00', '¥20.00', '25.00%']) expect(summary()).toContain(value)
  await act(async () => { vi.advanceTimersByTime(1_200) })
  expect(container.textContent).toContain('预览 2026.09.22')
  frame.live = { ...live, date: '2026-09-22', summary: { ...live.summary, holdings_cost: '200.00', market_value: '180.00', floating_profit_loss: '-20.00', cost_return: '-0.10' } }
  await act(async () => { requests[2]!(frame, 'live') })
  for (const value of ['¥200.00', '¥180.00', '-¥20.00', '-10.00%']) expect(summary()).toContain(value)
  expect(loadHistory).toHaveBeenCalledTimes(1)
  expect(loadCalendar).toHaveBeenCalledTimes(1)
  await act(async () => { button('暂停').click() })
  await act(async () => { vi.advanceTimersByTime(5_000) })
  expect(requests).toHaveLength(3)
  expect(container.textContent).toContain('预览 2026.09.22')
  await act(async () => { button('继续').click(); vi.advanceTimersByTime(1_200) })
  await act(async () => { vi.advanceTimersByTime(1_200) })
  expect(container.textContent).toContain('预览 2026.09.23')
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
  vi.mocked(loadMoreActivities).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
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


it('shows each module refresh independently while retaining data without refresh banners', async () => {
  await act(async () => {
    for (const part of ['live', 'history', 'calendar', 'activities'] as const) requests[0]!(state('原有记录'), part)
  })
  let finishHistory!: () => void
  vi.mocked(loadHistory).mockImplementation(() => new Promise((resolve) => { finishHistory = () => { resolve(state('').history!) } }))
  vi.mocked(loadCalendar).mockImplementation(() => new Promise(() => {}))
  await act(async () => { button('刷新数据').click() })
  const loading = () => [...container.querySelectorAll('[data-refresh-indicator][data-loading="true"]')]
  expect(loading()).toHaveLength(5)
  expect(container.textContent).toContain('原有记录')
  expect(container.textContent).not.toContain('正在刷新')
  await act(async () => { finishHistory() })
  expect(loading()).toHaveLength(4)
  expect(container.querySelector('[data-refresh-indicator="历史表现"]')?.getAttribute('data-loading')).toBe('false')
  expect(container.querySelector('[data-refresh-indicator="日历"]')?.getAttribute('data-loading')).toBe('true')
  await act(async () => { requests[1]!(state('原有记录'), 'live') })
  expect(loading()).toHaveLength(2)
})

it('polls only live modules and refreshes T+1 data at the Shanghai day boundary', async () => {
  await act(async () => { requests[0]!(state('持仓记录'), 'live'); requests[0]!(state('持仓记录'), 'activities') })
  await act(async () => { vi.advanceTimersByTime(15_000) })
  expect(loadObservatorySlice).toHaveBeenCalledTimes(2)
  expect(loadObservatorySlice).toHaveBeenLastCalledWith('2026-09-29', { category: 'all', status: 'all' }, expect.any(AbortSignal), expect.any(Function), ['live', 'activities'])
  expect(loadHistory).toHaveBeenCalledTimes(1)
  expect(loadCalendar).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-refresh-indicator="历史表现"]')?.getAttribute('data-loading')).toBe('false')
  vi.setSystemTime(new Date('2026-09-29T15:59:45Z'))
  await act(async () => { vi.advanceTimersByTime(30_000) })
  expect(loadHistory).toHaveBeenCalledTimes(2)
  expect(loadHistory).toHaveBeenLastCalledWith('2026-07-02', '2026-09-29', expect.any(AbortSignal))
  expect(loadCalendar).toHaveBeenLastCalledWith('2026-09', expect.any(AbortSignal), '2026-09-29')
})

it('does not replace a slow activity request when holdings have finished', async () => {
  await act(async () => { requests[0]!(state(''), 'live') })
  await act(async () => { vi.advanceTimersByTime(45_000) })
  expect(loadObservatorySlice).toHaveBeenCalledTimes(1)
  await act(async () => { requests[0]!(state('迟到记录'), 'activities') })
  await act(async () => { vi.advanceTimersByTime(14_999) })
  expect(loadObservatorySlice).toHaveBeenCalledTimes(1)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(loadObservatorySlice).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('迟到记录')
})

it('backs off a partial live failure, keeps its warning through retry and resets on success', async () => {
  await act(async () => { requests[0]!(state('原记录'), 'live'); requests[0]!(state('原记录'), 'activities') })
  await act(async () => { vi.advanceTimersByTime(15_000) })
  const failure = { ...state('原记录'), live: null, liveError: true }
  await act(async () => { requests[1]!(failure, 'live'); requests[1]!(failure, 'activities') })
  await act(async () => { vi.advanceTimersByTime(29_999) })
  expect(requests).toHaveLength(2)
  expect(container.textContent).toContain('¥120.00')
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(requests).toHaveLength(3)
  expect(container.textContent).toContain('可能已过期')
  await act(async () => { requests[2]!(state('新记录'), 'live'); requests[2]!(state('新记录'), 'activities') })
  expect(container.textContent).not.toContain('可能已过期')
  await act(async () => { vi.advanceTimersByTime(15_000) })
  expect(requests).toHaveLength(4)
})

it('automatically recovers failed history without reloading a successful calendar', async () => {
  await act(async () => { requests[0]!(state('原记录'), 'live'); requests[0]!(state('原记录'), 'activities') })
  vi.mocked(loadHistory).mockRejectedValueOnce(new Error('temporary outage'))
  await act(async () => { button('刷新数据').click() })
  expect(container.textContent).toContain('历史表现刷新失败')
  const calendarReads = vi.mocked(loadCalendar).mock.calls.length
  await act(async () => { vi.advanceTimersByTime(30_000) })
  expect(container.textContent).not.toContain('历史表现刷新失败')
  expect(loadHistory).toHaveBeenCalledTimes(3)
  expect(loadCalendar).toHaveBeenCalledTimes(calendarReads)
  await act(async () => { vi.advanceTimersByTime(120_000) })
  expect(loadHistory).toHaveBeenCalledTimes(3)
})

it('pauses in the background and offline, then resumes without reloading T+1 data', async () => {
  await act(async () => { requests[0]!(state('原记录'), 'live'); requests[0]!(state('原记录'), 'activities') })
  let online = true
  let visible = false
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60_000) })
  expect(requests).toHaveLength(1)
  online = false; visible = true
  await act(async () => { window.dispatchEvent(new Event('offline')); document.dispatchEvent(new Event('visibilitychange')) })
  await act(async () => { vi.advanceTimersByTime(60_000) })
  expect(container.textContent).toContain('网络已断开 · 自动刷新暂停')
  expect(requests).toHaveLength(1)
  online = true
  await act(async () => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(0) })
  expect(requests).toHaveLength(2)
  expect(loadHistory).toHaveBeenCalledTimes(1)
  expect(loadCalendar).toHaveBeenCalledTimes(1)
})

it('follows the current day after returning across midnight and keeps polling the new date', async () => {
  await act(async () => { requests[0]!(state('原记录'), 'live'); requests[0]!(state('原记录'), 'activities') })
  let visible = false
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  vi.setSystemTime(new Date('2026-09-29T16:01:00Z'))
  visible = true
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await act(async () => { vi.advanceTimersByTime(0) })
  expect(container.querySelector('[aria-label="持仓概览"]')!.textContent).toContain('截至 2026.09.30')
  expect(loadObservatorySlice).toHaveBeenCalledTimes(2)
  expect(vi.mocked(loadObservatorySlice).mock.calls[1]![0]).toBe('2026-09-30')
  expect(loadHistory).toHaveBeenLastCalledWith('2026-07-02', '2026-09-29', expect.any(AbortSignal))
  await act(async () => { requests[1]!(state('新记录'), 'live'); requests[1]!(state('新记录'), 'activities') })
  await act(async () => { vi.advanceTimersByTime(15_000) })
  expect(loadObservatorySlice).toHaveBeenCalledTimes(3)
})

it.each(['historical', 'disabled'])('preserves the selected date across midnight when %s', async (mode) => {
  if (mode === 'historical') {
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="前一日"]')!.click() })
  } else {
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
  }
  vi.setSystemTime(new Date('2026-09-29T16:01:00Z'))
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(container.querySelector('[aria-label="持仓概览"]')!.textContent).toContain(mode === 'historical' ? '截至 2026.09.28' : '截至 2026.09.29')
})

it('discards the previous playback date response and advances past unavailable dates', async () => {
  await act(async () => { button('播放').click() })
  const oldFrame = requests[1]!
  await act(async () => { button('当日').click() })
  await act(async () => { oldFrame({ ...state(''), live: { ...live, date: '2026-09-21' } }, 'live') })
  expect(container.querySelector('[aria-label="持仓概览"]')!.textContent).not.toContain('¥120.00')
  await act(async () => { requests[2]!(state(''), 'live') })
  await act(async () => { button('播放').click() })
  await act(async () => { requests[3]!({ ...state(''), live: { availability: 'unavailable', reason_code: 'missing', message: '所选日期没有持仓记录。' } }, 'live') })
  expect(container.querySelector('[aria-label="持仓概览"]')!.textContent).not.toContain('¥120.00')
  await act(async () => { vi.advanceTimersByTime(1_200) })
  expect(container.textContent).toContain('预览 2026.09.22')
})

it('keeps the displayed calendar month when an older month finishes late or a refresh fails', async () => {
  const pending = new Map<string, (value: NonNullable<ObservatorySlice['calendar']>) => void>()
  vi.mocked(loadCalendar).mockImplementation(month => new Promise((resolve) => { pending.set(month, resolve) }))
  const pickMonth = async (name: string) => {
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label^="选择月份"]')!.click() })
    await act(async () => { [...document.querySelectorAll('button')].find(item => item.textContent === name)!.click() })
  }
  await pickMonth('八月')
  await pickMonth('十月')
  const october = { ...state('').calendar!, month: '2026-10', items: [{ date: '2026-10-01', daily_profit_loss: '25.00' }] }
  await act(async () => { pending.get('2026-10')!(october) })
  await act(async () => { pending.get('2026-08')!({ ...state('').calendar!, month: '2026-08' }) })
  expect(container.querySelector('[aria-label="每日盈亏日历"]')!.textContent).toContain('¥25.00')
  await act(async () => { requests[0]!(state(''), 'live'); requests[0]!(state(''), 'activities') })
  vi.mocked(loadCalendar).mockRejectedValue(new Error('offline'))
  await act(async () => { button('刷新数据').click() })
  expect(loadCalendar).toHaveBeenLastCalledWith('2026-10', expect.any(AbortSignal), '2026-09-28')
  expect(container.querySelector('[aria-label="每日盈亏日历"]')!.textContent).toContain('¥25.00')
  expect(container.textContent).toContain('日历刷新失败，当前显示上次结果，可能已过期。')
})
