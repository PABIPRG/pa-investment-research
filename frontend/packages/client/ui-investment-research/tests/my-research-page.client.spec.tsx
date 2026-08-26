// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MyResearchPage } from '../src/client/MyResearchPage.tsx'

afterEach(cleanup)

type RequestData = ComponentProps<typeof MyResearchPage>['requestData']

function fixture(operation: string): unknown {
  if (operation === 'trading-core.holdings') {
    return { items: [{ ticker: '600519', name: '贵州茅台', quantity: 100, cost_price: 1_500 }] }
  }
  if (operation === 'market-watch.watchlist') {
    return { items: [{ code: '688981', name: '中芯国际' }] }
  }
  if (operation === 'trading-core.kyc-profile') {
    return {
      status: 'completed',
      inferred_profile: 'balanced',
      effective_profile: 'balanced',
      tiers: { quick: ['horizon', 'loss_tolerance', 'goal'], full: ['horizon', 'loss_tolerance', 'goal'] },
      question_bank: {
        horizon: { title: '你计划持有这笔资金多久？', options: [{ label: '1-3年', score: 3 }, { label: '5年以上', score: 5 }] },
        loss_tolerance: { title: '你能承受多大亏损？', options: [{ label: '10%左右', score: 3 }, { label: '20%以上', score: 5 }] },
        goal: { title: '你的投资目标是？', options: [{ label: '长期稳健增值', score: 3 }, { label: '追求高回报', score: 5 }] },
      },
      profiles_detail: { balanced: { risk_budget: { single_stock_weight_max: 0.25 } } },
    }
  }
  if (operation === 'trading-core.risk-profile') return { risk_profile: 'balanced', label: '稳健型' }
  if (operation === 'trading-core.personalized-profile') {
    return {
      effective_aggression: 0.58,
      behavior: {
        interest_industries: [{ industry: '半导体', count: 4 }],
        direction_skew: { 利好: 3, 利空: 1, good_pct: 0.75, bad_pct: 0.25 },
        strategy_affinity: [{ strategy_id: 's1', name: '事件动量', count: 2 }],
      },
    }
  }
  if (operation === 'trading-core.risk-portfolio') {
    return {
      summary: { n_positions: 1, equal_weight: 1, hhi: 1, shadow_max_drawdown: 0.08, shadow_annualized_vol: 0.21 },
      breaches: [{ indicator: 'single_stock_weight', severity: '高', label: '单股仓位超限', detail: '贵州茅台权重超过预算。' }],
    }
  }
  if (operation === 'trading-core.holdings-analyze') return { task_id: 'portfolio-task-1' }
  if (operation === 'trading-core.task-result') {
    return { signal: { total_market_value: 180_000, floating_pnl: 30_000, portfolio_annualized_vol: 0.24, concentration_hhi: 1, weighted_risk_score: 0.62, rebalance_suggestions: ['建议降低单股集中度。'] } }
  }
  if (operation === 'trading-core.kyc-questionnaire') return { profile: 'balanced', label: '稳健型' }
  if (operation === 'trading-core.kyc-adjust') return { profile: 'aggressive', label: '进取型' }
  if (operation === 'trading-core.kyc-parse') return { answers: [{ qid: 'horizon', label: '1-3年', score: 3 }] }
  return {}
}

function createRequestData(): ReturnType<typeof vi.fn<RequestData>> {
  return vi.fn<RequestData>(request => Promise.resolve(fixture(request.operation)))
}

