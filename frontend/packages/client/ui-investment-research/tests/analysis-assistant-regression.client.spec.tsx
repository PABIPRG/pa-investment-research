// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import packageManifest from '../package.json' with { type: 'json' }
import {
  InvestmentBrand, InvestmentPromptTemplateSelect, InvestmentShell, nextPromptTemplateDraft,
} from '../src/client/InvestmentShell.tsx'
import { AnalysisPromptTemplateController } from '../src/client/analysis-prompt-templates.ts'
import type { AnalysisPromptTemplateId } from '../src/client/analysis-modules.ts'
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
  delete document.body.dataset.investmentConversationPrimary
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
  const promptTemplates = new AnalysisPromptTemplateController()

  function Harness() {
    const [snapshot, setSnapshot] = useState(INITIAL)
    const [composerDraft, setComposerDraft] = useState('')
    const useInvestmentUi = <T,>(selector: (value: InvestmentUiSnapshot) => T): T => selector(snapshot)
    const setAssistantMode = (assistantMode: AssistantDisplayMode): void => {
      setSnapshot(current => ({ ...current, assistantMode }))
    }
    const openAssistant = async (intent: AssistantIntent, module?: AssistantModule): Promise<void> => {
      prepareAssistant(intent, module)
      const prompt = assistantPrompt(intent)
      setComposerDraft(prompt)
      if (intent.kind === 'prompt' && intent.promptTemplateId !== undefined) {
        promptTemplates.set('session-a', intent.promptTemplateId, prompt === '' ? undefined : prompt)
      }
      setSnapshot(current => ({
        ...current,
        assistantMode: current.assistantMode === 'closed' ? 'docked' : current.assistantMode,
        assistantModule: module ?? current.assistantModule,
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
          promptTemplates.set('session-a', 'general')
          setSnapshot(current => ({ ...current, assistantModule: 'general' }))
        }}
        openSession={() => Promise.resolve()}
        searchSessions={() => Promise.resolve([])}
        renameSession={() => Promise.resolve()}
        archiveSession={() => Promise.resolve()}
        prepareAssistant={openAssistant}
        toggleTheme={() => {}}
      />
      {createElement(InvestmentPromptTemplateSelect, {
        useInvestmentUi,
        promptTemplates,
        selectPromptTemplate: (
          sessionId: string,
          templateId: AnalysisPromptTemplateId,
          promptTemplate: string,
        ) => {
          const previous = promptTemplates.snapshot(sessionId)
          const nextDraft = nextPromptTemplateDraft(
            composerDraft,
            previous.automaticPrompt,
            promptTemplate,
          )
          if (nextDraft === undefined) return
          setComposerDraft(nextDraft)
          promptTemplates.set(
            sessionId,
            templateId,
            nextDraft === '' ? undefined : nextDraft,
          )
        },
        session: { sessionId: 'session-a', running: false },
        input: { phase: 'plain' },
      } as never)}
      <textarea
        aria-label="模型输入框"
        value={composerDraft}
        onChange={(event) => { setComposerDraft(event.target.value) }}
      />
      <button
        type="button"
        aria-label="测试路由到研究工作台"
        onClick={() => { setSnapshot(current => ({ ...current, route: 'dashboard' })) }}
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
  fireEvent.click(screen.getByRole('button', { name: /^提示词模板，当前：/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

describe('智能分析与全局 AI 助理回归', () => {
  it('提示词模板切换只替换自动内容，并允许回到开放式提问', () => {
    const stockPrompt = '个股模块自动提示'
    const briefPrompt = '市场简报模块自动提示'

    expect(nextPromptTemplateDraft('', undefined, stockPrompt)).toBe(stockPrompt)
    expect(nextPromptTemplateDraft(stockPrompt, stockPrompt, briefPrompt)).toBe(briefPrompt)
    expect(nextPromptTemplateDraft(briefPrompt, briefPrompt, '')).toBe('')
    expect(nextPromptTemplateDraft('我自己输入的研究问题', stockPrompt, briefPrompt)).toBeUndefined()
  })

  it('从研究工作台进入偏好复盘并返回工作台', async () => {
    const { requestData } = renderHarness(async (request) => {
      if (request.operation === 'trading-core.local-learning-review') {
        return {
          window_days: 7,
          status: { enabled: true, retention_days: 90, event_count: 0, feedback_count: 0 },
          enough_data: false,
          overview: {},
          funnel: {},
          insights: [],
          recent_activity: [],
          explicit_risk_profile: { key: 'balanced', label: '稳健型', behavior_adjustment: 0 },
        }
      }
      return defaultRequestData(request)
    })
    fireEvent.click(screen.getByRole('button', { name: '测试路由到研究工作台' }))
    const transition = await screen.findByTestId('dashboard-view-transition')
    expect(transition.getAttribute('data-view')).toBe('workbench')
    await waitFor(() => {
      expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.holdings')).toBe(true)
    })
    const initialHoldingsCalls = requestData.mock.calls.filter(
      ([request]) => request.operation === 'trading-core.holdings',
    ).length

    fireEvent.click(screen.getByRole('button', { name: '偏好复盘' }))
    expect(await screen.findByRole('heading', { name: '偏好复盘' })).toBeTruthy()
    expect(transition.getAttribute('data-view')).toBe('preferences')

    fireEvent.click(screen.getByRole('button', { name: '← 返回研究工作台' }))
    expect(screen.getByRole('heading', { name: '研究工作台' })).toBeTruthy()
    expect(transition.getAttribute('data-view')).toBe('workbench')
    expect(
      requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings'),
    ).toHaveLength(initialHoldingsCalls)
  })

  it('我的投研把共享对话设为主界面并提供会话与资料入口', () => {
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: '测试路由到我的投研' }))

    expect(document.body.dataset.investmentConversationPrimary).toBe('')
    expect(document.body.dataset.investmentWorkbenchActive).toBeUndefined()
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: '打开 AI 研究助理' })).toBeNull()
    expect(screen.getByRole('button', { name: '新对话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '历史对话' })).toBeTruthy()
    const materialsTrigger = screen.getByRole<HTMLButtonElement>('button', { name: '投研资料' })
    fireEvent.click(materialsTrigger)
    expect(screen.getByRole('dialog', { name: '投研资料' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭投研资料' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '投研资料' })).toBeNull()
    expect(document.activeElement).toBe(materialsTrigger)
  })

  it('在产品标识中展示当前候选版本', () => {
    render(createElement(InvestmentBrand, {
      compact: false,
      label: '投研智能体',
      startSession: vi.fn(),
    } as never))

    expect(screen.getByText(`${packageManifest.version} · 智能投研系统`)).toBeTruthy()
  })

  it('智能分析只展示能力介绍，并在助理模式切换时保留页面', () => {
    const { requestData } = renderHarness()

    const workbench = screen.getByTestId('analysis-workbench')
    expect(screen.getByRole('heading', { name: '智能分析' })).toBeTruthy()
    expect(workbench.querySelectorAll('article[data-analysis-module-id]')).toHaveLength(4)
    expect(within(workbench).getByText('17 个角色')).toBeTruthy()
    expect(within(workbench).queryByRole('textbox')).toBeNull()
    expect(within(workbench).queryByRole('combobox')).toBeNull()
    expect(within(workbench).queryByRole('button', { name: '开始个股分析' })).toBeNull()
    expect(within(workbench).queryByRole('button', { name: '运行历史回测' })).toBeNull()
    expect(requestData).not.toHaveBeenCalledWith(expect.objectContaining({
      operation: 'trading-core.holdings',
    }))

    fireEvent.click(assistantLauncher())
    const docked = screen.getByTestId('assistant-panel')
    expect(docked.getAttribute('data-mode')).toBe('docked')
    expect(screen.queryByRole('button', { name: '返回证券详情' })).toBeNull()
    expect(docked.querySelector('[data-icon="surface-expand"]')).toBeTruthy()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '近全屏展开 AI 助理' }))
    const expanded = screen.getByTestId('assistant-panel')
    expect(expanded.getAttribute('data-mode')).toBe('expanded')
    expect(expanded.getAttribute('role')).toBe('dialog')
    expect(expanded.querySelector('[data-icon="surface-collapse"]')).toBeTruthy()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '收起 AI 助理' }))
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 研究助理' }))
    expect(screen.queryByTestId('assistant-panel')).toBeNull()
    expect(assistantLauncher()).toBeTruthy()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()
  })

  it('智能分析普通入口创建空白对话，不注入隐藏模板', () => {
    const { prepareAssistant } = renderHarness()

    fireEvent.click(within(screen.getByTestId('analysis-workbench')).getByRole('button', {
      name: '打开 AI 研究助理',
    }))

    expect(prepareAssistant).toHaveBeenCalledWith({
      kind: 'prompt', prompt: '', promptTemplateId: 'general',
    }, undefined)
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
    expect(screen.queryByRole('button', { name: /恢复.*研究窗/u })).toBeNull()
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()
  })

  it('输入框工具栏的智能分析选择使用提示词模板，但不覆盖用户已有草稿', () => {
    renderHarness()
    fireEvent.click(assistantLauncher())
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' })
    fireEvent.change(composer, { target: { value: '请先比较供需拐点，再告诉我需要补充哪些证据。' } })

    chooseAssistantModule('市场简报')

    expect(screen.getByRole('button', { name: '提示词模板，当前：普通对话' })).toBeTruthy()
    expect(screen.queryByText('上下文由工具按需读取，输入框不会写入业务 JSON。')).toBeNull()
    expect(composer.value).toBe('请先比较供需拐点，再告诉我需要补充哪些证据。')
    expect(composer.value).not.toMatch(/[{}\[\]]/u)
  })

  it('新建对话清空已有草稿并重置到普通对话', async () => {
    const { startSession } = renderHarness()
    fireEvent.click(assistantLauncher())
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' })
    fireEvent.change(composer, { target: { value: '这段内容不能进入新对话' } })
    chooseAssistantModule('个股多智能体分析')

    fireEvent.click(screen.getByRole('button', { name: '新对话' }))

    await waitFor(() => { expect(startSession).toHaveBeenCalledOnce() })
    expect(composer.value).toBe('')
    expect(screen.getByRole('button', { name: '提示词模板，当前：普通对话' })).toBeTruthy()
  })

  it.each([
    ['stock', '个股多智能体分析'],
    ['portfolio', '持仓风险分析'],
    ['backtest', '历史决策回测'],
    ['brief', '市场简报'],
  ] as const)('模块 %s 的详情 CTA 以提示词模板打开普通 AI 对话且输入框不出现 JSON', (
    moduleId, moduleTitle,
  ) => {
    const { prepareAssistant } = renderHarness()
    const moduleCard = document.querySelector<HTMLElement>(`[data-analysis-module-id="${moduleId}"]`)
    if (moduleCard === null) {
      throw new Error(`智能分析模块 ${moduleId} 不存在`)
    }
    expect(within(moduleCard).getByRole('button', { name: '打开助理' })).toBeTruthy()
    fireEvent.click(within(moduleCard).getByRole('button', { name: '查看模块详情' }))

    const dialog = screen.getByRole('dialog', { name: moduleTitle })
    expect(within(dialog).getByTestId('expert-team')).toBeTruthy()
    const cta = within(dialog).getByRole('button', { name: '用此模块打开 AI 助理' })
    expect(cta.getAttribute('data-analysis-module-id')).toBe(moduleId)
    fireEvent.click(cta)

    expect(prepareAssistant).toHaveBeenCalledOnce()
    expect(prepareAssistant.mock.calls[0]?.[0]).toMatchObject({
      kind: 'prompt', promptTemplateId: moduleId,
    })
    expect(prepareAssistant.mock.calls[0]?.[1]).toBeUndefined()
    expect(screen.getByTestId('assistant-panel').getAttribute('data-mode')).toBe('docked')
    expect(screen.getByRole('button', { name: `提示词模板，当前：${moduleTitle}` })).toBeTruthy()

    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '模型输入框' })
    expect(composer.value).not.toBe('')
    expect(composer.value).not.toMatch(/[{}\[\]]/u)
    expect(composer.value).not.toMatch(/"(?:kind|ticker|strategy_id|report_id)"\s*:/u)
    expect(screen.getByTestId('analysis-workbench')).toBeTruthy()
  })
})
