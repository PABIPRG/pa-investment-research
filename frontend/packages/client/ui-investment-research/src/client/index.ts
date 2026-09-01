import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  InvestmentShell,
  InvestmentBrand,
  InvestmentNewSession,
  InvestmentWelcome,
  InvestmentSidebar,
  assistantModulePrompt,
  type InvestmentShellInjected,
  type InvestmentSidebarInjected,
} from './InvestmentShell.tsx'
import {
  InvestmentComposerContextControls,
  type InvestmentComposerContextInjected,
} from './ResearchContextControls.tsx'
import { ResearchChatContextController } from './research-chat-context.ts'
import { assistantPrompt, type AssistantIntent } from './assistant-intent.ts'
import {
  createLocalTelemetry, type LocalTelemetryEvent, type LocalTelemetrySurface,
} from './telemetry.ts'
import {
  InvestmentUiState,
  type AssistantDisplayMode,
  type AssistantModule,
  type InvestmentDraftKey,
  type InvestmentNavigationContext,
  type InvestmentRoute,
} from './state.ts'

export {
  InvestmentBrand, InvestmentNewSession,
  InvestmentShell, InvestmentSidebar, InvestmentWelcome,
} from './InvestmentShell.tsx'
export { InvestmentComposerContextControls } from './ResearchContextControls.tsx'
export type {
  InvestmentAssistantModuleInjected,
  InvestmentAssistantModuleProps,
  InvestmentBrandProps,
  InvestmentNewSessionProps,
  InvestmentWelcomeProps,
  InvestmentShellInjected,
  InvestmentShellProps,
  InvestmentSidebarInjected,
  InvestmentSidebarProps,
} from './InvestmentShell.tsx'
export { ResearchChatContextController } from './research-chat-context.ts'
export type {
  ResearchChatContext, ResearchChatContextEntry, ResearchChatContextTarget,
  ResearchChatInstrument,
} from './research-chat-context.ts'
export { InvestmentUiState } from './state.ts'
export { assistantPrompt } from './assistant-intent.ts'
export type { AssistantIntent } from './assistant-intent.ts'
export { EvolutionDashboard } from './EvolutionDashboard.tsx'
export { StrategyEvolutionDiagnostics } from './StrategyEvolutionDiagnostics.tsx'
export type { EvolutionDashboardProps, EvolutionLifecycleGroup, EvolutionRequestData, StrategyEvolutionDiagnosticsProps } from './evolution-types.ts'
export type {
  AssistantDisplayMode, AssistantModule, InvestmentDraftKey, InvestmentNavigationContext,
  InvestmentRoute, InvestmentUiSnapshot, StrategyResearchStage,
} from './state.ts'

/** Services required by the profile-scoped investment shell. */
export const inject = [
  'slots', 'sessions', 'workspaces', 'layout', 'theme', 'conversation', 'investmentResearchRuntimeClient',
]

