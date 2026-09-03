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
  nextPromptTemplateDraft,
  type InvestmentShellInjected,
  type InvestmentSidebarInjected,
} from './InvestmentShell.tsx'
import {
  InvestmentComposerContextControls,
  type InvestmentComposerContextInjected,
} from './ResearchContextControls.tsx'
import { ResearchChatContextController } from './research-chat-context.ts'
import { AnalysisPromptTemplateController } from './analysis-prompt-templates.ts'
import type { AnalysisPromptTemplateId } from './analysis-modules.ts'
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
export { AnalysisPromptTemplateController } from './analysis-prompt-templates.ts'
export type { AnalysisPromptTemplateId } from './analysis-modules.ts'
export type { AnalysisPromptTemplateSnapshot } from './analysis-prompt-templates.ts'
export type {
  ResearchChatContext, ResearchChatContextEntry, ResearchChatContextTarget,
  ResearchChatInstrument,
} from './research-chat-context.ts'
export { InvestmentUiState } from './state.ts'
export { assistantPrompt } from './assistant-intent.ts'
export type { AssistantIntent } from './assistant-intent.ts'
export { EvolutionDashboard } from './EvolutionDashboard.tsx'
export { StrategyEvolutionDiagnostics } from './StrategyEvolutionDiagnostics.tsx'
export { evolutionConfidenceLabel, evolutionParticipationLabel } from './evolution-types.ts'
export type {
  EvolutionDashboardProps, EvolutionLifecycleGroup, EvolutionRequestData,
  EvolutionStrategyStatus, StrategyEvolutionDiagnosticsProps,
} from './evolution-types.ts'
export type {
  AssistantDisplayMode, AssistantModule, InvestmentDraftKey, InvestmentNavigationContext,
  InvestmentRoute, InvestmentUiSnapshot, StrategyResearchStage,
} from './state.ts'

/** Services required by the profile-scoped investment shell. */
export const inject = [
  'slots', 'sessions', 'workspaces', 'layout', 'theme', 'conversation', 'investmentResearchRuntimeClient',
]

function assistantModuleForIntent(intent: AssistantIntent): AssistantModule {
  if (intent.kind === 'stock') return 'stock'
  if (intent.kind === 'portfolio') return 'portfolio'
  if (intent.kind === 'strategy' || intent.kind === 'shadow' || intent.kind === 'evolution') return 'strategy'
  if (intent.kind === 'watch') return 'watch'
  if (intent.kind === 'industry') return 'industry'
  return 'general'
}

type InvestmentNavigationModule = Exclude<InvestmentRoute, 'stock-detail' | 'assistant' | 'projects'>

function navigationModule(route: InvestmentRoute): InvestmentNavigationModule {
  if (route === 'stock-detail') return 'opportunity'
  if (route === 'assistant') return 'analysis'
  if (route === 'projects') return 'framework'
  return route
}

