// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { EvolutionDashboard } from '../src/client/EvolutionDashboard.tsx'
import { StrategyEvolutionDiagnostics } from '../src/client/StrategyEvolutionDiagnostics.tsx'
import { StrategyResearchPage } from '../src/client/ProductPages.tsx'

afterEach(cleanup)

describe('自进化全局只读看板', () => {
  it('只读取状态与归因且没有人工应用入口', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: false,
        lifecycle: {},
        per_strategy: [],
        recent_applied: [],
        counts: {},
      }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<EvolutionDashboard
      requestData={requestData}
      onAnalyze={() => {}}
      onOpenStrategy={() => {}}
    />)

    expect(await screen.findByText('策略演化链路')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成进化预案' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认并应用' })).toBeNull()
    expect(requestData.mock.calls.map(([request]) => request.operation)).toEqual([
      'trading-core.evolution-status',
      'trading-core.evolution-attribution',
    ])
    expect(screen.getByText(/自动闭环未启用/)).toBeTruthy()
    expect(screen.queryByText(/正在每日自动运行/)).toBeNull()
  })

  it('策略现状、链路和历史动作都进入对应策略诊断', async () => {
    const onOpenStrategy = vi.fn()
    const onOpenStock = vi.fn()
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: true,
        lifecycle: {
          active: [{ strategy_id: 'strat-child', name: '子策略', mutated_from: 'strat-parent' }],
          mutated: [{ strategy_id: 'strat-parent', name: '母策略' }],
        },
        per_strategy: [{ strategy_id: 'strat-child', name: '子策略', decision: 'promote', reason: '证据达标', nav: 1.12, closed_win_rate_pct: 64, symbols: ['600519'] }],
        recent_applied: [{ applied_at: '2026-09-01', count: 1, actions: [{ sid: 'strat-child', type: 'promote', reason: '升级' }] }],
        counts: { active: 1, mutated: 1 },
      }
      if (operation === 'trading-core.evolution-attribution') return {
        overall: {},
        strategies: [{ strategy_id: 'strat-child', return_pct: 12, max_drawdown_pct: 3, closed_trades: 8 }],
      }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<EvolutionDashboard requestData={requestData} onAnalyze={() => {}} onOpenStrategy={onOpenStrategy} onOpenStock={onOpenStock} initialLifecycleGroup="active" />)
    await screen.findByText('策略演化链路')
    expect(screen.getByText('12.00%')).toBeTruthy()
    expect(screen.getByText('3.00%')).toBeTruthy()
    expect(screen.getByText('8')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '600519' }))
    expect(onOpenStock).toHaveBeenCalledWith('600519')

    fireEvent.click(await screen.findByRole('button', { name: /子策略.*证据达标/ }))
    expect(onOpenStrategy).toHaveBeenLastCalledWith('strat-child', 'active')

    fireEvent.click(screen.getByRole('button', { name: /母策略/ }))
    expect(onOpenStrategy).toHaveBeenLastCalledWith('strat-parent', 'active')

    fireEvent.click(screen.getByRole('button', { name: /2026-09-01.*自动应用 1 项动作/ }))
    await waitFor(() => { expect(onOpenStrategy).toHaveBeenLastCalledWith('strat-child', 'active') })
  })
})

