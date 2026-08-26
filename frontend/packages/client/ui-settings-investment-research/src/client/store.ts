import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-investment-research-runtime/client'

/** Snapshot currency published by the injected Client facade. */
export type InvestmentReadinessSnapshot = ReturnType<
  ClientContext['investmentResearchRuntimeClient']['getSnapshot']
>

/** Restart acknowledgement currency published by the injected Client facade. */
export type InvestmentRestartResult = Awaited<ReturnType<
  ClientContext['investmentResearchRuntimeClient']['requestRestart']
>>

/** User-visible settlement of one explicit application restart request. */
export interface InvestmentRestartState {
  readonly status: 'idle' | 'pending' | 'accepted' | 'unavailable' | 'error'
  readonly reason?: string
}

/** User-visible lifecycle of the one UI-owned readiness refresh flight. */
export type InvestmentRefreshState = 'idle' | 'pending' | 'error'

/** Root-scoped interaction state; business readiness remains facade-owned. */
export interface InvestmentReadinessInteractionState {
  restart: InvestmentRestartState
  refresh: InvestmentRefreshState
}

type InvestmentReadinessInteractionActions = {
  beginRestart: (draft: InvestmentReadinessInteractionState) => void
  acceptRestart: (draft: InvestmentReadinessInteractionState) => void
  unavailableRestart: (draft: InvestmentReadinessInteractionState, reason: string) => void
  failRestart: (draft: InvestmentReadinessInteractionState) => void
  beginRefresh: (draft: InvestmentReadinessInteractionState) => void
  finishRefresh: (draft: InvestmentReadinessInteractionState) => void
  failRefresh: (draft: InvestmentReadinessInteractionState) => void
}

/**
 * Create the root-scoped restart-feedback store owned by the section entry.
 * @returns a fresh store handle whose instance survives section remounts.
 */
export function createInvestmentReadinessStore(): EngineStoreHandle<
  InvestmentReadinessInteractionState,
  InvestmentReadinessInteractionActions
> {
  return defineStore({
    init: (): InvestmentReadinessInteractionState => ({
      restart: { status: 'idle' },
      refresh: 'idle',
    }),
    actions: {
      beginRestart: (draft) => { draft.restart = { status: 'pending' } },
      acceptRestart: (draft) => { draft.restart = { status: 'accepted' } },
      unavailableRestart: (draft, reason: string) => {
        draft.restart = { status: 'unavailable', reason }
      },
      failRestart: (draft) => { draft.restart = { status: 'error' } },
      beginRefresh: (draft) => { draft.refresh = 'pending' },
      finishRefresh: (draft) => { draft.refresh = 'idle' },
      failRefresh: (draft) => { draft.refresh = 'error' },
    },
  })
}
