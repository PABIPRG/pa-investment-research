// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { ComponentProps } from 'react'
import { InvestmentComposerContextControls } from '../src/client/ResearchContextControls.tsx'
import { ResearchChatContextController } from '../src/client/research-chat-context.ts'
import type { InvestmentUiSnapshot } from '../src/client/state.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const UI: InvestmentUiSnapshot = {
  route: 'portfolio', historyOpen: false, reportsOpen: false,
  assistantMode: 'closed', assistantModule: 'general',
  analysisQuery: '', backtestQuery: '', watchQuery: '', chainQuery: '',
  selectedStockCode: '', selectedStrategyId: '',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function renderControls(requestData: ReturnType<typeof vi.fn>, overrides: Partial<InvestmentUiSnapshot> = {}) {
  const controller = new ResearchChatContextController(requestData as never)
  const snapshot = { ...UI, ...overrides }
  const props = {
    useInvestmentUi: ((selector: (value: InvestmentUiSnapshot) => unknown) => selector(snapshot)) as never,
    setAssistantModule: () => {},
    researchChatContext: controller,
    requestData: requestData as never,
    session: { sessionId: 'session-a', running: false } as never,
    input: { phase: 'plain' } as never,
  } as unknown as ComponentProps<typeof InvestmentComposerContextControls>
  return { ...render(<InvestmentComposerContextControls {...props} />), controller }
}

function renderReactiveControls(requestData: ReturnType<typeof vi.fn>) {
  const controller = new ResearchChatContextController(requestData as never)
  const onModuleSelected = vi.fn()

  function Harness() {
    const [snapshot, setSnapshot] = useState(UI)
    const useInvestmentUi = <T,>(selector: (value: InvestmentUiSnapshot) => T): T => selector(snapshot)
    return (
      <InvestmentComposerContextControls
        useInvestmentUi={useInvestmentUi}
        setAssistantModule={(assistantModule, promptOverride) => {
          onModuleSelected(assistantModule, promptOverride)
          setSnapshot(current => ({ ...current, assistantModule }))
        }}
        researchChatContext={controller}
        requestData={requestData as never}
        session={{ sessionId: 'session-a', running: false } as never}
        input={{ phase: 'plain' } as never}
      />
    )
  }

  return { ...render(<Harness />), onModuleSelected }
}

describe('investment composer research context controls', () => {
  it('我的投研使用智能分析模块和可选标的，不再选择策略池策略', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const view = renderReactiveControls(requestData)

    const moduleTrigger = screen.getByRole('button', { name: '研究模块，当前：未选择' })
    expect(within(moduleTrigger).getByText('选模块')).toBeTruthy()
    expect(screen.getByRole('button', { name: '标的，当前：未选择' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /策略，当前/u })).toBeNull()

    fireEvent.click(moduleTrigger)
    for (const label of ['个股多智能体分析', '持仓风险分析', '历史决策回测', '市场简报']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy()
    }
    expect(screen.getByRole('menuitem', { name: '不指定模块' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '市场简报' }))

    expect(screen.getByRole('button', { name: '研究模块，当前：市场简报' })).toBeTruthy()
    expect(view.onModuleSelected).toHaveBeenCalledWith(
      'watch',
      expect.stringContaining('市场简报专家'),
    )
  })

  it('恢复当前会话已确认的标的，但不恢复策略选择入口', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') {
        return {
          exists: true,
          context: {
            schema_version: 1, session_id: 'session-a', revision: 3,
            strategy_id: 'legacy-strategy',
            instrument: { code: '600519', name: '贵州茅台', market: '沪市', type: 'stock' },
            updated_at: '2026-09-02T08:00:00Z',
          },
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)

    expect(await screen.findByRole('button', { name: /标的，当前：贵州茅台.*600519.*A股/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /策略，当前/u })).toBeNull()
  })

  it('搜索并确认场内 ETF，同时清除旧策略上下文', async () => {
    let savedInput: Record<string, unknown> | undefined
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        savedInput = request.input
        return {
          schema_version: 1, session_id: 'session-a', revision: 1,
          strategy_id: null, instrument: request.input?.instrument,
          updated_at: '2026-09-02T08:00:00Z',
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)

    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '标的，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const input = screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' })
    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: '沪深300' } })
    await vi.advanceTimersByTimeAsync(180)
    vi.useRealTimers()
    fireEvent.click(await screen.findByRole('option', { name: /沪深300ETF.*510300.*ETF/u }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /标的，当前：沪深300ETF.*510300.*ETF/u })).toBeTruthy()
    })
    expect(savedInput).toEqual({
      session_id: 'session-a', expected_revision: 0, strategy_id: null,
      instrument: { code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' },
    })
  })

  it('证券搜索失败后可原位重试并保留输入焦点', async () => {
    let attempts = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'market-watch.security-search') {
        attempts += 1
        if (attempts === 1) throw new Error('temporary security search failure')
        return { items: [] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '标的，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const search = screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' })
    vi.useFakeTimers()
    fireEvent.change(search, { target: { value: '不存在' } })
    await vi.advanceTimersByTimeAsync(180)
    vi.useRealTimers()
    const retry = await screen.findByRole<HTMLButtonElement>('button', { name: '重试搜索' })
    retry.focus()

    fireEvent.click(retry)

    expect(document.activeElement).toBe(search)
    await waitFor(() => { expect(attempts).toBe(2) })
  })

  it('保存延迟完成时不抢走用户已移到外部的焦点', async () => {
    const pendingSave = deferred<unknown>()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') return pendingSave.promise
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '标的，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' }), { target: { value: '沪深300' } })
    await vi.advanceTimersByTimeAsync(180)
    vi.useRealTimers()
    fireEvent.click(await screen.findByRole('option', { name: /沪深300ETF.*510300.*ETF/u }))
    const external = document.createElement('button')
    external.tabIndex = -1
    document.body.append(external)
    external.focus()

    await act(async () => {
      pendingSave.resolve({
        schema_version: 1, session_id: 'session-a', revision: 1,
        strategy_id: null, instrument: { code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' },
        updated_at: '2026-09-02T08:00:00Z',
      })
      await pendingSave.promise
    })

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '选择投资标的' })).toBeNull() })
    expect(document.activeElement).toBe(external)
    external.remove()
  })

  it('标的保存失败时保留已确认值并可重试', async () => {
    let saveAttempts = 0
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        saveAttempts += 1
        if (saveAttempts === 1) throw new Error('temporary save failure')
        return {
          schema_version: 1, session_id: 'session-a', revision: 1,
          strategy_id: null, instrument: request.input?.instrument,
          updated_at: '2026-09-02T08:00:00Z',
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '标的，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' }), { target: { value: '沪深300' } })
    await vi.advanceTimersByTimeAsync(180)
    vi.useRealTimers()
    fireEvent.click(await screen.findByRole('option', { name: /沪深300ETF.*510300.*ETF/u }))

    expect(await screen.findByText(/保存失败，已保留上次选择/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '标的，当前：未选择' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试保存投研上下文' }))

    expect(await screen.findByRole('button', { name: /标的，当前：沪深300ETF.*510300.*ETF/u })).toBeTruthy()
    expect(saveAttempts).toBe(2)
  })

  it('我的投研之外仍保留研究专家选择器', () => {
    const requestData = vi.fn(async () => ({ exists: false, context: null }))
    renderControls(requestData, { route: 'framework', assistantMode: 'docked', assistantModule: 'strategy' })

    const trigger = screen.getByRole('button', { name: '研究模块，当前：策略验证专家' })
    expect(within(trigger).getByText('策略验证专家')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /标的，当前/u })).toBeNull()
  })
})
