// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { ResearchWorkbenchPage } from '../src/client/ResearchWorkbenchPage.tsx'

afterEach(cleanup)

function completeResponse(operation: InvestmentDataRequest['operation']): unknown {
  if (operation === 'trading-core.holdings') {
    return { items: [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1500 }] }
  }
  if (operation === 'trading-core.risk-portfolio') {
    return {
      as_of: '2026-08-26 09:31:00', profile_label: '稳健型',
      summary: { n_positions: 1, equal_weight: 1, hhi: 1 },
      breaches: [{ indicator: 'hhi', severity: '高' }],
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
  return {}
}

function renderWorkbench(requestData = vi.fn(async (request: InvestmentDataRequest) => completeResponse(request.operation))) {
  const navigate = vi.fn()
  const onAnalyze = vi.fn()
  const onOpenReports = vi.fn()
  const view = render(
    <ResearchWorkbenchPage
      requestData={requestData}
      navigate={navigate}
      onAnalyze={onAnalyze}
      onOpenReports={onOpenReports}
    />,
  )
  return { ...view, requestData, navigate, onAnalyze, onOpenReports }
}

describe('研究工作台', () => {
  it('并行读取五类真实数据，并展示真实 cards 与 match_reasons DTO', async () => {
    const view = renderWorkbench()

    expect(view.getByRole('heading', { name: '研究工作台' })).toBeTruthy()
    await waitFor(() => { expect(view.requestData).toHaveBeenCalledTimes(5) })
    expect(view.requestData.mock.calls.map(([request]) => request.operation)).toEqual(expect.arrayContaining([
      'trading-core.holdings',
      'trading-core.risk-portfolio',
      'trading-core.risk-alerts',
      'trading-core.personalized-cards',
      'trading-core.personalized-matches',
    ]))
    expect(view.requestData).toHaveBeenCalledWith({
      operation: 'trading-core.personalized-cards',
      input: { limit: 20, bucket: 'all', match: true, comment: false },
    })

    expect(await view.findByText('白酒板块经营数据改善')).toBeTruthy()
    expect(view.getByText('稳健画像与策略风险需求匹配')).toBeTruthy()
    expect(view.getByText('持仓成本金额')).toBeTruthy()
    expect(view.getByText('数量 × 成本价，非实时市值')).toBeTruthy()
    expect(view.getByText('¥15.0 万')).toBeTruthy()
    expect(view.getByText('集中度超预算')).toBeTruthy()
  })

  it('空持仓不把成本口径展示成伪造的零资产值', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.holdings') return { items: [] }
      return completeResponse(request.operation)
    })
    const view = renderWorkbench(requestData)

    expect(await view.findByText('尚未保存持仓。录入真实持仓后，这里会关联风险与资讯。')).toBeTruthy()
    const metric = view.getByText('持仓成本金额').parentElement!
    expect(within(metric).getByText('—')).toBeTruthy()
    expect(view.queryByText('¥0')).toBeNull()
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