/** Mount the investment navigation and workbench without replacing the shared conversation surface. */
export function apply(ctx: ClientContext): void {
  const state = new InvestmentUiState()
  const requestData: InvestmentShellInjected['requestData'] = request => (
    ctx.investmentResearchRuntimeClient.requestData(request)
  )
  const researchChatContext = new ResearchChatContextController(requestData)
  const promptTemplates = new AnalysisPromptTemplateController()
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

  ctx.effect(() => () => { promptTemplates.dispose() }, 'ui-investment-research: analysis prompt templates')

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

  const setDraft = (sessionId: SessionId, prompt: string): boolean => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) return false
    ctx.conversation.input.for(scope).setDraft(prompt)
    return true
  }

  const openConversationSession = async (sessionId: SessionId): Promise<void> => {
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
  }

  let floatingAssistantSessionId: SessionId | undefined
  let primaryAssistantSessionId: SessionId | undefined
  let activeConversationSurface: 'floating' | 'primary' = 'floating'
  let navigationGeneration = 0
  let floatingSessionResetRequired = false
  let floatingResetPromise: Promise<SessionId> | undefined
  let conversationSwitchRunning = false
  let pendingNavigation: {
    readonly generation: number
    readonly route: InvestmentRoute
    readonly context: InvestmentNavigationContext
    readonly surface: 'floating' | 'primary'
  } | undefined

  const sessionForSurface = (surface: 'floating' | 'primary'): SessionId | undefined => (
    surface === 'primary' ? primaryAssistantSessionId : floatingAssistantSessionId
  )

  const rememberSurfaceSession = (surface: 'floating' | 'primary', sessionId: SessionId): void => {
    if (surface === 'primary') primaryAssistantSessionId = sessionId
    else floatingAssistantSessionId = sessionId
  }

  const resetFloatingConversation = (): Promise<SessionId> => {
    if (floatingResetPromise !== undefined) return floatingResetPromise
    const previousSessionId = ctx.sessions.list.getSnapshot().current
    const operation = (async (): Promise<SessionId> => {
      try {
        const fresh = await ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
        if (fresh === undefined || !setDraft(fresh, '')) {
          throw new Error('investment floating conversation session is unavailable')
        }
        floatingAssistantSessionId = fresh
        promptTemplates.set(String(fresh), 'general')
        floatingSessionResetRequired = false
        return fresh
      } catch (reason) {
        if (previousSessionId !== undefined
          && ctx.sessions.list.getSnapshot().current !== previousSessionId) {
          try {
            await openConversationSession(previousSessionId)
          } catch (restoreReason) {
            console.warn('investment floating conversation restore failed:', restoreReason)
          }
        }
        throw reason
      }
    })()
    floatingResetPromise = operation
    void operation.then(
      () => { if (floatingResetPromise === operation) floatingResetPromise = undefined },
      () => { if (floatingResetPromise === operation) floatingResetPromise = undefined },
    )
    return operation
  }

  const restoreActiveSurfaceAfter = async (
    sourceSurface: 'floating' | 'primary',
    sourceSessionId: SessionId,
  ): Promise<void> => {
    rememberSurfaceSession(sourceSurface, sourceSessionId)
    if (activeConversationSurface === sourceSurface) return
    const activeSessionId = sessionForSurface(activeConversationSurface)
    if (activeSessionId !== undefined && ctx.sessions.list.getSnapshot().current !== activeSessionId) {
      await openConversationSession(activeSessionId)
    }
  }

  const ensureConversationSurface = async (nextSurface: 'floating' | 'primary'): Promise<void> => {
    let target = sessionForSurface(nextSurface)
    const current = ctx.sessions.list.getSnapshot().current
    if (nextSurface !== activeConversationSurface && current !== undefined && current !== target) {
      rememberSurfaceSession(activeConversationSurface, current)
    }

    if (nextSurface === 'floating' && floatingSessionResetRequired) {
      await resetFloatingConversation()
      return
    }

    if (target !== undefined) {
      if (current !== target) await openConversationSession(target)
      return
    }

    if (nextSurface === 'floating') {
      if (current !== undefined) floatingAssistantSessionId = current
      return
    }

    target = await ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
    if (target === undefined || !setDraft(target, '')) {
      throw new Error('investment primary conversation session is unavailable')
    }
    primaryAssistantSessionId = target
  }

  const flushPendingNavigation = (): void => {
    if (conversationSwitchRunning) return
    conversationSwitchRunning = true
    void (async () => {
      while (pendingNavigation !== undefined) {
        const request = pendingNavigation
        pendingNavigation = undefined
        let surfaceReady = true
        try {
          await ensureConversationSurface(request.surface)
        } catch (reason) {
          console.warn('investment conversation surface switch failed:', reason)
          surfaceReady = false
        }
        if (!surfaceReady && request.surface === 'primary') {
          continue
        }
        if (request.generation !== navigationGeneration) continue
        activeConversationSurface = request.surface
        state.navigate(request.route, request.context)
        ctx.layout.closeDetails()
      }
    })().finally(() => {
      conversationSwitchRunning = false
      if (pendingNavigation !== undefined) flushPendingNavigation()
    })
  }

  const navigate = (route: InvestmentRoute, context: InvestmentNavigationContext = {}): void => {
    const generation = ++navigationGeneration
    const nextSurface = route === 'portfolio' ? 'primary' : 'floating'
    const nextNavigationModule = navigationModule(route)
    const moduleChanged = navigationModule(state.getSnapshot().route) !== nextNavigationModule
    if (nextSurface === 'floating' && moduleChanged) {
      floatingSessionResetRequired = true
      cancelPendingDraft?.()
      cancelPendingDraft = undefined
      state.setAssistantMode('closed')
      state.setAssistantModule('general')
    }
    if (!conversationSwitchRunning
      && nextSurface === activeConversationSurface
      && !floatingSessionResetRequired) {
      state.navigate(route, context)
      ctx.layout.closeDetails()
      return
    }
    pendingNavigation = { generation, route, context, surface: nextSurface }
    flushPendingNavigation()
  }

  const selectPromptTemplate = (
    sessionId: string,
    templateId: AnalysisPromptTemplateId,
    prompt: string,
  ): void => {
    const scope = ctx.sessions.scope(sessionId as SessionId)
    if (scope === undefined) return
    const input = ctx.conversation.input.for(scope)
    const currentDraft = input.state.getSnapshot().draft
    const previous = promptTemplates.snapshot(sessionId)
    const nextDraft = nextPromptTemplateDraft(currentDraft, previous.automaticPrompt, prompt)
    if (nextDraft === undefined) return
    input.setDraft(nextDraft)
    promptTemplates.set(sessionId, templateId, nextDraft === '' ? undefined : nextDraft)
  }

  const applyModulePromptToBlankDraft = (module: AssistantModule): void => {
    const current = ctx.sessions.list.getSnapshot().current
    if (current === undefined) return
    const scope = ctx.sessions.scope(current)
    if (scope === undefined) return
    const input = ctx.conversation.input.for(scope)
    if (input.state.getSnapshot().draft.trim() !== '') return
    const prompt = assistantModulePrompt(module)
    if (prompt !== '') {
      input.setDraft(prompt)
      promptTemplates.set(String(current), 'general', prompt)
    }
  }

  const selectAssistantModule = (module: AssistantModule): void => {
    state.setAssistantModule(module)
    applyModulePromptToBlankDraft(module)
  }

  const prepareAssistant = async (
    intent: AssistantIntent,
    moduleOverride?: AssistantModule,
    sourceSurfaceOverride?: 'floating' | 'primary',
  ): Promise<void> => {
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
    const module: AssistantModule = intent.kind === 'prompt' && intent.promptTemplateId !== undefined
      ? 'general'
      : moduleOverride ?? assistantModuleForIntent(intent)
    cancelPendingDraft?.()
    cancelPendingDraft = undefined
    const sourceSurface = sourceSurfaceOverride ?? activeConversationSurface
    const fresh = await ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
    if (fresh === undefined || !setDraft(fresh, prompt)) {
      throw new Error('investment assistant fresh session is unavailable')
    }
    promptTemplates.set(
      String(fresh),
      intent.kind === 'prompt' && intent.promptTemplateId !== undefined
        ? intent.promptTemplateId
        : 'general',
      prompt === '' ? undefined : prompt,
    )
    await restoreActiveSurfaceAfter(sourceSurface, fresh)
    if (activeConversationSurface === sourceSurface) {
      state.openAssistant(module)
      ctx.layout.closeDetails()
    }
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
    setAssistantMode: (mode: AssistantDisplayMode) => {
      if (mode === 'closed' || activeConversationSurface !== 'floating' || !floatingSessionResetRequired) {
        state.setAssistantMode(mode)
        return
      }
      const generation = navigationGeneration
      void resetFloatingConversation()
        .then(async (sessionId) => {
          await restoreActiveSurfaceAfter('floating', sessionId)
          if (generation === navigationGeneration && activeConversationSurface === 'floating') {
            state.setAssistantMode(mode)
          }
        })
        .catch((reason: unknown) => {
          console.warn('investment floating conversation retry failed:', reason)
        })
    },
    setAssistantModule: selectAssistantModule,
    setModuleDraft: (key: InvestmentDraftKey, value: string) => { state.setDraft(key, value) },
    selectStrategy: (strategyId) => { state.selectStrategy(strategyId) },
    startSession: async () => {
      const sourceSurface = activeConversationSurface
      cancelPendingDraft?.()
      cancelPendingDraft = undefined
      state.setAssistantModule('general')
      state.openAssistant('general')
      const fresh = await ctx.workspaces.startFreshSession(undefined, { fallbackToHostCwd: true })
      if (fresh !== undefined) {
        setDraft(fresh, '')
        promptTemplates.set(String(fresh), 'general')
        await restoreActiveSurfaceAfter(sourceSurface, fresh)
      }
    },
    openSession: async (sessionId) => {
      const sourceSurface = activeConversationSurface
      const sourceSessionId = ctx.sessions.list.getSnapshot().current
      try {
        await openConversationSession(sessionId)
        await restoreActiveSurfaceAfter(sourceSurface, sessionId)
      } catch (reason) {
        const restoreSessionId = activeConversationSurface === sourceSurface
          ? sourceSessionId
          : sessionForSurface(activeConversationSurface)
        if (restoreSessionId !== undefined && ctx.sessions.list.getSnapshot().current !== restoreSessionId) {
          try {
            await openConversationSession(restoreSessionId)
          } catch (restoreReason) {
            console.warn('investment conversation session restore failed:', restoreReason)
          }
        }
        throw reason
      }
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
    archiveSession: async (sessionId) => {
      await ctx.workspaces.archiveSession(sessionId)
      promptTemplates.delete(String(sessionId))
    },
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
      promptTemplates,
      selectPromptTemplate,
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
