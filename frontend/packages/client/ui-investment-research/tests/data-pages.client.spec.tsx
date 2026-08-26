// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, type ComponentProps } from 'react'
import { OpportunityPage, PortfolioPage, safeExternalNewsUrl } from '../src/client/InvestmentShell.tsx'

type RequestData = ComponentProps<typeof OpportunityPage>['requestData']

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

afterEach(cleanup)

describe('投研数据页慢请求状态', () => {
  it('只把后端返回的安全原文地址渲染为新窗口链接', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.scan') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.news-flash') {
        return Promise.resolve({
          items: [
            { id: 'safe', title: '可查看原文', source: '新浪财经', time: '10:01', url: 'https://finance.example/news/1' },
            { id: 'unsafe', title: '不安全地址', source: '未知源', time: '10:00', url: 'javascript:alert(1)' },
          ],
        })
      }
      return Promise.resolve({})
    })

    render(<OpportunityPage requestData={requestData} initialQuery="" onAnalyze={() => {}} onView={() => {}} />)

    const link = await screen.findByRole<HTMLAnchorElement>('link', { name: '可查看原文（打开原文）' })
    expect(link.href).toBe('https://finance.example/news/1')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect(screen.getByText('新浪财经 · 原文')).toBeTruthy()
    expect(screen.getByText('未知源 · 暂无原文链接')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /不安全地址/ })).toBeNull()
    expect(safeExternalNewsUrl('https://user:pass@example.com/private')).toBeUndefined()
    expect(safeExternalNewsUrl('/relative')).toBeUndefined()
  })

  it('逐项展示机会数据，并只重试失败的资讯请求', async () => {
    const scan = deferred<unknown>()
    const firstNews = deferred<unknown>()
    const retriedNews = deferred<unknown>()
    const signal = deferred<unknown>()
    const newsFlights = [firstNews.promise, retriedNews.promise]
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.scan') return scan.promise
      if (request.operation === 'market-watch.news-flash') return newsFlights.shift()!
      if (request.operation === 'market-watch.tech-signal') return signal.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<OpportunityPage requestData={requestData} initialQuery="" onAnalyze={() => {}} onView={() => {}} />)

    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.news-flash', input: { limit: 12, enrich: false, personal: false },
    })
    const scanRegion = screen.getByRole('region', { name: '市场扫描' })
    expect(scanRegion.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('已完成 0/2 项')

    await act(async () => {
      scan.resolve({ items: [{ code: '600519', name: '贵州茅台', price: 1688, pct_change: 1.2 }] })
    })
    await screen.findByText('贵州茅台')
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'market-watch.tech-signal', input: { code: '600519', lookback: 120 },
      })
    })
    expect(screen.getByText('贵州茅台')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('数据会在完成后逐项显示')

    await act(async () => { firstNews.reject(new Error('news upstream timeout')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('实时资讯暂不可用')
    expect(screen.getByText('贵州茅台')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: '重试实时资讯暂不可用' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.news-flash')).toHaveLength(2)
    })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(1)

    await act(async () => {
      retriedNews.resolve({ items: [{ id: 'news-1', title: '白酒行业需求回暖' }], stale: true, complete: false })
      signal.resolve({ code: '600519', name: '贵州茅台', bars: 120, signals: ['趋势向上'] })
    })
    await screen.findByText('白酒行业需求回暖')
    expect(screen.getByText('缓存资讯')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('刷新持仓时保留旧数据、锁定重复动作并局部报告失败', async () => {
    const nextHoldings = deferred<unknown>()
    const nextRisk = deferred<unknown>()
    const nextAlerts = deferred<unknown>()
    const flights = new Map<string, unknown[]>([
      ['trading-core.holdings', [
        { items: [{ ticker: '600000', name: '浦发银行', quantity: 100, cost_price: 10 }] },
        nextHoldings.promise,
      ]],
      ['trading-core.risk-portfolio', [
        { profile_label: '稳健', summary: { n_positions: 1, hhi: 1 }, breaches: [] },
        nextRisk.promise,
      ]],
      ['trading-core.risk-alerts', [
        { items: [] },
        nextAlerts.promise,
      ]],
    ])
    const requestData = vi.fn<RequestData>(request =>
      Promise.resolve(flights.get(request.operation)?.shift()))

    render(<PortfolioPage requestData={requestData} onAnalyze={() => {}} />)
    await screen.findByText('浦发银行')
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '刷新' }).disabled).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    const busyButton = await screen.findByRole<HTMLButtonElement>('button', { name: '加载中…' })
    expect(busyButton.disabled).toBe(true)
    expect(screen.getByText('浦发银行')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('正在更新持仓数据')
    fireEvent.click(busyButton)
    expect(requestData).toHaveBeenCalledTimes(6)

    await act(async () => {
      nextHoldings.resolve({ items: [{ ticker: '000001', name: '平安银行', quantity: 200, cost_price: 11 }] })
      nextRisk.reject(new Error('risk engine unavailable'))
      nextAlerts.resolve({ items: [{ id: 'alert-1', title: '集中度提醒', detail: '请复核' }] })
    })

    await screen.findByText('平安银行')
    expect(screen.queryByText('浦发银行')).toBeNull()
    expect(screen.getByText('稳健')).toBeTruthy()
    expect(screen.getByText('集中度提醒')).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('组合风险更新失败')
    expect(alert.textContent).toContain('risk engine unavailable')
    expect(screen.getByRole('status').textContent).toContain('已显示 3/3 项')
  })

  it('筛选切换以新一代结果为准，晚到响应不会覆盖当前列表', async () => {
    const firstScan = deferred<unknown>()
    const secondScan = deferred<unknown>()
    const news = deferred<unknown>()
    const signal = deferred<unknown>()
    const scans = [firstScan.promise, secondScan.promise]
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.scan') return scans.shift()!
      if (request.operation === 'market-watch.news-flash') return news.promise
      if (request.operation === 'market-watch.tech-signal') return signal.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<OpportunityPage requestData={requestData} initialQuery="" onAnalyze={() => {}} onView={() => {}} />)
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: '量比异动' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(2)
    })

    await act(async () => {
      secondScan.resolve({ items: [{ code: '000001', name: '新筛选结果' }] })
    })
    await screen.findByText('新筛选结果')
    await act(async () => {
      firstScan.resolve({ items: [{ code: '600000', name: '晚到旧结果' }] })
    })
    expect(screen.getByText('新筛选结果')).toBeTruthy()
    expect(screen.queryByText('晚到旧结果')).toBeNull()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.news-flash')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '量比异动' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('StrictMode effect 重放复用初始请求并由最新 generation 接收结果', async () => {
    const holdings = deferred<unknown>()
    const risk = deferred<unknown>()
    const alerts = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'trading-core.holdings') return holdings.promise
      if (request.operation === 'trading-core.risk-portfolio') return risk.promise
      if (request.operation === 'trading-core.risk-alerts') return alerts.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <StrictMode>
        <PortfolioPage requestData={requestData} onAnalyze={() => {}} />
      </StrictMode>,
    )

    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(3) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-portfolio')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-alerts')).toHaveLength(1)

    await act(async () => {
      holdings.resolve({ items: [{ ticker: '600036', name: '招商银行', quantity: 100, cost_price: 40 }] })
      risk.resolve({ profile_label: '平衡', summary: { n_positions: 1 }, breaches: [] })
      alerts.resolve({ items: [] })
    })

    await screen.findByText('招商银行')
    expect(screen.getByText('平衡')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('共 3/3 项可用')
  })

  it('A-B-A 筛选复用仍未完成的 A flight，并由最后一次 A 选择接收结果', async () => {
    const gainers = deferred<unknown>()
    const volumeRatio = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.news-flash') return Promise.resolve([])
      if (request.operation === 'market-watch.tech-signal') return Promise.resolve({ signals: [] })
      if (request.operation === 'market-watch.scan') {
        return request.input?.kind === 'gainers' ? gainers.promise : volumeRatio.promise
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<OpportunityPage requestData={requestData} initialQuery="" onAnalyze={() => {}} onView={() => {}} />)
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })

    fireEvent.click(screen.getByRole('button', { name: '量比异动' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(2)
    })
    fireEvent.click(screen.getByRole('button', { name: '涨幅榜' }))
    await act(async () => {})

    const scanCalls = requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')
    expect(scanCalls).toHaveLength(2)
    expect(scanCalls.filter(([request]) => request.input?.kind === 'gainers')).toHaveLength(1)

    await act(async () => {
      gainers.resolve({ items: [{ code: '600000', name: '最终 A 结果' }] })
    })
    await screen.findByText('最终 A 结果')
    await act(async () => {
      volumeRatio.resolve({ items: [{ code: '000001', name: '晚到 B 结果' }] })
    })
    expect(screen.getByText('最终 A 结果')).toBeTruthy()
    expect(screen.queryByText('晚到 B 结果')).toBeNull()
    expect(screen.getByRole('button', { name: '涨幅榜' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('多个局部错误的重试按钮包含对应区域名称', async () => {
    const requestData = vi.fn<RequestData>(request => Promise.reject(new Error(`${request.operation} unavailable`)))

    render(<PortfolioPage requestData={requestData} onAnalyze={() => {}} />)

    await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(3) })
    expect(screen.getByRole('button', { name: '重试组合风险暂不可用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试持仓暂不可用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试风险预警暂不可用' })).toBeTruthy()
  })
})