describe('策略研究单策略诊断', () => {
  it('响应缺少目标策略时不回退展示其他策略或全局归因', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        lifecycle: { active: [{ strategy_id: 'strat-other', name: '其他策略' }] },
        per_strategy: [{ strategy_id: 'strat-other', decision: 'retire', reason: '其他策略理由', nav: 9.9 }],
        recent_applied: [],
      }
      if (operation === 'trading-core.evolution-attribution') return {
        overall: { return_pct: 88, max_drawdown_pct: 77 },
        strategies: [{ strategy_id: 'strat-other', return_pct: 66, max_drawdown_pct: 55 }],
      }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<StrategyEvolutionDiagnostics requestData={requestData} strategyId="strat-target" strategyLabel="目标策略" strategyStatus="active" onAnalyze={() => {}} onBack={() => {}} />)

    expect(await screen.findByText(/目标策略证据暂不可读取/)).toBeTruthy()
    expect(screen.queryByText('其他策略理由')).toBeNull()
    expect(screen.queryByText('66.00%')).toBeNull()
    expect(screen.queryByText('88.00%')).toBeNull()
    expect(screen.queryByText('带内运行')).toBeNull()
    expect(screen.queryByText('自动闭环未启用')).toBeNull()
  })

  it('生命周期重叠时以观察态为准并隐藏重新评估', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        lifecycle: {
          active: [{ strategy_id: 'strat-watch', name: '观察策略' }],
          watch: [{ strategy_id: 'strat-watch', name: '观察策略' }],
        },
        per_strategy: [{ strategy_id: 'strat-watch', decision: 'none', reason: '进入观察态' }],
        recent_applied: [],
      }
      if (operation === 'trading-core.evolution-attribution') return { strategies: [{ strategy_id: 'strat-watch' }] }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<StrategyEvolutionDiagnostics requestData={requestData} strategyId="strat-watch" strategyLabel="观察策略" strategyStatus="active" onAnalyze={() => {}} onBack={() => {}} />)

    expect(await screen.findByText(/进入观察态/)).toBeTruthy()
    expect(screen.getAllByText('观察').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '重新评估' })).toBeNull()
  })

  it('展示目标母子链并保留目标作为 parent 的自动变异历史', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        lifecycle: {
          active: [{ strategy_id: 'strat-parent', name: '母策略', symbols: ['600519'] }],
          candidate: [{ strategy_id: 'strat-child', name: '子策略', mutated_from: 'strat-parent' }],
          mutated: [{ strategy_id: 'strat-child', name: '子策略', mutated_from: 'strat-parent' }],
        },
        per_strategy: [{ strategy_id: 'strat-parent', decision: 'mutate', reason: '生成变体' }],
        recent_applied: [{ applied_at: '2026-09-01', actions: [{ sid: 'strat-child', parent: 'strat-parent', type: 'mutate', reason: '自动生成子策略' }] }],
      }
      if (operation === 'trading-core.evolution-attribution') return { strategies: [{ strategy_id: 'strat-parent' }] }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<StrategyEvolutionDiagnostics requestData={requestData} strategyId="strat-parent" strategyLabel="母策略" strategyStatus="active" onAnalyze={() => {}} onBack={() => {}} />)

    expect(await screen.findByText('自动生成子策略')).toBeTruthy()
    expect(screen.getByText('子策略')).toBeTruthy()
    expect(screen.getByText(/子策略 · 候选/)).toBeTruthy()
  })

  it('重新评估只读取当前策略且不调用 preview/run', async () => {
    const requestData = vi.fn(async ({ operation, input }: InvestmentDataRequest) => {
      expect(input).toEqual({ strategy_id: 'strat-a' })
      if (operation === 'trading-core.evolution-status') return {
        as_of: '2026-09-01 12:00:00',
        closed_loop_enabled: true,
        lifecycle: { active: [{ strategy_id: 'strat-a' }] },
        per_strategy: [{ strategy_id: 'strat-a', decision: 'none', reason: '仍在阈值带内' }],
        recent_applied: [],
      }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${operation}`)
    })
    render(<StrategyEvolutionDiagnostics
      requestData={requestData}
      strategyId="strat-a"
      strategyLabel="策略 A"
      strategyStatus="active"
      onAnalyze={() => {}}
      onBack={() => {}}
    />)
    fireEvent.click(await screen.findByRole('button', { name: '重新评估' }))
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(4) })
    expect(requestData.mock.calls.every(([request]) => (
      ['trading-core.evolution-status', 'trading-core.evolution-attribution'].includes(request.operation)
      && request.input?.strategy_id === 'strat-a'
    ))).toBe(true)
  })

  it('退役策略只展示历史和返回按钮，不提供重新评估', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        lifecycle: { retired: [{ strategy_id: 'strat-retired' }] },
        per_strategy: [{ strategy_id: 'strat-retired', decision: 'retire' }],
        recent_applied: [{ applied_at: '2026-08-31', actions: [{ sid: 'strat-retired', reason: '自动退役' }] }],
      }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${operation}`)
    })
    render(<StrategyEvolutionDiagnostics requestData={requestData} strategyId="strat-retired" strategyLabel="退役策略" strategyStatus="retired" onAnalyze={() => {}} onBack={() => {}} />)
    expect(await screen.findByText('自动退役')).toBeTruthy()
    expect(screen.getByRole('button', { name: '返回自进化看板' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新评估' })).toBeNull()
  })

  it('看板 deep-link 直接进入第4步且所有进化读取都带同一策略标识', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.strategies') return { items: [{ id: 'strat-a', name: '策略 A', status: 'candidate' }] }
      if (operation === 'trading-core.evolution-status') return { lifecycle: { candidate: [{ strategy_id: 'strat-a' }] }, per_strategy: [], recent_applied: [] }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected ${operation}`)
    })
    render(<StrategyResearchPage
      requestData={requestData}
      selectedStrategyId="strat-a"
      onSelectStrategy={() => {}}
      onOpenShadow={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
      initialStage="evolution"
      onBackEvolution={() => {}}
    />)
    expect(await screen.findByRole('heading', { name: /策略 A.*进化诊断/ })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestData.mock.calls.filter(([request]) => request.operation.startsWith('trading-core.evolution-')).every(([request]) => request.input?.strategy_id === 'strat-a')).toBe(true)
  })
})
