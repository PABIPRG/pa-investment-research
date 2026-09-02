// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { ResearchWorkbenchPage } from '../src/client/ResearchWorkbenchPage.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function completeResponse(operation: InvestmentDataRequest['operation']): unknown {
  if (operation === 'trading-core.holdings') {
    return { items: [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1500 }] }
  }
  if (operation === 'trading-core.risk-portfolio') {
    return {
      as_of: '2026-08-26 09:31:00', profile_label: '稳健型',
      summary: { n_positions: 1, equal_weight: 1, hhi: 1 },
      risk_budget: { single_stock_weight_max: 0.25, hhi_max: 0.3, portfolio_vol_max: 0.18, beta_max: 1 },
      breaches: [{ indicator: 'hhi', label: '集中度 HHI', value: 1, limit: 0.3, excess: 3.33, severity: '高' }],
    }
  }
  if (operation === 'trading-core.risk-alerts') {
    return {
      as_of: '2026-08-26 09:32:00',
      items: [
        { id: 'risk-1', source: 'portfolio', severity: '高', title: '集中度超预算', detail: '单股权重过高', codes: ['600519'], ts: '2026-08-26 09:30:00' },
        { id: 'risk-profile', source: 'profile', severity: '低', title: '画像预算提示', detail: '稳健型画像', codes: [], ts: '2026-08-26 09:30:00' },
      ],
    }
  }
  if (operation === 'trading-core.kyc-profile') {
    return {
      status: 'adjusted',
      inferred_profile: 'balanced',
      effective_profile: 'aggressive',
      effective_label: '进取型',
      score: 9,
      answers: [
        { qid: 'horizon', label: '1-3年', score: 3 },
        { qid: 'loss_tolerance', label: '10%左右', score: 3 },
        { qid: 'goal', label: '长期稳健增值', score: 3 },
      ],
      manual_adjust: { risk_tolerance: 0.8, horizon_years: 5, note: '' },
      tiers: { quick: ['horizon', 'loss_tolerance', 'goal'], full: ['horizon', 'loss_tolerance', 'goal'] },
      question_bank: {
        horizon: { qid: 'horizon', title: '你计划持有这笔资金多久？', options: [{ label: '1-3年', score: 3 }] },
        loss_tolerance: { qid: 'loss_tolerance', title: '你能承受多大亏损？', options: [{ label: '10%左右', score: 3 }] },
        goal: { qid: 'goal', title: '你的投资目标是？', options: [{ label: '长期稳健增值', score: 3 }] },
      },
      profile_labels: { conservative: '保守型', balanced: '稳健型', aggressive: '进取型' },
      profiles_detail: { aggressive: { risk_budget: { single_stock_weight_max: 0.4 } } },
    }
  }
  if (operation === 'trading-core.personalized-cards') {
    return {
      as_of: '2026-08-26 09:33:00',
      cards: [
        {
          card_id: 'card-holdings', bucket: 'holdings', direction: '利好', title: '白酒板块经营数据改善',
          summary: '贵州茅台发布经营数据', source: '交易所', time: '2026-08-26 09:20:00',
          tickers: [{ code: '600519', name: '贵州茅台' }], reasons: ['命中持仓：600519', '新鲜：<1小时'],
          risk: { level: '低', note: '仍需关注估值风险' }, matched: { strategies: [] },
        },
        {
          card_id: 'card-strategy', bucket: 'strategy', direction: '中性', title: '半导体设备订单变化',
          summary: '订单边际变化', source: '行业协会', time: '2026-08-26 09:10:00',
          tickers: [], reasons: ['命中策略'], risk: { level: '中' },
          matched: { strategies: [{ id: 'strategy-alpha', name: '设备景气策略' }] },
        },
      ],
    }
  }
  if (operation === 'trading-core.personalized-matches') {
    return {
      as_of: '2026-08-26 09:34:00',
      items: [{
        strategy_id: 'strategy-alpha', name: '设备景气策略', match_score: 86,
        match_reasons: [{ dim: 'profile_fit', text: '稳健画像与策略风险需求匹配', score: 28 }],
      }],
    }
  }
  if (operation === 'market-watch.quotes-batch') {
    return {
      as_of: '2026-08-26 09:35:00', trade_date: '2026-08-26',
      items: [{ code: '600519', name: '贵州茅台', price: 1450, pct_change: 1.2 }],
    }
  }
  return {}
}

