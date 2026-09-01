// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SecurityResearchContent } from '../src/client/SecurityResearchContent.tsx'
import { createResearchResourceStore } from '../src/client/research-resource.ts'
import type { ResearchResourceStore } from '../src/client/research-resource.ts'

type Props = ComponentProps<typeof SecurityResearchContent>
type RequestData = Props['requestData']

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function techKey(code: string): string {
  return JSON.stringify({ operation: 'market-watch.tech-signal', code, lookback: 120 })
}

function securityNewsKey(code: string): string {
  return JSON.stringify({ operation: 'market-watch.security-news', code, limit: 8 })
}

function requestCode(request: Parameters<RequestData>[0]): string {
  return typeof request.input?.code === 'string' ? request.input.code : ''
}

const MARKET_NEWS_KEY = JSON.stringify({
  operation: 'market-watch.news-flash', limit: 12, enrich: false, personal: false,
})

function readyTech(code: string, signal = `信号-${code}`, asOf = '2026-08-31 10:00:00') {
  return {
    status: 'ready', code, as_of: asOf, stale: false, bars: 120,
    indicators: { support_resistance: { support: 10.25, resistance: 12.75 }, ma: { ma20: 11.2 } },
    signals: [signal],
  }
}

function readyNews(code: string, title = `资讯-${code}`) {
  return {
    status: 'ready', code, as_of: '2026-08-31 10:01:00', stale: false, complete: true,
    items: [{ id: `${code}-1`, title, source: '测试资讯源', time: '10:01' }],
  }
}

function defaultRequestData(): ReturnType<typeof vi.fn<RequestData>> {
  return vi.fn<RequestData>((request) => {
    if (request.operation === 'market-watch.tech-signal') {
      return Promise.resolve(readyTech(requestCode(request)))
    }
    if (request.operation === 'market-watch.security-news') {
      return Promise.resolve(readyNews(requestCode(request)))
    }
    if (request.operation === 'market-watch.news-flash') {
      return Promise.resolve({ status: 'ready', as_of: '2026-08-31 10:02:00', items: [] })
    }
    throw new Error(`unexpected operation ${request.operation}`)
  })
}

