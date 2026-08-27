import { describe, expect, it, vi } from 'vitest'
import { InvestmentUiState } from '../src/client/state.ts'

describe('InvestmentUiState', () => {
  it('starts on 研究工作台 and keeps module drafts and selected entities independent', () => {
    const state = new InvestmentUiState()
    const listener = vi.fn()
    const unsubscribe = state.subscribe(listener)

    expect(state.getSnapshot()).toEqual({
      route: 'dashboard',
      historyOpen: false,
      reportsOpen: false,
      assistantMode: 'closed',
      assistantModule: 'general',
      analysisQuery: '',
      backtestQuery: '',
      watchQuery: '',
      chainQuery: '',
      selectedStockCode: '',
      selectedStrategyId: '',
    })

    state.setDraft('analysisQuery', '600519')
    state.setDraft('backtestQuery', '000001')
    state.setDraft('watchQuery', '000001')
    state.setDraft('chainQuery', '半导体')
    state.setHistory(true)
    state.navigate('stock-detail', { stockCode: '300750' })
    state.navigate('projects', { strategyId: 'strategy-1' })

    expect(listener).toHaveBeenCalledTimes(7)
    expect(state.getSnapshot()).toEqual({
      route: 'projects',
      historyOpen: false,
      reportsOpen: false,
      assistantMode: 'closed',
      assistantModule: 'general',
      analysisQuery: '600519',
      backtestQuery: '000001',
      watchQuery: '000001',
      chainQuery: '半导体',
      selectedStockCode: '300750',
      selectedStrategyId: 'strategy-1',
    })

    unsubscribe()
    state.navigate('portfolio')
    expect(listener).toHaveBeenCalledTimes(7)
  })

  it('makes history and reports mutually exclusive and skips duplicate publications', () => {
    const state = new InvestmentUiState()
    const listener = vi.fn()
    state.subscribe(listener)

    state.setHistory(false)
    expect(listener).not.toHaveBeenCalled()

    state.setHistory(true)
    state.setReports(true)
    expect(state.getSnapshot()).toMatchObject({ historyOpen: false, reportsOpen: true })

    state.setReports(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('only carries a strategy into shadow validation through an explicit lifecycle hand-off', () => {
    const state = new InvestmentUiState()

    state.selectStrategy('candidate-from-backtest')
    state.navigate('projects')
    expect(state.getSnapshot().selectedStrategyId).toBe('')

    state.navigate('framework')
    state.navigate('projects', { strategyId: 'active-strategy' })
    expect(state.getSnapshot().selectedStrategyId).toBe('active-strategy')
  })

  it('keeps assistant display and module state independent from the business route', () => {
    const state = new InvestmentUiState()

    state.navigate('analysis')
    state.setDraft('analysisQuery', '600519')
    state.openAssistant('stock')
    expect(state.getSnapshot()).toMatchObject({
      route: 'analysis', analysisQuery: '600519', assistantMode: 'docked', assistantModule: 'stock',
    })

    state.setAssistantMode('expanded')
    state.setAssistantMode('docked')
    state.setAssistantMode('closed')
    expect(state.getSnapshot()).toMatchObject({
      route: 'analysis', analysisQuery: '600519', assistantMode: 'closed', assistantModule: 'stock',
    })

    state.navigate('assistant')
    expect(state.getSnapshot().route).toBe('analysis')
  })
})
