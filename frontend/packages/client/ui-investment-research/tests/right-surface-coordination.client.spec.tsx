// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { InvestmentShell } from '../src/client/InvestmentShell.tsx'
import { assistantPrompt, type AssistantIntent } from '../src/client/assistant-intent.ts'
import type { RequestData } from '../src/client/research-types.ts'
import type {
  AssistantDisplayMode,
  AssistantModule,
  InvestmentUiSnapshot,
} from '../src/client/state.ts'

const STOCK_A = {
  code: '600519', name: '贵州茅台', price: 1500, pct_change: 1.25, volume_ratio: 1.6, amount_yi: 28,
}
const STOCK_B = {
  code: '000001', name: '平安银行', price: 11.2, pct_change: -0.4, volume_ratio: 0.9, amount_yi: 9,
}

const INITIAL: InvestmentUiSnapshot = {
  route: 'opportunity',
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
}

const SHELL_CSS = readFileSync(resolve(
  process.cwd(),
  'packages/client/ui-investment-research/src/client/InvestmentShell.module.css',
), 'utf8')

let rafId = 0
let rafCallbacks = new Map<number, FrameRequestCallback>()
let notifyResize: ResizeObserverCallback | undefined

interface BrowserDoubles {
  readonly setViewportWidth: (width: number) => void
}

function installBrowserDoubles(initialViewportWidth = 1280): BrowserDoubles {
  let viewportWidth = initialViewportWidth
  const mediaLists = new Map<string, MediaQueryList>()
  const mediaListeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>()
  const matches = (query: string): boolean => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/u.exec(query)
    return maxWidth === null ? false : viewportWidth <= Number(maxWidth[1])
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => {
      const existing = mediaLists.get(query)
      if (existing !== undefined) return existing
      const listeners = new Set<(event: MediaQueryListEvent) => void>()
      mediaListeners.set(query, listeners)
      const media = {
        get matches() { return matches(query) },
        media: query,
        onchange: null,
        addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener)
        }),
        removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener)
        }),
        addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener) }),
        removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener) }),
        dispatchEvent: vi.fn(() => true),
      } as unknown as MediaQueryList
      mediaLists.set(query, media)
      return media
    }),
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialViewportWidth })
  rafId = 0
  rafCallbacks = new Map()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafId += 1
    rafCallbacks.set(rafId, callback)
    return rafId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    rafCallbacks.delete(id)
  })
  class ResizeObserverHarness {
    constructor(callback: ResizeObserverCallback) { notifyResize = callback }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverHarness)
  return {
    setViewportWidth(width) {
      const previousMatches = new Map(
        [...mediaLists].map(([query]) => [query, matches(query)]),
      )
      viewportWidth = width
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
      window.dispatchEvent(new Event('resize'))
      for (const [query, media] of mediaLists) {
        const nextMatches = matches(query)
        if (previousMatches.get(query) === nextMatches) continue
        const event = { matches: nextMatches, media: query } as MediaQueryListEvent
        media.onchange?.call(media, event)
        for (const listener of mediaListeners.get(query) ?? []) listener(event)
      }
    },
  }
}

function flushAnimationFrames(): void {
  const callbacks = [...rafCallbacks.values()]
  rafCallbacks.clear()
  for (const callback of callbacks) callback(performance.now())
}

function defaultResponse(request: Parameters<RequestData>[0]): unknown {
  if (request.operation === 'market-watch.indices') return { items: [] }
  if (request.operation === 'market-watch.scan') return { items: [STOCK_A, STOCK_B] }
  if (request.operation === 'market-watch.tech-signal') {
    return {
      status: 'ready', code: request.input?.code ?? '', bars: 120, signals: [], indicators: {}, as_of: '2026-09-01T08:00:00Z',
    }
  }
  if (request.operation === 'market-watch.security-news') {
    return { status: 'ready', code: request.input?.code ?? '', items: [], as_of: '2026-09-01T08:00:00Z' }
  }
  if (request.operation === 'market-watch.security-search') return { items: [] }
  if (request.operation === 'trading-core.reports') return { items: [] }
  if (request.operation === 'trading-core.holdings') return { items: [] }
  return {}
}

interface HarnessOptions {
  readonly initial?: Partial<InvestmentUiSnapshot>
  readonly mobile?: boolean
  readonly viewportWidth?: number
  readonly requestData?: RequestData
  readonly prepareAssistantGate?: (intent: AssistantIntent, module: AssistantModule) => Promise<void>
}

