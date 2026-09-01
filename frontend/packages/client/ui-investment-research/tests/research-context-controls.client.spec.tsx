// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { InvestmentComposerContextControls } from '../src/client/ResearchContextControls.tsx'
import { ResearchChatContextController } from '../src/client/research-chat-context.ts'
import type { InvestmentUiSnapshot } from '../src/client/state.ts'

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.removeAttribute('tabindex')
  if (scrollIntoViewDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  else Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
})

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

function focusNativeDisabledFallback(): void {
  document.body.tabIndex = -1
  document.body.focus()
  expect(document.activeElement).toBe(document.body)
}

describe('investment composer research context controls', () => {
  it('searches every strategy, previews details, and marks only active and passed as recommended', async () => {
    let revision = 0
    let savedInput: Record<string, unknown> | undefined
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
        savedInput = request.input
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
    expect(screen.getByLabelText(/稳健趋势.*已启用.*已验证.*推荐/)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索策略名称或标识' }), { target: { value: 'candidate' } })
    expect(screen.queryByLabelText(/稳健趋势/)).toBeNull()
    const candidate = screen.getByLabelText(/候选事件.*候选.*待验证.*非推荐/)
    fireEvent.click(candidate)
    const detail = screen.getByRole('region', { name: '候选事件策略详情' })
    expect(candidate.getAttribute('aria-expanded')).toBe('true')
    expect(candidate.nextElementSibling).toBe(detail)
    expect(within(detail).getByText('事件冲击后观察价格修复')).toBeTruthy()
    expect(within(detail).getByText('候选')).toBeTruthy()
    expect(within(detail).getByText('待验证')).toBeTruthy()
    expect(within(detail).getByText('window：10')).toBeTruthy()
    expect(within(detail).getByText('600519')).toBeTruthy()
    expect(savedInput).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: '确认使用候选事件' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /策略，当前：候选事件.*候选.*待验证.*非推荐/ })).toBeTruthy()
    })
    expect(savedInput).toEqual({
      session_id: 'session-a', expected_revision: 0, strategy_id: 'candidate', instrument: null,
    })
  })

  it('reveals the expanded strategy confirm action without scrolling a collapsed or replaced detail', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    let saves = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [
          { id: 'alpha', name: '策略甲', status: 'active', verification_status: 'passed', hypothesis: '甲详情' },
          { id: 'beta', name: '策略乙', status: 'candidate', verification_status: 'pending', hypothesis: '乙详情' },
        ] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        saves += 1
        throw new Error('unexpected save')
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const alpha = await screen.findByLabelText(/策略甲.*推荐/)
    const beta = screen.getByLabelText(/策略乙.*非推荐/)

    fireEvent.click(alpha)
    const alphaDetail = screen.getByRole('region', { name: '策略甲策略详情' })
    const alphaConfirm = within(alphaDetail).getByRole('button', { name: '确认使用策略甲' })
    expect(alpha.nextElementSibling).toBe(alphaDetail)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(alpha.closest('[role="listitem"]'))
    fireEvent.transitionEnd(alphaDetail, { propertyName: 'grid-template-rows' })
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView.mock.contexts[1]).toBe(alphaConfirm)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', behavior: 'smooth' })

    fireEvent.click(beta)
    const betaDetail = screen.getByRole('region', { name: '策略乙策略详情' })
    const betaConfirm = within(betaDetail).getByRole('button', { name: '确认使用策略乙' })
    expect(screen.queryByRole('region', { name: '策略甲策略详情' })).toBeNull()
    expect(beta.nextElementSibling).toBe(betaDetail)
    expect(scrollIntoView).toHaveBeenCalledTimes(3)
    expect(scrollIntoView.mock.contexts[2]).toBe(beta.closest('[role="listitem"]'))

    fireEvent.transitionEnd(alphaDetail, { propertyName: 'grid-template-rows' })
    expect(scrollIntoView).toHaveBeenCalledTimes(3)
    fireEvent.transitionEnd(betaDetail, { propertyName: 'grid-template-rows' })
    expect(scrollIntoView).toHaveBeenCalledTimes(4)
    expect(scrollIntoView.mock.contexts[3]).toBe(betaConfirm)

    fireEvent.click(beta)
    expect(screen.queryByRole('region', { name: '策略乙策略详情' })).toBeNull()
    fireEvent.transitionEnd(betaDetail, { propertyName: 'grid-template-rows' })
    expect(scrollIntoView).toHaveBeenCalledTimes(4)
    expect(saves).toBe(0)
  })

  it('reveals the strategy confirm action immediately when reduced motion suppresses transitions', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [
          { id: 'calm', name: '无动效策略', status: 'active', verification_status: 'passed' },
        ] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const strategy = await screen.findByRole('button', { name: /无动效策略.*推荐/u })

    fireEvent.click(strategy)

    const confirm = screen.getByRole('button', { name: '确认使用无动效策略' })
    await waitFor(() => { expect(scrollIntoView).toHaveBeenCalledTimes(2) })
    expect(scrollIntoView.mock.contexts[0]).toBe(strategy.closest('[role="listitem"]'))
    expect(scrollIntoView.mock.contexts[1]).toBe(confirm)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', behavior: 'auto' })
  })

  it('re-reveals the expanded confirm after viewport resize without fighting ordinary scroll', async () => {
    const animationFrames = new Map<number, FrameRequestCallback>()
    let nextAnimationFrame = 0
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const frame = ++nextAnimationFrame
      animationFrames.set(frame, callback)
      return frame
    })
    const cancelAnimationFrame = vi.fn((frame: number) => { animationFrames.delete(frame) })
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const visualViewport = Object.assign(new EventTarget(), {
      offsetLeft: 0, offsetTop: 0, width: 820, height: 801,
    })
    vi.stubGlobal('visualViewport', visualViewport)
    const flushAnimationFrames = (): void => {
      const pending = [...animationFrames.entries()]
      animationFrames.clear()
      for (const [, callback] of pending) callback(0)
    }
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [
          { id: 'responsive', name: '响应式策略', status: 'active', verification_status: 'passed' },
        ] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const strategy = await screen.findByRole('button', { name: /响应式策略.*推荐/u })
    fireEvent.click(strategy)
    const detail = screen.getByRole('region', { name: '响应式策略策略详情' })
    const confirm = within(detail).getByRole('button', { name: '确认使用响应式策略' })
    fireEvent.transitionEnd(detail, { propertyName: 'grid-template-rows' })
    expect(scrollIntoView).toHaveBeenCalledTimes(2)

    fireEvent.scroll(screen.getByRole('list'))
    fireEvent.scroll(window)
    fireEvent(visualViewport, new Event('scroll'))
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)

    fireEvent.resize(window)
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    flushAnimationFrames()
    expect(scrollIntoView).toHaveBeenCalledTimes(3)
    expect(scrollIntoView.mock.contexts[2]).toBe(confirm)

    visualViewport.height = 484
    fireEvent(visualViewport, new Event('resize'))
    flushAnimationFrames()
    expect(scrollIntoView).toHaveBeenCalledTimes(4)
    expect(scrollIntoView.mock.contexts[3]).toBe(confirm)
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
    const strategy = screen.getByRole('button', { name: /键盘策略.*，推荐$/u })
    expect(document.activeElement).toBe(strategy)
    expect(screen.queryByRole('region', { name: '键盘策略策略详情' })).toBeNull()
    fireEvent.click(strategy)
    expect(screen.getByRole('region', { name: '键盘策略策略详情' })).toBeTruthy()
    const confirm = screen.getByRole('button', { name: '确认使用键盘策略' })
    expect(confirm.tabIndex).toBe(0)
    confirm.focus()
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.research-chat-context-save')).toBe(false)
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(screen.queryByLabelText('选择投研策略')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses an open selector when the user points outside it', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') return { items: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog', { name: '选择投研策略' })).toBeTruthy()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('dialog', { name: '选择投研策略' })).toBeNull()
  })

  it('opens below a top-edge trigger and respects the visual viewport on every side', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') return { items: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const visualViewport = {
      offsetLeft: 4, offsetTop: 20, width: 320, height: 500,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }
    vi.stubGlobal('visualViewport', visualViewport)
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 300, right: 336, top: 30, bottom: 74, width: 36, height: 44,
      x: 300, y: 30, toJSON: () => ({}),
    })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })

    fireEvent.click(trigger)

    const dialog = await screen.findByRole<HTMLDivElement>('dialog', { name: '选择投研策略' })
    expect(dialog.style.left).toBe('16px')
    expect(dialog.style.top).toBe('82px')
    expect(dialog.style.width).toBe('296px')
    expect(dialog.style.maxWidth).toBe('296px')
    expect(dialog.style.maxHeight).toBe('426px')
  })

  it('portals the selector and clamps both axes inside a narrow viewport', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'edge', name: '边缘策略', status: 'active', verification_status: 'passed' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 350, right: 386, top: 780, bottom: 824, width: 36, height: 44,
      x: 350, y: 780, toJSON: () => ({}),
    })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole<HTMLDivElement>('dialog', { name: '选择投研策略' })

    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.style.position).toBe('fixed')
    expect(dialog.style.left).toBe('12px')
    expect(Number.parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(12)
    expect(Number.parseFloat(dialog.style.maxHeight)).toBeLessThanOrEqual(560)

    fireEvent.pointerDown(dialog)
    expect(screen.getByRole('dialog', { name: '选择投研策略' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: '选择投研策略' })).toBeNull()
  })

  it('restores the strategy trigger after native disabled focus falls back to the document body', async () => {
    let resolveSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => { resolveSave = resolve })
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'focus', name: '焦点策略', status: 'active', verification_status: 'passed' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        await saveGate
        return {
          schema_version: 1, session_id: 'session-a', revision: 1,
          strategy_id: request.input?.strategy_id, instrument: null, updated_at: '2026-09-01T04:00:00Z',
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /焦点策略.*，推荐$/u }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认使用焦点策略' })
    confirm.focus()

    fireEvent.click(confirm)
    await waitFor(() => { expect(confirm.disabled).toBe(true) })
    focusNativeDisabledFallback()
    resolveSave?.()

    const selectedTrigger = await screen.findByRole<HTMLButtonElement>('button', {
      name: /策略，当前：焦点策略.*推荐/u,
    })
    await waitFor(() => { expect(document.activeElement).toBe(selectedTrigger) })
  })

  it('does not steal focus when a deferred save finishes after focus moved to an external tabindex -1 target', async () => {
    let resolveSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => { resolveSave = resolve })
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'deferred', name: '延迟策略', status: 'active', verification_status: 'passed' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        await saveGate
        return {
          schema_version: 1, session_id: 'session-a', revision: 1,
          strategy_id: request.input?.strategy_id, instrument: null, updated_at: '2026-09-01T04:00:00Z',
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const view = renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /延迟策略.*，推荐$/u }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认使用延迟策略' })
    confirm.focus()
    fireEvent.click(confirm)
    const outside = document.createElement('div')
    outside.tabIndex = -1
    view.container.append(outside)
    outside.focus()

    resolveSave?.()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /策略，当前：延迟策略.*，推荐$/u })).toBeTruthy()
    })
    expect(document.activeElement).toBe(outside)
  })

  it('returns focus to the strategy search after retrying a failed strategy load', async () => {
    let attempts = 0
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        attempts += 1
        if (attempts === 1) throw new Error('temporary strategy load failure')
        return { items: [] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    const search = screen.getByRole('searchbox', { name: '搜索策略名称或标识' })
    const retry = await screen.findByRole<HTMLButtonElement>('button', { name: '重试加载策略' })
    retry.focus()

    fireEvent.click(retry)

    expect(document.activeElement).toBe(search)
    await waitFor(() => { expect(attempts).toBe(2) })
  })

  it('returns focus to the instrument search after retrying a failed security search', async () => {
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

  it('shows strategy kind and explicit archived or unknown verification risk before expansion', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [
          {
            id: 'archived', name: '归档策略', kind: 'mean_reversion',
            status: 'active', verification_status: 'archived',
          },
          {
            id: 'unknown', name: '未知验证', kind: 'event',
            status: 'active', verification_status: 'mystery',
          },
        ] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)

    const archived = await screen.findByRole('button', {
      name: '归档策略，类型 mean_reversion，已启用，已归档，非推荐',
    })
    const unknown = screen.getByRole('button', {
      name: '未知验证，类型 event，已启用，验证状态未知，非推荐',
    })
    expect(archived.textContent).toContain('mean_reversion')
    expect(unknown.textContent).toContain('event')
    expect(within(archived).getByText('已归档')).toBeTruthy()
    expect(within(unknown).getByText('验证状态未知')).toBeTruthy()
    fireEvent.click(archived)
    const archivedDetail = screen.getByRole('region', { name: '归档策略策略详情' })
    expect(within(archivedDetail).getByText('已归档').getAttribute('data-tone')).toBe('muted')
  })

  it('resets strategy keyboard navigation after close and announces zero results', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [
          { id: 'alpha', name: '首项策略', status: 'active', verification_status: 'passed' },
          { id: 'beta', name: '次项策略', status: 'active', verification_status: 'passed' },
        ] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    let search = await screen.findByRole('searchbox', { name: '搜索策略名称或标识' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /首项策略.*，推荐$/u }))
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' })

    fireEvent.click(trigger)
    search = await screen.findByRole('searchbox', { name: '搜索策略名称或标识' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /首项策略.*，推荐$/u }))
    fireEvent.change(search, { target: { value: '不存在的策略' } })
    const status = screen.getByRole('status')
    expect(within(status).getByText('没有匹配的策略')).toBeTruthy()
    expect(status.closest('[role="list"]')).toBeNull()
  })

  it('retains the confirmed value after save failure and retries the same target', async () => {
    let saveAttempts = 0
    let releaseFirstSave: (() => void) | undefined
    let resolveRetrySave: (() => void) | undefined
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve })
    const retrySaveGate = new Promise<void>((resolve) => { resolveRetrySave = resolve })
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.research-chat-context') return { exists: false, context: null }
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'retry', name: '重试策略', status: 'active', verification_status: 'passed' }] }
      }
      if (request.operation === 'trading-core.research-chat-context-save') {
        saveAttempts += 1
        if (saveAttempts === 1) {
          await firstSaveGate
          throw new Error('temporary failure')
        }
        await retrySaveGate
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
    fireEvent.click(await screen.findByRole('button', { name: /重试策略.*已启用/ }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认使用重试策略' })
    confirm.focus()
    fireEvent.click(confirm)
    await waitFor(() => { expect(confirm.disabled).toBe(true) })
    focusNativeDisabledFallback()
    releaseFirstSave?.()

    const retry = await screen.findByRole<HTMLButtonElement>('button', { name: '重试保存投研上下文' })
    expect(screen.getByRole('button', { name: '策略，当前：未选择' })).toBeTruthy()
    await waitFor(() => { expect(document.activeElement).toBe(retry) })
    focusNativeDisabledFallback()
    fireEvent.click(retry)
    resolveRetrySave?.()
    expect(await screen.findByRole('button', { name: /策略，当前：重试策略.*推荐/ })).toBeTruthy()
    expect(saveAttempts).toBe(2)
    expect(screen.queryByRole('dialog', { name: '选择投研策略' })).toBeNull()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /策略，当前：重试策略.*推荐/ }))
    })
  })

  it('does not restore focus after an external custom pointer target during the 409 refresh load', async () => {
    let loadAttempts = 0
    let resolveConflictRefresh: (() => void) | undefined
    const conflictRefreshGate = new Promise<void>((resolve) => { resolveConflictRefresh = resolve })
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.research-chat-context') {
        loadAttempts += 1
        if (loadAttempts === 1) return { exists: false, context: null }
        await conflictRefreshGate
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
    const view = renderControls(requestData)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '策略，当前：未选择' })
    await waitFor(() => { expect(trigger.disabled).toBe(false) })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /本地选择.*已启用/u }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认使用本地选择' })
    confirm.focus()
    fireEvent.click(confirm)
    await waitFor(() => { expect(loadAttempts).toBe(2) })
    focusNativeDisabledFallback()
    const outside = document.createElement('canvas')
    view.container.append(outside)
    fireEvent.pointerDown(outside)

    resolveConflictRefresh?.()

    expect(await screen.findByRole('button', { name: /策略，当前：其他窗口选择.*推荐/u })).toBeTruthy()
    expect(document.activeElement).toBe(document.body)
  })

  it('refreshes after 409 and never offers to replay the stale target', async () => {
    let loadAttempts = 0
    let rejectConflict: (() => void) | undefined
    const conflictGate = new Promise<void>((resolve) => { rejectConflict = resolve })
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
        await conflictGate
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
    fireEvent.click(await screen.findByRole('button', { name: /本地选择.*已启用/ }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认使用本地选择' })
    confirm.focus()
    fireEvent.click(confirm)
    await waitFor(() => { expect(confirm.disabled).toBe(true) })
    focusNativeDisabledFallback()
    rejectConflict?.()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('该会话已在其他位置更新，请重新选择。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试保存投研上下文' })).toBeNull()
    expect(await screen.findByRole('button', { name: /策略，当前：其他窗口选择.*推荐/ })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '选择投研策略' })).toBeNull()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /策略，当前：其他窗口选择.*推荐/ }))
    })
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
    expect(screen.queryByRole('option', { name: '清除标的' })).toBeNull()
    const input = screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' })
    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: '沪深300' } })
    await vi.advanceTimersByTimeAsync(180)
    vi.useRealTimers()
    const option = await screen.findByRole('option', { name: /沪深300ETF.*510300.*ETF/ })
    expect(option.getAttribute('aria-selected')).toBe('false')
    expect(option.tabIndex).toBe(-1)
    input.focus()
    expect(fireEvent.mouseDown(option)).toBe(false)
    expect(document.activeElement).toBe(input)
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