function renderWorkbench(requestData = vi.fn(async (request: InvestmentDataRequest) => completeResponse(request.operation))) {
  const navigate = vi.fn()
  const onAnalyze = vi.fn()
  const onOpenReports = vi.fn()
  const onOpenPreferences = vi.fn()
  const trackTelemetry = vi.fn(async () => {})
  const view = render(
    <ResearchWorkbenchPage
      requestData={requestData}
      navigate={navigate}
      onAnalyze={onAnalyze}
      onOpenReports={onOpenReports}
      onOpenPreferences={onOpenPreferences}
      trackTelemetry={trackTelemetry}
    />,
  )
  return { ...view, requestData, navigate, onAnalyze, onOpenReports, onOpenPreferences, trackTelemetry }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('研究工作台', () => {
  it('从页头操作区打开偏好复盘', () => {
    const view = renderWorkbench()

    fireEvent.click(view.getByRole('button', { name: '偏好复盘' }))

    expect(view.onOpenPreferences).toHaveBeenCalledOnce()
  })

  it('并行读取七类真实数据，并展示真实 cards、KYC 与 match_reasons DTO', async () => {
    const view = renderWorkbench()

    expect(view.getByRole('heading', { name: '研究工作台' })).toBeTruthy()
    await waitFor(() => { expect(view.requestData).toHaveBeenCalledTimes(7) })
    expect(view.requestData.mock.calls.map(([request]) => request.operation)).toEqual(expect.arrayContaining([
      'trading-core.holdings',
      'trading-core.risk-portfolio',
      'trading-core.risk-alerts',
      'trading-core.kyc-profile',
      'trading-core.personalized-cards',
      'trading-core.personalized-matches',
      'market-watch.quotes-batch',
    ]))
    expect(view.requestData).toHaveBeenCalledWith({
      operation: 'trading-core.personalized-cards',
      input: { limit: 20, bucket: 'all', match: true, comment: false },
    })

    expect(await view.findByText('白酒板块经营数据改善')).toBeTruthy()
    expect(view.getByText('稳健画像与策略风险需求匹配')).toBeTruthy()
    expect(view.getByText('持仓成本金额')).toBeTruthy()
    expect(view.getByText('总资产现价')).toBeTruthy()
    expect(view.getByText('数量 × 成本价 →')).toBeTruthy()
    expect(view.getByText('数量 × 实时价，不含现金 →')).toBeTruthy()
    expect(view.getByText('¥15.0 万')).toBeTruthy()
    expect(view.getByText('¥14.5 万')).toBeTruthy()
    expect(view.getByText('成本 ¥1500.00 · 现价 ¥1450.00 · 市值 ¥14.5 万')).toBeTruthy()
    expect(view.getByText('集中度超预算')).toBeTruthy()
    expect(view.getByRole('button', { name: /命中持仓：贵州茅台.*600519/ })).toBeTruthy()
  })

  it('在风险预警后、策略匹配前展示独立 KYC 画像区', async () => {
    const view = renderWorkbench()

    const kycHeading = await view.findByRole('heading', { name: 'KYC 风险画像' })
    const alertsSection = view.getByRole('heading', { name: '风险预警' }).closest('section')!
    const kycSection = kycHeading.closest('section')!
    const strategiesSection = view.getByRole('heading', { name: '策略匹配' }).closest('section')!

    expect(view.requestData).toHaveBeenCalledWith({ operation: 'trading-core.kyc-profile' })
    expect(alertsSection.compareDocumentPosition(kycSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(kycSection.compareDocumentPosition(strategiesSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(kycSection).getByText('问卷推断')).toBeTruthy()
    expect(within(kycSection).getByText('稳健型')).toBeTruthy()
    expect(within(kycSection).getByText('当前生效')).toBeTruthy()
    expect(within(kycSection).getByText('进取型')).toBeTruthy()
  })

  it('KYC 失败时保留其他区域并只重试画像资源', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.kyc-profile') throw new Error('画像服务繁忙')
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)

    const kycError = await view.findByText('风险画像暂不可用')
    const kycSection = kycError.closest('section')!
    expect(within(kycSection).getByText('画像服务繁忙')).toBeTruthy()
    expect(view.getByText('贵州茅台')).toBeTruthy()
    expect(view.getByText('集中度超预算')).toBeTruthy()
    expect(view.getByText('稳健画像与策略风险需求匹配')).toBeTruthy()

    fireEvent.click(within(kycSection).getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.kyc-profile')).toHaveLength(2)
    })
    for (const operation of [
      'trading-core.holdings',
      'trading-core.risk-portfolio',
      'trading-core.risk-alerts',
      'trading-core.personalized-cards',
      'trading-core.personalized-matches',
    ]) {
      expect(requestData.mock.calls.filter(([request]) => request.operation === operation)).toHaveLength(1)
    }
  })

  it('KYC 更新成功后只刷新画像及其风险和策略依赖', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.kyc-questionnaire') {
        return { profile: 'balanced', label: '稳健型', score: 9, inferred_profile: 'balanced' }
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByRole('heading', { name: 'KYC 风险画像' })

    fireEvent.click(view.getByRole('button', { name: '重做风险测评' }))
    const dialog = view.getByRole('dialog', { name: '风险测评' })
    for (const label of ['1-3年', '10%左右', '长期稳健增值']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }
    fireEvent.click(within(dialog).getByRole('button', { name: '提交并应用画像' }))

    await waitFor(() => {
      for (const operation of [
        'trading-core.kyc-profile',
        'trading-core.risk-portfolio',
        'trading-core.risk-alerts',
        'trading-core.personalized-matches',
      ]) {
        expect(requestData.mock.calls.filter(([request]) => request.operation === operation)).toHaveLength(2)
      }
    })
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings')).toHaveLength(1)
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.personalized-cards')).toHaveLength(1)
  })

  it('KYC 写入后的依赖刷新不复用写入前的在途读取', async () => {
    const dependencies = new Set<InvestmentDataRequest['operation']>([
      'trading-core.kyc-profile',
      'trading-core.risk-portfolio',
      'trading-core.risk-alerts',
      'trading-core.personalized-matches',
    ])
    const counts = new Map<InvestmentDataRequest['operation'], number>()
    const staleReads = new Map<InvestmentDataRequest['operation'], ReturnType<typeof deferred<unknown>>>()
    const requestData = vi.fn((request: InvestmentDataRequest): Promise<unknown> => {
      const count = (counts.get(request.operation) ?? 0) + 1
      counts.set(request.operation, count)
      if (request.operation === 'trading-core.kyc-questionnaire') {
        return Promise.resolve({ profile: 'balanced', label: '稳健型' })
      }
      if (dependencies.has(request.operation) && count === 2) {
        const pending = deferred<unknown>()
        staleReads.set(request.operation, pending)
        return pending.promise
      }
      return Promise.resolve(completeResponse(request.operation))
    })
    const view = renderWorkbench(requestData)
    await view.findByRole('heading', { name: 'KYC 风险画像' })
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(7) })

    fireEvent.click(view.getByRole('button', { name: '刷新数据' }))
    await waitFor(() => {
      for (const operation of dependencies) expect(counts.get(operation)).toBe(2)
    })
    fireEvent.click(view.getByRole('button', { name: '重做风险测评' }))
    const dialog = view.getByRole('dialog', { name: '风险测评' })
    fireEvent.click(within(dialog).getByRole('button', { name: '提交并应用画像' }))

    await waitFor(() => {
      for (const operation of dependencies) expect(counts.get(operation)).toBe(3)
    })
    for (const [operation, pending] of staleReads) pending.resolve(completeResponse(operation))
  })

  it('持仓 name 为空时经 security-search 反查中文名，与代码一起展示', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') {
        return { items: [{ ticker: '513050', name: '', quantity: 6800, cost_price: 1.0115 }] }
      }
      if (request.operation === 'trading-core.risk-portfolio') {
        return { as_of: '2026-08-26 09:31:00', profile_label: '稳健型', summary: { n_positions: 1, equal_weight: 1, hhi: 1 }, breaches: [] }
      }
      if (request.operation === 'trading-core.risk-alerts') return { items: [] }
      if (request.operation === 'trading-core.personalized-cards') return { cards: [] }
      if (request.operation === 'trading-core.personalized-matches') return { items: [] }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: request.input?.query, name: '中概互联网ETF易方达', market: '沪市' }] }
      }
      return {}
    })

    const view = renderWorkbench(requestData)
    await view.findByText('513050')
    expect(await view.findByText('中概互联网ETF易方达')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.security-search',
      input: { query: '513050', limit: 8 },
    })
  })

  it('空持仓不把成本口径展示成伪造的零资产值', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') return { items: [] }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)

    expect(await view.findByText('尚未保存持仓。录入真实持仓后，这里会关联风险与资讯。')).toBeTruthy()
    const metric = view.getByText('总资产现价').parentElement!
    expect(within(metric).getByText('—')).toBeTruthy()
    expect(view.queryByText('¥0')).toBeNull()
  })

  it('投研概览五张卡片在当前页打开对应详情，不再跳转或移动锚点', async () => {
    const view = renderWorkbench()
    await view.findByText('白酒板块经营数据改善')

    const cases = [
      { trigger: /持仓数量/, dialog: '持仓明细', content: '100 股' },
      { trigger: /持仓成本金额/, dialog: '持仓成本明细', content: '¥15.0 万' },
      { trigger: /总资产现价/, dialog: '总资产现价明细', content: '¥14.5 万' },
      { trigger: /风险画像/, dialog: '风险画像详情', content: '风险数据时间' },
      { trigger: /需关注预警/, dialog: '组合风险中心', content: '集中度超预算' },
    ] as const

    for (const item of cases) {
      const trigger = view.getByRole('button', { name: item.trigger })
      fireEvent.click(trigger)
      const dialog = view.getByRole('dialog', { name: item.dialog })
      expect(within(dialog).getByText(item.content, { exact: false })).toBeTruthy()
      expect(view.navigate).not.toHaveBeenCalledWith('portfolio')
      fireEvent.click(within(dialog).getByRole('button', { name: `关闭${item.dialog}` }))
      await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    }
  })

  it('持仓明细默认只负责查看，点击导入后再选择单条或批量并保留草稿', async () => {
    const view = renderWorkbench()
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })

    expect(within(dialog).getByRole('button', { name: '导入持仓' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '编辑 贵州茅台 600519' })).toBeTruthy()
    expect(within(dialog).queryByRole('tab', { name: '单条录入' })).toBeNull()
    expect(within(dialog).queryByRole('tab', { name: '批量导入' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    expect(within(dialog).getByRole('button', { name: '返回持仓明细' })).toBeTruthy()
    const singleTab = within(dialog).getByRole('tab', { name: '单条录入' })
    expect(singleTab.getAttribute('aria-selected')).toBe('true')
    await waitFor(() => { expect(document.activeElement).toBe(singleTab) })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '股票代码' }), { target: { value: '000001' } })

    fireEvent.click(within(dialog).getByRole('tab', { name: '批量导入' }))
    const source = '股票代码,数量,成本价\n000858,300,135'
    fireEvent.change(within(dialog).getByRole('textbox', { name: '持仓导入内容' }), { target: { value: source } })
    fireEvent.click(within(dialog).getByRole('button', { name: '返回持仓明细' }))

    expect(within(dialog).queryByRole('tab', { name: '单条录入' })).toBeNull()
    const importButton = within(dialog).getByRole('button', { name: '导入持仓' })
    expect(within(dialog).getByRole('button', { name: '编辑 贵州茅台 600519' })).toBeTruthy()
    await waitFor(() => { expect(document.activeElement).toBe(importButton) })
    fireEvent.click(importButton)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: '股票代码' }).value).toBe('000001')
    fireEvent.click(within(dialog).getByRole('tab', { name: '批量导入' }))
    expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '持仓导入内容' }).value).toBe(source)
  })

  it('在持仓明细内新增持仓，提交完整列表并联动刷新工作台资源', async () => {
    let savedHoldings = [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1500 }]
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') return { items: savedHoldings }
      if (request.operation === 'trading-core.holdings-save') {
        savedHoldings = (request.input?.holdings as typeof savedHoldings).map(item => ({ ...item }))
        return { saved: savedHoldings.length }
      }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: request.input?.query, name: '平安银行', market: '深市' }] }
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    const callsBeforeSave = (operation: InvestmentDataRequest['operation']) => requestData.mock.calls
      .filter(([request]) => request.operation === operation).length
    const holdingsReads = callsBeforeSave('trading-core.holdings')
    const riskReads = callsBeforeSave('trading-core.risk-portfolio')
    const alertReads = callsBeforeSave('trading-core.risk-alerts')

    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '股票代码' }), { target: { value: '000001' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '200' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '成本价' }), { target: { value: '12.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存单条持仓' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save',
        input: {
          holdings: [
            { ticker: '600519', quantity: 100, cost_price: 1500 },
            { ticker: '000001', quantity: 200, cost_price: 12.5 },
          ],
        },
      })
    })
    expect(view.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()
    expect((await within(dialog).findByRole('status')).textContent).toContain('持仓已保存')
    expect(within(dialog).queryByRole('tab', { name: '单条录入' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: '导入持仓' })).toBeTruthy()
    await waitFor(() => {
      expect(callsBeforeSave('trading-core.holdings')).toBeGreaterThan(holdingsReads)
      expect(callsBeforeSave('trading-core.risk-portfolio')).toBeGreaterThan(riskReads)
      expect(callsBeforeSave('trading-core.risk-alerts')).toBeGreaterThan(alertReads)
    })
    expect(view.navigate).not.toHaveBeenCalledWith('portfolio')
  })

  it('保存成功到持仓刷新完成前继续以已确认列表为操作基线', async () => {
    let savedHoldings = [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1500 }]
    let saveCount = 0
    let holdingsReadCount = 0
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') {
        holdingsReadCount += 1
        const snapshot = savedHoldings.map(item => ({ ...item }))
        if (saveCount > 0 && holdingsReadCount === 2) await refreshGate
        return { items: snapshot }
      }
      if (request.operation === 'trading-core.holdings-save') {
        saveCount += 1
        savedHoldings = (request.input?.holdings as typeof savedHoldings).map(item => ({ ...item }))
        return { saved: savedHoldings.length }
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '股票代码' }), { target: { value: '000001' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '200' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '成本价' }), { target: { value: '12.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存单条持仓' }))

    expect((await within(dialog).findByRole('status')).textContent).toContain('持仓已保存')
    expect(within(dialog).getByText('000001')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除 贵州茅台 600519' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除 600519' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save',
        input: { holdings: [{ ticker: '000001', quantity: 200, cost_price: 12.5 }] },
      })
    })
    releaseRefresh?.()
    await waitFor(() => { expect(holdingsReadCount).toBeGreaterThanOrEqual(3) })
    await waitFor(() => {
      expect(within(dialog).queryByText('贵州茅台')).toBeNull()
      expect(within(dialog).getAllByText('000001').length).toBeGreaterThan(0)
    })
  })

  it('在持仓明细内编辑并经二次确认删除已有持仓', async () => {
    let savedHoldings = [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1500 }]
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') return { items: savedHoldings }
      if (request.operation === 'trading-core.holdings-save') {
        savedHoldings = (request.input?.holdings as typeof savedHoldings).map(item => ({ ...item }))
        return { saved: savedHoldings.length }
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })

    fireEvent.click(within(dialog).getByRole('button', { name: '编辑 贵州茅台 600519' }))
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '120' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '成本价' }), { target: { value: '1490' } })
    const saveButton = within(dialog).getByRole('button', { name: '保存持仓' })
    saveButton.focus()
    fireEvent.click(saveButton)
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save',
        input: { holdings: [{ ticker: '600519', quantity: 120, cost_price: 1490 }] },
      })
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '导入持仓' }))
    })

    const saveCallsAfterEdit = requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings-save').length
    fireEvent.click(within(dialog).getByRole('button', { name: /删除 .*600519/ }))
    expect(within(dialog).getByText('确认删除该持仓？')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消删除 600519' }))
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings-save')).toHaveLength(saveCallsAfterEdit)

    fireEvent.click(within(dialog).getByRole('button', { name: /删除 .*600519/ }))
    const confirmDeleteButton = within(dialog).getByRole('button', { name: '确认删除 600519' })
    confirmDeleteButton.focus()
    fireEvent.click(confirmDeleteButton)
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save', input: { holdings: [] },
      })
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '导入持仓' }))
    })
  })

  it('拒绝非法和重复持仓，保存失败时保留草稿供重试', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings-save') throw new Error('持仓保存服务暂不可用')
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))

    fireEvent.change(within(dialog).getByRole('textbox', { name: '股票代码' }), { target: { value: '600519' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '0' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '成本价' }), { target: { value: '12.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存单条持仓' }))
    expect(within(dialog).getByRole('alert').textContent).toContain('数量必须大于 0')
    expect(requestData).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'trading-core.holdings-save' }))

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '200' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存单条持仓' }))
    expect(within(dialog).getByRole('alert').textContent).toContain('持仓代码不能重复')
    expect(requestData).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'trading-core.holdings-save' }))

    fireEvent.change(within(dialog).getByRole('textbox', { name: '股票代码' }), { target: { value: '000001' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存单条持仓' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('持仓保存服务暂不可用')
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: '股票代码' }).value).toBe('000001')
    expect(within(dialog).getByRole<HTMLInputElement>('spinbutton', { name: '持仓数量' }).value).toBe('200')
    expect(view.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()
  })

  it('持仓保存未完成时禁止重复提交和关闭模态框', async () => {
    let finishSave: (() => void) | undefined
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings-save') {
        await new Promise<void>((resolve) => { finishSave = resolve })
        return { saved: 2 }
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '股票代码' }), { target: { value: '000001' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '200' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '成本价' }), { target: { value: '12.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存单条持仓' }))

    await waitFor(() => { expect(finishSave).toBeTypeOf('function') })
    expect(within(dialog).getByRole('button', { name: '正在保存…' }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: '关闭持仓明细' }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: '关闭' }).hasAttribute('disabled')).toBe(true)
    view.getByRole('button', { name: '刷新数据' }).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings-save')).toHaveLength(1)

    finishSave?.()
    expect((await within(dialog).findByRole('status')).textContent).toContain('持仓已保存')
  })

  it('在持仓明细内粘贴表格预览并整体替换持仓', async () => {
    let savedHoldings = [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1500 }]
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') return { items: savedHoldings }
      if (request.operation === 'trading-core.holdings-save') {
        savedHoldings = (request.input?.holdings as typeof savedHoldings).map(item => ({ ...item }))
        return { saved: savedHoldings.length }
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    const holdingsReads = requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings').length
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })

    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: '批量导入' }))
    const source = '股票代码\t数量\t成本价\n000001\t200\t12.5\n000858\t300\t135'
    fireEvent.change(within(dialog).getByRole('textbox', { name: '持仓导入内容' }), { target: { value: source } })

    expect(within(dialog).getByText('有效 2 条')).toBeTruthy()
    expect(within(dialog).getByText('错误 0 条')).toBeTruthy()
    expect(within(dialog).getByText('当前 1 条')).toBeTruthy()
    expect(within(dialog).getByText('导入后 2 条')).toBeTruthy()
    expect(within(dialog).getByRole('cell', { name: '000001' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('tab', { name: '单条录入' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: '批量导入' }))
    expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '持仓导入内容' }).value).toBe(source)

    fireEvent.click(within(dialog).getByRole('button', { name: '确认替换 2 条持仓' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save',
        input: {
          holdings: [
            { ticker: '000001', quantity: 200, cost_price: 12.5 },
            { ticker: '000858', quantity: 300, cost_price: 135 },
          ],
        },
      })
    })
    expect((await within(dialog).findByRole('status')).textContent).toContain('已批量导入 2 条持仓')
    expect(within(dialog).queryByRole('tab', { name: '单条录入' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: '导入持仓' })).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings').length).toBeGreaterThan(holdingsReads)
    })
    expect(view.navigate).not.toHaveBeenCalledWith('portfolio')
  })

  it('批量导入统一解析选择文件和拖放文件，并阻止错误数据提交', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => completeResponse(request.operation))
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: '批量导入' }))

    const textarea = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '持仓导入内容' })
    fireEvent.change(textarea, { target: { value: '股票代码,数量,成本价\n600519,0,1500' } })
    expect(within(dialog).getByText('错误 1 条')).toBeTruthy()
    expect(within(dialog).getByRole('alert').textContent).toContain('第 2 行：数量必须大于 0')
    expect(within(dialog).getByRole('button', { name: '确认替换 0 条持仓' }).hasAttribute('disabled')).toBe(true)
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.holdings-save')).toBe(false)

    const selected = new File(['股票代码,数量,成本价\n000001,200,12.5'], '持仓.csv', { type: 'text/csv' })
    Object.defineProperty(selected, 'text', { value: vi.fn(async () => '股票代码,数量,成本价\n000001,200,12.5') })
    fireEvent.change(within(dialog).getByLabelText('选择持仓文件'), { target: { files: [selected] } })
    await waitFor(() => { expect(textarea.value).toContain('000001,200,12.5') })
    expect(within(dialog).getByText('有效 1 条')).toBeTruthy()

    const dropped = new File(['股票代码\t数量\t成本价\n000858\t300\t135'], '持仓.tsv', { type: 'text/tab-separated-values' })
    Object.defineProperty(dropped, 'text', { value: vi.fn(async () => '股票代码\t数量\t成本价\n000858\t300\t135') })
    fireEvent.drop(within(dialog).getByRole('button', { name: '拖放持仓文件' }), { dataTransfer: { files: [dropped] } })
    await waitFor(() => { expect(textarea.value).toContain('000858\t300\t135') })
    expect(within(dialog).getByRole('cell', { name: '000858' })).toBeTruthy()
  })

  it('批量导入保存失败保留草稿，保存期间锁定切换和关闭', async () => {
    let rejectSave: ((reason: Error) => void) | undefined
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings-save') {
        await new Promise<void>((_resolve, reject) => { rejectSave = reject })
      }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('白酒板块经营数据改善')
    fireEvent.click(view.getByRole('button', { name: /持仓数量/ }))
    const dialog = view.getByRole('dialog', { name: '持仓明细' })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入持仓' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: '批量导入' }))
    const source = '股票代码,数量,成本价\n000001,200,12.5'
    fireEvent.change(within(dialog).getByRole('textbox', { name: '持仓导入内容' }), { target: { value: source } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认替换 1 条持仓' }))

    await waitFor(() => { expect(rejectSave).toBeTypeOf('function') })
    expect(within(dialog).getByRole('tab', { name: '单条录入' }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: '返回持仓明细' }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: '正在批量保存…' }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: '关闭持仓明细' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()

    rejectSave?.(new Error('批量保存服务暂不可用'))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('批量保存服务暂不可用')
    expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '持仓导入内容' }).value).toBe(source)
  })

  it('查看完整风险详情在当前页打开风险中心，并展示预算与全部预警', async () => {
    const view = renderWorkbench()
    await view.findByText('白酒板块经营数据改善')

    const trigger = view.getByRole('button', { name: '查看完整风险详情 →' })
    fireEvent.click(trigger)

    const dialog = view.getByRole('dialog', { name: '组合风险中心' })
    expect(within(dialog).getByText('风险预算')).toBeTruthy()
    expect(within(dialog).getByText('单股预算上限')).toBeTruthy()
    expect(within(dialog).getByText('25.0%')).toBeTruthy()
    expect(within(dialog).getByText('组合波动预算上限')).toBeTruthy()
    expect(within(dialog).getByText('18.0%')).toBeTruthy()
    expect(within(dialog).getByText('预算突破')).toBeTruthy()
    expect(within(dialog).getByText('当前值 1.000')).toBeTruthy()
    expect(within(dialog).getByText('预算上限 0.300')).toBeTruthy()
    expect(within(dialog).getByText('集中度超预算')).toBeTruthy()
    expect(within(dialog).getByText('画像预算提示')).toBeTruthy()
    expect(within(dialog).getByText('组合风险引擎')).toBeTruthy()
    expect(within(dialog).getByText('600519')).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: '研究建议' })).toBeTruthy()
    expect(view.navigate).not.toHaveBeenCalledWith('portfolio')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(view.queryByRole('dialog', { name: '组合风险中心' })).toBeNull() })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('资源未加载或失败时展示真实状态，不把未知数据误报为空', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') throw new Error('持仓服务离线')
      if (request.operation === 'trading-core.risk-portfolio') throw new Error('风险服务离线')
      if (request.operation === 'trading-core.risk-alerts') throw new Error('预警服务离线')
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    await view.findByText('持仓暂不可用')

    const holdingsTrigger = view.getByRole('button', { name: /持仓数量/ })
    fireEvent.click(holdingsTrigger)
    const holdingsDialog = view.getByRole('dialog', { name: '持仓明细' })
    expect(within(holdingsDialog).getByText('持仓详情暂不可用')).toBeTruthy()
    expect(within(holdingsDialog).queryByText(/尚未保存持仓/)).toBeNull()
    fireEvent.click(within(holdingsDialog).getByRole('button', { name: '关闭持仓明细' }))

    const riskTrigger = view.getByRole('button', { name: /需关注预警/ })
    fireEvent.click(riskTrigger)
    const riskDialog = view.getByRole('dialog', { name: '组合风险中心' })
    expect(within(riskDialog).getByText('组合风险暂不可用')).toBeTruthy()
    expect(within(riskDialog).getByText('风险预警暂不可用')).toBeTruthy()
    const alertHeading = within(riskDialog).getByRole('heading', { name: '全部预警' }).parentElement!
    expect(within(alertHeading).getByText('—')).toBeTruthy()
    expect(within(alertHeading).queryByText('0 条')).toBeNull()
    expect(within(riskDialog).queryByText(/当前没有风险预警/)).toBeNull()
  })

  it('显式反馈显示当前选择、支持纠正，并只发送白名单上下文', async () => {
    const view = renderWorkbench()
    const heading = await view.findByRole('heading', { name: '白酒板块经营数据改善' })
    const card = heading.closest('article')!
    const controls = within(card)

    fireEvent.click(controls.getByRole('button', { name: '值得关注' }))
    await waitFor(() => {
      expect(view.requestData).toHaveBeenCalledWith({
        operation: 'trading-core.personalized-feedback',
        input: {
          card_id: 'card-holdings', sentiment: 'useful',
          meta: { ticker: '600519', direction: '利好', bucket: 'holdings' },
        },
      })
    })
    expect(controls.getByRole('button', { name: '值得关注' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(controls.getByRole('button', { name: '减少此类' }))
    await waitFor(() => {
      expect(controls.getByRole('button', { name: '减少此类' }).getAttribute('aria-pressed')).toBe('true')
    })
    const correction = view.requestData.mock.calls
      .map(([request]) => request)
      .filter(request => request.operation === 'trading-core.personalized-feedback')
      .at(-1)
    expect(correction?.input?.card_id).toBe('card-holdings')
    expect(correction?.input?.sentiment).toBe('useless')
  })

  it('标题与摘要重复时只保留标题，并把可操作项集中在独立操作区', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      const response = completeResponse(request.operation)
      if (request.operation !== 'trading-core.personalized-cards') return response
      const value = response as { cards: Array<Record<string, unknown>> }
      return {
        ...value,
        cards: [{ ...value.cards[0], title: '银行行业资金流出榜', summary: '银行行业资金流出榜。' }],
      }
    })
    const view = renderWorkbench(requestData)

    const heading = await view.findByRole('heading', { name: '银行行业资金流出榜' })
    const article = heading.closest('article')!
    expect(within(article).queryByText('银行行业资金流出榜。')).toBeNull()
    const controls = within(article).getByRole('group', { name: '事件操作' })
    expect(within(controls).getByRole('button', { name: '查看事件详情' })).toBeTruthy()
    expect(within(controls).getByRole('button', { name: '带入智能分析' })).toBeTruthy()
  })

  it('反馈失败给出局部重试提示，不阻塞事件详情', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.personalized-feedback') throw new Error('offline')
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)
    const heading = await view.findByRole('heading', { name: '白酒板块经营数据改善' })
    const card = heading.closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: '值得关注' }))
    expect((await within(card).findByRole('alert')).textContent).toContain('偏好未保存，请重试。')
    fireEvent.click(within(card).getByRole('button', { name: '查看事件详情' }))
    expect(await view.findByRole('dialog')).toBeTruthy()
  })

  it('卡片进入一半视口并持续一秒后才记录有效曝光', async () => {
    vi.useFakeTimers()
    const observers: Array<{
      callback: IntersectionObserverCallback
      element?: Element
      disconnected: boolean
    }> = []
    class TestIntersectionObserver {
      readonly root = null
      readonly rootMargin = '0px'
      readonly thresholds = [0.5]
      private readonly state: typeof observers[number]
      constructor(callback: IntersectionObserverCallback) {
        this.state = { callback, disconnected: false }
        observers.push(this.state)
      }
      observe = (element: Element) => { this.state.element = element }
      unobserve = () => {}
      disconnect = () => { this.state.disconnected = true }
      takeRecords = () => []
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const view = renderWorkbench()
    await vi.waitFor(() => { expect(view.getByText('白酒板块经营数据改善')).toBeTruthy() })
    const article = view.getByText('白酒板块经营数据改善').closest('article')!
    const observer = observers.find(item => item.element === article)!

    observer.callback([{ isIntersecting: true, intersectionRatio: 0.5 } as IntersectionObserverEntry], {} as IntersectionObserver)
    await vi.advanceTimersByTimeAsync(999)
    expect(view.trackTelemetry).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'impression' }))
    observer.callback([{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry], {} as IntersectionObserver)
    await vi.advanceTimersByTimeAsync(1)
    expect(view.trackTelemetry).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'impression' }))

    observer.callback([{ isIntersecting: true, intersectionRatio: 0.8 } as IntersectionObserverEntry], {} as IntersectionObserver)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(view.trackTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      action: 'impression', targetType: 'event', targetId: 'card-holdings', dedupe: 'session',
    }))
  })

  it('筛选关联事件，并以可复核详情承接事件、风险和策略动作', async () => {
    const view = renderWorkbench()
    const holdingsEvent = await view.findByText('白酒板块经营数据改善')
    const holdingsArticle = holdingsEvent.closest('article')!
    fireEvent.click(within(holdingsArticle).getByRole('button', { name: '查看个股' }))
    expect(view.navigate).toHaveBeenCalledWith('stock-detail', { stockCode: '600519' })
    fireEvent.click(within(holdingsArticle).getByRole('button', { name: '带入智能分析' }))
    expect(view.onAnalyze).toHaveBeenCalledWith({ kind: 'stock', code: '600519', name: '贵州茅台' })
    fireEvent.click(within(holdingsArticle).getByRole('button', { name: '查看事件详情' }))
    const eventDialog = view.getByRole('dialog', { name: '白酒板块经营数据改善' })
    expect(within(eventDialog).getByText('事件研究详情')).toBeTruthy()
    expect(within(eventDialog).getByText(/暂未返回稳定事件标识/)).toBeTruthy()
    fireEvent.click(within(eventDialog).getByRole('button', { name: '关闭' }))

    fireEvent.click(view.getByRole('button', { name: '策略', pressed: false }))
    expect(view.queryByText('白酒板块经营数据改善')).toBeNull()
    const strategyEvent = view.getByText('半导体设备订单变化').closest('article')!
    fireEvent.click(within(strategyEvent).getByRole('button', { name: '查看策略' }))
    expect(view.navigate).toHaveBeenCalledWith('framework', { strategyId: 'strategy-alpha' })

    fireEvent.click(view.getByRole('button', { name: /设备景气策略/ }))
    expect(view.navigate).toHaveBeenCalledWith('framework', { strategyId: 'strategy-alpha' })

    const alert = view.getByText('集中度超预算').closest('article')!
    fireEvent.click(within(alert).getByRole('button', { name: '查看详情' }))
    const riskDialog = view.getByRole('dialog', { name: '集中度超预算' })
    expect(within(riskDialog).getByText('触发原因')).toBeTruthy()
    expect(within(riskDialog).getByText('数据来源与口径')).toBeTruthy()
    expect(within(riskDialog).getByText('建议动作')).toBeTruthy()
    fireEvent.click(within(riskDialog).getByRole('button', { name: '带入智能分析' }))
    expect(view.onAnalyze).toHaveBeenCalledWith({ kind: 'stock', code: '600519' })
  })

  it('单个慢区失败时保留其他区域，并只重试失败资源', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.personalized-cards') throw new Error('事件上游暂不可用')
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)

    expect(await view.findByText('关联事件暂不可用')).toBeTruthy()
    expect(view.getByText('贵州茅台')).toBeTruthy()
    expect(view.getByText('集中度超预算')).toBeTruthy()
    const initialCalls = requestData.mock.calls.length
    fireEvent.click(view.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(requestData.mock.calls.length).toBe(initialCalls + 1) })
    expect(requestData.mock.calls.at(-1)?.[0].operation).toBe('trading-core.personalized-cards')
  })

  it('生成盘前简报时展示任务状态，完成后进入统一报告入口', async () => {
    const task = '1234567890abcdef1234567890abcdef'
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.brief-start') return { task_id: task }
      if (request.operation === 'trading-core.task-status') return { status: 'done' }
      if (request.operation === 'trading-core.task-result') return { reports: { brief: { id: 'report-1' } } }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)

    fireEvent.click(view.getByRole('button', { name: '生成盘前简报' }))
    expect(await view.findByText('盘前简报已生成，可在投研报告中查看。')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.brief-start', input: { period: 'pre_market', scope: 'all' },
    })
    expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-status', input: { task_id: task } })
    expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-result', input: { task_id: task } })
    fireEvent.click(view.getByRole('button', { name: '打开投研报告' }))
    expect(view.onOpenReports).toHaveBeenCalledOnce()
  })

  it('简报任务创建失败时不把旧报告入口冒充为本次结果', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.brief-start') throw new Error('任务创建失败')
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)

    fireEvent.click(view.getByRole('button', { name: '生成盘前简报' }))
    expect(await view.findByText('任务创建失败')).toBeTruthy()
    expect(view.queryByRole('button', { name: '打开投研报告' })).toBeNull()
    expect(view.getByRole('button', { name: '生成盘前简报' })).toBeTruthy()
  })
})
