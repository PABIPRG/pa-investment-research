// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function installBrowserDoubles(mobile = false): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(max-width: 900px)' ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  })
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
  readonly requestData?: RequestData
}

function renderHarness(options: HarnessOptions = {}) {
  installBrowserDoubles(options.mobile)
  const prepareAssistant = vi.fn<(intent: AssistantIntent, module?: AssistantModule) => void>()
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
    const openAssistant = (intent: AssistantIntent, module: AssistantModule = 'general'): void => {
      prepareAssistant(intent, module)
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
      </>
    )
  }

  return { ...render(<Harness />), prepareAssistant, requestData }
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

  it('研究 expanded 时继续隐藏 AI launcher', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))

    fireEvent.click(screen.getByRole('button', { name: '展开研究窗' }))

    expect(screen.getByRole('dialog', { name: '贵州茅台证券研究窗' }).getAttribute('data-mode')).toBe('expanded')
    expect(screen.queryByRole('button', { name: '打开 AI 研究助理' })).toBeNull()
  })

  it('AI 已 expanded 时接管 initialQuery，最终只显示 docked 研究窗', async () => {
    renderHarness({ initial: { assistantMode: 'expanded', watchQuery: '600519' } })

    expect(await screen.findByRole('complementary', { name: '600519证券研究窗' })).toBeTruthy()
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()
  })

  it('扫描项直接智能分析创建该证券返回目标，显式返回 docked 后关闭会聚焦原按钮', async () => {
    const { prepareAssistant } = renderHarness()
    await waitForScan()

    const card = screen.getByRole('article', { name: '贵州茅台 600519' })
    const analyze = within(card).getByRole('button', { name: '智能分析' })
    analyze.focus()
    const focus = vi.spyOn(analyze, 'focus')
    focus.mockClear()
    fireEvent.click(analyze)

    expect(prepareAssistant).toHaveBeenCalledWith({ kind: 'stock', code: '600519', name: '贵州茅台' }, 'general')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' }).value).toContain('贵州茅台（600519）')
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    fireEvent.click(screen.getByRole('button', { name: '返回证券详情' }))
    expect(researchSurface('贵州茅台').getAttribute('data-mode')).toBe('docked')

    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    flushAnimationFrames()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(analyze)
  })

  it('已有研究窗时扫描项直接分析另一证券，直接关闭 AI 后恢复新证券 minimized', async () => {
    const { prepareAssistant } = renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))

    const nextCard = screen.getByRole('article', { name: '平安银行 000001' })
    const analyze = within(nextCard).getByRole('button', { name: '智能分析' })
    analyze.focus()
    const focus = vi.spyOn(analyze, 'focus')
    focus.mockClear()
    fireEvent.click(analyze)

    expect(prepareAssistant).toHaveBeenCalledWith({ kind: 'stock', code: '000001', name: '平安银行' }, 'general')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' }).value).toContain('平安银行（000001）')
    expect(screen.queryByRole('complementary', { name: '贵州茅台证券研究窗' })).toBeNull()
    expect(screen.getByRole('button', { name: '返回证券详情' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复平安银行研究窗' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗' }))
    flushAnimationFrames()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(analyze)
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

  it('研究进入 AI 后直接关闭恢复同一证券 minimized', async () => {
    renderHarness()
    await waitForScan()
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))

    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))

    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(screen.getByRole('button', { name: '恢复贵州茅台研究窗' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()
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
  ] as const)('移动端 expanded AI %s 后恢复 minimized 且不遗留 modal 资源', async (_, closerName) => {
    renderHarness({ mobile: true })
    await waitForScan()
    const workbench = document.querySelector('main')
    if (workbench === null) throw new Error('真实工作台不存在')
    fireEvent.click(screen.getByRole('button', { name: '打开贵州茅台研究' }))
    fireEvent.click(screen.getByRole('button', { name: '带入智能分析' }))
    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))
    expect(workbench.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: closerName }))

    expect(screen.getByRole('button', { name: '恢复贵州茅台研究窗' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开 AI 研究助理' }).dataset.placement).toBe('research-minimized')
    expect(document.body.style.overflow).toBe('')
    expect(workbench.hasAttribute('inert')).toBe(false)
    expect(workbench.hasAttribute('aria-hidden')).toBe(false)
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
