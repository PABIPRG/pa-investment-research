// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { InvestmentComposerContextControls } from '../src/client/ResearchContextControls.tsx'
import { ResearchChatContextController } from '../src/client/research-chat-context.ts'
import type { InvestmentUiSnapshot } from '../src/client/state.ts'

afterEach(cleanup)

const UI: InvestmentUiSnapshot = {
  route: 'portfolio', historyOpen: false, reportsOpen: false,
  assistantMode: 'closed', assistantModule: 'general',
  analysisQuery: '', backtestQuery: '', watchQuery: '', chainQuery: '',
  selectedStockCode: '', selectedStrategyId: '',
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
  const view = render(<InvestmentComposerContextControls {...props} />)
  return { ...view, controller }
}

describe('investment composer research context controls', () => {
  it('searches every strategy, previews details, and marks only active and passed as recommended', async () => {
    let revision = 0
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') {
        return { exists: false, context: null }
      }
      if (request.operation === 'trading-core.strategies') {
        return { items: [
          { id: 'recommended', name: '稳健趋势', status: 'active', verification_status: 'passed', updated_at: '2026-08-31T00:00:00Z' },
          { id: 'candidate', name: '候选事件', status: 'candidate', verification_status: 'pending', kind: 'event', hypothesis: '事件冲击后观察价格修复', params: { window: 10 }, symbols: ['600519'], updated_at: '2026-09-01T00:00:00Z' },
        ] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        revision += 1
        return {
          schema_version: 1, session_id: 'session-a', revision,
          strategy_id: request.input?.strategy_id, instrument: request.input?.instrument,
          updated_at: '2026-09-01T04:00:00Z',
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)

    const strategyTrigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(strategyTrigger.disabled).toBe(false) })
    fireEvent.click(strategyTrigger)
    expect(await screen.findByText('推荐策略')).toBeTruthy()
    expect(screen.getByText('其他策略')).toBeTruthy()
    expect(screen.getByRole('option', { name: /稳健趋势.*已启用.*已验证.*推荐/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索策略名称或标识' }), { target: { value: 'candidate' } })
    expect(screen.queryByRole('option', { name: /稳健趋势/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /候选事件.*候选.*待验证.*非推荐/ }))
    expect(screen.getByText('事件冲击后观察价格修复')).toBeTruthy()
    expect(screen.getByText('window：10')).toBeTruthy()
    expect(screen.getByText('600519')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认使用候选事件' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /策略，当前：候选事件.*候选.*待验证.*非推荐/ })).toBeTruthy()
    })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.research-chat-context-save',
      input: { session_id: 'session-a', expected_revision: 0, strategy_id: 'candidate', instrument: null },
    })
  })

  it('refreshes a restored session and keeps non-recommended risk visible before opening the menu', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') {
        return {
          exists: true,
          context: {
            schema_version: 1, session_id: 'session-a', revision: 4,
            strategy_id: 'candidate', instrument: null, updated_at: '2026-09-01T04:00:00Z',
          },
        }
      }
      if (request.operation === 'trading-core.strategy-detail') {
        return { id: 'candidate', name: '候选事件', status: 'candidate', verification_status: 'pending' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)

    expect(await screen.findByRole('button', { name: /策略，当前：候选事件.*候选.*待验证.*非推荐/ })).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.research-chat-context', input: { session_id: 'session-a' },
    })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.strategy-detail', input: { strategy_id: 'candidate' },
    })
  })

  it('marks a restored deleted strategy as invalid instead of showing a neutral id', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') {
        return {
          exists: true,
          context: {
            schema_version: 1, session_id: 'session-a', revision: 2,
            strategy_id: 'deleted', instrument: null, updated_at: '2026-09-01T04:00:00Z',
          },
        }
      }
      if (request.operation === 'trading-core.strategy-detail') throw new Error('HTTP 404: 策略不存在')
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)

    expect(await screen.findByRole('button', { name: /策略，当前：deleted.*已失效.*非推荐/ })).toBeTruthy()
    expect(screen.getByText('已失效')).toBeTruthy()
  })

  it('keeps context load failures compact, hides transport details, and retries in place', async () => {
    let attempts = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation !== 'trading-core.research-chat-context') throw new Error('unexpected operation')
      attempts += 1
      if (attempts === 1) {
        throw new Error('investment Runtime Client: request-data failed: HTTP 404: {"detail":"Not Found"}')
      }
      return { exists: false, context: null }
    })
    renderControls(requestData)

    const alert = await screen.findByRole('alert', { name: '投研上下文暂不可用' })
    expect(alert.textContent).not.toContain('request-data')
    expect(alert.textContent).not.toContain('HTTP 404')
    fireEvent.click(screen.getByRole('button', { name: '重试读取投研上下文' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(attempts).toBe(2)
  })

  it('supports strategy keyboard preview and returns focus to the trigger on Escape', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'keyboard', name: '键盘策略', status: 'active', verification_status: 'passed', hypothesis: '键盘预览假设' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const search = await screen.findByRole('searchbox', { name: '搜索策略名称或标识' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByText('键盘预览假设')).toBeTruthy()
    expect(search.getAttribute('aria-activedescendant')).toContain('keyboard')
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '选择投研策略' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('retains the confirmed value after save failure and retries the same target', async () => {
    let saveAttempts = 0
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'retry', name: '重试策略', status: 'active', verification_status: 'passed' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        saveAttempts += 1
        if (saveAttempts === 1) throw new Error('temporary failure')
        return {
          schema_version: 1, session_id: 'session-a', revision: 1,
          strategy_id: request.input?.strategy_id, instrument: null, updated_at: '2026-09-01T04:00:00Z',
        }
      }
      if (request.operation === 'trading-core.strategy-detail') {
        return { id: 'retry', name: '重试策略', status: 'active', verification_status: 'passed' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: /重试策略/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认使用重试策略' }))

    expect(await screen.findByRole('button', { name: '重试保存投研上下文' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '策略，当前：未选择' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试保存投研上下文' }))
    expect(await screen.findByRole('button', { name: /策略，当前：重试策略.*推荐/ })).toBeTruthy()
    expect(saveAttempts).toBe(2)
  })

  it('refreshes after 409 and never offers to replay the stale target', async () => {
    let loadAttempts = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') {
        loadAttempts += 1
        if (loadAttempts === 1) return { exists: false, context: null }
        return {
          exists: true,
          context: {
            schema_version: 1, session_id: 'session-a', revision: 3,
            strategy_id: 'server', instrument: null, updated_at: '2026-09-01T04:00:00Z',
          },
        }
      }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'local', name: '本地选择', status: 'active', verification_status: 'passed' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        throw new Error('HTTP 409: revision_conflict')
      }
      if (request.operation === 'trading-core.strategy-detail') {
        return { id: 'server', name: '其他窗口选择', status: 'active', verification_status: 'passed' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: /本地选择/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认使用本地选择' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('该会话已在其他位置更新，请重新选择。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试保存投研上下文' })).toBeNull()
    expect(await screen.findByRole('button', { name: /策略，当前：其他窗口选择.*推荐/ })).toBeTruthy()
  })

  it('searches and confirms a venue ETF from the composer toolbar', async () => {
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
          updated_at: '2026-09-01T04:00:00Z',
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)

    const instrumentTrigger = screen.getByRole<HTMLButtonElement>('button', { name: '标的，当前：未选择' })
    await waitFor(() => { expect(instrumentTrigger.disabled).toBe(false) })
    fireEvent.click(instrumentTrigger)
    const input = screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' })
    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: '沪深300' } })
    await vi.advanceTimersByTimeAsync(180)
    vi.useRealTimers()
    const option = await screen.findByRole('option', { name: /沪深300ETF.*510300.*ETF/ })
    fireEvent.click(option)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /标的，当前：沪深300ETF.*510300.*ETF/ })).toBeTruthy()
    })
    expect(savedInput).toEqual({
      session_id: 'session-a', expected_revision: 0, strategy_id: null,
      instrument: { code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' },
    })
  })

  it('keeps the fixed research-module selector outside My Research', () => {
    const requestData = vi.fn(async () => ({ exists: false, context: null }))
    renderControls(requestData, { route: 'framework', assistantMode: 'docked', assistantModule: 'strategy' })

    const trigger = screen.getByRole('button', { name: '研究模块，当前：策略验证专家' })
    expect(within(trigger).getByText('策略验证专家')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /策略，当前/ })).toBeNull()
  })
})
