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
  it('为代码占位的持仓补全证券名称，并保留代码作为次级信息', async () => {
    const requestData = vi.fn<RequestData>(async (request) => {
      if (request.operation === 'trading-core.holdings') {
        return { items: [{ ticker: '000001', name: '000001', quantity: 100, cost_price: 11.65 }] }
      }
      if (request.operation === 'trading-core.risk-portfolio') {
        return { profile_label: '稳健型', summary: { n_positions: 1 }, breaches: [] }
      }
      if (request.operation === 'trading-core.risk-alerts') return { items: [] }
      if (request.operation === 'trading-core.personalized-cards') return { items: [] }
      if (request.operation === 'market-watch.watchlist') return { items: [] }
      if (request.operation === 'trading-core.watchlist') return { tickers: [] }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '000001', name: '平安银行', market: '深市' }] }
      }
      return {}
    })

    render(<PortfolioPage requestData={requestData} onAnalyze={() => {}} />)

    expect((await screen.findAllByText('平安银行')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('000001').length).toBeGreaterThan(0)
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-search', input: { query: '000001', limit: 8 },
    })
  })

  it('只接受无凭据的 HTTP(S) 原文地址', () => {
    expect(safeExternalNewsUrl('https://finance.example/news/1')).toBe('https://finance.example/news/1')
    expect(safeExternalNewsUrl('https://user:pass@example.com/private')).toBeUndefined()
    expect(safeExternalNewsUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalNewsUrl('/relative')).toBeUndefined()
  })

  it('首次只请求指数和当前扫描，不自动选股或预取证券资源', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') {
        return Promise.resolve({ items: [{ code: 'sh000001', name: '上证指数', price: 3210, pct_change: 0.8 }] })
      }
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({ items: [{ code: '600519', name: '贵州茅台' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()
    const onAnalyzeResearch = vi.fn()

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={onOpenResearch}
        onAnalyzeResearch={onAnalyzeResearch}
      />,
    )

    expect(await screen.findByText('上证指数')).toBeTruthy()
    expect(await screen.findByText('贵州茅台')).toBeTruthy()
    await waitFor(() => {
      const requests = requestData.mock.calls.map(([request]) => request)
      expect(requests).toHaveLength(2)
      expect(requests).toEqual(expect.arrayContaining([
        { operation: 'market-watch.indices' },
        { operation: 'market-watch.scan', input: { kind: 'gainers', top_n: 12 } },
      ]))
    })
    const operations = requestData.mock.calls.map(([request]) => request.operation)
    expect(operations).not.toContain('market-watch.tech-signal')
    expect(operations).not.toContain('market-watch.security-news')
    expect(operations).not.toContain('market-watch.security-detail')
    expect(operations).not.toContain('market-watch.news-flash')
    expect(onOpenResearch).not.toHaveBeenCalled()
    expect(onAnalyzeResearch).not.toHaveBeenCalled()
    expect(screen.getByText('选择证券查看研究详情')).toBeTruthy()
  })

  it.each([
    {
      label: '新浪备用源完整结果', source: 'sina', expectedSource: '新浪',
      stale: false, complete: true, warning: '主行情源不可用，已使用备用源',
    },
    {
      label: '东财缓存不完整结果', source: 'eastmoney', expectedSource: '东财',
      stale: true, complete: false, warning: '实时刷新失败，已返回最近成功缓存',
    },
    {
      label: '未知来源安全文本', source: '<custom-feed>', expectedSource: '<custom-feed>',
      stale: false, complete: true, warning: '供应商标识尚未映射',
    },
  ])('成功扫描以非阻断事实条披露$label', async ({
    source, expectedSource, stale, complete, warning,
  }) => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({
          kind: 'gainers',
          trade_date: '2026-09-01',
          as_of: '2026-09-01T09:31:45+08:00',
          source,
          stale,
          complete,
          warnings: [warning],
          items: [{ code: '600519', name: '贵州茅台' }],
        })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={() => {}}
        onAnalyzeResearch={() => {}}
      />,
    )

    const facts = await screen.findByRole('note', { name: '扫描数据事实' })
    expect(facts.textContent).toContain(`来源：${expectedSource}`)
    expect(facts.textContent).toContain('数据时间：2026-09-01T09:31:45+08:00')
    expect(facts.textContent).toContain(warning)
    expect(facts.textContent?.includes('缓存数据')).toBe(stale)
    expect(facts.textContent?.includes('结果不完整')).toBe(!complete)
    expect(screen.getByText('贵州茅台')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('扫描项主体、详情和智能分析分别发出完整的显式意图', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({
          items: [{
            code: ' 600519 ', name: ' 贵州茅台 ', price: 1688.5,
            pct_change: 1.2, volume_ratio: 2.5, amount_yi: 31.6,
            turnover: 3.7, bad_number: Number.POSITIVE_INFINITY,
          }],
        })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()
    const onAnalyzeResearch = vi.fn()

    const { container } = render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={onOpenResearch}
        onAnalyzeResearch={onAnalyzeResearch}
      />,
    )

    const item = await screen.findByRole('article', { name: '贵州茅台 600519' })
    expect(container.querySelector('button button')).toBeNull()
    const subject = {
      code: '600519',
      name: '贵州茅台',
      quote: { price: 1688.5, pctChange: 1.2, volumeRatio: 2.5, amountYi: 31.6 },
    }
    const main = within(item).getByRole('button', { name: '打开贵州茅台研究' })
    const detail = within(item).getByRole('button', { name: '详情' })
    const analyze = within(item).getByRole('button', { name: '智能分析' })
    fireEvent.click(main)
    fireEvent.click(detail)
    expect(onOpenResearch).toHaveBeenNthCalledWith(1, subject)
    expect(onOpenResearch).toHaveBeenNthCalledWith(2, subject)
    expect(onAnalyzeResearch).not.toHaveBeenCalled()
    fireEvent.click(analyze)
    expect(onAnalyzeResearch).toHaveBeenCalledTimes(1)
    expect(onAnalyzeResearch).toHaveBeenCalledWith(subject)
    expect(onOpenResearch).toHaveBeenCalledTimes(2)
  })

  it('扫描 subject 只保留有限数值且不把错误类型强制转换为行情', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({
          items: [
            {
              code: '600519', name: '零值样本', price: 0,
              pct_change: Number.NaN, volume_ratio: Number.POSITIVE_INFINITY, amount_yi: '31.6',
            },
            {
              code: '000001', name: { label: '非字符串名称' }, price: Number.NEGATIVE_INFINITY,
              pct_change: 0, volume_ratio: { value: 2.5 }, amount_yi: Number.NaN,
            },
          ],
        })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={onOpenResearch}
        onAnalyzeResearch={() => {}}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '打开零值样本研究' }))
    fireEvent.click(screen.getByRole('button', { name: '打开000001研究' }))
    expect(onOpenResearch).toHaveBeenNthCalledWith(1, {
      code: '600519', name: '零值样本', quote: { price: 0 },
    })
    expect(onOpenResearch).toHaveBeenNthCalledWith(2, {
      code: '000001', quote: { pctChange: 0 },
    })
  })

  it('非字符串证券代码不产生 subject，三个扫描动作均禁用', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({ items: [{ code: 600519, name: ['非字符串名称'], price: 0 }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()
    const onAnalyzeResearch = vi.fn()

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={onOpenResearch}
        onAnalyzeResearch={onAnalyzeResearch}
      />,
    )

    const item = await screen.findByRole('article', { name: 'row-0 row-0' })
    const actions = within(item).getAllByRole<HTMLButtonElement>('button')
    expect(actions).toHaveLength(3)
    for (const action of actions) {
      expect(action.disabled).toBe(true)
      fireEvent.click(action)
    }
    expect(onOpenResearch).not.toHaveBeenCalled()
    expect(onAnalyzeResearch).not.toHaveBeenCalled()
  })

  it('activeCode 只标记当前研究证券，点击其他扫描项不在页内改写高亮', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({
          items: [
            { code: '600519', name: '贵州茅台' },
            { code: '000001', name: '平安银行' },
          ],
        })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=" 600519 "
        onOpenResearch={onOpenResearch}
        onAnalyzeResearch={() => {}}
      />,
    )

    const active = await screen.findByRole('button', { name: '打开贵州茅台研究' })
    const other = screen.getByRole('button', { name: '打开平安银行研究' })
    expect(active.getAttribute('aria-current')).toBe('true')
    expect(other.hasAttribute('aria-current')).toBe(false)
    fireEvent.click(other)
    expect(onOpenResearch).toHaveBeenCalledWith({ code: '000001', name: '平安银行', quote: {} })
    expect(active.getAttribute('aria-current')).toBe('true')
    expect(other.hasAttribute('aria-current')).toBe(false)
  })

  it('initialQuery 每个合法代码只发出一次打开意图，StrictMode 重放和扫描返回均不重复', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({ items: [{ code: '300750', name: '扫描证券' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()
    const renderPage = (initialQuery: string) => (
      <StrictMode>
        <OpportunityPage
          requestData={requestData}
          initialQuery={initialQuery}
          activeCode=""
          onOpenResearch={onOpenResearch}
          onAnalyzeResearch={() => {}}
        />
      </StrictMode>
    )
    const view = render(renderPage(' 000001 '))

    await waitFor(() => {
      expect(onOpenResearch).toHaveBeenCalledTimes(1)
      expect(onOpenResearch).toHaveBeenLastCalledWith({ code: '000001' })
    })
    expect(await screen.findByText('扫描证券')).toBeTruthy()
    expect(onOpenResearch).toHaveBeenCalledTimes(1)

    view.rerender(renderPage('600519'))
    await waitFor(() => {
      expect(onOpenResearch).toHaveBeenCalledTimes(2)
      expect(onOpenResearch).toHaveBeenLastCalledWith({ code: '600519' })
    })
    view.rerender(renderPage('000001'))
    view.rerender(renderPage('60051'))
    view.rerender(renderPage('   '))
    await act(async () => {})
    expect(onOpenResearch).toHaveBeenCalledTimes(2)
  })

  it('刷新只重新请求指数和当前扫描', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({ items: [{ code: '600519', name: '贵州茅台' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onOpenResearch = vi.fn()
    const onAnalyzeResearch = vi.fn()
    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode="600519"
        onOpenResearch={onOpenResearch}
        onAnalyzeResearch={onAnalyzeResearch}
      />,
    )

    await screen.findByText('贵州茅台')
    const refresh = await screen.findByRole<HTMLButtonElement>('button', { name: '刷新数据' })
    await waitFor(() => { expect(refresh.disabled).toBe(false) })
    fireEvent.click(refresh)
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(4) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.indices')).toHaveLength(2)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(2)
    expect(requestData.mock.calls.every(([request]) =>
      request.operation === 'market-watch.indices' || request.operation === 'market-watch.scan')).toBe(true)
    expect(onOpenResearch).not.toHaveBeenCalled()
    expect(onAnalyzeResearch).not.toHaveBeenCalled()
  })

  it('指数失败时保留已完成扫描，局部重试不重发扫描', async () => {
    const firstIndices = deferred<unknown>()
    let indicesAttempts = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') {
        indicesAttempts += 1
        return indicesAttempts === 1
          ? firstIndices.promise
          : Promise.resolve({ items: [{ code: 'sh000001', name: '上证指数', price: 3210 }] })
      }
      if (request.operation === 'market-watch.scan') {
        return Promise.resolve({ items: [{ code: '600519', name: '贵州茅台' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={() => {}}
        onAnalyzeResearch={() => {}}
      />,
    )

    expect(await screen.findByText('贵州茅台')).toBeTruthy()
    await act(async () => { firstIndices.reject(new Error('indices unavailable')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('大盘指数暂不可用')
    expect(screen.getByText('贵州茅台')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('机会数据部分暂不可用，已显示 1/2 项')

    fireEvent.click(within(alert).getByRole('button', { name: '重试大盘指数暂不可用' }))
    expect(await screen.findByText('上证指数')).toBeTruthy()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.indices')).toHaveLength(2)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(1)
    expect(screen.getByText('贵州茅台')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('扫描失败时保留已完成指数，局部重试不重发指数', async () => {
    const firstScan = deferred<unknown>()
    let scanAttempts = 0
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') {
        return Promise.resolve({ items: [{ code: 'sh000001', name: '上证指数', price: 3210 }] })
      }
      if (request.operation === 'market-watch.scan') {
        scanAttempts += 1
        return scanAttempts === 1
          ? firstScan.promise
          : Promise.resolve({ items: [{ code: '600519', name: '贵州茅台' }] })
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={() => {}}
        onAnalyzeResearch={() => {}}
      />,
    )

    expect(await screen.findByText('上证指数')).toBeTruthy()
    await act(async () => { firstScan.reject(new Error('scan unavailable')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('市场扫描暂不可用')
    expect(screen.getByText('上证指数')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('机会数据部分暂不可用，已显示 1/2 项')

    fireEvent.click(within(alert).getByRole('button', { name: '重试市场扫描暂不可用' }))
    expect(await screen.findByText('贵州茅台')).toBeTruthy()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.indices')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(2)
    expect(screen.getByText('上证指数')).toBeTruthy()
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
    expect(requestData).toHaveBeenCalledTimes(14)

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
    expect(screen.getByRole('status').textContent).toContain('已显示 6/6 项')
  })

  it('筛选切换以新一代结果为准，晚到响应不会覆盖当前列表', async () => {
    const firstScan = deferred<unknown>()
    const secondScan = deferred<unknown>()
    const scans = [firstScan.promise, secondScan.promise]
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') return scans.shift()!
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={() => {}}
        onAnalyzeResearch={() => {}}
      />,
    )
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: '量比异动' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.scan')).toHaveLength(2)
    })

    await act(async () => {
      secondScan.resolve({ items: [{ code: '000001', name: '新筛选结果' }] })
    })
    await screen.findAllByText('新筛选结果')
    await act(async () => {
      firstScan.resolve({ items: [{ code: '600000', name: '晚到旧结果' }] })
    })
    expect(screen.getAllByText('新筛选结果')).not.toHaveLength(0)
    expect(screen.queryByText('晚到旧结果')).toBeNull()
    expect(requestData.mock.calls.every(([request]) =>
      request.operation === 'market-watch.indices' || request.operation === 'market-watch.scan')).toBe(true)
    expect(screen.getByRole('button', { name: '量比异动' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('StrictMode effect 重放复用初始请求并由最新 generation 接收结果', async () => {
    const holdings = deferred<unknown>()
    const risk = deferred<unknown>()
    const alerts = deferred<unknown>()
    const events = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'trading-core.holdings') return holdings.promise
      if (request.operation === 'trading-core.risk-portfolio') return risk.promise
      if (request.operation === 'trading-core.risk-alerts') return alerts.promise
      if (request.operation === 'trading-core.personalized-cards') return events.promise
      if (request.operation === 'market-watch.watchlist') return Promise.resolve({ items: [] })
      if (request.operation === 'trading-core.watchlist') return Promise.resolve({ tickers: [] })
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <StrictMode>
        <PortfolioPage requestData={requestData} onAnalyze={() => {}} />
      </StrictMode>,
    )

    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(6) })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-portfolio')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-alerts')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.personalized-cards')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'market-watch.watchlist')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.watchlist')).toHaveLength(1)

    await act(async () => {
      holdings.resolve({ items: [{ ticker: '600036', name: '招商银行', quantity: 100, cost_price: 40 }] })
      risk.resolve({ profile_label: '平衡', summary: { n_positions: 1 }, breaches: [] })
      alerts.resolve({ items: [] })
      events.resolve({ items: [] })
    })

    await screen.findByText('招商银行')
    expect(screen.getByText('平衡')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('共 6/6 项可用')
  })

  it('A-B-A 筛选复用仍未完成的 A flight，并由最后一次 A 选择接收结果', async () => {
    const gainers = deferred<unknown>()
    const volumeRatio = deferred<unknown>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'market-watch.indices') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.scan') {
        return request.input?.kind === 'gainers' ? gainers.promise : volumeRatio.promise
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(
      <OpportunityPage
        requestData={requestData}
        initialQuery=""
        activeCode=""
        onOpenResearch={() => {}}
        onAnalyzeResearch={() => {}}
      />,
    )
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
    await screen.findAllByText('最终 A 结果')
    await act(async () => {
      volumeRatio.resolve({ items: [{ code: '000001', name: '晚到 B 结果' }] })
    })
    expect(screen.getAllByText('最终 A 结果')).not.toHaveLength(0)
    expect(screen.queryByText('晚到 B 结果')).toBeNull()
    expect(screen.getByRole('button', { name: '涨幅榜' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('多个局部错误的重试按钮包含对应区域名称', async () => {
    const requestData = vi.fn<RequestData>(request => Promise.reject(new Error(`${request.operation} unavailable`)))

    render(<PortfolioPage requestData={requestData} onAnalyze={() => {}} />)

    await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(5) })
    expect(screen.getByRole('button', { name: '重试组合风险暂不可用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试持仓暂不可用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试风险预警暂不可用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试研究事件暂不可用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试自选股暂不可用' })).toBeTruthy()
  })

  it('持仓表按实时行情渲染现价与市值，并汇总总资产现价', async () => {
    const requestData = vi.fn<RequestData>(async (request) => {
      if (request.operation === 'trading-core.holdings') {
        return {
          items: [
            { ticker: '000001', name: '平安银行', quantity: 100, cost_price: 10 },
            { ticker: '600519', name: '贵州茅台', quantity: 2, cost_price: 1400 },
          ],
        }
      }
      if (request.operation === 'trading-core.risk-portfolio') {
        return { profile_label: '稳健型', summary: { n_positions: 2 }, breaches: [] }
      }
      if (request.operation === 'trading-core.risk-alerts') return { items: [] }
      if (request.operation === 'trading-core.personalized-cards') return { items: [] }
      if (request.operation === 'market-watch.watchlist') return { items: [] }
      if (request.operation === 'trading-core.watchlist') return { tickers: [] }
      if (request.operation === 'market-watch.quotes-batch') {
        return {
          as_of: '2026-08-31 10:00:00', trade_date: '2026-08-31',
          items: [
            { code: '000001', name: '平安银行', price: 14.5, pct_change: 1.2 },
            { code: '600519', name: '贵州茅台', price: 1200, pct_change: -0.5 },
          ],
        }
      }
      return {}
    })

    render(<PortfolioPage requestData={requestData} onAnalyze={() => {}} />)

    await screen.findByText('贵州茅台')
    expect(screen.getByText('¥14.50')).toBeTruthy()
    expect(screen.getByText('¥1200.00')).toBeTruthy()
    expect(screen.getByText('¥1450.00')).toBeTruthy()
    expect(screen.getByText('¥2400.00')).toBeTruthy()
    expect(screen.getByText('¥3,850')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.quotes-batch',
      input: { codes: ['000001', '600519'] },
    })
  })

  it('实时行情不可用时持仓价格静默降级为 —，不渲染额外错误', async () => {
    const requestData = vi.fn<RequestData>(async (request) => {
      if (request.operation === 'trading-core.holdings') {
        return { items: [{ ticker: '000001', name: '平安银行', quantity: 100, cost_price: 10 }] }
      }
      if (request.operation === 'trading-core.risk-portfolio') {
        return { profile_label: '稳健型', summary: { n_positions: 1 }, breaches: [] }
      }
      if (request.operation === 'trading-core.risk-alerts') return { items: [] }
      if (request.operation === 'trading-core.personalized-cards') return { items: [] }
      if (request.operation === 'market-watch.watchlist') return { items: [] }
      if (request.operation === 'trading-core.watchlist') return { tickers: [] }
      if (request.operation === 'market-watch.quotes-batch') return Promise.reject(new Error('quotes upstream unavailable'))
      return {}
    })

    render(<PortfolioPage requestData={requestData} onAnalyze={() => {}} />)

    await screen.findByText('平安银行')
    const row = screen.getAllByRole('row')[1]!
    const cells = within(row).getAllByRole('cell')
    expect(cells[4]!.textContent).toBe('—')
    expect(cells[5]!.textContent).toBe('—')
    expect(screen.getByText('总资产现价').nextElementSibling?.textContent).toBe('—')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
