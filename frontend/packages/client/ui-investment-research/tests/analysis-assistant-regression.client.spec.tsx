// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  InvestmentAssistantModuleSelect, InvestmentBrand, InvestmentShell,
} from '../src/client/InvestmentShell.tsx'
import { assistantPrompt, type AssistantIntent } from '../src/client/assistant-intent.ts'
import type {
  AssistantDisplayMode,
  AssistantModule,
  InvestmentUiSnapshot,
} from '../src/client/state.ts'

afterEach(() => {
  cleanup()
  delete document.body.dataset.investmentAssistantMode
  delete document.body.dataset.investmentWorkbenchActive
})

const INITIAL: InvestmentUiSnapshot = {
  route: 'analysis',
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

const neverGlobalHook = (() => {
  throw new Error('global hook is not used in this regression harness')
}) as never

async function defaultRequestData(request: { operation: string }): Promise<unknown> {
  if (request.operation === 'trading-core.holdings') return { items: [] }
  if (request.operation === 'market-watch.security-search') return { items: [] }
  return {}
}

function renderHarness(
  requestDataImplementation: (request: { operation: string }) => Promise<unknown> = defaultRequestData,
) {
  const prepareAssistant = vi.fn<(intent: AssistantIntent, module?: AssistantModule) => void>()
  const startSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const requestData = vi.fn(requestDataImplementation)

  function Harness() {
    const [snapshot, setSnapshot] = useState(INITIAL)
    const [composerDraft, setComposerDraft] = useState('')
    const useInvestmentUi = <T,>(selector: (value: InvestmentUiSnapshot) => T): T => selector(snapshot)
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

    return <>
      <InvestmentShell
        useInvestmentUi={useInvestmentUi}
        useSessions={neverGlobalHook}
        useWorkspaces={neverGlobalHook}
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
        setHistory={(historyOpen) => { setSnapshot(current => ({ ...current, historyOpen })) }}
        setReports={(reportsOpen) => { setSnapshot(current => ({ ...current, reportsOpen })) }}
        setAssistantMode={setAssistantMode}
        setAssistantModule={(assistantModule) => {
          setSnapshot(current => ({ ...current, assistantModule }))
        }}
        setModuleDraft={(key, value) => { setSnapshot(current => ({ ...current, [key]: value })) }}
        selectStrategy={() => {}}
        startSession={async () => {
          await startSession()
          setComposerDraft('')
          setSnapshot(current => ({ ...current, assistantModule: 'general' }))
        }}
        openSession={() => Promise.resolve()}
        searchSessions={() => Promise.resolve([])}
        renameSession={() => Promise.resolve()}
        archiveSession={() => Promise.resolve()}
        prepareAssistant={openAssistant}
        toggleTheme={() => {}}
      />
      {createElement(InvestmentAssistantModuleSelect, {
        useInvestmentUi,
        setAssistantModule: (assistantModule: AssistantModule) => {
          setSnapshot(current => ({ ...current, assistantModule }))
        },
      } as never)}
      <textarea
        aria-label="模型输入框"
        value={composerDraft}
        onChange={(event) => { setComposerDraft(event.target.value) }}
      />
      <button
        type="button"
        aria-label="测试路由到我的投研"
        onClick={() => { setSnapshot(current => ({ ...current, route: 'portfolio' })) }}
      />
      <button
        type="button"
        aria-label="测试路由到智能分析"
        onClick={() => { setSnapshot(current => ({ ...current, route: 'analysis' })) }}
      />
    </>
  }

  return { ...render(<Harness />), prepareAssistant, requestData, startSession }
}

function assistantLauncher(): HTMLButtonElement {
  const launcher = document.querySelector<HTMLButtonElement>('[data-action="assistant-open"]')
  if (launcher === null) {
    throw new Error('AI 研究助理浮动入口不存在')
  }
  return launcher
}

function chooseAssistantModule(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: /^研究模块，当前：/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

describe('智能分析与全局 AI 助理回归', () => {
  it('在产品标识中展示当前候选版本', () => {
    render(createElement(InvestmentBrand, {
      compact: false,
      label: '投研智能体',
      startSession: vi.fn(),
    } as never))

    expect(screen.getByText('0.1.0-rc.8 · 智能投研系统')).toBeTruthy()
  })

  it('始终保留结构化智能分析工作台，并在助理模式切换时保留两份业务输入', () => {
    renderHarness()

    const workbench = screen.getByTestId('analysis-workbench')
    expect(screen.getByRole('heading', { name: '智能分析' })).toBeTruthy()
    expect(workbench.querySelectorAll('[data-analysis-module-id]')).toHaveLength(4)
    expect(within(workbench).getByText('17 个角色')).toBeTruthy()

    const stockInput = screen.getByRole<HTMLInputElement>('textbox', { name: '个股分析股票代码' })
    const backtestInput = screen.getByRole<HTMLInputElement>('textbox', { name: '历史回测股票代码' })
    const depthInput = screen.getByRole<HTMLSelectElement>('combobox', { name: '研究深度' })
    const windowInput = screen.getByRole<HTMLSelectElement>('combobox', { name: '前瞻窗口' })
    fireEvent.change(stockInput, { target: { value: '600519' } })
    fireEvent.change(backtestInput, { target: { value: '000001' } })
    fireEvent.change(depthInput, { target: { value: 'deep' } })
    fireEvent.change(windowInput, { target: { value: '60' } })

    fireEvent.click(assistantLauncher())
    const docked = screen.getByTestId('assistant-panel')
    expect(docked.getAttribute('data-mode')).toBe('docked')
    expect(docked.querySelector('[data-icon="assistant-expand"]')).toBeTruthy()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))
    const expanded = screen.getByTestId('assistant-panel')
    expect(expanded.getAttribute('data-mode')).toBe('expanded')
    expect(expanded.getAttribute('role')).toBe('dialog')
    expect(expanded.querySelector('[data-icon="assistant-collapse"]')).toBeTruthy()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '收起 AI 助理' }))
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(assistantLauncher()).toBeTruthy()

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '个股分析股票代码' }).value).toBe('600519')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '历史回测股票代码' }).value).toBe('000001')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '研究深度' }).value).toBe('deep')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '前瞻窗口' }).value).toBe('60')
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()
  })

  it('路由往返后保留智能分析的股票、回测及表单配置', () => {
    renderHarness()
    fireEvent.change(screen.getByRole('textbox', { name: '个股分析股票代码' }), {
      target: { value: '600519' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: '历史回测股票代码' }), {
      target: { value: '000001' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: '研究深度' }), {
      target: { value: 'full' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: '风险画像' }), {
      target: { value: 'aggressive' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: '前瞻窗口' }), {
      target: { value: '60' },
    })

    fireEvent.click(screen.getByRole('button', { name: '测试路由到我的投研' }))
    expect(screen.getByTestId('analysis-workbench').parentElement?.hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '测试路由到智能分析' }))
    expect(screen.getByTestId('analysis-workbench').parentElement?.hidden).toBe(false)

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '个股分析股票代码' }).value).toBe('600519')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '历史回测股票代码' }).value).toBe('000001')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '研究深度' }).value).toBe('full')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '风险画像' }).value).toBe('aggressive')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '前瞻窗口' }).value).toBe('60')
  })

  it('路由往返后保留已经完成的智能分析任务状态与报告入口', async () => {
    renderHarness(async (request) => {
      if (request.operation === 'trading-core.holdings') return { items: [{ code: '600519' }] }
      if (request.operation === 'trading-core.analyze') return { task_id: 'analysis-task-1' }
      if (request.operation === 'trading-core.task-status') return { status: 'done' }
      if (request.operation === 'trading-core.task-result') return { report_id: 'report-analysis-1' }
      return {}
    })
    fireEvent.change(screen.getByRole('textbox', { name: '个股分析股票代码' }), {
      target: { value: '600519' },
    })
    fireEvent.click(screen.getByRole('button', { name: '开始个股分析' }))
    expect((await screen.findAllByText('报告 report-analysis-1 已生成。')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '测试路由到我的投研' }))
    fireEvent.click(screen.getByRole('button', { name: '测试路由到智能分析' }))

    expect(screen.getAllByText('报告 report-analysis-1 已生成。').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '查看投研报告' }).length).toBeGreaterThan(0)
  })

  it('Escape 从 expanded 退回 docked，再从 docked 关闭', () => {
    renderHarness()
    fireEvent.click(assistantLauncher())
    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(assistantLauncher()).toBeTruthy()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()
  })

  it('输入框工具栏的模块选择改变研究角色，但不覆盖用户已有草稿', () => {
    renderHarness()
    fireEvent.click(assistantLauncher())
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' })
    fireEvent.change(composer, { target: { value: '请先比较供需拐点，再告诉我需要补充哪些证据。' } })

    chooseAssistantModule('产业链研究专家')

    expect(screen.getByRole('button', { name: '研究模块，当前：产业链研究专家' })).toBeTruthy()
    expect(screen.queryByText('上下文由工具按需读取，输入框不会写入业务 JSON。')).toBeNull()
    expect(screen.getByText('行业景气 · 上下游 · 影响传导')).toBeTruthy()
    expect(composer.value).toBe('请先比较供需拐点，再告诉我需要补充哪些证据。')
    expect(composer.value).not.toMatch(/[{}\[\]]/u)
  })

  it('新建对话清空已有草稿并重置到通用研究模块', async () => {
    const { startSession } = renderHarness()
    fireEvent.click(assistantLauncher())
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' })
    fireEvent.change(composer, { target: { value: '这段内容不能进入新对话' } })
    chooseAssistantModule('个股研究专家')

    fireEvent.click(screen.getByRole('button', { name: '新对话' }))

    await waitFor(() => { expect(startSession).toHaveBeenCalledOnce() })
    expect(composer.value).toBe('')
    expect(screen.getByRole('button', { name: '研究模块，当前：通用研究' })).toBeTruthy()
  })

  it('持仓摘要不可用时禁止提交持仓分析任务', async () => {
    const { requestData } = renderHarness(async (request) => {
      if (request.operation === 'trading-core.holdings') throw new Error('backend unavailable')
      return {}
    })

    expect(await screen.findByText('持仓摘要暂不可用，请先恢复数据连接后再运行分析。')).toBeTruthy()
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '分析持仓风险' })
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(requestData).not.toHaveBeenCalledWith(expect.objectContaining({
      operation: 'trading-core.holdings-analyze',
    }))
  })

  it.each([
    ['stock', '个股多智能体分析', 'stock', '个股研究专家'],
    ['portfolio', '持仓风险分析', 'portfolio', '组合风控专家'],
    ['backtest', '历史决策回测', 'strategy', '策略验证专家'],
    ['brief', '市场简报', 'watch', '实时盯盘专家'],
  ] as const)('模块 %s 的详情 CTA 打开对应 AI 模块且输入框不出现 JSON', (
    moduleId, moduleTitle, assistantModule, assistantLabel,
  ) => {
    const { prepareAssistant } = renderHarness()
    const moduleCard = document.querySelector<HTMLElement>(`[data-analysis-module-id="${moduleId}"]`)
    if (moduleCard === null) {
      throw new Error(`智能分析模块 ${moduleId} 不存在`)
    }
    fireEvent.click(within(moduleCard).getByRole('button', { name: '查看模块详情' }))

    const dialog = screen.getByRole('dialog', { name: moduleTitle })
    expect(within(dialog).getByTestId('expert-team')).toBeTruthy()
    const cta = within(dialog).getByRole('button', { name: '用此模块打开 AI 助理' })
    expect(cta.getAttribute('data-analysis-module-id')).toBe(moduleId)
    fireEvent.click(cta)

    expect(prepareAssistant).toHaveBeenCalledOnce()
    expect(prepareAssistant.mock.calls[0]?.[1]).toBe(assistantModule)
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    expect(screen.getByRole('button', { name: `研究模块，当前：${assistantLabel}` })).toBeTruthy()

    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' })
    expect(composer.value).not.toBe('')
    expect(composer.value).not.toMatch(/[{}\[\]]/u)
    expect(composer.value).not.toMatch(/"(?:kind|ticker|strategy_id|report_id)"\s*:/u)
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()
  })
})