function renderContent(overrides: Partial<Props> = {}) {
  const props: Props = {
    subject: {
      code: '920223', name: '荣亿精密',
      quote: { price: 12.34, pctChange: 1.25, volumeRatio: 2.4, amountYi: 3.6 },
    },
    requestData: defaultRequestData(),
    resources: createResearchResourceStore(),
    active: true,
    onAnalyze: vi.fn(),
    onOpenFullDetail: vi.fn(),
    ...overrides,
  }
  return { props, view: render(<SecurityResearchContent {...props} />) }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SecurityResearchContent', () => {
  it('immediately renders the quote and starts code-owned technical and security-news requests in parallel', async () => {
    const technical = deferred<unknown>()
    const securityNews = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return technical.promise
      if (request.operation === 'market-watch.security-news') return securityNews.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })

    expect(screen.getByRole('heading', { name: '荣亿精密' })).toBeTruthy()
    expect(screen.getByText('12.34')).toBeTruthy()
    expect(screen.getByText('+1.25%')).toBeTruthy()
    expect(screen.getByText('2.40')).toBeTruthy()
    expect(screen.getByText('3.60 亿')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '个股相关' }).getAttribute('aria-selected')).toBe('true')
    expect(requestData).toHaveBeenCalledTimes(2)
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.tech-signal', input: { code: '920223', lookback: 120 },
    })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-news', input: { code: '920223', limit: 8 },
    })
    expect(requestData.mock.calls.some(([request]) => request.operation === 'market-watch.news-flash')).toBe(false)

    await act(async () => {
      technical.resolve(readyTech('920223'))
      securityNews.resolve(readyNews('920223'))
    })
  })

  it('uses placeholders for missing quote fields', async () => {
    renderContent({ subject: { code: '000001', name: '平安银行', quote: {} } })

    const quote = screen.getByRole('region', { name: '行情摘要' })
    expect(within(quote).getAllByText('—')).toHaveLength(4)
    await screen.findByText('信号-000001')
  })

  it('resolves a blank display name without changing the technical or news request owner', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('000001'))
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('000001'))
      if (request.operation === 'market-watch.security-search') {
        return Promise.resolve({ items: [{ code: '000001', name: '平安银行', market: '深市' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData, subject: { code: '000001', name: '   ' } })

    expect(await screen.findByRole('heading', { name: '平安银行' })).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-search', input: { query: '000001', limit: 8 },
    })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.tech-signal', input: { code: '000001', lookback: 120 },
    })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-news', input: { code: '000001', limit: 8 },
    })
  })

  it('loads the global market-news key lazily once and reuses it across security changes', async () => {
    const requestData = defaultRequestData()
    const resources = createResearchResourceStore()
    const read = vi.spyOn(resources, 'read')
    const first = renderContent({ requestData, resources })
    await screen.findByText('资讯-920223')
    expect(requestData.mock.calls.some(([request]) => request.operation === 'market-watch.news-flash')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: '市场快讯' }))
    expect(await screen.findByText('不特指当前证券')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.news-flash')).toHaveLength(1)
    })
    expect(read.mock.calls.some(([key]) => key === MARKET_NEWS_KEY)).toBe(true)
    expect(MARKET_NEWS_KEY).not.toContain('920223')

    first.view.rerender(<SecurityResearchContent
      {...first.props}
      subject={{ code: '600519', name: '贵州茅台' }}
    />)
    await screen.findByText('信号-600519')
    expect(screen.getByText('不特指当前证券')).toBeTruthy()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.news-flash')).toHaveLength(1)
  })

  it('shows a security-specific empty result without mixing in market news', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('920223'))
      if (request.operation === 'market-watch.security-news') {
        return Promise.resolve({ status: 'ready', code: '920223', as_of: '2026-08-31 10:01:00', items: [] })
      }
      if (request.operation === 'market-watch.news-flash') {
        return Promise.resolve({ items: [{ id: 'market-1', title: '全市场快讯不应混入' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })

    expect(await screen.findByText('暂无与该证券直接关联的资讯')).toBeTruthy()
    expect(screen.queryByText('全市场快讯不应混入')).toBeNull()
    expect(requestData.mock.calls.some(([request]) => request.operation === 'market-watch.news-flash')).toBe(false)
  })

  it('keeps the B title, technical result and security news when A settles last', async () => {
    const aTechnical = deferred<unknown>()
    const aNews = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      const code = requestCode(request)
      if (code === '000001' && request.operation === 'market-watch.tech-signal') return aTechnical.promise
      if (code === '000001' && request.operation === 'market-watch.security-news') return aNews.promise
      if (code === '600519' && request.operation === 'market-watch.tech-signal') {
        return Promise.resolve(readyTech(code, 'B 技术信号'))
      }
      if (code === '600519' && request.operation === 'market-watch.security-news') {
        return Promise.resolve(readyNews(code, 'B 个股资讯'))
      }
      throw new Error(`unexpected request ${request.operation} ${code}`)
    })
    const resources = createResearchResourceStore()
    const first = renderContent({
      requestData,
      resources,
      subject: { code: '000001', name: 'A 股票' },
    })

    first.view.rerender(<SecurityResearchContent
      {...first.props}
      subject={{ code: '600519', name: 'B 股票' }}
    />)
    expect(await screen.findByText('B 技术信号')).toBeTruthy()
    expect(await screen.findByText('B 个股资讯')).toBeTruthy()

    await act(async () => {
      aTechnical.resolve(readyTech('000001', 'A 晚到技术'))
      aNews.resolve(readyNews('000001', 'A 晚到资讯'))
    })

    expect(screen.getByRole('heading', { name: 'B 股票' })).toBeTruthy()
    expect(screen.getByText('B 技术信号')).toBeTruthy()
    expect(screen.getByText('B 个股资讯')).toBeTruthy()
    expect(screen.queryByText('A 晚到技术')).toBeNull()
    expect(screen.queryByText('A 晚到资讯')).toBeNull()
    expect(resources.peek(techKey('000001'))).toEqual(readyTech('000001', 'A 晚到技术'))
    expect(resources.peek(securityNewsKey('000001'))).toEqual(readyNews('000001', 'A 晚到资讯'))
  })

  it('keeps security news visible when the technical region fails', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.reject(new Error('technical transport failed'))
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223', '独立显示的个股资讯'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })

    expect(await screen.findByText('独立显示的个股资讯')).toBeTruthy()
    const technical = screen.getByRole('region', { name: '技术信号' })
    expect(within(technical).getByRole('alert').textContent).toContain('技术信号暂不可用')
    expect(within(technical).getByRole('alert').textContent).toContain('technical transport failed')
  })

  it('keeps security news visible when the independently lazy market region fails', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('920223'))
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223', '仍然可见的个股资讯'))
      if (request.operation === 'market-watch.news-flash') return Promise.reject(new Error('market news failed'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    await screen.findByText('仍然可见的个股资讯')
    fireEvent.click(screen.getByRole('tab', { name: '市场快讯' }))
    expect((await screen.findByRole('alert')).textContent).toContain('市场快讯暂不可用')
    fireEvent.click(screen.getByRole('tab', { name: '个股相关' }))
    expect(screen.getByText('仍然可见的个股资讯')).toBeTruthy()
  })

  it('continues a preparing technical result automatically on the same key until ready', async () => {
    vi.useFakeTimers()
    const second = deferred<unknown>()
    const technicalFlights: unknown[] = [
      { status: 'preparing', code: '920223', retry_after_ms: 1500, message: '技术信号正在准备' },
      second.promise,
    ]
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(technicalFlights.shift())
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <StrictMode>
        <SecurityResearchContent
          subject={{ code: '920223', name: '荣亿精密' }}
          requestData={requestData}
          resources={createResearchResourceStore()}
          active
          onAnalyze={() => {}}
          onOpenFullDetail={() => {}}
        />
      </StrictMode>,
    )
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('技术信号准备中')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试技术信号' })).toBeNull()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1499) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(2)

    await act(async () => {
      second.resolve(readyTech('920223', '自动完成信号', '2026-08-31 10:03:00'))
      await Promise.resolve()
    })
    expect(screen.getByText('自动完成信号')).toBeTruthy()
    expect(screen.getByText('10.25')).toBeTruthy()
    expect(screen.getByText('2026-08-31 10:03:00')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(2)
  })

  it('keeps the last ready technical content and original fact time while a refresh is preparing', async () => {
    vi.useFakeTimers()
    const resources = createResearchResourceStore()
    const oldReady = readyTech('920223', '旧 ready 信号', '2026-08-30 15:00:00')
    const newReady = readyTech('920223', '刷新完成信号', '2026-08-31 10:08:00')
    let technicalCalls = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        technicalCalls += 1
        return Promise.resolve(technicalCalls === 1 ? oldReady : newReady)
      }
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData, resources })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('旧 ready 信号')).toBeTruthy()
    await act(async () => {
      resources.invalidate(techKey('920223'))
      await resources.read(techKey('920223'), async () => ({
        status: 'preparing', code: '920223', retry_after_ms: 1000,
      }))
    })

    expect(screen.getByText('旧 ready 信号')).toBeTruthy()
    expect(screen.getByText('缓存 · 2026-08-30 15:00:00')).toBeTruthy()
    expect(screen.getByText('技术信号准备中')).toBeTruthy()
    expect(screen.getByText('10.25')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('刷新完成信号')).toBeTruthy()
    expect(screen.getByText('2026-08-31 10:08:00')).toBeTruthy()
    expect(screen.queryByText('旧 ready 信号')).toBeNull()
  })

  it('keeps retained preparing content isolated by technical key across A to B to A', async () => {
    vi.useFakeTimers()
    const resources = createResearchResourceStore()
    const requestData = vi.fn<RequestData>((request) => {
      const code = requestCode(request)
      if (request.operation === 'market-watch.tech-signal') {
        return Promise.resolve(code === '000001'
          ? readyTech(code, 'A 缓存技术', '2026-08-30 14:00:00')
          : { status: 'preparing', code, retry_after_ms: 5000 })
      }
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews(code))
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({
      resources,
      requestData,
      subject: { code: '000001', name: 'A 股票' },
    })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('A 缓存技术')).toBeTruthy()
    await act(async () => {
      resources.invalidate(techKey('000001'))
      await resources.read(techKey('000001'), async () => ({
        status: 'preparing', code: '000001', retry_after_ms: 5000,
      }))
    })

    first.view.rerender(<SecurityResearchContent
      {...first.props}
      subject={{ code: '600519', name: 'B 股票' }}
    />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('heading', { name: 'B 股票' })).toBeTruthy()
    expect(screen.getByText('技术信号准备中')).toBeTruthy()
    expect(screen.queryByText('A 缓存技术')).toBeNull()

    first.view.rerender(<SecurityResearchContent
      {...first.props}
      subject={{ code: '000001', name: 'A 股票' }}
    />)
    expect(screen.getByText('A 缓存技术')).toBeTruthy()
    expect(screen.getByText('缓存 · 2026-08-30 14:00:00')).toBeTruthy()
    expect(screen.queryByText('信号-600519')).toBeNull()
  })

  it.each([
    { retryAfter: 10, before: 999, at: 1 },
    { retryAfter: 9000, before: 4999, at: 1 },
  ])('clamps preparing retry_after_ms=$retryAfter to the supported delay', async ({ retryAfter, before, at }) => {
    vi.useFakeTimers()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        return Promise.resolve({ status: 'preparing', code: '920223', retry_after_ms: retryAfter })
      }
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(before) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(at) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(2)
  })

  it('stops after a transport error during preparing instead of polling forever', async () => {
    vi.useFakeTimers()
    const failedPoll = deferred<unknown>()
    const technicalFlights: Array<Promise<unknown>> = [
      Promise.resolve({ status: 'preparing', code: '920223', retry_after_ms: 1000 }),
      failedPoll.promise,
    ]
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return technicalFlights.shift()!
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => {
      failedPoll.reject(new Error('poll transport failed'))
      await Promise.resolve()
    })

    const technicalRegion = screen.getByRole('region', { name: '技术信号' })
    const alert = within(technicalRegion).getByRole('alert')
    expect(alert.textContent).toContain('poll transport failed')
    expect(screen.queryByText('技术信号准备中')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(2)
  })

  it('deduplicates consecutive technical retry calls and permits another retry after settlement', async () => {
    const retryFlight = deferred<unknown>()
    let technicalCalls = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        technicalCalls += 1
        if (technicalCalls === 1 || technicalCalls === 3) {
          return Promise.resolve({ status: 'unavailable', code: '920223', message: '技术源不可用' })
        }
        return retryFlight.promise
      }
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    const firstRetry = await screen.findByRole<HTMLButtonElement>('button', { name: '重试技术信号' })
    await act(async () => { firstRetry.click(); firstRetry.click() })
    expect(technicalCalls).toBe(2)
    const busyRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试技术信号' })
    expect(busyRetry.disabled).toBe(true)
    expect(busyRetry.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      retryFlight.resolve({ status: 'unavailable', code: '920223', message: '技术源仍不可用' })
    })
    const settledRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试技术信号' })
    expect(settledRetry.disabled).toBe(false)
    fireEvent.click(settledRetry)
    expect(technicalCalls).toBe(3)
  })

  it('deduplicates consecutive security-news retry calls and permits another retry after settlement', async () => {
    const retryFlight = deferred<unknown>()
    let newsCalls = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('920223'))
      if (request.operation === 'market-watch.security-news') {
        newsCalls += 1
        if (newsCalls === 1 || newsCalls === 3) {
          return Promise.resolve({ status: 'unavailable', code: '920223', message: '个股资讯源不可用' })
        }
        return retryFlight.promise
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    const firstRetry = await screen.findByRole<HTMLButtonElement>('button', { name: '重试个股资讯' })
    await act(async () => { firstRetry.click(); firstRetry.click() })
    expect(newsCalls).toBe(2)
    const busyRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试个股资讯' })
    expect(busyRetry.disabled).toBe(true)
    expect(busyRetry.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      retryFlight.resolve({ status: 'unavailable', code: '920223', message: '个股资讯仍不可用' })
    })
    const settledRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试个股资讯' })
    expect(settledRetry.disabled).toBe(false)
    fireEvent.click(settledRetry)
    expect(newsCalls).toBe(3)
  })

  it('deduplicates consecutive market-news retry calls and permits another retry after settlement', async () => {
    const retryFlight = deferred<unknown>()
    let marketCalls = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('920223'))
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      if (request.operation === 'market-watch.news-flash') {
        marketCalls += 1
        if (marketCalls === 1 || marketCalls === 3) {
          return Promise.resolve({ status: 'unavailable', message: '市场快讯源不可用' })
        }
        return retryFlight.promise
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    fireEvent.click(screen.getByRole('tab', { name: '市场快讯' }))
    const firstRetry = await screen.findByRole<HTMLButtonElement>('button', { name: '重试市场快讯' })
    await act(async () => { firstRetry.click(); firstRetry.click() })
    expect(marketCalls).toBe(2)
    const busyRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试市场快讯' })
    expect(busyRetry.disabled).toBe(true)
    expect(busyRetry.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      retryFlight.resolve({ status: 'unavailable', message: '市场快讯仍不可用' })
    })
    const settledRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试市场快讯' })
    expect(settledRetry.disabled).toBe(false)
    fireEvent.click(settledRetry)
    expect(marketCalls).toBe(3)
  })

  it('disables every retry while inactive and guards handlers even if disabled DOM is programmatically bypassed', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        return Promise.resolve({ status: 'unavailable', code: '920223', message: '技术源不可用' })
      }
      if (request.operation === 'market-watch.security-news') {
        return Promise.resolve({ status: 'unavailable', code: '920223', message: '个股资讯源不可用' })
      }
      if (request.operation === 'market-watch.news-flash') {
        return Promise.resolve({ status: 'unavailable', message: '市场快讯源不可用' })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({ requestData })
    await screen.findByRole('button', { name: '重试技术信号' })
    await screen.findByRole('button', { name: '重试个股资讯' })
    fireEvent.click(screen.getByRole('tab', { name: '市场快讯' }))
    await screen.findByRole('button', { name: '重试市场快讯' })
    first.view.rerender(<SecurityResearchContent {...first.props} active={false} />)
    const before = requestData.mock.calls.length

    for (const name of ['重试技术信号', '重试市场快讯']) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name })
      expect(button.disabled).toBe(true)
      button.disabled = false
      await act(async () => { button.click() })
    }
    fireEvent.click(screen.getByRole('tab', { name: '个股相关' }))
    const securityRetry = screen.getByRole<HTMLButtonElement>('button', { name: '重试个股资讯' })
    expect(securityRetry.disabled).toBe(true)
    securityRetry.disabled = false
    await act(async () => { securityRetry.click() })

    expect(requestData).toHaveBeenCalledTimes(before)
  })

  it('reschedules the current preparing key after becoming active again', async () => {
    vi.useFakeTimers()
    let technicalCalls = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        technicalCalls += 1
        return Promise.resolve(technicalCalls === 1
          ? { status: 'preparing', code: '920223', retry_after_ms: 1000 }
          : readyTech('920223', '恢复后自动完成'))
      }
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({ requestData })
    await act(async () => { await Promise.resolve() })
    first.view.rerender(<SecurityResearchContent {...first.props} active={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(technicalCalls).toBe(1)

    first.view.rerender(<SecurityResearchContent {...first.props} active />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(technicalCalls).toBe(2)
    expect(screen.getByText('恢复后自动完成')).toBeTruthy()
  })

  it('reactivates ready technical and security news with stale-while-revalidate once per key', async () => {
    const resources = createResearchResourceStore()
    await resources.read(techKey('920223'), async () => readyTech('920223', '旧技术', '2026-08-30 15:00:00'))
    await resources.read(securityNewsKey('920223'), async () => readyNews('920223', '旧资讯'))
    const technical = deferred<unknown>()
    const securityNews = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return technical.promise
      if (request.operation === 'market-watch.security-news') return securityNews.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({ resources, requestData, active: false })

    expect(screen.getByText('旧技术')).toBeTruthy()
    expect(screen.getByText('旧资讯')).toBeTruthy()
    first.view.rerender(<SecurityResearchContent {...first.props} active />)
    expect(screen.getByText('旧技术')).toBeTruthy()
    expect(screen.getByText('旧资讯')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(1)
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.security-news')).toHaveLength(1)
    })

    await act(async () => {
      technical.resolve(readyTech('920223', '新技术', '2026-09-01 10:00:00'))
      securityNews.resolve(readyNews('920223', '新资讯'))
    })
    expect(screen.getByText('新技术')).toBeTruthy()
    expect(screen.getByText('新资讯')).toBeTruthy()
    expect(screen.queryByText('旧技术')).toBeNull()
    expect(screen.queryByText('旧资讯')).toBeNull()
  })

  it('revalidates business-stale security news once when the research surface becomes active', async () => {
    const resources = createResearchResourceStore()
    await resources.read(securityNewsKey('920223'), async () => ({
      status: 'stale', code: '920223', as_of: '2026-08-30 09:30:00',
      stale: true, complete: false,
      items: [{ id: 'old-news', title: '业务缓存资讯', source: '测试资讯源', time: '09:30' }],
    }))
    const refresh = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        return Promise.resolve(readyTech('920223'))
      }
      if (request.operation === 'market-watch.security-news') return refresh.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({ resources, requestData, active: false })

    expect(screen.getByText('业务缓存资讯')).toBeTruthy()
    expect(screen.getByText('缓存 · 2026-08-30 09:30:00')).toBeTruthy()
    first.view.rerender(<SecurityResearchContent {...first.props} active />)
    expect(screen.getByText('业务缓存资讯')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.security-news')).toHaveLength(1)
    })

    first.view.rerender(<SecurityResearchContent {...first.props} active />)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.security-news')).toHaveLength(1)

    await act(async () => {
      refresh.resolve({
        status: 'ready', code: '920223', as_of: '2026-09-01 10:05:00',
        stale: false, complete: true,
        items: [{ id: 'new-news', title: '刷新后的个股资讯', source: '测试资讯源', time: '10:05' }],
      })
    })
    expect(screen.getByText('刷新后的个股资讯')).toBeTruthy()
    expect(screen.queryByText('业务缓存资讯')).toBeNull()
    expect(resources.getSnapshot(securityNewsKey('920223')).asOf).toBe('2026-09-01 10:05:00')
  })

  it('keeps ready content and its original fact time when active revalidation fails', async () => {
    const resources = createResearchResourceStore()
    await resources.read(techKey('920223'), async () => readyTech('920223', '保留技术', '2026-08-30 15:00:00'))
    await resources.read(securityNewsKey('920223'), async () => readyNews('920223', '保留资讯'))
    const requestData = vi.fn<RequestData>(async request => {
      throw new Error(`${request.operation} refresh failed`)
    })
    const first = renderContent({ resources, requestData, active: false })

    first.view.rerender(<SecurityResearchContent {...first.props} active />)
    await waitFor(() => {
      expect(resources.getSnapshot(techKey('920223')).phase).toBe('stale')
      expect(resources.getSnapshot(securityNewsKey('920223')).phase).toBe('stale')
    })

    expect(screen.getByText('保留技术')).toBeTruthy()
    expect(screen.getByText('保留资讯')).toBeTruthy()
    expect(screen.getByText('缓存 · 2026-08-30 15:00:00')).toBeTruthy()
    expect(resources.getSnapshot(techKey('920223')).asOf).toBe('2026-08-30 15:00:00')
    expect(screen.queryByText('技术信号暂不可用')).toBeNull()
  })

  it('reuses an in-flight A request but revalidates completed A after A to B to A transitions', async () => {
    const aTechnical = deferred<unknown>()
    const aNews = deferred<unknown>()
    const aTechnicalRefresh = deferred<unknown>()
    const aNewsRefresh = deferred<unknown>()
    let aTechnicalCalls = 0
    let aNewsCalls = 0
    const requestData = vi.fn<RequestData>((request) => {
      const code = requestCode(request)
      if (code === '000001' && request.operation === 'market-watch.tech-signal') {
        aTechnicalCalls += 1
        return aTechnicalCalls === 1 ? aTechnical.promise : aTechnicalRefresh.promise
      }
      if (code === '000001' && request.operation === 'market-watch.security-news') {
        aNewsCalls += 1
        return aNewsCalls === 1 ? aNews.promise : aNewsRefresh.promise
      }
      if (code === '600519' && request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech(code, 'B 技术'))
      if (code === '600519' && request.operation === 'market-watch.security-news') return Promise.resolve(readyNews(code, 'B 资讯'))
      throw new Error(`unexpected request ${request.operation} ${code}`)
    })
    const first = renderContent({
      requestData,
      resources: createResearchResourceStore(),
      subject: { code: '000001', name: 'A 股票' },
    })
    first.view.rerender(<SecurityResearchContent {...first.props} subject={{ code: '600519', name: 'B 股票' }} />)
    await screen.findByText('B 技术')
    first.view.rerender(<SecurityResearchContent {...first.props} subject={{ code: '000001', name: 'A 股票' }} />)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal' && requestCode(request) === '000001')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.security-news' && requestCode(request) === '000001')).toHaveLength(1)

    await act(async () => {
      aTechnical.resolve(readyTech('000001', 'A flight 完成'))
      aNews.resolve(readyNews('000001', 'A flight 资讯'))
    })
    expect(screen.getByText('A flight 完成')).toBeTruthy()
    first.view.rerender(<SecurityResearchContent {...first.props} subject={{ code: '600519', name: 'B 股票' }} />)
    first.view.rerender(<SecurityResearchContent {...first.props} subject={{ code: '000001', name: 'A 股票' }} />)
    expect(screen.getByText('A flight 完成')).toBeTruthy()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal' && requestCode(request) === '000001')).toHaveLength(2)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.security-news' && requestCode(request) === '000001')).toHaveLength(2)

    await act(async () => {
      aTechnicalRefresh.resolve(readyTech('000001', 'A 后台刷新完成'))
      aNewsRefresh.resolve(readyNews('000001', 'A 后台刷新资讯'))
    })
    expect(screen.getByText('A 后台刷新完成')).toBeTruthy()
    expect(screen.getByText('A 后台刷新资讯')).toBeTruthy()
  })

  it.each(['switch', 'inactive', 'unmount'] as const)('invalidates an already-dequeued timer callback after %s', async (stop) => {
    const base = createResearchResourceStore()
    const scheduled: Array<{ readonly key: string; readonly callback: () => void }> = []
    const resources: ResearchResourceStore = {
      ...base,
      schedule(_owner, key, _delayMs, callback) { scheduled.push({ key, callback }) },
    }
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        return Promise.resolve({ status: 'preparing', code: requestCode(request), retry_after_ms: 1000 })
      }
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews(requestCode(request)))
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({
      requestData,
      resources,
      subject: { code: '000001', name: 'A 股票' },
    })
    await act(async () => { await Promise.resolve() })
    const oldCallback = scheduled.find(item => item.key === techKey('000001'))?.callback
    expect(oldCallback).toBeTypeOf('function')
    const beforeStop = requestData.mock.calls.filter(([request]) => (
      request.operation === 'market-watch.tech-signal' && requestCode(request) === '000001'
    )).length

    if (stop === 'switch') {
      first.view.rerender(<SecurityResearchContent {...first.props} subject={{ code: '600519', name: 'B 股票' }} />)
    } else if (stop === 'inactive') {
      first.view.rerender(<SecurityResearchContent {...first.props} active={false} />)
    } else {
      first.view.unmount()
    }
    await act(async () => { oldCallback?.(); await Promise.resolve() })

    expect(requestData.mock.calls.filter(([request]) => (
      request.operation === 'market-watch.tech-signal' && requestCode(request) === '000001'
    ))).toHaveLength(beforeStop)
  })

  it.each(['switch', 'inactive', 'unmount'] as const)('stops an old preparing callback after %s', async (stop) => {
    vi.useFakeTimers()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') {
        return Promise.resolve({ status: 'preparing', code: request.input?.code, retry_after_ms: 1000 })
      }
      if (request.operation === 'market-watch.security-news') {
        return Promise.resolve({ status: 'ready', code: request.input?.code, items: [] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({ requestData, subject: { code: '000001', name: 'A 股票' } })
    await act(async () => { await Promise.resolve() })
    const beforeStop = requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal').length

    if (stop === 'switch') {
      first.view.rerender(<SecurityResearchContent
        {...first.props}
        subject={{ code: '600519', name: 'B 股票' }}
      />)
    } else if (stop === 'inactive') {
      first.view.rerender(<SecurityResearchContent {...first.props} active={false} />)
    } else {
      first.view.unmount()
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const afterStop = requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')
    expect(afterStop.filter(([request]) => request.input?.code === '000001')).toHaveLength(beforeStop)
    if (stop !== 'switch') expect(afterStop).toHaveLength(beforeStop)
  })

  it('shows unavailable without old content as a local alert, retries only manually and then renders ready', async () => {
    vi.useFakeTimers()
    const technicalFlights: unknown[] = [
      { status: 'unavailable', code: '920223', as_of: '2026-08-31 10:00:00', message: 'K 线源暂不可用', retryable: true },
      readyTech('920223', '手动重试成功'),
    ]
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(technicalFlights.shift())
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })
    await act(async () => { await Promise.resolve() })
    const region = screen.getByRole('region', { name: '技术信号' })
    const alert = within(region).getByRole('alert')
    expect(alert.textContent).toContain('K 线源暂不可用')
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(1)

    fireEvent.click(within(alert).getByRole('button', { name: '重试技术信号' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('手动重试成功')).toBeTruthy()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.tech-signal')).toHaveLength(2)
  })

  it('keeps stale technical content and labels it with the original fact time', async () => {
    const resources = createResearchResourceStore()
    await resources.read(techKey('920223'), async () => readyTech('920223', '旧技术信号', '2026-08-30 15:00:00'))
    resources.invalidate(techKey('920223'))
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.reject(new Error('refresh failed'))
      if (request.operation === 'market-watch.security-news') return Promise.resolve(readyNews('920223'))
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ resources, requestData })

    expect(await screen.findByText('旧技术信号')).toBeTruthy()
    expect(screen.getByText('缓存 · 2026-08-30 15:00:00')).toBeTruthy()
    expect(screen.queryByText('技术信号暂不可用')).toBeNull()
  })

  it('renders stale and unavailable news as local states without replacing technical content', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('920223', '持续可见的技术'))
      if (request.operation === 'market-watch.security-news') {
        return Promise.resolve({
          status: 'stale', code: '920223', stale: true, as_of: '2026-08-30 09:30:00',
          items: [{ id: 'old-news', title: '缓存个股资讯', source: '测试源' }],
        })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const first = renderContent({ requestData })
    expect(await screen.findByText('缓存个股资讯')).toBeTruthy()
    expect(screen.getByText('缓存 · 2026-08-30 09:30:00')).toBeTruthy()
    expect(screen.getByText('持续可见的技术')).toBeTruthy()

    const unavailableRequest = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('600519', 'B 技术仍可见'))
      if (request.operation === 'market-watch.security-news') {
        return Promise.resolve({ status: 'unavailable', code: '600519', message: '个股资讯源不可用' })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    first.view.rerender(<SecurityResearchContent
      {...first.props}
      subject={{ code: '600519', name: '贵州茅台' }}
      requestData={unavailableRequest}
    />)
    expect(await screen.findByText('B 技术仍可见')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('个股资讯源不可用')
  })

  it('only creates credential-free HTTP(S) article links with safe new-window attributes', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve(readyTech('920223'))
      if (request.operation === 'market-watch.security-news') {
        return Promise.resolve({
          status: 'ready', code: '920223', items: [
            { id: 'safe', title: '安全原文', source: '测试源', url: 'https://example.com/news/1' },
            { id: 'credential', title: '带凭据地址', source: '测试源', url: 'https://user:pass@example.com/private' },
            { id: 'script', title: '脚本地址', source: '测试源', url: 'javascript:alert(1)' },
            { id: 'relative', title: '相对地址', source: '测试源', url: '/relative' },
          ],
        })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderContent({ requestData })

    const safe = await screen.findByRole<HTMLAnchorElement>('link', { name: '安全原文（打开原文）' })
    expect(safe.href).toBe('https://example.com/news/1')
    expect(safe.target).toBe('_blank')
    expect(safe.rel).toBe('noopener noreferrer')
    expect(screen.queryByRole('link', { name: /带凭据地址|脚本地址|相对地址/ })).toBeNull()
  })

  it('emits the exact full-detail code and stock assistant intent from nearby actions', async () => {
    const onAnalyze = vi.fn<Props['onAnalyze']>()
    const onOpenFullDetail = vi.fn<Props['onOpenFullDetail']>()
    renderContent({ onAnalyze, onOpenFullDetail })

    fireEvent.click(screen.getByRole('button', { name: '查看证券详情' }))
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))

    expect(onOpenFullDetail).toHaveBeenCalledWith('920223')
    expect(onAnalyze).toHaveBeenCalledWith({ kind: 'stock', code: '920223', name: '荣亿精密' })
    await screen.findByText('信号-920223')
  })
})
