// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { EvolutionDashboard } from '../src/client/EvolutionDashboard.tsx'
import { StrategyEvolutionDiagnostics } from '../src/client/StrategyEvolutionDiagnostics.tsx'
import { StrategyResearchPage } from '../src/client/ProductPages.tsx'
import {
  evolutionConfidenceLabel,
  evolutionParticipationLabel,
  evolutionSemanticLabels,
  formatEvolutionTimestamp,
} from '../src/client/evolution-types.ts'

afterEach(cleanup)

describe('自进化全局只读看板', () => {
  it('首屏先展示演化关系和紧凑运行摘要，明细列表后置', async () => {
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: false,
        lifecycle: { candidate: [{ strategy_id: 'strat-candidate', name: '候选策略' }] },
        per_strategy: [{ strategy_id: 'strat-candidate', name: '候选策略', reason: '等待验证' }],
        recent_applied: [],
        counts: { candidate: 1 },
      }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<EvolutionDashboard requestData={requestData} onAnalyze={() => {}} onOpenStrategy={() => {}} initialLifecycleGroup="candidate" />)

    const overview = await screen.findByRole('region', { name: '演化关系' })
    const runtime = screen.getByRole('region', { name: '运行状态摘要' })
    const distribution = screen.getByRole('region', { name: '策略状态分布' })
    const diagnostics = screen.getByRole('region', { name: '策略现状与诊断' })
    const history = screen.getByRole('region', { name: '历史进化动作' })
    expect(overview.compareDocumentPosition(runtime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(runtime.compareDocumentPosition(distribution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(distribution.compareDocumentPosition(diagnostics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(diagnostics.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(overview).getByText('尚未发生自动进化')).toBeTruthy()
    expect(screen.getByRole('region', { name: '候选策略列表' }).className).toContain('evolutionLifecycleList')
  })

  it('原样消费后端四桶、完整运行时间和五维策略语义', async () => {
    expect(formatEvolutionTimestamp('2026-09-04T15:35:00+08:00')).toBe('2026-09-04 15:35:00 UTC+08:00')
    expect(evolutionSemanticLabels({
      participation_status: 'active',
      verification_status: 'passed',
      confidence_tier: 2,
      source: 'evolution',
      task_status: 'completed',
    })).toEqual({
      participation: '正常运行',
      verification: '已验证通过',
      confidence: '已升级',
      source: '变异来源',
      task: '已完成',
    })

    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: true,
        lifecycle: {
          active: [{ strategy_id: 'strat-upgraded', name: '升级策略', tier: 2, source: 'evolution', mutated_from: 'strat-parent' }],
          mutated: [{ strategy_id: 'strat-upgraded', name: '升级策略', mutated_from: 'strat-parent' }],
        },
        per_strategy: [{ strategy_id: 'strat-upgraded', name: '升级策略', reason: '证据达标' }],
        evolution_counts: { normal: 7, watch: 6, promote: 5, retire: 4 },
        counts: { active: 99, mutated: 88 },
        recent_run_at: '2026-09-04T00:25:53+08:00',
        next_scheduled_run_at: '2026-09-04T15:35:00+08:00',
        recent_applied: [{ applied_at: '2026-09-04 00:20:00', count: 1, actions: [{ sid: 'strat-upgraded', type: 'promote', reason: '样本外证据达标' }] }],
      }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (operation === 'trading-core.strategies') return { items: [{
        id: 'strat-upgraded', name: '升级策略', participation_status: 'active', verification_status: 'passed',
        confidence_tier: 2, source: 'evolution', task_status: 'completed', mutated_from: 'strat-parent',
      }] }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<EvolutionDashboard requestData={requestData} onAnalyze={() => {}} onOpenStrategy={() => {}} />)
    const summary = await screen.findByTestId('evolution-status-summary')
    expect(summary.textContent).toContain('正常运行7')
    expect(summary.textContent).toContain('观察中6')
    expect(summary.textContent).toContain('已升级5')
    expect(summary.textContent).toContain('已淘汰4')
    expect(summary.textContent).not.toContain('变异')
    expect(screen.getByText('2026-09-04 00:25:53 UTC+08:00')).toBeTruthy()
    expect(screen.getByText('2026-09-04 15:35:00 UTC+08:00')).toBeTruthy()
    expect(screen.getByText('样本外证据达标')).toBeTruthy()
    expect(screen.getByText('参与状态：正常运行')).toBeTruthy()
    expect(screen.getByText('验证结果：已验证通过')).toBeTruthy()
    expect(screen.getByText('置信等级：已升级')).toBeTruthy()
    expect(screen.getByText('来源：变异来源')).toBeTruthy()
    expect(screen.getByText('任务状态：已完成')).toBeTruthy()
  })

  it('统一参与状态和置信层级，并把变异仅作为来源标记', async () => {
    expect(evolutionParticipationLabel('active')).toBe('正常运行')
    expect(evolutionParticipationLabel('watch')).toBe('观察中')
    expect(evolutionParticipationLabel('retired')).toBe('已淘汰')
    expect(evolutionConfidenceLabel(2)).toBe('已升级')

    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: true,
        lifecycle: {
          active: [
            { strategy_id: 'strat-normal', name: '正常策略', tier: 1 },
            { strategy_id: 'strat-upgraded', name: '升级策略', tier: 2, mutated_from: 'strat-parent' },
          ],
          watch: [{ strategy_id: 'strat-watch', name: '观察策略', tier: 1 }],
          retired: [{ strategy_id: 'strat-retired', name: '淘汰策略', tier: 1 }],
          mutated: [{ strategy_id: 'strat-upgraded', name: '升级策略', mutated_from: 'strat-parent' }],
        },
        per_strategy: [
          { strategy_id: 'strat-normal', name: '正常策略', decision: 'none', reason: '阈值带内', tier: 1 },
          { strategy_id: 'strat-upgraded', name: '升级策略', decision: 'promote', reason: '证据达标', tier: 2, mutated_from: 'strat-parent' },
        ],
        recent_applied: [],
        evolution_counts: { normal: 1, watch: 1, promote: 1, retire: 1 },
        counts: { active: 2, watch: 1, retired: 1, mutated: 1 },
      }
      if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${operation}`)
    })

    render(<EvolutionDashboard requestData={requestData} onAnalyze={() => {}} onOpenStrategy={() => {}} />)
    const summary = await screen.findByTestId('evolution-status-summary')
    expect(summary.textContent).toContain('正常运行1')
    expect(summary.textContent).toContain('观察中1')
    expect(summary.textContent).toContain('已升级1')
    expect(summary.textContent).toContain('已淘汰1')
    expect(screen.queryByRole('button', { name: /变体 1/ })).toBeNull()
    expect(screen.getByText('变异来源：strat-parent')).toBeTruthy()
  })

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
      'trading-core.strategies',
    ])
    expect(screen.getAllByText(/自动闭环未启用/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/正在每日自动运行/)).toBeNull()
  })

  it('策略现状、链路和历史动作都进入对应策略诊断', async () => {
    const onOpenStrategy = vi.fn()
    const onOpenStock = vi.fn()
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: true,
        lifecycle: {
          // 变异是来源标记：母策略按真实状态（retired）落桶，子策略 active 并沿 mutated_from 上溯母链
          active: [{ strategy_id: 'strat-child', name: '子策略', mutated_from: 'strat-parent' }],
          retired: [{ strategy_id: 'strat-parent', name: '母策略' }],
        },
        per_strategy: [{ strategy_id: 'strat-child', name: '子策略', decision: 'promote', reason: '证据达标', nav: 1.12, closed_win_rate_pct: 64, symbols: ['600519'] }],
        recent_applied: [{ applied_at: '2026-09-01', count: 1, actions: [{ sid: 'strat-child', type: 'promote', reason: '升级' }] }],
        counts: { active: 1, retired: 1 },
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
  it('详情展示与列表一致的五维字段和完整计划时间', async () => {
    const onAnalyze = vi.fn()
    const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
      if (operation === 'trading-core.evolution-status') return {
        closed_loop_enabled: true,
        next_scheduled_run_at: '2026-09-04T15:35:00+08:00',
        lifecycle: { active: [{ strategy_id: 'strat-a', name: '策略 A', source: 'evolution', mutated_from: 'strat-parent' }] },
        per_strategy: [{ strategy_id: 'strat-a', decision: 'none', reason: '仍在阈值带内' }],
        recent_applied: [],
      }
      if (operation === 'trading-core.evolution-attribution') return { strategies: [{ strategy_id: 'strat-a' }] }
      if (operation === 'trading-core.strategy-detail') return {
        id: 'strat-a', participation_status: 'active', verification_status: 'passed', confidence_tier: 2,
        source: 'evolution', task_status: 'completed', mutated_from: 'strat-parent',
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    render(<StrategyEvolutionDiagnostics requestData={requestData} strategyId="strat-a" strategyLabel="策略 A" strategyStatus="active" onAnalyze={onAnalyze} onBack={() => {}} />)

    expect(await screen.findByText('参与状态：正常运行')).toBeTruthy()
    expect(screen.getByText('验证结果：已验证通过')).toBeTruthy()
    expect(screen.getByText('置信等级：已升级')).toBeTruthy()
    expect(screen.getByText('来源：变异来源')).toBeTruthy()
    expect(screen.getByText('任务状态：已完成')).toBeTruthy()
    expect(screen.getByText('2026-09-04 15:35:00 UTC+08:00')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'AI 解释当前判定' }))
    expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'evolution',
      semanticSummary: '参与状态：正常运行；验证结果：已验证通过；置信等级：已升级；来源：变异来源；任务状态：已完成',
    }))
  })

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
    expect(screen.getAllByText('观察中').length).toBeGreaterThan(0)
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
    const childRow = screen.getByText('子策略').closest('[class*="dataRow"]')
    expect(childRow?.textContent).toContain('候选')
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
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(6) })
    expect(requestData.mock.calls.every(([request]) => (
      ['trading-core.evolution-status', 'trading-core.evolution-attribution', 'trading-core.strategy-detail'].includes(request.operation)
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