describe('我的投研页面', () => {
  it('在独立数据区展示持仓、自选、风险画像和行为画像', async () => {
    const requestData = createRequestData()
    render(<MyResearchPage requestData={requestData} onAskAssistant={() => {}} />)

    expect(await screen.findByText('贵州茅台')).toBeTruthy()
    expect(screen.getByText('中芯国际')).toBeTruthy()
    expect(screen.getAllByText('稳健型').length).toBeGreaterThan(0)
    expect(screen.getByText('关注：半导体')).toBeTruthy()
    expect(screen.getByText('100.0%')).toBeTruthy()
    expect(screen.getByText('单股仓位超限')).toBeTruthy()
    expect(requestData).toHaveBeenCalledTimes(6)
    expect(screen.queryByText('接口覆盖')).toBeNull()
    expect(screen.queryByText('验收场景')).toBeNull()
  })

  it('保存持仓后刷新持仓与组合风险', async () => {
    const requestData = createRequestData()
    render(<MyResearchPage requestData={requestData} onAskAssistant={() => {}} />)
    await screen.findByText('贵州茅台')

    fireEvent.click(screen.getByRole('button', { name: '编辑持仓' }))
    fireEvent.change(screen.getByLabelText('第 1 行持仓数量'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: '保存持仓' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.holdings-save',
        input: { holdings: [{ ticker: '600519', quantity: 120, cost_price: 1_500 }] },
      })
    })
    expect(await screen.findByText('已保存 1 条持仓，组合风险正在刷新。')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings')).toHaveLength(2)
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.risk-portfolio')).toHaveLength(2)
    })
  })

  it('通过真实操作添加与移除自选并在成功后刷新', async () => {
    const requestData = createRequestData()
    render(<MyResearchPage requestData={requestData} onAskAssistant={() => {}} />)
    await screen.findByText('中芯国际')

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加自选' }))
    fireEvent.change(screen.getByLabelText('自选股票代码'), { target: { value: '002371' } })
    fireEvent.change(screen.getByLabelText('自选股票名称'), { target: { value: '北方华创' } })
    fireEvent.click(screen.getByRole('button', { name: '添加自选' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'market-watch.watch-add', input: { code: '002371', name: '北方华创' } })
    })

    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'market-watch.watch-remove', input: { code: '688981' } })
    })
  })

  it('组合风险按钮调用后端异步任务并把结果留在当前页面', async () => {
    const requestData = createRequestData()
    const onAskAssistant = vi.fn<ComponentProps<typeof MyResearchPage>['onAskAssistant']>()
    render(<MyResearchPage requestData={requestData} onAskAssistant={onAskAssistant} />)
    await screen.findByText('贵州茅台')

    fireEvent.click(screen.getByRole('button', { name: '分析组合风险' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith(expect.objectContaining({ operation: 'trading-core.holdings-analyze' }))
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-result', input: { task_id: 'portfolio-task-1' } })
    })
    expect(await screen.findByRole('region', { name: '最新组合风险分析' })).toBeTruthy()
    expect(screen.getByText('建议降低单股集中度。')).toBeTruthy()
    expect(onAskAssistant).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '问投研助理' }))
    const assistantInput = onAskAssistant.mock.calls.at(-1)?.[0]
    if (assistantInput === undefined || typeof assistantInput === 'string') throw new Error('expected structured assistant input')
    expect(assistantInput.intent).toBe('portfolio.holding-research')
    expect(assistantInput.module).toBe('portfolio')
    expect(assistantInput.question).toContain('600519')
    const assistantData = assistantInput.data as { selectedHolding?: { ticker?: string } }
    expect(assistantData.selectedHolding?.ticker).toBe('600519')
  })

  it('通过 KYC 接口完成问卷并应用画像', async () => {
    const requestData = createRequestData()
    render(<MyResearchPage requestData={requestData} onAskAssistant={() => {}} />)
    await screen.findByText('贵州茅台')

    fireEvent.click(screen.getByRole('button', { name: '重做风险测评' }))
    fireEvent.click(screen.getByRole('radio', { name: '1-3年' }))
    fireEvent.click(screen.getByRole('radio', { name: '10%左右' }))
    fireEvent.click(screen.getByRole('radio', { name: '长期稳健增值' }))
    fireEvent.click(screen.getByRole('button', { name: '提交并应用画像' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.kyc-questionnaire',
        input: {
          answers: [
            { qid: 'horizon', label: '1-3年', score: 3 },
            { qid: 'loss_tolerance', label: '10%左右', score: 3 },
            { qid: 'goal', label: '长期稳健增值', score: 3 },
          ],
          tier: 'quick',
          method: 'questionnaire',
        },
      })
    })
    expect(await screen.findByText('风险测评已完成，当前画像更新为稳健型。')).toBeTruthy()
  })

  it('通过 KYC 微调接口复核生效画像', async () => {
    const requestData = createRequestData()
    render(<MyResearchPage requestData={requestData} onAskAssistant={() => {}} />)
    await screen.findByText('贵州茅台')

    fireEvent.click(screen.getByRole('button', { name: '复核画像' }))
    fireEvent.change(screen.getByLabelText('风险承受度'), { target: { value: '0.8' } })
    fireEvent.change(screen.getByLabelText('计划投资期限'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: '确认并应用' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.kyc-adjust',
        input: { risk_tolerance: 0.8, horizon_years: 5 },
      })
    })
    expect(await screen.findByText('画像复核已应用，当前画像为进取型。')).toBeTruthy()
  })

  it('单一区域失败时提供自己的重试且不影响其他数据区', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'trading-core.kyc-profile') return Promise.reject(new Error('画像服务繁忙'))
      return Promise.resolve(fixture(request.operation))
    })
    render(<MyResearchPage requestData={requestData} onAskAssistant={() => {}} />)

    expect(await screen.findByText('贵州茅台')).toBeTruthy()
    expect(screen.getByText('中芯国际')).toBeTruthy()
    expect(await screen.findByText('画像服务繁忙')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.kyc-profile')).toHaveLength(2)
    })
  })
})
