// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useSecurityNames } from '../src/client/security-names.ts'
import { cacheSecurityNames, readSecurityNames } from '../src/client/security-name-cache.ts'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

type Request = (request: InvestmentDataRequest) => Promise<unknown>
function Names({ request, known }: { request: Request; known?: Record<string, string> }) {
  const names = useSecurityNames(request, ['002131'], known)
  return <p>{names['002131'] === undefined ? '名称加载中' : names['002131'] || '名称暂不可用'}</p>
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers() })

it('损坏或禁用的浏览器缓存不阻塞真实名称查询', async () => {
  localStorage.setItem('investment-research.security-names.v1', '{invalid')
  expect(readSecurityNames()).toEqual({})
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  const request = vi.fn().mockResolvedValue({ items: [{ code: '002131', name: '利欧股份' }] })
  render(<Names request={request} />)
  expect(await screen.findByText('利欧股份')).toBeTruthy()
})

it('只缓存有效的公开名称并限制为最近 512 条', () => {
  cacheSecurityNames({ '002131': '', '123': '无效代码', '600000': '600000' })
  expect(readSecurityNames()).toEqual({})
  cacheSecurityNames(Object.fromEntries(Array.from({ length: 513 }, (_, i) => [String(100000 + i), `证券${i}`])))
  expect(Object.keys(readSecurityNames())).toHaveLength(512)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 1)
  cacheSecurityNames({ '002131': '利欧股份' })
  expect(readSecurityNames()['002131']).toBe('利欧股份')
  expect(Object.keys(readSecurityNames())).toHaveLength(512)
})

it('查询失败保持有限重试，失败结果不持久化', async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockRejectedValue(new Error('offline'))
  const view = render(<Names request={request} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(request).toHaveBeenCalledTimes(3)
  expect(screen.getByText('名称暂不可用')).toBeTruthy()
  expect(readSecurityNames()).toEqual({})
  view.unmount()
  request.mockResolvedValue({ items: [{ code: '002131', name: '利欧股份' }] })
  render(<Names request={request} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByText('利欧股份')).toBeTruthy()
})

it('查到的名称在重新挂载后立即复用，不再请求目录', async () => {
  const request = vi.fn().mockResolvedValue({ items: [{ code: '002131', name: '利欧股份' }] })
  const view = render(<Names request={request} />)
  await screen.findByText('利欧股份')
  view.unmount()
  const slow = vi.fn(() => new Promise(() => {}))
  render(<Names request={slow} />)
  expect(screen.getByText('利欧股份')).toBeTruthy()
  expect(slow).not.toHaveBeenCalled()
})

it('已知行情名称也被缓存，并覆盖旧名称', async () => {
  const request = vi.fn().mockResolvedValue({ items: [] })
  const view = render(<Names request={request} known={{ '002131': '利欧股份' }} />)
  await screen.findByText('利欧股份')
  view.rerender(<Names request={request} known={{ '002131': '新证券名称' }} />)
  await screen.findByText('新证券名称')
  view.unmount()
  render(<Names request={request} />)
  expect(screen.getByText('新证券名称')).toBeTruthy()
  expect(request).not.toHaveBeenCalled()
})

it('超过 24 小时的缓存重新查询，代码不作为名称缓存', async () => {
  const now = Date.now()
  const date = vi.spyOn(Date, 'now').mockReturnValue(now)
  const request = vi.fn().mockResolvedValue({ items: [{ code: '002131', name: '利欧股份' }] })
  const view = render(<Names request={request} />)
  await screen.findByText('利欧股份')
  view.unmount()
  date.mockReturnValue(now + 24 * 60 * 60 * 1000 + 1)
  request.mockResolvedValue({ items: [{ code: '002131', name: '002131' }] })
  render(<Names request={request} />)
  expect(screen.getByText('名称加载中')).toBeTruthy()
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(screen.queryByText('002131')).toBeNull()
})