/** Mount the investment navigation and workbench without replacing the shared conversation surface. */
export function apply(ctx: ClientContext): void {
  const state = new InvestmentUiState()
  const requestData: InvestmentShellInjected['requestData'] = request => (
    ctx.investmentResearchRuntimeClient.requestData(request)
  )
  const researchChatContext = new ResearchChatContextController(requestData)
  const telemetry = createLocalTelemetry(requestData)
  let cancelPendingDraft: (() => void) | undefined

  ctx.effect(() => {
    const previousTitle = document.title
    const previousWorkspaceContextVisibility = document.body.dataset.workspaceContextVisibility
    document.body.dataset.investmentResearchUi = ''
    document.body.dataset.workspaceContextVisibility = 'hidden'
    document.title = '投研智能体'
    return () => {
      cancelPendingDraft?.()
      cancelPendingDraft = undefined
      delete document.body.dataset.investmentResearchUi
      if (previousWorkspaceContextVisibility === undefined) {
        delete document.body.dataset.workspaceContextVisibility
      } else {
        document.body.dataset.workspaceContextVisibility = previousWorkspaceContextVisibility
      }
      document.title = previousTitle
    }
  }, 'ui-investment-research: profile marker')

  ctx.effect(() => () => { researchChatContext.dispose() }, 'ui-investment-research: research chat context')

  // Workspace remains an internal session-grouping and tool-scope abstraction
  // in this product. On a truly empty first run, create one ordinary Session at
  // the Host cwd so the assistant is immediately usable without exposing
  // project-directory or Workspace mechanics anywhere in the product UI.
  ctx.effect(() => {
    let requested = false
    const ensureFirstSession = (): void => {
      if (requested) return
      const workspace = ctx.workspaces.list.getSnapshot()
      const sessions = ctx.sessions.list.getSnapshot()
      if (!workspace.baselinesReady || workspace.items.length > 0
        || sessions.current !== undefined || sessions.ids.length > 0) return
      requested = true
      void ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
        .catch((reason: unknown) => {
          console.warn('investment initial session failed:', reason)
        })
    }
    const stopWorkspaces = ctx.workspaces.list.subscribe(ensureFirstSession)
    const stopSessions = ctx.sessions.list.subscribe(ensureFirstSession)
    ensureFirstSession()
    return () => {
      stopWorkspaces()
      stopSessions()
    }
  }, 'ui-investment-research: implicit first session')

  const navigate = (route: InvestmentRoute, context: InvestmentNavigationContext = {}): void => {
    state.navigate(route, context)
    ctx.layout.closeDetails()
  }

  const setDraft = (sessionId: SessionId, prompt: string): boolean => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) return false
    ctx.conversation.input.for(scope).setDraft(prompt)
    return true
  }

  const applyModulePromptToBlankDraft = (module: AssistantModule): void => {
    const current = ctx.sessions.list.getSnapshot().current
    if (current === undefined) return
    const scope = ctx.sessions.scope(current)
    if (scope === undefined) return
    const input = ctx.conversation.input.for(scope)
    if (input.state.getSnapshot().draft.trim() !== '') return
    const prompt = assistantModulePrompt(module)
    if (prompt !== '') input.setDraft(prompt)
  }

  const selectAssistantModule = (module: AssistantModule): void => {
    state.setAssistantModule(module)
    applyModulePromptToBlankDraft(module)
  }

  const prepareAssistant = (intent: AssistantIntent, moduleOverride?: AssistantModule): void => {
    const currentRoute = state.getSnapshot().route
    const surface: LocalTelemetrySurface = currentRoute === 'stock-detail'
      ? 'stock_detail'
      : currentRoute === 'framework' || currentRoute === 'projects'
        ? 'strategy'
        : currentRoute === 'tasks'
          ? 'evolution'
          : currentRoute === 'knowledge'
            ? 'industry'
            : currentRoute === 'opportunity'
              ? 'opportunity'
              : currentRoute === 'portfolio'
                ? 'portfolio'
                : currentRoute === 'dashboard'
                  ? 'dashboard'
                  : 'assistant'
    const telemetryTarget: Pick<LocalTelemetryEvent, 'targetType' | 'targetId' | 'context'> = (() => {
      if (intent.kind === 'stock') {
        const code = intent.code.trim()
        return {
          targetType: 'security', targetId: code || 'unknown-security',
          context: { ...(code === '' ? {} : { ticker: code }), analysis_kind: 'stock' },
        }
      }
      if (intent.kind === 'portfolio') {
        return { targetType: 'portfolio', targetId: 'current-portfolio', context: { analysis_kind: 'portfolio' } }
      }
      if (intent.kind === 'watch') {
        const code = intent.code?.trim() ?? ''
        return {
          targetType: code === '' ? 'page' : 'security', targetId: code || 'market-overview',
          context: { ...(code === '' ? {} : { ticker: code }), analysis_kind: 'watch' },
        }
      }
      if (intent.kind === 'strategy' || intent.kind === 'shadow') {
        const strategyId = intent.strategyId?.trim() ?? ''
        return {
          targetType: 'strategy', targetId: strategyId || 'strategy-pool',
          context: { ...(strategyId === '' ? {} : { strategy_id: strategyId }), analysis_kind: intent.kind },
        }
      }
      if (intent.kind === 'evolution') {
        const strategyId = intent.strategyId?.trim() ?? ''
        return {
          targetType: 'strategy', targetId: strategyId || 'evolution-review',
          context: { ...(strategyId === '' ? {} : { strategy_id: strategyId }), analysis_kind: 'evolution' },
        }
      }
      if (intent.kind === 'reports') {
        return { targetType: 'report', targetId: intent.reportId?.trim() || 'report-center', context: { analysis_kind: 'reports' } }
      }
      if (intent.kind === 'industry') {
        return { targetType: 'industry', targetId: 'industry-context', context: { analysis_kind: 'industry' } }
      }
      return { targetType: 'page', targetId: 'assistant-prompt', context: { analysis_kind: 'prompt' } }
    })()
    void telemetry.track({ action: 'analyze', surface, ...telemetryTarget })
    const prompt = assistantPrompt(intent)
    const module: AssistantModule = moduleOverride ?? (intent.kind === 'stock' ? 'stock'
      : intent.kind === 'portfolio' ? 'portfolio'
        : intent.kind === 'strategy' || intent.kind === 'shadow' || intent.kind === 'evolution' ? 'strategy'
          : intent.kind === 'watch' ? 'watch'
            : intent.kind === 'industry' ? 'industry' : 'general')
    state.openAssistant(module)
    ctx.layout.closeDetails()
    const current = ctx.sessions.list.getSnapshot().current
    if (current !== undefined && setDraft(current, prompt)) return

    cancelPendingDraft?.()
    let settled = false
    let timer = 0
    let unsubscribe = (): void => {}
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      unsubscribe()
      cancelPendingDraft = undefined
    }
    const tryApply = (): void => {
      const next = ctx.sessions.list.getSnapshot().current
      if (next !== undefined && setDraft(next, prompt)) finish()
    }
    unsubscribe = ctx.sessions.list.subscribe(tryApply)
    timer = window.setTimeout(finish, 8_000)
    cancelPendingDraft = finish
    void ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
      .then(tryApply)
      .catch((reason: unknown) => {
        console.warn('investment assistant session failed:', reason)
        finish()
      })
    tryApply()
  }

  const shared = {
    hooks: { investmentUi: state },
    navigate,
  }

  const sidebarInjected = (): InvestmentSidebarInjected => shared

  const shellInjected = (): InvestmentShellInjected => ({
    ...shared,
    requestData,
    trackTelemetry: telemetry.track,
    setHistory: (open) => { state.setHistory(open) },
    setReports: (open) => { state.setReports(open) },
    setAssistantMode: (mode: AssistantDisplayMode) => { state.setAssistantMode(mode) },
    setAssistantModule: selectAssistantModule,
    setModuleDraft: (key: InvestmentDraftKey, value: string) => { state.setDraft(key, value) },
    selectStrategy: (strategyId) => { state.selectStrategy(strategyId) },
    startSession: async () => {
      cancelPendingDraft?.()
      cancelPendingDraft = undefined
      state.setAssistantModule('general')
      state.openAssistant('general')
      const fresh = await ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
      if (fresh !== undefined) setDraft(fresh, '')
    },
    openSession: async (sessionId) => {
      ctx.sessions.open(sessionId)
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`unknown session "${sessionId}"`)
      const session = binding.session
      const current = session.getSnapshot()
      if (current.openState === 'open') return
      if (current.openState === 'error') {
        throw new Error(current.openError?.message ?? 'session open failed')
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let unsubscribe = (): void => {}
        let timeout = 0
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          window.clearTimeout(timeout)
          unsubscribe()
          if (error === undefined) resolve()
          else reject(error)
        }
        const check = (): void => {
          const snapshot = session.getSnapshot()
          if (snapshot.openState === 'open') finish()
          else if (snapshot.openState === 'error') {
            finish(new Error(snapshot.openError?.message ?? 'session open failed'))
          }
        }
        unsubscribe = session.subscribe(check)
        timeout = window.setTimeout(() => { finish(new Error('session open timed out')) }, 20_000)
        check()
      })
    },
    searchSessions: async (query, signal) => {
      const result = await ctx.sessions.search(query, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value.items
    },
    renameSession: async (sessionId, title) => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    archiveSession: sessionId => ctx.workspaces.archiveSession(sessionId),
    prepareAssistant,
    toggleTheme: () => {
      const next = ctx.theme.getTheme().active.colorScheme === 'dark' ? 'light' : 'dark'
      ctx.theme.setTheme(next)
    },
  })

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -100,
    inject: sidebarInjected,
  }, InvestmentSidebar))

  ctx.slots.inject('sidebar.brand', () => ctx.slots.register({
    name: 'sidebar.brand',
    priority: -100,
  }, InvestmentBrand))

  ctx.slots.inject('sidebar.newSession', () => ctx.slots.register({
    name: 'sidebar.newSession',
    priority: -100,
  }, InvestmentNewSession))

  ctx.slots.inject('conversation.hero.welcome', () => ctx.slots.register({
    name: 'conversation.hero.welcome',
    priority: -100,
  }, InvestmentWelcome))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'investment-research-context',
    order: -100,
    inject: (): InvestmentComposerContextInjected => ({
      hooks: { investmentUi: state },
      setAssistantModule: selectAssistantModule,
      researchChatContext,
      requestData,
    }),
  }, InvestmentComposerContextControls))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'investment-research-shell',
    order: -100,
    inject: shellInjected,
  }, InvestmentShell))
}