function renderHarness(options: HarnessOptions = {}) {
  const browserDoubles = installBrowserDoubles(
    options.viewportWidth ?? (options.mobile === true ? 640 : 1280),
  )
  const prepareAssistant = vi.fn<(
    intent: AssistantIntent,
    module?: AssistantModule,
    sourceSurface?: 'floating' | 'primary',
  ) => void>()
  const requestData = vi.fn<RequestData>(options.requestData ?? (async request => defaultResponse(request)))
  const initial = { ...INITIAL, ...options.initial }

  function Harness() {
    const [snapshot, setSnapshot] = useState(initial)
    const [composerDraft, setComposerDraft] = useState('')
    const useInvestmentUi = <T,>(selector: (value: InvestmentUiSnapshot) => T): T => selector(snapshot)
    const useSessions = <T,>(selector: (value: unknown) => T): T => selector({
      ids: [], byId: {}, current: undefined,
    })
    const useWorkspaces = <T,>(selector: (value: unknown) => T): T => selector({ archivedSessionIds: [] })
    const setAssistantMode = (assistantMode: AssistantDisplayMode): void => {
      setSnapshot(current => ({ ...current, assistantMode }))
    }
    const openAssistant = async (
      intent: AssistantIntent,
      module: AssistantModule = 'general',
      sourceSurface?: 'floating' | 'primary',
    ): Promise<void> => {
      if (sourceSurface === undefined) prepareAssistant(intent, module)
      else prepareAssistant(intent, module, sourceSurface)
      await options.prepareAssistantGate?.(intent, module)
      setComposerDraft(assistantPrompt(intent))
      setSnapshot(current => ({
        ...current,
        assistantMode: current.assistantMode === 'closed' ? 'docked' : current.assistantMode,
        assistantModule: module,
      }))
    }

    return (
      <>
        <InvestmentShell
          useInvestmentUi={useInvestmentUi}
          useSessions={useSessions as never}
          useWorkspaces={useWorkspaces as never}
          requestData={requestData}
          trackTelemetry={vi.fn(async () => {})}
          navigate={(route, context = {}) => {
            setSnapshot(current => ({
              ...current,
              route: route === 'assistant' ? 'analysis' : route,
              selectedStockCode: context.stockCode ?? current.selectedStockCode,
              selectedStrategyId: context.strategyId ?? current.selectedStrategyId,
            }))
          }}
          setHistory={(historyOpen) => {
            setSnapshot(current => ({ ...current, historyOpen, reportsOpen: historyOpen ? false : current.reportsOpen }))
          }}
          setReports={(reportsOpen) => {
            setSnapshot(current => ({ ...current, reportsOpen, historyOpen: reportsOpen ? false : current.historyOpen }))
          }}
          setAssistantMode={setAssistantMode}
          setAssistantModule={(assistantModule) => {
            setSnapshot(current => ({ ...current, assistantModule }))
          }}
          setModuleDraft={(key, value) => { setSnapshot(current => ({ ...current, [key]: value })) }}
          selectStrategy={() => {}}
          startSession={() => Promise.resolve()}
          openSession={() => Promise.resolve()}
          searchSessions={() => Promise.resolve([])}
          renameSession={() => Promise.resolve()}
          archiveSession={() => Promise.resolve()}
          prepareAssistant={openAssistant}
          toggleTheme={() => {}}
        />
        <textarea aria-label="模型输入框" readOnly value={composerDraft} />
        <button
          type="button"
          aria-label="外部展开 AI"
          onClick={() => { setSnapshot(current => ({ ...current, assistantMode: 'expanded' })) }}
        />
        <button
          type="button"
          aria-label="外部打开 AI"
          onClick={() => { setSnapshot(current => ({ ...current, assistantMode: 'docked' })) }}
        />
        <button
          type="button"
          aria-label="同帧请求贵州茅台研究并重开 AI"
          onClick={() => {
            document.querySelector<HTMLButtonElement>('[aria-label="打开贵州茅台研究"]')?.click()
            setSnapshot(current => ({ ...current, assistantMode: 'expanded' }))
          }}
        />
        <button
          type="button"
          aria-label="外部关闭 AI"
          onClick={() => { setSnapshot(current => ({ ...current, assistantMode: 'closed' })) }}
        />
        <button
          type="button"
          aria-label="外部打开 600519 研究"
          onClick={() => { setSnapshot(current => ({ ...current, watchQuery: '600519' })) }}
        />
        <button
          type="button"
          aria-label="外部打开历史"
          onClick={() => { setSnapshot(current => ({ ...current, historyOpen: true })) }}
        />
        <button
          type="button"
          aria-label="外部打开报告"
          onClick={() => { setSnapshot(current => ({ ...current, reportsOpen: true })) }}
        />
        <button
          type="button"
          aria-label="外部进入我的投研"
          onClick={() => { setSnapshot(current => ({ ...current, route: 'portfolio' })) }}
        />
        <button
          type="button"
          aria-label="外部进入研究工作台"
          onClick={() => { setSnapshot(current => ({ ...current, route: 'dashboard' })) }}
        />
        <button
          type="button"
          aria-label="外部返回实时盯盘"
          onClick={() => { setSnapshot(current => ({ ...current, route: 'opportunity' })) }}
        />
      </>
    )
  }

  return { ...render(<Harness />), prepareAssistant, requestData, ...browserDoubles }
}

