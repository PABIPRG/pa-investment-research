// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import {
  EvolutionPage,
  IndustryChainPage,
  ReportCenter,
  ShadowValidationPage,
  StrategyResearchPage,
} from '../src/client/ProductPages.tsx'
import { InvestmentShell, InvestmentWelcome } from '../src/client/InvestmentShell.tsx'
import type { InvestmentUiSnapshot } from '../src/client/state.ts'

afterEach(cleanup)

const neverGlobalHook = (() => { throw new Error('global hook is not used in this scenario') }) as never

describe('投研产品闭环', () => {
  it('从策略列表选择 active 策略并把同一标识传给影子验证', async () => {
    const onSelectStrategy = vi.fn()
    const onOpenShadow = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
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
      onAnalyze={() => {}}
    />)

    expect(await screen.findByText('事件驱动策略')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('回测结论：样本外胜率/均收益达标')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '进入影子验证' }))

    expect(onSelectStrategy).toHaveBeenCalledWith('strategy-active-1')
    expect(onOpenShadow).toHaveBeenCalledWith('strategy-active-1')
    expect(onSelectStrategy.mock.invocationCallOrder[0]).toBeLessThan(onOpenShadow.mock.invocationCallOrder[0]!)
  })

  it('策略回测只有在任务结果含正式正文时才提示已进入报告中心', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [{
            id: 'strategy-1', name: '候选策略', status: 'candidate', symbols: ['600519'], backtest: null,
          }],
        }
      }
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
      onAnalyze={() => {}}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '运行回测' }))
    expect(await screen.findByText('回测完成，正式结果已进入投研报告。')).toBeTruthy()
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
      onAnalyze={() => {}}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '运行影子验证' }))
    expect(await screen.findByText('影子验证未执行：无 active 策略')).toBeTruthy()
    expect(screen.queryByText(/正式结果已进入投研报告/)).toBeNull()
  })

  it('无进化动作时保持写入禁用，且绝不请求 apply=true', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.evolution-status') return { ready: true, counts: {} }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (request.operation === 'trading-core.evolution-run' && request.input?.apply === false) {
        return { status: 'preview', actions: [], note: '暂无满足条件的动作' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('button', { name: '确认并应用' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '生成进化预案' }))
    const confirm = await screen.findByRole<HTMLButtonElement>('button', { name: '确认并应用' })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)

    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.evolution-run', input: { apply: false },
    })
    expect(requestData.mock.calls.some(([request]) => (
      request.operation === 'trading-core.evolution-run' && request.input?.apply === true
    ))).toBe(false)
  })

  it('有进化动作时也先只读预览，用户明确确认后才 apply=true', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.evolution-status') return { ready: true, counts: { active: 1 } }
      if (request.operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
      if (request.operation === 'trading-core.evolution-run' && request.input?.apply === false) {
        return {
          status: 'preview',
          actions: [{ sid: 'strategy-active-1', strategy_name: '事件驱动策略', type: 'promote', reason: '样本外证据稳定' }],
        }
      }
      if (request.operation === 'trading-core.evolution-run' && request.input?.apply === true) {
        return { status: 'applied', actions: [] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<EvolutionPage requestData={requestData as never} onAnalyze={() => {}} />)
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: '生成进化预案' }))

    const confirm = await screen.findByRole<HTMLButtonElement>('button', { name: '确认并应用' })
    expect(confirm.disabled).toBe(false)
    expect(screen.getByText('样本外证据稳定')).toBeTruthy()
    const beforeConfirmation = requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.evolution-run')
    expect(beforeConfirmation.map(([request]) => request.input)).toEqual([{ apply: false }])

    fireEvent.click(confirm)
    await waitFor(() => {
      const writes = requestData.mock.calls.filter(([request]) => (
        request.operation === 'trading-core.evolution-run' && request.input?.apply === true
      ))
      expect(writes).toHaveLength(1)
    })
    const evolutionCalls = requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.evolution-run')
    expect(evolutionCalls.map(([request]) => request.input)).toEqual([{ apply: false }, { apply: true }])
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

  it('产业链筛选、全局证券搜索和智能分析代码拥有三份独立输入状态', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.personalized-impact') return { events: [] }
      if (request.operation === 'market-watch.security-search') return { items: [] }
      return {}
    })
    const base: InvestmentUiSnapshot = {
      route: 'knowledge', historyOpen: false, reportsOpen: false,
      analysisQuery: '', watchQuery: '', chainQuery: '',
      selectedStockCode: '', selectedStrategyId: '',
    }

    function Harness() {
      const [snapshot, setSnapshot] = useState(base)
      const useInvestmentUi = <T,>(selector: (value: InvestmentUiSnapshot) => T): T => selector(snapshot)
      return <>
        <InvestmentShell
          useInvestmentUi={useInvestmentUi as never}
          useSessions={neverGlobalHook}
          useWorkspaces={neverGlobalHook}
          requestData={requestData as never}
          navigate={() => {}}
          setHistory={() => {}}
          setReports={() => {}}
          setModuleDraft={(key, value) => { setSnapshot(current => ({ ...current, [key]: value })) }}
          selectStrategy={() => {}}
          startSession={() => Promise.resolve()}
          openSession={() => Promise.resolve()}
          searchSessions={() => Promise.resolve([])}
          renameSession={() => Promise.resolve()}
          archiveSession={() => Promise.resolve()}
          prepareAssistant={() => {}}
          toggleTheme={() => {}}
        />
        <InvestmentWelcome
          useSessions={neverGlobalHook}
          useWorkspaces={neverGlobalHook}
          disabled={false}
          onPrompt={() => {}}
        />
      </>
    }

    render(<Harness />)
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({ operation: 'trading-core.personalized-impact', input: { limit: 20 } })
    })
    const globalSearch = screen.getByRole<HTMLInputElement>('combobox', { name: '搜索 A 股代码或名称' })
    const chainFilter = screen.getByRole<HTMLInputElement>('textbox', { name: '筛选事件、股票或行业' })
    const analysisCode = screen.getByRole<HTMLInputElement>('textbox', { name: '智能分析股票代码' })

    fireEvent.change(globalSearch, { target: { value: '贵州茅台' } })
    expect(chainFilter.value).toBe('')
    expect(analysisCode.value).toBe('')
    fireEvent.change(chainFilter, { target: { value: '半导体' } })
    expect(globalSearch.value).toBe('贵州茅台')
    expect(analysisCode.value).toBe('')
    fireEvent.change(analysisCode, { target: { value: '600519' } })
    expect(globalSearch.value).toBe('贵州茅台')
    expect(chainFilter.value).toBe('半导体')
  })

  it('按真实 DTO 展示产业链标的对象与影子账户字段', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.personalized-impact') {
        return {
          events: [{
            id: 'event-1',
            summary: '白酒消费复苏',
            tickers: [{ code: '600519', name: '贵州茅台' }],
            industries: ['白酒'],
            impact_codes: [],
            impact_industries: [],
            impact_by: [],
          }],
        }
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
      onAnalyze={() => {}}
    />)
    expect(await screen.findByText('贵州茅台（600519）')).toBeTruthy()
    industry.unmount()

    render(<ShadowValidationPage
      requestData={requestData as never}
      selectedStrategyId="strategy-1"
      onOpenEvolution={() => {}}
      onAnalyze={() => {}}
    />)
    expect(await screen.findByText('2026-08-26 15:30:00')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('100')).toBeTruthy()
  })

  it('影子验证切页后停止长任务轮询且不再读取结果', async () => {
    let finishStatus: ((value: unknown) => void) | undefined
    const pendingStatus = new Promise(resolve => { finishStatus = resolve })
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
