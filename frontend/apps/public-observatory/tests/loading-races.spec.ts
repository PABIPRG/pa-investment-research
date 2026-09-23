// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { loadMoreActivities, loadObservatorySlice, PublicApiError, type ObservatorySlice, type PublicActivities } from '../src/api.ts'

vi.mock('../src/api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api.ts')>(),
  loadObservatorySlice: vi.fn(), loadMoreActivities: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
let requests: Array<NonNullable<Parameters<typeof loadObservatorySlice>[3]>>
const page = (title: string, cursor: string | null): PublicActivities => ({
  as_of: '2026-09-21', next_cursor: cursor,
  items: [{ public_id: title, title, summary: '测试操作记录', category: 'operation', status: 'completed', occurred_at: '2026-09-21T10:00:00+08:00' }],
})
const state = (activities: PublicActivities, accountLoading = true): ObservatorySlice => ({
  accountLoading, activitiesLoading: false, account: null, accountUnavailable: { availability: 'unavailable', reason_code: 'missing', message: '缺少资金' }, accountError: null,
  activities, activitiesError: false,
})
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!

it('uses accessible filter menus and clears both active filters together', async () => {
  expect(container.querySelector('select')).toBeNull()
  const select = (label: string) => container.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`)!
  await act(async () => { select('记录类型').click() })
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent === '操作')!.click() })
  expect(loadObservatorySlice).toHaveBeenLastCalledWith(expect.any(String), { category: 'operation', status: 'all' }, expect.any(AbortSignal), expect.any(Function))
  await act(async () => { select('记录状态').click() })
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent === '失败 / 已回滚')!.click() })
  expect(loadObservatorySlice).toHaveBeenLastCalledWith(expect.any(String), { category: 'operation', status: 'failed' }, expect.any(AbortSignal), expect.any(Function))
  await act(async () => { button('清除筛选').click() })
  expect(loadObservatorySlice).toHaveBeenLastCalledWith(expect.any(String), { category: 'all', status: 'all' }, expect.any(AbortSignal), expect.any(Function))
  expect(button('清除筛选')).toBeUndefined()
})

it('shows pending feedback and blocks duplicate operation retries', async () => {
  const failed = { ...state(page('', null), false), activities: null, activitiesError: true }
  await act(async () => { requests[0]!(failed, 'activities'); requests[0]!(failed, 'account') })
  await act(async () => { button('重试记录').click() })
  expect(button('正在重试…').disabled).toBe(true)
  await act(async () => { button('正在重试…').click() })
  expect(requests).toHaveLength(2)
  await act(async () => { requests[1]!(state(page('重试成功的记录', null), false), 'activities') })
  expect(container.textContent).toContain('重试成功的记录')
  expect(container.textContent).not.toContain('操作记录暂时无法读取')
})

it('does not present a failed account request as proof of a missing snapshot', async () => {
  const failed = { ...state(page('独立记录', null), false), accountUnavailable: null, accountError: '账户数据加载失败，请重试。' }
  await act(async () => { requests[0]!(failed, 'activities'); requests[0]!(failed, 'account') })
  expect(container.textContent).toContain('暂时无法确认快照状态')
  expect(container.textContent).not.toContain('尚无可公开的完整账户快照')
  expect(container.textContent).toContain('独立记录')
})

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
})

it('keeps page two when a slow account response completes after operations pagination', async () => {
  const first = state(page('第一页记录', 'cursor-one'))
  await act(async () => { requests[0]!(first, 'activities') })
  vi.mocked(loadMoreActivities).mockResolvedValue(page('第二页记录', null))
  await act(async () => { button('加载更多').click() })
  expect(container.textContent).toContain('第二页记录')
  await act(async () => { requests[0]!({ ...first, accountLoading: false }, 'account') })
  expect(container.textContent).toContain('第二页记录')
  expect(container.textContent).toContain('缺少资金')
})

it('disables stale-cursor pagination during refresh and discards an old page after revocation', async () => {
  const first = state(page('第一页记录', 'cursor-one'), false)
  await act(async () => { requests[0]!(first, 'activities') })
  let finishPage!: (value: PublicActivities) => void
  vi.mocked(loadMoreActivities).mockImplementation(() => new Promise(resolve => { finishPage = resolve }))
  await act(async () => { button('加载更多').click() })
  await act(async () => { button('刷新数据').click() })
  expect(requests).toHaveLength(2)
  expect(button('加载更多').disabled).toBe(true)
  await act(async () => { button('加载更多').click() })
  expect(loadMoreActivities).toHaveBeenCalledTimes(1)
  const revoked = { ...first, activities: { ...first.activities!, items: [], next_cursor: null } }
  await act(async () => { requests[1]!(revoked, 'activities') })
  await act(async () => { finishPage(page('已撤销的第二页记录', null)) })
  expect(container.textContent).not.toContain('已撤销的第二页记录')
  expect(container.textContent).toContain('截至所选日期暂无已公开记录')
})

it('clears expired pages and reloads the first page without retrying the expired cursor', async () => {
  const first = state(page('失效前的记录', 'cursor-one'), false)
  await act(async () => { requests[0]!(first, 'activities') })
  vi.mocked(loadMoreActivities).mockRejectedValue(new PublicApiError(409, '记录范围已更新'))
  await act(async () => { button('加载更多').click() })
  expect(container.textContent).not.toContain('失效前的记录')
  expect(container.textContent).toContain('记录范围已更新，已清除旧分页。')
  expect(requests).toHaveLength(2)
  expect(container.textContent).not.toContain('更多记录加载失败')
  await act(async () => { requests[1]!(state(page('重新读取的记录', null), false), 'activities') })
  expect(container.textContent).toContain('重新读取的记录')
  await act(async () => { requests[1]!(state(page('重新读取的记录', null), false), 'account') })
  expect(container.textContent).toContain('缺少资金')
  expect(loadMoreActivities).toHaveBeenCalledTimes(1)
})