function operationCalls(requestData: ReturnType<typeof vi.fn<RequestData>>, operation: string) {
  return requestData.mock.calls.filter(([request]) => request.operation === operation)
}

async function waitForScan(hidden = false): Promise<void> {
  await screen.findByRole('button', { name: '打开贵州茅台研究', hidden })
}

function researchSurface(name: string): HTMLElement {
  return screen.getByRole('complementary', { name: `${name}证券研究窗` })
}

beforeEach(() => {
  document.body.style.overflow = ''
  document.body.removeAttribute('data-investment-assistant-mode')
  document.body.removeAttribute('data-investment-workbench-active')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rafCallbacks.clear()
  document.body.style.overflow = ''
  delete document.body.dataset.investmentAssistantMode
  delete document.body.dataset.investmentWorkbenchActive
})

describe('Shell 右侧表面协调', () => {
  it.each([
    ['桌面', false],
    ['移动', true],
  ] as const)('%s研究 docked 时隐藏 AI launcher，minimized 时以独立锚点重新显示', async (_, mobile) => {
    renderHarness({ mobile })
    await waitForScan()
    expect(screen.getByRole('button', { name: '打开 AI 研究助理' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(screen.queryByRole('button', { name: '打开 AI 研究助理' })).toBeNull()
    expect(screen.getByRole(mobile ? 'dialog' : 'complementary', { name: '贵州茅台证券研究窗' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '最小化研究窗' }))
    expect(screen.getByRole('button', { name: '恢复贵州茅台研究窗' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开 AI 研究助理' }).dataset.placement).toBe('research-minimized')
  })

  it('为 minimized launcher 在桌面、900px 和 420px 三档声明真实不重叠偏移', () => {
    const firstMediaStart = SHELL_CSS.search(/^@media\b/mu)
    const media900Start = SHELL_CSS.indexOf('@media (max-width: 900px)')
    const media680Start = SHELL_CSS.indexOf('@media (max-width: 680px)')
    const media420Start = SHELL_CSS.indexOf('@media (max-width: 420px)')
    expect(firstMediaStart).toBeGreaterThan(0)
    expect(media900Start).toBeGreaterThan(firstMediaStart)
    expect(media680Start).toBeGreaterThan(media900Start)
    expect(media420Start).toBeGreaterThan(media680Start)

    const desktop = SHELL_CSS.slice(0, firstMediaStart)
    const mobile900 = SHELL_CSS.slice(media900Start, media680Start)
    const mobile420 = SHELL_CSS.slice(media420Start)

    expect(desktop).toContain(".assistantLauncher[data-placement='research-minimized'] { right: max(24px, env(safe-area-inset-right)); bottom: calc(max(24px, env(safe-area-inset-bottom)) + 64px); }")
    expect(mobile900).toContain(".assistantLauncher[data-placement='research-minimized'] { right: max(14px, env(safe-area-inset-right)); bottom: calc(max(14px, env(safe-area-inset-bottom)) + 64px); }")
    expect(mobile420).toContain(".assistantLauncher[data-placement='research-minimized'] { right: max(14px, env(safe-area-inset-right)); bottom: calc(max(14px, env(safe-area-inset-bottom)) + 62px); }")
  })

  it('实时盯盘按工作区实际宽度收起资讯栏，避免侧栏挤压扫描卡片', () => {
    expect(SHELL_CSS).toContain('.pageScroll { container-type: inline-size;')
    expect(SHELL_CSS).toContain('@container (max-width: 860px)')
    expect(SHELL_CSS).toMatch(
      /@container \(max-width: 860px\)[\s\S]*?\.opportunityWorkspace \{ grid-template-columns: minmax\(0, 1fr\); \}/u,
    )
    expect(SHELL_CSS).toMatch(/@container \(max-width: 860px\)[\s\S]*?\.marketNewsRail \{ position: relative; top: auto;/u)
  })

  it('实时盯盘为 AI 受控让位，并在关闭后保留资讯实例和恢复焦点', async () => {
    const { requestData } = renderHarness()
    await waitForScan()
    await waitFor(() => {
      expect(operationCalls(requestData, 'market-watch.news-flash')).toHaveLength(1)
    })
    const root = screen.getByTestId('opportunity-root')
    const newsRail = screen.getByRole('complementary', { name: '市场资讯栏' })
    const launcher = screen.getByRole('button', { name: '打开 AI 研究助理' })

    fireEvent.click(launcher)
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy()
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')
    expect(newsRail.getAttribute('aria-hidden')).toBe('true')
    expect(newsRail.hasAttribute('inert')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))
    act(() => { flushAnimationFrames() })
    expect(root.getAttribute('data-assistant-layout')).toBe('closed')
    expect(newsRail.hasAttribute('aria-hidden')).toBe(false)
    expect(operationCalls(requestData, 'market-watch.news-flash')).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '打开 AI 研究助理' }))
  })

  it('实时盯盘为证券研究窗按同一实测宽度让位，切股时复用浮窗容器', async () => {
    renderHarness({ viewportWidth: 1202 })
    await waitForScan()
    const root = screen.getByTestId('opportunity-root')
    const newsRail = screen.getByRole('complementary', { name: '市场资讯栏' })
    const widthAnchor = newsRail.lastElementChild
    if (!(widthAnchor instanceof HTMLElement)) throw new Error('研究窗宽度锚点不存在')
    vi.spyOn(widthAnchor, 'getBoundingClientRect').mockReturnValue({
      x: 804,
      y: 210,
      width: 366,
      height: 640,
      top: 210,
      right: 1170,
      bottom: 850,
      left: 804,
      toJSON: () => ({}),
    })

    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    const firstSurface = researchSurface('贵州茅台')
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')
    expect(root.style.getPropertyValue('--investment-right-surface-width')).toBe('min(366px, 42vw)')
    expect(firstSurface.style.getPropertyValue('--investment-research-surface-width')).toBe('min(366px, 42vw)')

    fireEvent.click(screen.getByRole('button', { name: '打开平安银行研究' }))
    const nextSurface = researchSurface('平安银行')
    expect(nextSurface).toBe(firstSurface)
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')
    expect(root.style.getPropertyValue('--investment-right-surface-width')).toBe('min(366px, 42vw)')
  })

  it('证券研究窗在 1023px 内切换为遮罩，回到桌面后恢复让位布局', async () => {
    const { setViewportWidth } = renderHarness({ viewportWidth: 1202 })
    await waitForScan()
    const root = screen.getByTestId('opportunity-root')
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')

    act(() => { setViewportWidth(1023) })
    expect(await screen.findByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeTruthy()
    expect(root.getAttribute('data-assistant-layout')).toBe('overlay')

    act(() => { setViewportWidth(1024) })
    expect(await screen.findByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeTruthy()
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')
  })

  it('切换左侧功能模块会关闭研究窗并清除回到实时盯盘后的自动恢复状态', async () => {
    renderHarness({ initial: { watchQuery: '600519' } })
    expect(await screen.findByRole('complementary', { name: '600519证券研究窗' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '外部进入研究工作台' }))
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '600519证券研究窗' })).toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: '外部返回实时盯盘' }))
    await waitForScan()
    expect(screen.queryByRole('complementary', { name: '600519证券研究窗' })).toBeNull()
    expect(screen.getByTestId('opportunity-root').getAttribute('data-assistant-layout')).toBe('closed')
  })

  it('切换左侧功能模块会关闭 AI 小窗', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开 AI 研究助理' }))
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '外部进入研究工作台' }))
    await waitFor(() => { expect(screen.queryByTestId('assistant-panel')).toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: '外部返回实时盯盘' }))
    await waitForScan()
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
  })

  it('异步创建 AI 会话期间切换左侧功能模块，不会在完成后重新打开旧模块小窗', async () => {
    let releaseAssistant: (() => void) | undefined
    const assistantGate = new Promise<void>((resolve) => { releaseAssistant = resolve })
    const { prepareAssistant } = renderHarness({ prepareAssistantGate: () => assistantGate })
    await waitForScan()

    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))
    expect(prepareAssistant).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '外部进入研究工作台' }))
    expect(screen.getByRole('heading', { name: '研究工作台' })).toBeTruthy()

    await act(async () => {
      releaseAssistant?.()
      await assistantGate
    })

    await waitFor(() => { expect(screen.queryByTestId('assistant-panel')).toBeNull() })
    expect(screen.getByRole('heading', { name: '研究工作台' })).toBeTruthy()
  })

  it('旧模块异步请求完成时保留新模块由用户手动打开的 AI 小窗', async () => {
    let releaseAssistant: (() => void) | undefined
    const assistantGate = new Promise<void>((resolve) => { releaseAssistant = resolve })
    renderHarness({ prepareAssistantGate: () => assistantGate })
    await waitForScan()

    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))
    fireEvent.click(screen.getByRole('button', { name: '外部进入研究工作台' }))
    fireEvent.click(screen.getByRole('button', { name: '打开 AI 研究助理' }))
    expect(screen.getByTestId('assistant-panel')).toBeTruthy()

    await act(async () => {
      releaseAssistant?.()
      await assistantGate
    })

    await waitFor(() => { expect(screen.getByTestId('assistant-panel')).toBeTruthy() })
    expect(screen.getByRole('heading', { name: '研究工作台' })).toBeTruthy()
  })

  it('跨模块后可重新发起同一分析，旧请求完成时保持收窗直到新请求就绪', async () => {
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    let invocation = 0
    const { prepareAssistant } = renderHarness({
      prepareAssistantGate: () => {
        invocation += 1
        return invocation === 1 ? firstGate : secondGate
      },
    })
    await waitForScan()

    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))
    fireEvent.click(screen.getByRole('button', { name: '外部进入研究工作台' }))
    fireEvent.click(screen.getByRole('button', { name: '外部返回实时盯盘' }))
    await waitForScan()
    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))

    await act(async () => {
      releaseFirst?.()
      await firstGate
    })
    await waitFor(() => { expect(prepareAssistant).toHaveBeenCalledTimes(2) })
    expect(screen.queryByTestId('assistant-panel')).toBeNull()

    await act(async () => {
      releaseSecond?.()
      await secondGate
    })
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' }).value)
      .toContain('贵州茅台（600519）')
  })

  it('实时盯盘只在 680px 内将 docked AI 升级为遮罩，并随视口动态恢复让位布局', async () => {
    const { setViewportWidth } = renderHarness({ viewportWidth: 820 })
    await waitForScan()
    const root = screen.getByTestId('opportunity-root')
    const workbench = document.querySelector('main')
    const newsRail = screen.getByRole('complementary', { name: '市场资讯栏' })
    const outsideModal = screen.getByRole('button', { name: '投研报告' })
    if (workbench === null) throw new Error('真实工作台不存在')

    fireEvent.click(screen.getByRole('button', { name: '打开 AI 研究助理' }))

    expect(await screen.findByRole('complementary', { name: 'AI 研究助理' })).toBeTruthy()
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')
    expect(document.querySelector('[class*="assistantBackdrop"]')).toBeNull()
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
    expect(newsRail.hasAttribute('inert')).toBe(true)
    expect(newsRail.getAttribute('aria-hidden')).toBe('true')

    act(() => { setViewportWidth(640) })

    const modal = await screen.findByRole('dialog', { name: 'AI 研究助理' })
    const modalControls = within(modal).getAllByRole('button')
    for (const control of modalControls) {
      Object.defineProperty(control, 'offsetParent', { configurable: true, get: () => modal })
    }
    outsideModal.focus()
    act(() => { flushAnimationFrames() })
    expect(document.activeElement).toBe(modalControls[0])
    expect(root.getAttribute('data-assistant-layout')).toBe('overlay')
    expect(document.querySelector('[class*="assistantBackdrop"]')).toBeTruthy()
    expect(workbench.hasAttribute('inert')).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')

    outsideModal.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(modalControls[0])

    act(() => { setViewportWidth(681) })

    expect(await screen.findByRole('complementary', { name: 'AI 研究助理' })).toBeTruthy()
    expect(root.getAttribute('data-assistant-layout')).toBe('docked')
    expect(document.querySelector('[class*="assistantBackdrop"]')).toBeNull()
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))
    expect(screen.getByRole('dialog', { name: 'AI 研究助理' }).getAttribute('aria-modal')).toBe('true')
    expect(document.querySelector('[class*="assistantBackdrop"]')).toBeTruthy()
    expect(workbench.hasAttribute('inert')).toBe(true)
  })

  it('实时盯盘按容器宽度切换紧凑密度', async () => {
    renderHarness()
    await waitForScan()
    const root = screen.getByTestId('opportunity-root')
    expect(root.getAttribute('data-density')).toBe('comfortable')

    act(() => {
      notifyResize?.([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(root.getAttribute('data-density')).toBe('compact')
  })

  it('研究 expanded 时继续隐藏 AI launcher', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))

    fireEvent.click(screen.getByRole('button', { name: '近全屏展开研究窗' }))

    expect(screen.getByRole('dialog', { name: '贵州茅台证券研究窗' }).getAttribute('data-mode')).toBe('expanded')
    expect(screen.queryByRole('button', { name: '打开 AI 研究助理' })).toBeNull()
  })

  it('AI 已 expanded 时接管 initialQuery，最终只显示 docked 研究窗', async () => {
    renderHarness({ initial: { assistantMode: 'expanded', watchQuery: '600519' } })

    expect(await screen.findByRole('complementary', { name: '600519证券研究窗' })).toBeTruthy()
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()
  })

  it('进入实时盯盘时不把历史选股自动打开为研究窗', async () => {
    renderHarness({ initial: { selectedStockCode: '600519' } })
    await waitForScan()

    expect(screen.queryByRole('complementary', { name: '600519证券研究窗' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开贵州茅台研究' }).hasAttribute('aria-current')).toBe(false)
    expect(screen.getByRole('button', { name: '打开 AI 研究助理' })).toBeTruthy()
  })

  it('扫描项直接智能分析不创建隐藏研究窗或恢复入口', async () => {
    const { prepareAssistant } = renderHarness()
    await waitForScan()

    const card = screen.getByRole('article', { name: '贵州茅台 600519' })
    const analyze = within(card).getByRole('button', { name: '智能分析' })
    fireEvent.click(analyze)
    await screen.findByTestId('assistant-panel')

    expect(prepareAssistant).toHaveBeenCalledWith({ kind: 'stock', code: '600519', name: '贵州茅台' }, 'general')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' }).value).toContain('贵州茅台（600519）')
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))
    expect(screen.queryByRole('button', { name: '恢复贵州茅台研究窗' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeNull()
  })

  it('不同证券的智能分析在首个会话创建中会排队，不静默丢弃后续意图', async () => {
    let releaseFirst: (() => void) | undefined
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const { prepareAssistant } = renderHarness({
      prepareAssistantGate: intent => intent.kind === 'stock' && intent.code === '600519'
        ? firstPending
        : Promise.resolve(),
    })
    await waitForScan()

    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))
    fireEvent.click(within(screen.getByRole('article', { name: '平安银行 000001' }))
      .getByRole('button', { name: '智能分析' }))

    expect(prepareAssistant).toHaveBeenCalledOnce()
    releaseFirst?.()
    await waitFor(() => {
      expect(prepareAssistant).toHaveBeenCalledTimes(2)
    })
    expect(prepareAssistant).toHaveBeenLastCalledWith(
      { kind: 'stock', code: '000001', name: '平安银行' },
      'general',
      'floating',
    )
  })

  it('排队意图在等待期间切换左侧模块后整体失效，不把旧请求带入新模块', async () => {
    let releaseFirst: (() => void) | undefined
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const { prepareAssistant } = renderHarness({
      prepareAssistantGate: intent => intent.kind === 'stock' && intent.code === '600519'
        ? firstPending
        : Promise.resolve(),
    })
    await waitForScan()

    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))
    fireEvent.click(within(screen.getByRole('article', { name: '平安银行 000001' }))
      .getByRole('button', { name: '智能分析' }))
    fireEvent.click(screen.getByRole('button', { name: '外部进入我的投研' }))
    await act(async () => {
      releaseFirst?.()
      await firstPending
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新对话' }).getAttribute('aria-busy')).toBe('false')
    })
    expect(prepareAssistant).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
  })

  it('首个排队意图失败后，后续成功意图会清除旧错误并正常展示', async () => {
    let rejectFirst: ((reason: Error) => void) | undefined
    const firstPending = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    renderHarness({
      prepareAssistantGate: intent => intent.kind === 'stock' && intent.code === '600519'
        ? firstPending
        : Promise.resolve(),
    })
    await waitForScan()

    fireEvent.click(within(screen.getByRole('article', { name: '贵州茅台 600519' }))
      .getByRole('button', { name: '智能分析' }))
    fireEvent.click(within(screen.getByRole('article', { name: '平安银行 000001' }))
      .getByRole('button', { name: '智能分析' }))
    rejectFirst?.(new Error('create failed'))

    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' }).value).toContain('平安银行（000001）')
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('已有研究窗时扫描项直接分析另一证券，关闭 AI 后不暂存任一研究窗', async () => {
    const { prepareAssistant } = renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))

    const nextCard = screen.getByRole('article', { name: '平安银行 000001' })
    const analyze = within(nextCard).getByRole('button', { name: '智能分析' })
    fireEvent.click(analyze)
    await screen.findByTestId('assistant-panel')

    expect(prepareAssistant).toHaveBeenCalledWith({ kind: 'stock', code: '000001', name: '平安银行' }, 'general')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' }).value).toContain('平安银行（000001）')
    expect(screen.queryByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeNull()
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))
    expect(screen.queryByRole('button', { name: '恢复平安银行研究窗' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复贵州茅台研究窗' })).toBeNull()
  })

  it('研究进入 AI 后显式返回同一证券 docked，先展示旧值并后台刷新已完成资源', async () => {
    const { requestData } = renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(researchSurface('贵州茅台')).toBeTruthy()
    await waitFor(() => {
      expect(operationCalls(requestData, 'market-watch.tech-signal')).toHaveLength(1)
      expect(operationCalls(requestData, 'market-watch.security-news')).toHaveLength(1)
    })

    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    await screen.findByRole('button', { name: '返回证券详情' })
    expect(screen.queryByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeNull()
    expect(screen.getByRole('button', { name: '返回证券详情' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '返回证券详情' }))
    expect(researchSurface('贵州茅台').getAttribute('data-mode')).toBe('docked')
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    await waitFor(() => {
      expect(operationCalls(requestData, 'market-watch.tech-signal')).toHaveLength(2)
      expect(operationCalls(requestData, 'market-watch.security-news')).toHaveLength(2)
    })
  })

  it('研究进入 AI 后直接关闭自动恢复同一证券 docked', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    await screen.findByRole('button', { name: '返回证券详情' })

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))

    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(researchSurface('贵州茅台').getAttribute('data-mode')).toBe('docked')
    expect(screen.queryByRole('button', { name: '恢复贵州茅台研究窗' })).toBeNull()
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()
  })

  it.each([
    ['显式返回', '返回证券详情'],
    ['直接关闭', '关闭 AI 研究助理'],
  ] as const)('研究进入 AI 后%s时保留原先实测宽度', async (_, closerName) => {
    renderHarness({ viewportWidth: 1202 })
    await waitForScan()
    const root = screen.getByTestId('opportunity-root')
    const newsRail = screen.getByRole('complementary', { name: '市场资讯栏' })
    const widthAnchor = newsRail.lastElementChild
    if (!(widthAnchor instanceof HTMLElement)) throw new Error('研究窗宽度锚点不存在')
    vi.spyOn(widthAnchor, 'getBoundingClientRect').mockReturnValue({
      x: 804,
      y: 210,
      width: 366,
      height: 640,
      top: 210,
      right: 1170,
      bottom: 850,
      left: 804,
      toJSON: () => ({}),
    })

    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(researchSurface('贵州茅台').style.getPropertyValue('--investment-research-surface-width'))
      .toBe('min(366px, 42vw)')
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    await screen.findByRole('button', { name: '返回证券详情' })

    fireEvent.click(screen.getByRole('button', { name: closerName }))

    await waitFor(() => {
      expect(researchSurface('贵州茅台').style.getPropertyValue('--investment-research-surface-width'))
        .toBe('min(366px, 42vw)')
    })
    expect(root.style.getPropertyValue('--investment-right-surface-width')).toBe('min(366px, 42vw)')
  })

  it('切换证券时更新主题与触发元素所有权，不展示旧证券数据', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(researchSurface('贵州茅台')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开贵州茅台研究' }).getAttribute('aria-current')).toBe('true')

    const nextTrigger = screen.getByRole('button', { name: '打开平安银行研究' })
    fireEvent.click(nextTrigger)
    expect(researchSurface('平安银行')).toBeTruthy()
    expect(nextTrigger.getAttribute('aria-current')).toBe('true')
    expect(screen.queryByText('贵州茅台证券研究窗')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    flushAnimationFrames()
    expect(document.activeElement).toBe(nextTrigger)
  })

  it('查看完整证券详情时关闭研究窗，返回实时盯盘后只重新打开研究而不循环导航', async () => {
    const { requestData } = renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    await waitFor(() => {
      expect(operationCalls(requestData, 'market-watch.tech-signal')).toHaveLength(1)
    })

    fireEvent.click(screen.getByRole('button', { name: '查看证券详情' }))
    expect(screen.getByRole('button', { name: '返回实时盯盘' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '返回实时盯盘' }))
    expect(await screen.findByRole('complementary', { name: '600519证券研究窗' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '实时盯盘' })).toBeTruthy()
    await waitFor(() => {
      expect(operationCalls(requestData, 'market-watch.tech-signal')).toHaveLength(2)
    })
  })

  it('外部 assistantMode transition 也不会让 AI 与研究窗同屏', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(researchSurface('贵州茅台')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '外部打开 AI' }))

    expect(screen.getByTestId('assistant-panel')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeNull()
  })

  it('同帧外部 reopen 覆盖研究关闭请求后，后续关闭不会恢复旧证券并清理 modal 资源', async () => {
    renderHarness({ mobile: true, initial: { assistantMode: 'expanded' } })
    await waitForScan(true)
    const workbench = document.querySelector('main')
    if (workbench === null) throw new Error('真实工作台不存在')

    fireEvent.click(screen.getByRole('button', { name: '同帧请求贵州茅台研究并重开 AI' }))
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('expanded')
    expect(screen.queryByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '外部关闭 AI' }))

    expect(screen.queryByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复贵州茅台研究窗' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开 AI 研究助理' }).dataset.placement).toBe('default')
    expect(document.body.style.overflow).toBe('')
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
  })

  it.each([
    ['历史对话', '外部打开历史'],
    ['投研报告', '投研报告'],
  ] as const)('%s 打开时优先处理 Escape，底层研究窗保持 docked', async (dialogName, openerName) => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    fireEvent.click(screen.getByRole('button', { name: openerName }))
    expect(await screen.findByRole('dialog', { name: dialogName })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })

    expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull()
    expect(researchSurface('贵州茅台').getAttribute('data-mode')).toBe('docked')
  })

  it.each([
    ['历史对话', '外部打开历史'],
    ['投研报告', '外部打开报告'],
  ] as const)('移动端 %s 保持底层研究 modal lease，关闭上层后再完整释放', async (dialogName, openerName) => {
    renderHarness({ mobile: true })
    await waitForScan()
    const pageScroll = screen.getByRole('heading', { name: '实时盯盘' }).parentElement?.parentElement?.parentElement
    const workbench = document.querySelector('main')
    if (pageScroll === undefined || pageScroll === null || workbench === null) {
      throw new Error('真实工作台或页面滚动容器不存在')
    }
    pageScroll.scrollTop = 219
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.inert).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: openerName }))
    expect(await screen.findByRole('dialog', { name: dialogName })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.inert).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')
    expect(pageScroll.scrollTop).toBe(219)

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull()
    const research = screen.getByRole('dialog', { name: '贵州茅台证券研究窗' })
    expect(research).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.inert).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')
    expect(pageScroll.scrollTop).toBe(219)
    flushAnimationFrames()
    expect(research.contains(document.activeElement)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    expect(document.body.style.overflow).toBe('')
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
    expect(pageScroll.scrollTop).toBe(219)
  })

  it('移动端 expanded AI 显式返回通过两阶段交接保持研究背景锁并最终恢复', async () => {
    renderHarness({ mobile: true })
    await waitForScan()
    const pageScroll = screen.getByRole('heading', { name: '实时盯盘' }).parentElement?.parentElement?.parentElement
    const workbench = document.querySelector('main')
    if (pageScroll === undefined || pageScroll === null || workbench === null) {
      throw new Error('真实工作台或页面滚动容器不存在')
    }
    pageScroll.scrollTop = 271
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    await screen.findByRole('button', { name: '返回证券详情' })
    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))

    fireEvent.click(screen.getByRole('button', { name: '返回证券详情' }))
    expect(screen.getByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.inert).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')
    expect(pageScroll.scrollTop).toBe(271)

    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    expect(document.body.style.overflow).toBe('')
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
    expect(pageScroll.scrollTop).toBe(271)
  })

  it('移动端初始 expanded AI 与 initialQuery 交接后不会留下背景锁基线', async () => {
    renderHarness({ mobile: true, initial: { assistantMode: 'expanded', watchQuery: '600519' } })
    const workbench = document.querySelector('main')
    if (workbench === null) throw new Error('真实工作台不存在')

    expect(await screen.findByRole('dialog', { name: '600519证券研究窗' })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.inert).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    expect(document.body.style.overflow).toBe('')
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
  })

  it.each([
    ['直接关闭', '关闭 AI 研究助理'],
    ['外部关闭', '外部关闭 AI'],
  ] as const)('移动端 expanded AI %s 后自动恢复研究窗且不遗留 AI modal 资源', async (_, closerName) => {
    renderHarness({ mobile: true })
    await waitForScan()
    const workbench = document.querySelector('main')
    if (workbench === null) throw new Error('真实工作台不存在')
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    await screen.findByRole('button', { name: '返回证券详情' })
    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))
    expect(workbench.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: closerName }))

    expect(screen.queryByRole('button', { name: '恢复贵州茅台研究窗' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.inert).toBe(true)
    expect(workbench.getAttribute('aria-hidden')).toBe('true')
  })

  it('移动端完整往返保留滚动、锁与原触发焦点，AI 切换时不抢回背景', async () => {
    renderHarness({ mobile: true })
    await waitForScan()
    const trigger = screen.getByRole('button', { name: '打开贵州茅台研究' })
    const pageScroll = screen.getByRole('heading', { name: '实时盯盘' }).parentElement?.parentElement?.parentElement
    const workbench = document.querySelector('main')
    if (pageScroll === undefined || pageScroll === null || workbench === null) {
      throw new Error('真实工作台或页面滚动容器不存在')
    }
    pageScroll.scrollTop = 173
    trigger.focus()

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(workbench.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    await screen.findByRole('button', { name: '返回证券详情' })
    flushAnimationFrames()
    expect(document.activeElement).not.toBe(trigger)
    expect(screen.getByTestId('assistant-panel')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '返回证券详情' }))
    expect(screen.getByRole('dialog', { name: '贵州茅台证券研究窗' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    expect(document.body.style.overflow).toBe('')
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
    expect(pageScroll.scrollTop).toBe(173)
    expect(document.activeElement).not.toBe(trigger)

    flushAnimationFrames()
    expect(document.activeElement).toBe(trigger)
  })

  it('移动端从最小化恢复后关闭时聚焦原触发器且不滚动背景列表', async () => {
    renderHarness({ mobile: true })
    await waitForScan()
    const trigger = screen.getByRole('button', { name: '打开贵州茅台研究' })
    const pageScroll = screen.getByRole('heading', { name: '实时盯盘' }).parentElement?.parentElement?.parentElement
    if (pageScroll === undefined || pageScroll === null) {
      throw new Error('页面滚动容器不存在')
    }

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '最小化研究窗' }))
    flushAnimationFrames()
    pageScroll.scrollTop = 159

    fireEvent.click(screen.getByRole('button', { name: '恢复贵州茅台研究窗' }))
    const research = screen.getByRole('dialog', { name: '贵州茅台证券研究窗' })
    research.scrollTop = 650
    const focus = vi.spyOn(trigger, 'focus').mockImplementation((options?: FocusOptions) => {
      HTMLElement.prototype.focus.call(trigger, options)
      if (options?.preventScroll !== true) pageScroll.scrollTop = 727
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    expect(document.body.style.overflow).toBe('')
    expect(pageScroll.scrollTop).toBe(159)

    flushAnimationFrames()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(trigger)
    expect(pageScroll.scrollTop).toBe(159)
  })
})
