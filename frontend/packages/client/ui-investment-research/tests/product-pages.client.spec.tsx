// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import {
  EvolutionPage,
  IndustryChainPage,
  ReportCenter,
  ShadowValidationPage,
  StrategyResearchPage,
} from '../src/client/ProductPages.tsx'
import { InvestmentShell, InvestmentSidebar } from '../src/client/InvestmentShell.tsx'
import type { AssistantIntent } from '../src/client/assistant-intent.ts'
import type { InvestmentUiSnapshot } from '../src/client/state.ts'

afterEach(cleanup)

const neverGlobalHook = (() => { throw new Error('global hook is not used in this scenario') }) as never

describe('投研产品闭环', () => {
  it('从策略列表选择 active 策略并把同一标识传给影子验证', async () => {
    const onSelectStrategy = vi.fn()
    const onOpenShadow = vi.fn()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [{
            id: 'strategy-active-1',
            name: '事件驱动策略',
            kind: 'event',
            status: 'active',
            hypothesis: '产业催化会提高订单可见度',
            direction: 'long',
            symbols: ['600519'],
            tickers: [{ code: '600519', name: '贵州茅台' }],
            backtest: {
              out_of_sample: { win_rate_pct: 62.5, n_evaluated: 12 },
              reason: '样本外胜率/均收益达标',
            },
          }],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<StrategyResearchPage
      requestData={requestData as never}
      selectedStrategyId=""
      onSelectStrategy={onSelectStrategy}
      onOpenShadow={onOpenShadow}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    expect(await screen.findByText('贵州茅台 · 600519')).toBeTruthy()
    expect(screen.getByText('利好').getAttribute('data-direction')).toBe('利好')
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('回测结论：样本外胜率/均收益达标')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '进入影子验证' }))

    expect(onSelectStrategy).toHaveBeenCalledWith('strategy-active-1')
    expect(onOpenShadow).toHaveBeenCalledWith('strategy-active-1')
    expect(onSelectStrategy.mock.invocationCallOrder[0]).toBeLessThan(onOpenShadow.mock.invocationCallOrder[0]!)
  })

  it('策略回测只有在任务结果含正式正文时才提示已进入报告中心', async () => {
    const onOpenReports = vi.fn()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [{
            id: 'strategy-1', name: '候选策略', status: 'candidate', symbols: ['600519'], backtest: null,
          }],
        }
      }
      if (request.operation === 'trading-core.strategy-backtests') return { strategy_id: 'strategy-1', count: 0, tasks: [] }
      if (request.operation === 'trading-core.strategy-run') return { task_id: '1'.repeat(32) }
      if (request.operation === 'trading-core.task-status') return { status: 'done' }
      if (request.operation === 'trading-core.task-result') {
        return { reports: { strategy: '# 策略样本外回测报告' } }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<StrategyResearchPage
      requestData={requestData as never}
      selectedStrategyId=""
      onSelectStrategy={() => {}}
      onOpenShadow={() => {}}
      onOpenReports={onOpenReports}
      onAnalyze={() => {}}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    fireEvent.click(await screen.findByRole('button', { name: '新建回测任务' }))
    expect(await screen.findByRole('dialog', { name: '新建回测任务' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '开始回测' }))
    expect(await screen.findByText('回测完成，正式结果已进入投研报告。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看本次投研报告' }))
    expect(onOpenReports).toHaveBeenCalledOnce()
  })

  it('影子任务被业务护栏跳过时展示原因且不伪称已生成报告', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') return {}
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      if (request.operation === 'trading-core.shadow-run') return { task_id: '2'.repeat(32) }
      if (request.operation === 'trading-core.task-status') return { status: 'done' }
      if (request.operation === 'trading-core.task-result') {
        return { skipped: true, reason: '无 active 策略' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '运行影子验证' }))
    expect(await screen.findByText('影子验证未执行：无 active 策略')).toBeTruthy()
    expect(screen.queryByText(/正式结果已进入投研报告/)).toBeNull()
  })

  it('影子验证用范围说明展示全部生效策略，不再伪装成可点击流程', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') return {}
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    const scope = await screen.findByLabelText('当前影子验证范围')
    expect(within(scope).getByText('全部生效策略')).toBeTruthy()
    expect(within(scope).getByText('每条生效策略独立使用纸面账户记账')).toBeTruthy()
    expect(screen.queryByLabelText('当前验证对象')).toBeNull()
  })

  it('纸面持仓展示证券与策略名称，并可进入个股详情', async () => {
    const onOpenStock = vi.fn()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.shadow-status') {
        return { trade_date: '2026-08-28', strategy_count: 1, ran_at: '2026-08-28 14:00:32', overall_nav: 1 }
      }
      if (request.operation === 'trading-core.shadow-positions') {
        return { items: [{ strategy_id: 'strat-1', symbol: '600101', qty: 100, avg_cost: 12.5 }] }
      }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      if (request.operation === 'market-watch.security-search') {
        expect(request.input).toEqual({ query: '600101', limit: 8 })
        return { items: [{ code: '600101', name: '明星电力' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      strategyNames={{ 'strat-1': '电力事件策略' }}
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
      onOpenStock={onOpenStock}
    />)

    const position = await screen.findByRole('button', { name: '查看明星电力 · 600101个股详情' })
    expect(position.textContent).toContain('600101 · 电力事件策略')
    expect(position.textContent).toContain('100 股')
    expect(position.textContent).toContain('成本 ¥12.50')
    fireEvent.click(position)
    expect(onOpenStock).toHaveBeenCalledWith('600101')
  })

  it('已选策略时明确区分全局运行摘要与单策略证据', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') {
        return { trade_date: '2026-08-28', strategy_count: 3, ran_at: '2026-08-28 14:00:32', overall_nav: 1.08 }
      }
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId="strat-1"
      strategyNames={{ 'strat-1': '电力事件策略' }}
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    expect(await screen.findByRole('region', { name: '全部策略最近运行' })).toBeTruthy()
    expect(screen.getByText('下方持仓与净值仅展示“电力事件策略”')).toBeTruthy()
  })

  it('证券代码缺失的纸面持仓不可点击', async () => {
    const onOpenStock = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') return {}
      if (request.operation === 'trading-core.shadow-positions') {
        return { items: [{ strategy_id: 'strat-1', symbol: '', qty: 10, avg_cost: 12.5 }] }
      }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      strategyNames={{ 'strat-1': '无代码策略' }}
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
      onOpenStock={onOpenStock}
    />)

    expect(await screen.findByText('证券代码缺失')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /无代码策略.*个股详情/u })).toBeNull()
    expect(onOpenStock).not.toHaveBeenCalled()
  })

  it('影子首屏未返回真实数据前不伪造等待状态或零持仓', () => {
    const requestData = vi.fn(() => new Promise(() => {}))
    const view = render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    expect(view.container.textContent).not.toContain('等待数据')
    expect(view.container.textContent).not.toContain('0 项')
    expect(view.container.textContent).not.toContain('0 日')
  })

  it('影子验证归档后在当前页提供查看报告入口', async () => {
    const onOpenReports = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') return {}
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      if (request.operation === 'trading-core.shadow-run') return { task_id: '3'.repeat(32) }
      if (request.operation === 'trading-core.task-status') return { status: 'done' }
      if (request.operation === 'trading-core.task-result') {
        return { reports: { shadow: '# 影子验证报告' } }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      onOpenEvolution={() => {}}
      onOpenReports={onOpenReports}
      onAnalyze={() => {}}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '运行影子验证' }))
    expect(await screen.findByText('影子验证完成，正式结果已进入投研报告。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看本次投研报告' }))
    expect(onOpenReports).toHaveBeenCalledOnce()
  })

  it('按单策略查看净值时不回退展示无关的组合净值', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') return {}
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') {
        return {
          items: [
            { date: '2026-08-26', strategy: { nav: 1.03 } },
            { date: '2026-08-25', strategy: null, overall_nav: 9.99 },
          ],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId="strategy-a"
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    expect(await screen.findByText('1.03')).toBeTruthy()
    expect(screen.queryByText('9.99')).toBeNull()
  })

  it('全自动闭环：只请求状态与归因，不引导人工确认，进页即展示各策略判定', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        return {
          ready: true, days_of_data: 5, min_days: 5, counts: { active: 1, candidate: 2 },
          closed_loop_enabled: true, closed_loop_time: '15:35',
          last_applied_at: '2026-08-31 16:35:44',
          per_strategy: [{
            strategy_id: 'strat-1', name: '利空·rsi_reversal·600519', kind: 'rsi_reversal',
            symbols: ['600519'], nav: 1.05, closed_win_rate_pct: 80, closed_trades: 3,
            decision: 'promote', behavior: '升级', reason: '影子净值 1.05 ≥ 升级线 1.03',
          }],
          recent_applied: [],
        }
      }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '600519', name: '贵州茅台' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    await waitFor(() => {
      const ops = requestData.mock.calls.map(([request]) => request.operation)
      expect(ops).toContain('trading-core.evolution-status')
      expect(ops).toContain('trading-core.evolution-attribution')
    })
    // 无任何人工确认/生成预案按钮
    expect(screen.queryByRole('button', { name: '确认并应用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '生成进化预案' })).toBeNull()
    // 从未请求 evolution-run
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.evolution-run')).toBe(false)
    // 进页即展示各策略判定
    expect(screen.getByText(/影子净值 1\.05 ≥ 升级线 1\.03/)).toBeTruthy()
    expect(screen.getAllByText('升级').length).toBeGreaterThan(0)
    // 闭环运行状态
    expect(screen.getByText('每日 15:35')).toBeTruthy()
    expect(screen.getByText('2026-08-31 16:35:44')).toBeTruthy()
  })

  it('最近自动进化时间线渲染各轮动作', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        return {
          ready: true, counts: { active: 1 },
          closed_loop_enabled: true, closed_loop_time: '15:35',
          last_applied_at: '2026-08-31 16:35:44',
          per_strategy: [],
          recent_applied: [{
            applied_at: '2026-08-31 16:35:44', count: 2,
            actions: [
              { type: 'promote', sid: 'strat-1', reason: '升级：影子净值越线' },
              { type: 'mutate', sid: 'kid-1', reason: '变异衍生新候选' },
            ],
          }],
        }
      }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    expect(await screen.findByText('2026-08-31 16:35:44 · 自动应用 2 项动作')).toBeTruthy()
    expect(screen.getByText(/升级：影子净值越线/)).toBeTruthy()
    expect(screen.getByText(/变异衍生新候选/)).toBeTruthy()
    // statusLabel 将 promote/mutate 映射为中文
    expect(screen.getByText('升级')).toBeTruthy()
    expect(screen.getByText('生成变体')).toBeTruthy()
  })

  it('进化状态读取失败时明确告知并可同步重试', async () => {
    let statusAttempts = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        statusAttempts += 1
        if (statusAttempts === 1) throw new Error('进化状态服务不可用')
        return { ready: true, counts: { active: 1 } }
      }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('进化状态服务不可用')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(statusAttempts).toBe(2) })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('策略现状：点击策略行展开详情而非跳个股，详情内标的才进入个股详情', async () => {
    const onOpenStock = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        return {
          ready: true, days_of_data: 5, min_days: 5, counts: { active: 1 },
          closed_loop_enabled: true, closed_loop_time: '15:35',
          per_strategy: [{
            strategy_id: 'strat-1', name: '利空·rsi_reversal·600519', kind: 'rsi_reversal',
            symbols: ['600519'], nav: 1.05, closed_win_rate_pct: 66.7, closed_trades: 3,
            decision: 'none', behavior: '带内运行', reason: '影子净值 1.05 处于带内，无升降级动作',
          }],
          recent_applied: [],
        }
      }
      if (request.operation === 'trading-core.evolution-attribution') {
        return {
          overall: { return_pct: 2.1 },
          strategies: [{
            strategy_id: 'strat-1', name: '利空·rsi_reversal·600519', kind: 'rsi_reversal',
            symbols: ['600519'], return_pct: 1.2, max_drawdown_pct: 0.4, closed_win_rate_pct: 66.7,
          }],
        }
      }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '600519', name: '贵州茅台' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} onOpenStock={onOpenStock} />)
    // 策略行展示判定与依据（非个股跳转按钮）
    const row = await screen.findByRole('button', { name: /贵州茅台.*600519/ })
    fireEvent.click(row)
    // 点击策略行展开策略现状详情，不跳个股
    const detail = await screen.findByRole('region', { name: '策略现状详情' })
    expect(within(detail).getByText(/判定依据：影子净值 1\.05 处于带内/)).toBeTruthy()
    expect(within(detail).getByText('累计收益')).toBeTruthy()
    expect(within(detail).getByText('最大回撤')).toBeTruthy()
    expect(onOpenStock).not.toHaveBeenCalled()
    // 详情内关联标的位置才可进入个股详情
    fireEvent.click(within(detail).getByRole('button', { name: /贵州茅台.*600519/ }))
    expect(onOpenStock).toHaveBeenCalledWith('600519')
  })

  it('数据不足时各策略判定显示待判定', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        return {
          ready: false, days_of_data: 2, min_days: 5, counts: { active: 1 },
          closed_loop_enabled: true, closed_loop_time: '15:35',
          per_strategy: [{
            strategy_id: 'strat-1', name: '利空·rsi_reversal·600519', kind: 'rsi_reversal',
            symbols: ['600519'], nav: null, closed_win_rate_pct: null, closed_trades: 0,
            decision: 'none', behavior: '待判定', reason: '影子数据不足，暂不参与判定',
          }],
          recent_applied: [],
        }
      }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '600519', name: '贵州茅台' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    expect(await screen.findByText('待判定')).toBeTruthy()
    expect(screen.getByText(/影子数据不足，暂不参与判定/)).toBeTruthy()
  })

  it('闭环运行状态：点击生命周期计数展开对应策略列表并可进入标的', async () => {
    const onOpenStock = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        return {
          ready: true, days_of_data: 5, min_days: 5,
          counts: { active: 1, candidate: 1, mutated: 1, retired: 1 },
          closed_loop_enabled: true, closed_loop_time: '15:35',
          lifecycle: {
            active: [{ strategy_id: 'strat-1', name: '利空·rsi_reversal·600519', kind: 'rsi_reversal', tier: 1, symbols: ['600519'] }],
            candidate: [{ strategy_id: 'kid-1', name: '变体·600519', kind: 'rsi_reversal', tier: 1, symbols: ['600519'], mutated_from: 'strat-1', source: 'evolution' }],
            mutated: [{ strategy_id: 'kid-1', name: '变体·600519', kind: 'rsi_reversal', tier: 1, symbols: ['600519'] }],
            retired: [{ strategy_id: 'strat-old', name: '旧策略', kind: 'momentum', tier: 1, symbols: [] }],
          },
          per_strategy: [],
          recent_applied: [],
        }
      }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '600519', name: '贵州茅台' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} onOpenStock={onOpenStock} />)
    // 点击「待验证候选」计数展开对应策略列表
    fireEvent.click(await screen.findByRole('button', { name: /待验证候选/ }))
    const candidateRow = await screen.findByRole('button', { name: /贵州茅台.*600519/ })
    expect(candidateRow).toBeTruthy()
    // 列表项点击展开策略基础详情，再点标的进个股（不整行跳个股）
    fireEvent.click(candidateRow)
    const detail = await screen.findByRole('region', { name: '策略基础详情' })
    fireEvent.click(within(detail).getByRole('button', { name: /贵州茅台.*600519/ }))
    expect(onOpenStock).toHaveBeenCalledWith('600519')
    // 点击「退役策略」计数展开对应策略（链路区也显示同一策略，故用 findAll）
    fireEvent.click(screen.getByRole('button', { name: /退役策略/ }))
    expect((await screen.findAllByText('旧策略')).length).toBeGreaterThan(0)
  })

  it('策略演化链路：仅展示生效策略及其母链，过滤候选/退役后代', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.evolution-status') {
        return {
          ready: true, counts: { active: 1, candidate: 1, mutated: 1, retired: 1 },
          closed_loop_enabled: true, closed_loop_time: '15:35',
          lifecycle: {
            active: [
              { strategy_id: 'strat-f6e7d8c9b0', name: '生效变体', kind: 'rsi_reversal', tier: 2, symbols: ['600519'], mutated_from: 'strat-a1b2c3d4e5', source: 'evolution' },
            ],
            candidate: [
              { strategy_id: 'strat-9a8b7c6d5e', name: '待验证变体', kind: 'momentum', tier: 1, symbols: ['600519'], mutated_from: 'strat-f6e7d8c9b0', source: 'evolution' },
            ],
            mutated: [
              { strategy_id: 'strat-9a8b7c6d5e', name: '待验证变体', kind: 'momentum', tier: 1, symbols: ['600519'], mutated_from: 'strat-f6e7d8c9b0', source: 'evolution' },
            ],
            retired: [
              { strategy_id: 'strat-a1b2c3d4e5', name: '退役母策略', kind: 'rsi_reversal', tier: 1, symbols: ['600519'] },
            ],
            watch: [], rejected: [],
          },
          per_strategy: [],
          recent_applied: [],
        }
      }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '600519', name: '贵州茅台' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    expect(await screen.findByText('策略演化链路')).toBeTruthy()
    // 生效策略 + 沿母链上溯的退役母策略，同屏可见
    expect(screen.getByText('仅生效 · 2 个策略 · 1 条衍生')).toBeTruthy()
    expect(screen.getByText('#a1b2c3')).toBeTruthy()
    expect(screen.getByText('退役母策略')).toBeTruthy()
    expect(screen.getByText('#f6e7d8')).toBeTruthy()
    expect(screen.getByText('生效变体')).toBeTruthy()
    // 候选后代（待验证变体）不进入链路图
    expect(screen.queryByText('#9a8b7c')).toBeNull()
    expect(screen.queryByText('待验证变体')).toBeNull()
  })

  it('从统一报告列表读取 sections 详情并以 report intent 交给 AI 复核', async () => {
    const onAnalyze = vi.fn()
    const onClose = vi.fn()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.reports') {
        return { items: [{ id: 'report-1', title: '策略回测报告', kind: 'strategy', created_at: '2026-08-26' }] }
      }
      if (request.operation === 'trading-core.report') {
        return {
          id: request.input?.report_id,
          title: '策略回测报告',
          summary: '样本外证据通过',
          kind: 'strategy',
          created_at: '2026-08-26',
          sections: [{ key: 'conclusion', title: '核心结论', content: '## 执行建议\n\n继续进入影子验证' }],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ReportCenter requestData={requestData as never} onClose={onClose} onAnalyze={onAnalyze} />)

    expect(await screen.findByText('继续进入影子验证')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '执行建议' })).toBeTruthy()
    expect(screen.getAllByText('策略研究').length).toBeGreaterThan(0)
    expect(screen.queryByText('strategy')).toBeNull()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.report', input: { report_id: 'report-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'AI 复核' }))
    expect(onAnalyze).toHaveBeenCalledWith({ kind: 'reports', reportId: 'report-1' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('把历史策略报告中的代码标识转换为可读标题与中文状态', async () => {
    const reportId = 'a840c24ccbe34c4b9b02ff3038e82146'
    const rawTitle = '策略研究报告 · 利空·rsi_reversal·600101（strat-63955a2386）'
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.reports') {
        return { items: [{ id: reportId, title: rawTitle, summary: '利空·rsi_reversal·600101（strat-63955a2386）', kind: 'strategy' }] }
      }
      if (request.operation === 'trading-core.report') {
        return {
          id: reportId,
          title: rawTitle,
          summary: '利空·rsi_reversal·600101（strat-63955a2386）',
          kind: 'strategy',
          sections: [{
            key: 'strategy',
            title: '策略样本外回测',
            content: '# 策略样本外回测报告\n\n- 策略：利空·rsi_reversal·600101\n- 策略标识：strat-63955a2386\n- 规则类型：rsi_reversal\n- 标的：600101\n- 生命周期状态：candidate',
          }],
        }
      }
      if (request.operation === 'market-watch.security-search') {
        expect(request.input).toEqual({ query: '600101', limit: 5 })
        return { items: [{ code: '600101', name: '明星电力' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ReportCenter requestData={requestData as never} onClose={() => {}} onAnalyze={() => {}} />)

    expect(await screen.findByRole('heading', { name: '策略研究报告 · 明星电力 · 600101 · 超跌反弹 · 利空' })).toBeTruthy()
    const reportBody = screen.getByRole('article')
    expect(reportBody.textContent).toContain('策略：明星电力 · 600101 · 超跌反弹 · 利空')
    expect(reportBody.textContent).toContain('策略编号：63955a2386')
    expect(reportBody.textContent).toContain('规则类型：超跌反弹')
    expect(reportBody.textContent).toContain('标的：明星电力 · 600101')
    expect(reportBody.textContent).toContain('生命周期状态：候选')
    expect(reportBody.textContent).not.toContain('rsi_reversal')
    expect(reportBody.textContent).not.toContain('candidate')
    expect(screen.getByTitle(reportId).textContent).toBe('a840c24c…e82146')
  })

  it('刷新报告列表后会收敛到仍存在的报告，不保留旧正文', async () => {
    const firstId = 'a'.repeat(32)
    const removedId = 'b'.repeat(32)
    let listCalls = 0
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.reports') {
        listCalls += 1
        return { items: listCalls === 1
          ? [{ id: firstId, title: '保留报告' }, { id: removedId, title: '将被移除的报告' }]
          : [{ id: firstId, title: '保留报告' }] }
      }
      if (request.operation === 'trading-core.report') {
        const id = String(request.input?.report_id)
        return { id, title: id === firstId ? '保留报告' : '将被移除的报告', sections: [{ key: 'body', content: id === firstId ? '保留正文' : '旧正文' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ReportCenter requestData={requestData as never} onClose={() => {}} onAnalyze={() => {}} />)
    expect(await screen.findByText('保留正文')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /将被移除的报告/ }))
    expect(await screen.findByText('旧正文')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新报告' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /将被移除的报告/ })).toBeNull()
      expect(screen.getByText('保留正文')).toBeTruthy()
      expect(screen.queryByText('旧正文')).toBeNull()
    })
  })

  it('本机缺少产业链数据时先由用户显式下载，完成前不读取图谱', async () => {
    let finishBootstrap: ((value: unknown) => void) | undefined
    const bootstrap = new Promise((resolve) => { finishBootstrap = resolve })
    let statusCalls = 0
    const requestData = vi.fn((request: { operation: string }) => {
      if (request.operation === 'industry-chain.data-status') {
        statusCalls += 1
        return Promise.resolve(statusCalls === 1
          ? { status: 'missing', files_completed: 0, files_total: 5, downloaded_bytes: 0, current_file: null, error: null }
          : { status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000, current_file: null, error: null })
      }
      if (request.operation === 'industry-chain.data-bootstrap') return bootstrap
      if (request.operation === 'industry-chain.stats') return Promise.resolve({ total_nodes: 2594, total_edges: 8700, subject_count: 1297, relationships: 4 })
      if (request.operation === 'trading-core.personalized-impact') return Promise.resolve({ events: [] })
      return Promise.reject(new Error(`unexpected operation ${request.operation}`))
    })

    render(<IndustryChainPage requestData={requestData as never} query="" onQuery={() => {}} onAnalyze={() => {}} onOpenStock={() => {}} />)

    expect(await screen.findByText('首次使用需下载产业链数据')).toBeTruthy()
    expect(screen.getByText(/约 25 MB/)).toBeTruthy()
    expect(requestData.mock.calls.some(([request]) => request.operation === 'industry-chain.stats')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '下载并开始使用' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.data-bootstrap' })
    })
    const busyButton = screen.getByRole<HTMLButtonElement>('button', { name: '正在下载…' })
    expect(busyButton.disabled).toBe(true)
    expect(busyButton.getAttribute('aria-busy')).toBe('true')

    finishBootstrap?.({ status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000, current_file: null, error: null })
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.stats' })
    })
    expect(await screen.findByText('1,297 家')).toBeTruthy()
  })

  it('产业链刷新失败时保留旧数据且不展示后端路径或调用栈', async () => {
    let statsCalls = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'industry-chain.data-status') {
        return { status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000, current_file: null, error: null }
      }
      if (request.operation === 'industry-chain.stats') {
        statsCalls += 1
        if (statsCalls > 1) throw new Error('Traceback: /Users/private/backend/industry-chain/data/seed/stats.json')
        return { total_nodes: 2594, total_edges: 8700, subject_count: 1297, relationships: 4 }
      }
      if (request.operation === 'trading-core.personalized-impact') return { events: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<IndustryChainPage requestData={requestData as never} query="" onQuery={() => {}} onAnalyze={() => {}} onOpenStock={() => {}} />)
    expect(await screen.findByText('1,297 家')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('刷新失败，继续显示上次数据')).toBeTruthy()
    expect(screen.getByText('1,297 家')).toBeTruthy()
    expect(screen.queryByText(/Traceback|\/Users\/private/)).toBeNull()
  })

  it('产业链、全局搜索、个股分析和历史回测拥有四份独立输入状态', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'industry-chain.data-status') {
        return { status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000, current_file: null, error: null }
      }
      if (request.operation === 'industry-chain.stats') return { total_nodes: 0, total_edges: 0, subject_count: 0, relationships: 0 }
      if (request.operation === 'industry-chain.companies') return { items: [], count: 0 }
      if (request.operation === 'trading-core.personalized-impact') return { events: [] }
      if (request.operation === 'market-watch.security-search') return { items: [] }
      return {}
    })
    const base: InvestmentUiSnapshot = {
      route: 'knowledge', historyOpen: false, reportsOpen: false,
      assistantMode: 'closed', assistantModule: 'general',
      analysisQuery: '', backtestQuery: '', watchQuery: '', chainQuery: '',
      selectedStockCode: '', selectedStrategyId: '',
    }

    function Harness() {
      const [snapshot, setSnapshot] = useState(base)
      const useInvestmentUi = <T,>(selector: (value: InvestmentUiSnapshot) => T): T => selector(snapshot)
      const navigate = (route: InvestmentUiSnapshot['route']) => { setSnapshot(current => ({ ...current, route })) }
      return <>
        <InvestmentSidebar
          wide
          expandSidebar={() => {}}
          useSessions={neverGlobalHook}
          useWorkspaces={neverGlobalHook}
          useInvestmentUi={useInvestmentUi}
          navigate={navigate}
        />
        <InvestmentShell
          useInvestmentUi={useInvestmentUi}
          useSessions={neverGlobalHook}
          useWorkspaces={neverGlobalHook}
          requestData={requestData}
          trackTelemetry={vi.fn(async () => {})}
          navigate={navigate}
          setHistory={() => {}}
          setReports={() => {}}
          setAssistantMode={(mode) => { setSnapshot(current => ({ ...current, assistantMode: mode })) }}
          setAssistantModule={(module) => { setSnapshot(current => ({ ...current, assistantModule: module })) }}
          setModuleDraft={(key, value) => { setSnapshot(current => ({ ...current, [key]: value })) }}
          selectStrategy={() => {}}
          startSession={() => Promise.resolve()}
          openSession={() => Promise.resolve()}
          searchSessions={() => Promise.resolve([])}
          renameSession={() => Promise.resolve()}
          archiveSession={() => Promise.resolve()}
          prepareAssistant={async () => {}}
          toggleTheme={() => {}}
        />
      </>
    }

    render(<Harness />)
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.stats' })
    })
    const globalSearch = screen.getByRole<HTMLInputElement>('combobox', { name: '搜索 A 股或场内 ETF 代码或名称' })
    const chainFilter = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索公司、行业或股票代码' })

    fireEvent.change(globalSearch, { target: { value: '贵州茅台' } })
    expect(chainFilter.value).toBe('')
    fireEvent.change(chainFilter, { target: { value: '半导体' } })
    expect(globalSearch.value).toBe('贵州茅台')
    fireEvent.click(screen.getByRole('button', { name: '智能分析' }))
    const analysisCode = screen.getByRole<HTMLInputElement>('textbox', { name: '个股分析股票代码' })
    const backtestCode = screen.getByRole<HTMLInputElement>('textbox', { name: '历史回测股票代码' })
    fireEvent.change(analysisCode, { target: { value: '600519' } })
    fireEvent.change(backtestCode, { target: { value: '000001' } })
    expect(globalSearch.value).toBe('贵州茅台')
    expect(analysisCode.value).toBe('600519')
    expect(backtestCode.value).toBe('000001')
    fireEvent.click(screen.getByRole('button', { name: '产业链' }))
    const restoredChainFilter = await screen.findByRole<HTMLInputElement>('textbox', { name: '搜索公司、行业或股票代码' })
    expect(restoredChainFilter.value).toBe('半导体')
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'industry-chain.companies', input: { keyword: '半导体', limit: 20 },
      })
    })
    expect(globalSearch.value).toBe('贵州茅台')
    fireEvent.click(screen.getByRole('button', { name: '智能分析' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '个股分析股票代码' }).value).toBe('600519')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '历史回测股票代码' }).value).toBe('000001')
  })

  it('按真实 DTO 检索公司、逐层展示上下游并只向 AI 传短意图', async () => {
    const onAnalyze = vi.fn<(intent: AssistantIntent) => void>()
    const onOpenStock = vi.fn<(code: string) => void>()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'industry-chain.data-status') {
        return { status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000, current_file: null, error: null }
      }
      if (request.operation === 'industry-chain.stats') {
        return { total_nodes: 2594, total_edges: 8700, companies: 1297, subject_count: 1297, relationships: 4 }
      }
      if (request.operation === 'industry-chain.companies') {
        return { items: [{ code: '600519', name: '贵州茅台', industry: '白酒', exchange: 'SH', is_subject: true }], count: 1 }
      }
      if (request.operation === 'industry-chain.chain') {
        if (request.input?.code === '600000') {
          return {
            center: {
              id: 'cn-600000', code: '600000', name: '高粱供应商', industry: '农业',
              material_count: 4, supplier_count: 6, product_count: 3, customer_count: 5,
            },
            up_levels: [{
              level: -1,
              nodes: [{ id: 'seed-1', code: '000998', expandable: true, name: '种业公司', share: 22, type: 'direct', via: '高粱种子', note: '上游种源供应' }],
            }],
            down_levels: [{
              level: 1,
              nodes: [{ id: 'cn-600519', code: '600519', expandable: true, name: '贵州茅台', share: 18, type: 'direct', via: '高粱', note: '核心原料采购方' }],
            }],
          }
        }
        return {
          center: {
            id: 'cn-600519', code: '600519', name: '贵州茅台', industry: '白酒',
            material_count: 3, supplier_count: 5, product_count: 2, customer_count: 4,
          },
          up_levels: [{
            level: -1,
            nodes: [{ id: 'supplier-1', code: '600000', expandable: true, name: '高粱供应商', share: 18, type: 'direct', via: '高粱', note: '核心原料供应' }],
          }],
          down_levels: [{
            level: 1,
            nodes: [{ id: 'customer-1', code: null, expandable: false, name: '经销渠道', share: 12, type: 'direct', via: '高端白酒', note: null }],
          }],
        }
      }
      if (request.operation === 'industry-chain.entity') {
        if (request.input?.key === '600000') {
          return {
            code: '600000', name: '高粱供应商', industry: '农业', market_cap_display: '420 亿元',
            supplier_count: 6, customer_count: 5, metrics: [{ label: '产能', value: '80 万吨' }],
          }
        }
        if (request.input?.key === 'customer-1') {
          return {
            id: 'customer-1', name: '经销渠道', appearance_count: 9,
            as_customer: [{ company_code: '600519', company_name: '贵州茅台', item: '高端白酒', share: 12, type: 'direct' }],
            as_supplier: [], metrics: [{ label: '覆盖区域', value: '31 省' }], related: [],
          }
        }
        return {
          code: '600519', name: '贵州茅台', industry: '白酒', market_cap_display: '2.1 万亿元',
          supplier_count: 5, customer_count: 4, metrics: [{ label: '毛利率', value: '91.2%' }],
        }
      }
      if (request.operation === 'trading-core.personalized-impact') {
        return {
          events: [{
            id: 'event-1',
            summary: '白酒消费复苏',
            tickers: [{ code: '600519', name: '贵州茅台' }],
            industries: ['白酒'],
            impact_codes: ['603079', '301335'],
            impact_industries: ['食品'],
            impact_by: ['行业「食品」：圣达生物(603079)'],
          }],
        }
      }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: request.input?.query, name: '天元宠物' }] }
      }
      if (request.operation === 'trading-core.shadow-status') {
        return { trade_date: '2026-08-26', ran_at: '2026-08-26 15:30:00', strategy_count: 1, overall_nav: 1.05 }
      }
      if (request.operation === 'trading-core.shadow-positions') {
        return { items: [{ strategy_id: 'strategy-1', symbol: '600519', qty: 100, avg_cost: 1450 }] }
      }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    const industry = render(<IndustryChainPage
      requestData={requestData as never}
      query="600519"
      onQuery={() => {}}
      onAnalyze={onAnalyze}
      onOpenStock={onOpenStock}
    />)
    expect(await screen.findByText('1,297 家')).toBeTruthy()
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'industry-chain.companies', input: { keyword: '600519', limit: 20 },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: /^贵州茅台/ }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'industry-chain.chain',
        input: { code: '600519', depth_up: 3, depth_down: 3, top_up: 5, top_down: 5 },
      })
    })
    expect((await screen.findAllByText('高粱供应商')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('经销渠道').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/高端白酒/u).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('小窗可缩放、可拖动节点的产业链物理图谱')).toBeTruthy()
    expect(screen.getByRole('button', { name: '高粱供应商 600000，上游第 1 层' })).toBeTruthy()
    expect(await screen.findByText('91.2%')).toBeTruthy()
    const compactGraph = screen.getByLabelText('小窗可缩放、可拖动节点的产业链物理图谱')
    fireEvent.click(screen.getByRole('button', { name: '放大图谱' }))
    const compactTransform = await waitFor(() => {
      const transform = compactGraph.querySelector(':scope > g')?.getAttribute('transform')
      expect(transform).toBeTruthy()
      return transform
    })
    fireEvent.click(screen.getByRole('button', { name: '放大查看' }))
    expect(screen.getByRole('dialog', { name: '贵州茅台 · 600519' })).toBeTruthy()
    const expandedGraph = screen.getByLabelText('可缩放、可拖动节点的产业链物理图谱')
    expect(expandedGraph.querySelector(':scope > g')?.getAttribute('transform')).toBe(compactTransform)
    const capturePointer = vi.fn()
    Object.defineProperty(expandedGraph, 'setPointerCapture', {
      configurable: true,
      value: capturePointer,
    })
    fireEvent.pointerDown(screen.getByRole('button', { name: '贵州茅台 600519，当前视角' }), {
      button: 0,
      pointerId: 11,
    })
    expect(capturePointer).not.toHaveBeenCalled()
    const canvasTransform = expandedGraph.querySelector(':scope > g')?.getAttribute('transform')
    const supplierTransform = screen.getByRole('button', { name: '高粱供应商 600000，上游第 1 层' })
      .getAttribute('transform')
    expect(screen.getByLabelText('产业链视角与已加载路径')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看节点详情：高粱供应商 600000' }))
    expect(screen.getByRole('dialog', { name: '高粱供应商 · 600000' })).toBeTruthy()
    expect(expandedGraph.querySelector(':scope > g')?.getAttribute('transform')).toBe(canvasTransform)
    expect(screen.getByRole('button', { name: '高粱供应商 600000，当前视角' }).getAttribute('transform'))
      .toBe(supplierTransform)
    expect(screen.getByText('上下游以此节点为起点')).toBeTruthy()
    expect(await screen.findByText('80 万吨')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '展开上游完整链路' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'industry-chain.chain',
        input: { code: '600000', depth_up: 3, depth_down: 3, top_up: 5, top_down: 5 },
      })
    })
    expect(screen.getByRole('button', { name: '高粱供应商' }).getAttribute('aria-current')).toBe('page')
    const expandedTransformBeforeClose = expandedGraph.querySelector(':scope > g')?.getAttribute('transform')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog', { name: '贵州茅台 · 600519' })).toBeNull()
    expect(screen.getByLabelText('小窗可缩放、可拖动节点的产业链物理图谱')
      .querySelector(':scope > g')?.getAttribute('transform')).toBe(expandedTransformBeforeClose)
    fireEvent.click(await screen.findByRole('button', { name: '查看圣达生物 · 603079个股详情' }))
    expect(onOpenStock).toHaveBeenCalledWith('603079')
    expect(await screen.findByRole('button', { name: '查看天元宠物 · 301335个股详情' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'AI 解读所选公司' }))
    expect(onAnalyze).toHaveBeenCalledWith({ kind: 'industry', reference: '600000 高粱供应商' })
    const intent = onAnalyze.mock.calls[0]?.[0]
    expect(intent?.kind).toBe('industry')
    if (intent?.kind === 'industry') expect(intent.reference).not.toContain('{')
    industry.unmount()

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId="strategy-1"
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)
    expect(await screen.findByText('2026-08-26 15:30:00')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('100 股')).toBeTruthy()
  })

  it('产业链搜索复用全市场证券目录，并为无图谱证券提供个股入口', async () => {
    const onOpenStock = vi.fn<(code: string) => void>()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'industry-chain.data-status') {
        return { status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000, current_file: null, error: null }
      }
      if (request.operation === 'industry-chain.stats') return { total_nodes: 1, total_edges: 0, subject_count: 1, relationships: 0 }
      if (request.operation === 'industry-chain.companies') return { items: [], count: 0 }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '510300', name: '沪深300ETF', type: 'etf' }] }
      }
      if (request.operation === 'trading-core.personalized-impact') return { events: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<IndustryChainPage
      requestData={requestData as never}
      query="510300"
      onQuery={() => {}}
      onAnalyze={() => {}}
      onOpenStock={onOpenStock}
    />)

    expect(await screen.findByText('全市场证券匹配')).toBeTruthy()
    expect(screen.getByText('沪深300ETF')).toBeTruthy()
    expect(screen.getByText('暂无产业链图谱 · 查看个股')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /沪深300ETF.*510300/ }))
    expect(onOpenStock).toHaveBeenCalledWith('510300')
  })

  it('小窗物理图可查看实体关系、继续上下钻并通过已加载路径返回', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'industry-chain.data-status') {
        return { status: 'ready', files_completed: 5, files_total: 5, downloaded_bytes: 25_000_000 }
      }
      if (request.operation === 'industry-chain.stats') return { subject_count: 3, total_nodes: 3, total_edges: 2, relationships: 1 }
      if (request.operation === 'industry-chain.companies') {
        return { items: [{ code: '600519', name: '贵州茅台', industry: '白酒' }] }
      }
      if (request.operation === 'market-watch.security-search') return { items: [] }
      if (request.operation === 'trading-core.personalized-impact') return { events: [] }
      if (request.operation === 'industry-chain.entity') {
        return {
          code: '600000', name: '高粱供应商', industry: '农业', market_cap_display: '420 亿元',
          supplier_count: 6, customer_count: 5,
          as_supplier: [{ company_code: '601111', company_name: '下游客户', item: '高粱', share: 16 }],
          as_customer: [{ company_code: '000998', company_name: '种业公司', item: '种子', share: 8 }],
          metrics: [{ label: '产能', value: '80 万吨' }],
        }
      }
      if (request.operation === 'industry-chain.chain') {
        const code = typeof request.input?.code === 'string' ? request.input.code : ''
        if (code === '601111') {
          return { center: { code, name: '下游客户', industry: '食品' }, up_levels: [], down_levels: [] }
        }
        return {
          center: { code: '600519', name: '贵州茅台', industry: '白酒' },
          up_levels: [{ level: -1, nodes: [{ id: 'supplier-1', code: '600000', name: '高粱供应商', via: '高粱', type: 'direct', share: 18 }] }],
          down_levels: [],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<IndustryChainPage
      requestData={requestData as never}
      query="600519"
      onQuery={() => {}}
      onAnalyze={() => {}}
      onOpenStock={() => {}}
    />)

    fireEvent.click(await screen.findByRole('button', { name: /^贵州茅台/u }))
    const supplier = await screen.findByRole('button', { name: '查看节点详情：高粱供应商 600000' })
    fireEvent.click(supplier)
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.entity', input: { key: '600000' } })
    })
    const relations = await screen.findByRole('region', { name: '实体关联公司' })
    expect(screen.getByText('80 万吨')).toBeTruthy()
    fireEvent.click(within(relations).getByRole('button', { name: /下游客户.*下钻/u }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'industry-chain.chain',
        input: { code: '601111', depth_up: 3, depth_down: 3, top_up: 5, top_down: 5 },
      })
    })
    const path = screen.getByRole('navigation', { name: '产业链视角与已加载路径' })
    expect(within(path).getByRole('button', { name: '下游客户' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(path).getByRole('button', { name: '贵州茅台' }))
    expect(within(path).getByRole('button', { name: '贵州茅台' }).getAttribute('aria-current')).toBe('page')
    expect(requestData.mock.calls.filter(([request]) => (
      request.operation === 'industry-chain.chain' && request.input?.code === '600519'
    ))).toHaveLength(1)
  })

  it('全部策略运行记录表：按交易日×策略展示净值/资金/异常并可打开报告', async () => {
    const onOpenReports = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') {
        return { trade_date: '2026-09-01', strategy_count: 2, ran_at: '2026-09-01 15:30:00', overall_nav: 1.01 }
      }
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      if (request.operation === 'trading-core.shadow-history') {
        return {
          count: 2,
          items: [
            { date: '2026-09-01', strategy_id: 'strat-1', strategy_name: '利空·rsi_reversal·600519', kind: 'rsi_reversal',
              initial_capital: 100000, equity: 101200, nav: 1.012, track_from: '2026-08-01', closed_count: 1, open_positions: 1,
              symbol_errors: {}, strategy_error: '' },
            { date: '2026-08-28', strategy_id: 'strat-2', strategy_name: '事件策略B', kind: 'event',
              initial_capital: 100000, equity: 96000, nav: 0.96, track_from: '2026-08-01', closed_count: 0, open_positions: 0,
              symbol_errors: { '600000': '无历史行情（baostock 空）' }, strategy_error: 'TimeoutError: 数据源超时' },
          ],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId=""
      onOpenEvolution={() => {}}
      onOpenReports={onOpenReports}
      onAnalyze={() => {}}
    />)

    const table = await screen.findByRole('region', { name: '全部策略运行记录' })
    expect(within(table).getByText('2026-09-01')).toBeTruthy()
    expect(within(table).getByText('1.01')).toBeTruthy()
    expect(within(table).getByText('¥101200.00')).toBeTruthy()
    expect(within(table).getAllByText('¥100000.00').length).toBeGreaterThan(0)
    expect(within(table).getByText('0.96')).toBeTruthy()
    // 存在策略级 strategy_error 时展示该原因（而非标的计数）
    expect(within(table).getByText('TimeoutError: 数据源超时')).toBeTruthy()
    // 打开投研报告抽屉
    fireEvent.click(within(table).getAllByRole('button', { name: '影子报告' })[0]!)
    expect(onOpenReports).toHaveBeenCalledOnce()
  })

  it('已选策略时默认单策略历史，可切到全部策略运行记录', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.shadow-status') {
        return { trade_date: '2026-09-01', strategy_count: 1, ran_at: '2026-09-01 15:30:00', overall_nav: 1.012 }
      }
      if (request.operation === 'trading-core.shadow-positions') return { items: [] }
      if (request.operation === 'trading-core.shadow-equity') return { items: [] }
      if (request.operation === 'trading-core.shadow-history') {
        const single = String(request.input?.strategy_id ?? '') === 'strat-1'
        const rows = [
          { date: '2026-09-01', strategy_id: 'strat-1', strategy_name: '电力事件策略', kind: 'event',
            initial_capital: 100000, equity: 101200, nav: 1.012, track_from: '2026-08-01', closed_count: 1, open_positions: 1,
            symbol_errors: {}, strategy_error: '' },
          { date: '2026-08-28', strategy_id: 'strat-other', strategy_name: '无关策略', kind: 'event',
            initial_capital: 100000, equity: 90000, nav: 0.9, track_from: '2026-07-01', closed_count: 0, open_positions: 0,
            symbol_errors: {}, strategy_error: '' },
        ]
        return { count: rows.length, items: single ? rows.filter(row => row.strategy_id === 'strat-1') : rows }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId="strat-1"
      strategyNames={{ 'strat-1': '电力事件策略' }}
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)

    const region = await screen.findByRole('region', { name: '影子验证历史' })
    // 默认当前策略历史：只见 strat-1 行
    expect(within(region).getByRole('button', { name: '当前策略历史' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(region).getByText('2026-09-01')).toBeTruthy()
    expect(within(region).queryByText('2026-08-28')).toBeNull()
    // 切到全部策略运行记录 → 出现其它策略行
    fireEvent.click(within(region).getByRole('button', { name: '全部策略运行记录' }))
    expect(await within(region).findByText('2026-08-28')).toBeTruthy()
    expect(within(region).getByText('无关策略')).toBeTruthy()
  })

  it('影子验证切页后停止长任务轮询且不再读取结果', async () => {
    let finishStatus: ((value: unknown) => void) | undefined
    const pendingStatus = new Promise((resolve) => { finishStatus = resolve })
    const requestData = vi.fn((request: { operation: string }) => {
      if (request.operation === 'trading-core.shadow-status') return Promise.resolve({})
      if (request.operation === 'trading-core.shadow-positions') return Promise.resolve({ items: [] })
      if (request.operation === 'trading-core.shadow-equity') return Promise.resolve({ items: [] })
      if (request.operation === 'trading-core.shadow-run') return Promise.resolve({ task_id: '0123456789abcdef0123456789abcdef' })
      if (request.operation === 'trading-core.task-status') return pendingStatus
      if (request.operation === 'trading-core.task-result') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected operation ${request.operation}`))
    })

    const view = render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId="strategy-1"
      onOpenEvolution={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
    />)
    fireEvent.click(screen.getByRole('button', { name: '运行影子验证' }))
    await waitFor(() => {
      expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.task-status')).toHaveLength(1)
    })
    view.unmount()
    finishStatus?.({ status: 'done' })
    await Promise.resolve()
    await Promise.resolve()

    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.task-status')).toHaveLength(1)
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.task-result')).toBe(false)
  })
})
