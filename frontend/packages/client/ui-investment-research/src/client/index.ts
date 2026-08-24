import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  InvestmentShell,
  InvestmentBrand,
  InvestmentNewSession,
  InvestmentWelcome,
  InvestmentSidebar,
  type InvestmentShellInjected,
  type InvestmentSidebarInjected,
} from './InvestmentShell.tsx'
import { InvestmentUiState, type InvestmentRoute } from './state.ts'

export { InvestmentBrand, InvestmentNewSession, InvestmentShell, InvestmentSidebar, InvestmentWelcome } from './InvestmentShell.tsx'
export type {
  InvestmentBrandProps,
  InvestmentNewSessionProps,
  InvestmentWelcomeProps,
  InvestmentShellInjected,
  InvestmentShellProps,
  InvestmentSidebarInjected,
  InvestmentSidebarProps,
} from './InvestmentShell.tsx'
export { InvestmentUiState } from './state.ts'
export type { InvestmentRoute, InvestmentUiSnapshot } from './state.ts'

/** Services required by the profile-scoped investment shell. */
export const inject = [
  'slots', 'sessions', 'workspaces', 'layout', 'conversation', 'investmentResearchRuntimeClient',
]

/** Mount the investment navigation and workbench without replacing the shared conversation surface. */
export function apply(ctx: ClientContext): void {
  const state = new InvestmentUiState()
  let cancelPendingDraft: (() => void) | undefined

  ctx.effect(() => {
    const previousTitle = document.title
    document.body.dataset.investmentResearchUi = ''
    document.title = '投研智能体'
    return () => {
      cancelPendingDraft?.()
      cancelPendingDraft = undefined
      delete document.body.dataset.investmentResearchUi
      document.title = previousTitle
    }
  }, 'ui-investment-research: profile marker')

  const navigate = (route: InvestmentRoute, stockQuery = ''): void => {
    state.navigate(route, stockQuery)
    if (route !== 'assistant') ctx.layout.closeDetails()
  }

  const setDraft = (sessionId: SessionId, prompt: string): boolean => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) return false
    ctx.conversation.input.for(scope).setDraft(prompt)
    return true
  }

  const prepareAssistant = (prompt: string): void => {
    navigate('assistant')
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
    ctx.workspaces.startSession()
    tryApply()
  }

  const shared = {
    hooks: { investmentUi: state },
    navigate,
  }

  const sidebarInjected = (): InvestmentSidebarInjected => ({
    ...shared,
    selectWorkspace: async (workspaceId: WorkspaceId) => {
      const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
      ctx.sessions.open(sessionId)
    },
  })

  const shellInjected = (): InvestmentShellInjected => ({
    ...shared,
    requestData: request => ctx.investmentResearchRuntimeClient.requestData(request),
    setHistory: (open) => { state.setHistory(open) },
    startSession: async () => {
      navigate('assistant')
      await ctx.workspaces.startFreshSession()
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

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'investment-research-shell',
    order: -100,
    inject: shellInjected,
  }, InvestmentShell))
}
