// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import {
  AnalysisPage,
  ChainPage,
  DashboardPage,
  EvolutionPage,
  ShadowPage,
  StrategyPage,
} from '../src/client/V2Pages.tsx'

afterEach(cleanup)

type DashboardRequest = ComponentProps<typeof DashboardPage>['requestData']

function dashboardData(operation: string): unknown {
  if (operation === 'trading-core.holdings') {
    return { items: [{ ticker: '600519', quantity: 100, cost_price: 1500 }] }
  }
  if (operation === 'trading-core.risk-alerts') {
    return { items: [{ id: 'risk-1', severity: '高', title: '集中度超限', detail: '单一持仓权重较高' }] }
  }
  if (operation === 'trading-core.personalized-cards') {
    return { items: [{ card_id: 'card-1', bucket: 'holdings', direction: '利空', title: '白酒渠道波动', summary: '持仓相关事件', relevance_score: 92 }] }
  }
  if (operation === 'trading-core.personalized-matches') {
    return { items: [{ strategy_id: 'strategy-1', name: '价值质量策略', match_score: 88 }] }
  }
  if (operation === 'trading-core.risk-profile') return { label: '稳健型' }
  return {}
}

describe('v0.0.2 投研业务页面', () => {
  it('研究工作台展示真实资源并通过后端任务生成盘前简报', async () => {
    const requestData = vi.fn<DashboardRequest>((request) => {
      if (request.operation === 'trading-core.brief-run') return Promise.resolve({ task_id: 'brief-1' })
      if (request.operation === 'trading-core.task-status') return Promise.resolve({ status: 'done' })
      if (request.operation === 'trading-core.task-result') return Promise.resolve({ summary: '今日关注白酒渠道与组合集中度。' })
      return Promise.resolve(dashboardData(request.operation))
    })
    render(<DashboardPage requestData={requestData} onAnalyze={() => {}} onNavigate={() => {}} />)

    expect(await screen.findByText('白酒渠道波动')).toBeTruthy()
    expect(screen.getByText('集中度超限')).toBeTruthy()
    expect(screen.getByText('价值质量策略')).toBeTruthy()
    expect(screen.getByText('稳健型')).toBeTruthy()
    expect(requestData).toHaveBeenCalledTimes(5)

    fireEvent.click(screen.getByRole('button', { name: '有用' }))
    expect(screen.getByRole('button', { name: '有用' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.personalized-feedback',
        input: { card_id: 'card-1', sentiment: 'useful', meta: { surface: 'dashboard' } },
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '自选' }))
    expect(screen.getByText('当前范围没有相关事件。')).toBeTruthy()
    expect(screen.queryByText('接入说明')).toBeNull()
    expect(screen.queryByText('接口覆盖')).toBeNull()
    expect(screen.queryByText('验收场景')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '生成盘前简报' }))
    expect(await screen.findByText('今日关注白酒渠道与组合集中度。')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.brief-run', input: { period: 'pre_market', scope: 'all' },
    })
    expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-status', input: { task_id: 'brief-1' } })
    expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-result', input: { task_id: 'brief-1' } })
  })

  it('智能分析通过后端任务运行并仅把已返回的业务结果交给投研助理', async () => {
    const requestData = vi.fn<DashboardRequest>((request) => {
      if (request.operation === 'trading-core.analyze') return Promise.resolve({ task_id: 'stock-task-1' })
      if (request.operation === 'trading-core.task-status') return Promise.resolve({ status: 'done' })
      if (request.operation === 'trading-core.task-result') return Promise.resolve({ signal: { action: '谨慎增持', reasoning: '估值合理但波动仍高。' } })
      return Promise.resolve({})
    })
    const onAnalyze = vi.fn<ComponentProps<typeof AnalysisPage>['onAnalyze']>()
    render(<AnalysisPage requestData={requestData} onAnalyze={onAnalyze} onPortfolio={() => {}} />)

    fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: '000001' } })
    fireEvent.change(screen.getByLabelText('研究深度'), { target: { value: 'deep' } })
    fireEvent.click(screen.getAllByRole('button', { name: '开始分析' })[0]!)
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.analyze', input: { ticker: '000001', research_depth: 'deep' } })
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-result', input: { task_id: 'stock-task-1' } })
    })
    expect(await screen.findByText('估值合理但波动仍高。')).toBeTruthy()
    expect(onAnalyze).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '让投研助理解读结果 →' }))
    const assistantInput = onAnalyze.mock.calls[0]?.[0]
    if (assistantInput === undefined || typeof assistantInput === 'string') throw new Error('expected structured assistant input')
    expect(assistantInput.module).toBe('analysis')
    expect((assistantInput.data as { task?: string }).task).toBe('stock')
  })

  it('策略、影子和自进化页面读取各自的真实数据区', async () => {
    const requestData = vi.fn<DashboardRequest>((request) => {
      if (request.operation === 'trading-core.strategies') return Promise.resolve({ items: [{ strategy_id: 's1', name: '事件动量', status: 'active', kind: 'momentum', symbols: ['600519'] }] })
      if (request.operation === 'trading-core.strategy-detail') return Promise.resolve({ strategy_id: 's1', name: '事件动量', status: 'active', kind: 'momentum', symbols: ['600519'], hypothesis: '事件推动短期动量' })
      if (request.operation === 'trading-core.strategy-run') return Promise.resolve({ task_id: 'strategy-task-1' })
      if (request.operation === 'trading-core.strategy-action') return Promise.resolve({ id: 's1', status: 'retired' })
      if (request.operation === 'trading-core.task-status') return Promise.resolve({ status: 'done' })
      if (request.operation === 'trading-core.task-result') return Promise.resolve({ passed: true })
      if (request.operation === 'market-watch.news-events') return Promise.resolve({ items: [{ id: 'event-1' }] })
      if (request.operation === 'trading-core.shadow-status') return Promise.resolve({ trade_date: '2026-08-25', strategy_count: 1 })
      if (request.operation === 'trading-core.shadow-positions') return Promise.resolve({ items: [{ strategy_id: 's1', ticker: '600519', quantity: 100 }] })
      if (request.operation === 'trading-core.shadow-equity') return Promise.resolve({ items: [{ date: '2026-08-25', overall_nav: 1.02 }, { date: '2026-08-24', overall_nav: 1.0 }] })
      if (request.operation === 'trading-core.evolution-status') return Promise.resolve({ ready: true, days_of_data: 12, min_days: 5 })
      if (request.operation === 'trading-core.evolution-attribution') return Promise.resolve({ overall: { return_pct: 6.7 }, strategies: [{ strategy_id: 's1', name: '事件动量', return_pct: 8.4, status: 'active' }] })
      if (request.operation === 'trading-core.evolution-run') return Promise.resolve({ status: 'ready', applied: false, actions: [{ type: 'promote', sid: 's1', reason: '净值达到升级线' }] })
      return Promise.resolve({})
    })

    const strategyView = render(<StrategyPage requestData={requestData} onAnalyze={() => {}} />)
    expect(await screen.findByText('事件动量')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    expect(await screen.findByText('事件推动短期动量')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '运行样本外回测' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.strategy-run', input: { strategy_id: 's1' } })
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.task-result', input: { task_id: 'strategy-task-1' } })
    })
    strategyView.unmount()

    const shadowView = render(<ShadowPage requestData={requestData} onAnalyze={() => {}} />)
    await waitFor(() => { expect(screen.getByRole('img', { name: '影子净值曲线' })).toBeTruthy() })
    shadowView.unmount()

    render(<EvolutionPage requestData={requestData} onAnalyze={() => {}} />)
    expect(await screen.findByText('已就绪')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认并应用' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '预览本轮动作' }))
    expect(await screen.findByText('净值达到升级线')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认并应用' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '确认并应用' }))
    fireEvent.click(screen.getByRole('button', { name: '确认写入策略池' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.evolution-run', input: { apply: true } })
    })
  })

  it('策略假设、候选入池和影子验证均调用真实业务接口', async () => {
    const requestData = vi.fn<DashboardRequest>((request) => {
      if (request.operation === 'trading-core.strategies') return Promise.resolve({ items: [] })
      if (request.operation === 'market-watch.news-events') return Promise.resolve({ items: [{ id: 'e1' }, { id: 'e2' }] })
      if (request.operation === 'trading-core.strategies-hypothesize') {
        return Promise.resolve({ n_events: 2, hypotheses: [{ event_idx: 0, symbols: ['600519'], direction: '利好', kind: 'momentum', rationale: '渠道改善', holding_window_days: 20 }], candidates: request.input?.dry_run === true ? [] : ['strat-1'] })
      }
      if (request.operation === 'trading-core.shadow-status') return Promise.resolve({})
      if (request.operation === 'trading-core.shadow-positions') return Promise.resolve({ items: [] })
      if (request.operation === 'trading-core.shadow-equity') return Promise.resolve({ items: [] })
      if (request.operation === 'trading-core.shadow-run') return Promise.resolve({ task_id: 'shadow-1' })
      if (request.operation === 'trading-core.task-status') return Promise.resolve({ status: 'done' })
      if (request.operation === 'trading-core.task-result') return Promise.resolve({ note: '影子记账完成' })
      return Promise.resolve({})
    })

    const strategyView = render(<StrategyPage requestData={requestData} onAnalyze={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '预览投资假设' }))
    expect(await screen.findByText('渠道改善')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.strategies-hypothesize', input: { limit: 20, dry_run: true } })
    fireEvent.click(screen.getByRole('button', { name: '生成候选策略' }))
    fireEvent.click(screen.getByRole('button', { name: '确认生成并入池' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.strategies-hypothesize', input: { limit: 2, dry_run: false } })
    })
    strategyView.unmount()

    render(<ShadowPage requestData={requestData} onAnalyze={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '运行今日影子验证' }))
    expect(await screen.findByText('影子记账完成')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.shadow-run', input: { force: false } })
  })

  it('产业链在未选公司时使用可行动空状态', () => {
    const onAnalyze = vi.fn()
    render(<ChainPage onAnalyze={onAnalyze} />)
    const input = screen.getByRole('textbox', { name: '搜索公司、代码或行业' })
    const submit = screen.getByRole('button', { name: '搜索' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: '中芯国际' } })
    fireEvent.click(submit)
    expect(onAnalyze).toHaveBeenCalledWith(expect.stringContaining('中芯国际 的产业链'))
  })
})
