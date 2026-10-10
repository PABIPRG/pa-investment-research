// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { App } from '../src/App.tsx'
import { loadBundle, PublicApiError, type PublicBundle } from '../src/api.ts'
vi.mock('../src/api.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/api.ts')>(), loadBundle: vi.fn() }))
vi.mock('../src/EquityChart.tsx', () => ({ EquityChart: () => createElement('div') }))
let container: HTMLDivElement
let root: Root
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!
const seek = () => container.querySelector<HTMLInputElement>('input[aria-label="跳转历史播放日期"]')!
const click = async (label: string) => { await act(async () => { button(label).click() }) }
const dates = ['2026-09-25', '2026-09-28', '2026-10-09']
function fixture(): PublicBundle {
  return {
    from: '2026-07-12', to: '2026-10-09', currency: 'CNY', data_version: 'v1', available_dates: dates,
    history: { from: '2026-07-12', to: '2026-10-09', currency: 'CNY', quality: 'estimated', available_since: dates[0]!, limitations: [], points: dates.map((date, i) => ({ date, value: String(100 + i * 10), profit_loss: String(i * 10) })) },
    frames: dates.map((date, i) => ({ availability: 'available', date, currency: 'CNY', source: 'recorded_holdings', holdings_as_of: date, summary: { holdings_cost: '80', market_value: String(100 + i * 10), floating_profit_loss: String(20 + i * 10), cost_return: String((20 + i * 10) / 80), cash: null, initial_capital: null, total_equity: null }, items: [], freshness: { stale: false, message: null } })),
    calendars: ['2026-09', '2026-10'].map(month => ({ month, days: dates.filter(date => date.startsWith(month)).map(date => ({ date, trading_status: 'trading' })), items: dates.filter(date => date.startsWith(month)).map(date => ({ date, daily_profit_loss: '10' })), limitations: [] })),
    activities_status: 'ready', activities: [{ public_id: 'a'.repeat(24), category: 'operation', status: 'completed', occurred_at: '2026-09-28T10:00:00+08:00', title: '持仓资料更新', summary: '公开记录', related_snapshot_id: null }],
  }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T06:00:00Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.mocked(loadBundle).mockReset().mockResolvedValue(fixture())
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
const mount = async () => { await act(async () => { root.render(createElement(App)) }) }
afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })
it('loads once and skips holidays and gaps in both directions without polling', async () => {
  await mount(); expect(seek().getAttribute('aria-valuetext')).toBe('2026-10-09')
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="前一日"]')!.click() })
  expect(seek().getAttribute('aria-valuetext')).toBe('2026-09-28')
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="后一日"]')!.click() })
  expect(seek().getAttribute('aria-valuetext')).toBe('2026-10-09')
  await act(async () => { vi.advanceTimersByTime(120_000) })
  expect(loadBundle).toHaveBeenCalledTimes(1)
})
it('plays cached frames offline with synchronized amounts and no new reads', async () => {
  await mount(); await click('第一天'); vi.stubGlobal('navigator', { onLine: false })
  await act(async () => { window.dispatchEvent(new Event('offline')) }); await click('播放')
  await act(async () => { vi.advanceTimersByTime(1_200) })
  expect(seek().getAttribute('aria-valuetext')).toBe('2026-09-28')
  expect(container.querySelector('[aria-label="持仓概览"]')!.textContent).toContain('¥110.00')
  await act(async () => { vi.advanceTimersByTime(1_200) })
  expect(seek().getAttribute('aria-valuetext')).toBe('2026-10-09')
  expect(loadBundle).toHaveBeenCalledTimes(1)
})
it('seeks and opens cached details without requests', async () => {
  await mount(); await act(async () => { fireEvent.change(seek(), { target: { value: '0' } }) })
  expect(container.textContent).not.toContain('持仓资料更新')
  await click('最新数据')
  await act(async () => { [...container.querySelectorAll('button')].find(item => item.textContent?.includes('持仓资料更新'))!.click() })
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('公开记录')
  expect(loadBundle).toHaveBeenCalledTimes(1)
})
it('preserves a batch on failure then replaces it and clears old activities', async () => {
  await mount(); vi.mocked(loadBundle).mockRejectedValueOnce(new PublicApiError(503, '服务暂时不可用')); await click('刷新数据')
  expect(container.textContent).toContain('可能已过期')
  expect(container.querySelector('[aria-label="持仓概览"]')!.textContent).toContain('¥120.00')
  const next = fixture(); next.data_version = 'v2'; next.activities = []
  vi.mocked(loadBundle).mockResolvedValue(next); await click('刷新数据')
  expect(container.textContent).not.toContain('可能已过期'); expect(container.textContent).not.toContain('持仓资料更新')
})
it('disables playback for empty and single-date batches', async () => {
  const empty = fixture()
  empty.available_dates = []; empty.frames = []; empty.history.points = []
  empty.calendars.forEach((month) => { month.items = [] })
  vi.mocked(loadBundle).mockResolvedValue(empty); await mount()
  expect(button('播放').disabled).toBe(true); expect(container.textContent).toContain('当前区间暂无可用历史估值')
  const single = fixture()
  single.available_dates = dates.slice(0, 1); single.frames = single.frames.slice(0, 1)
  single.history.points = single.history.points.slice(0, 1)
  vi.mocked(loadBundle).mockResolvedValue(single); await click('刷新数据'); expect(button('播放').disabled).toBe(true)
})
it('keeps explicit historical selection when loading the next day', async () => {
  await mount(); await click('第一天')
  await act(async () => { vi.setSystemTime(new Date('2026-10-11T06:00:00Z')); window.dispatchEvent(new Event('online')) })
  expect(loadBundle).toHaveBeenCalledTimes(2); expect(seek().getAttribute('aria-valuetext')).toBe(dates[0])
})
it('clears retained data when public access is denied', async () => {
  await mount(); vi.mocked(loadBundle).mockRejectedValue(new PublicApiError(403, '公开访问不可用')); await click('刷新数据')
  expect(container.textContent).not.toContain('¥120.00')
})

it('distinguishes market closure, missing records and profit in calendar cells', async () => {
  const data = fixture()
  const month = data.calendars.find(item => item.month === '2026-10')!
  month.days.push({ date: '2026-10-01', trading_status: 'closed' }, { date: '2026-10-08', trading_status: 'trading' })
  vi.mocked(loadBundle).mockResolvedValue(data)
  await mount()
  const cell = (date: string) => container.querySelector<HTMLButtonElement>(`[aria-label^="${date}，"]`)!
  expect(cell('2026-10-01').querySelector('strong')!.textContent).toBe('休市')
  expect(cell('2026-10-01').getAttribute('aria-label')).toBe('2026-10-01，休市')
  expect(cell('2026-10-01').disabled).toBe(true)
  expect(cell('2026-10-08').querySelector('strong')!.textContent).toBe('无记录')
  expect(cell('2026-10-08').disabled).toBe(true)
  expect(cell('2026-10-09').querySelector('strong')!.textContent).toBe('¥10.00')
  expect(cell('2026-10-09').disabled).toBe(false)
  expect(cell('2026-10-02').textContent).toContain('待确认')
  expect(loadBundle).toHaveBeenCalledTimes(1)
})
