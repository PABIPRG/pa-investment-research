import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { EvolutionLifecycleGroup } from './evolution-types.ts'

export type InvestmentRoute =
  | 'dashboard'
  | 'analysis'
  /** @deprecated Compatibility alias. New navigation must use `analysis`. */
  | 'assistant'
  | 'opportunity'
  | 'stock-detail'
  | 'portfolio'
  | 'framework'
  | 'projects'
  | 'tasks'
  | 'knowledge'

export type AssistantDisplayMode = 'closed' | 'docked' | 'expanded'
export type AssistantModule = 'general' | 'stock' | 'industry' | 'portfolio' | 'strategy' | 'watch'
export type StrategyResearchStage = 'form' | 'backtest' | 'shadow' | 'evolution'

export interface InvestmentUiSnapshot {
  readonly route: InvestmentRoute
  readonly historyOpen: boolean
  readonly reportsOpen: boolean
  readonly assistantMode: AssistantDisplayMode
  readonly assistantModule: AssistantModule
  /** Drafts intentionally stay independent so typing in one module cannot mutate another. */
  readonly analysisQuery: string
  readonly backtestQuery: string
  readonly watchQuery: string
  readonly chainQuery: string
  readonly selectedStockCode: string
  readonly selectedStrategyId: string
  /** Always populated by InvestmentUiState; optional for legacy snapshot providers. */
  readonly strategyResearchStage?: StrategyResearchStage
  /** Always populated by InvestmentUiState; optional for legacy snapshot providers. */
  readonly evolutionReturnGroup?: EvolutionLifecycleGroup
}

export type InvestmentDraftKey = 'analysisQuery' | 'backtestQuery' | 'watchQuery' | 'chainQuery'

export interface InvestmentNavigationContext {
  readonly stockCode?: string
  readonly strategyId?: string
  readonly strategyStage?: StrategyResearchStage
  readonly evolutionReturnGroup?: EvolutionLifecycleGroup
}

const INITIAL: InvestmentUiSnapshot = Object.freeze({
  route: 'dashboard',
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
  strategyResearchStage: 'form',
  evolutionReturnGroup: '',
})

/** One profile-local navigation source shared by the sidebar and overlay surfaces. */
export class InvestmentUiState implements HostObservable<InvestmentUiSnapshot> {
  private snapshot = INITIAL
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): InvestmentUiSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  navigate(route: InvestmentRoute, context: InvestmentNavigationContext = {}): void {
    const nextRoute = route === 'assistant' ? 'analysis' : route
    this.publish({
      ...this.snapshot,
      route: nextRoute,
      historyOpen: false,
      reportsOpen: false,
      selectedStockCode: context.stockCode ?? this.snapshot.selectedStockCode,
      // Entering the shadow workbench from the sidebar means "all active
      // strategies". Only the deliberate lifecycle hand-off carries a
      // concrete strategy id; a stale candidate selected while backtesting
      // must never leak into paper validation.
      selectedStrategyId: context.strategyId
        ?? (nextRoute === 'projects' ? '' : this.snapshot.selectedStrategyId),
      strategyResearchStage: context.strategyStage
        ?? (nextRoute === 'framework' ? 'form' : this.snapshot.strategyResearchStage ?? 'form'),
      evolutionReturnGroup: context.evolutionReturnGroup ?? this.snapshot.evolutionReturnGroup ?? '',
    })
  }

  setAssistantMode(mode: AssistantDisplayMode): void {
    this.publish({ ...this.snapshot, assistantMode: mode })
  }

  setAssistantModule(module: AssistantModule): void {
    this.publish({ ...this.snapshot, assistantModule: module })
  }

  openAssistant(module: AssistantModule = this.snapshot.assistantModule): void {
    this.publish({
      ...this.snapshot,
      assistantMode: this.snapshot.assistantMode === 'closed' ? 'docked' : this.snapshot.assistantMode,
      assistantModule: module,
    })
  }

  setHistory(open: boolean): void {
    this.publish({ ...this.snapshot, historyOpen: open, reportsOpen: open ? false : this.snapshot.reportsOpen })
  }

  setReports(open: boolean): void {
    this.publish({ ...this.snapshot, reportsOpen: open, historyOpen: open ? false : this.snapshot.historyOpen })
  }

  setDraft(key: InvestmentDraftKey, value: string): void {
    this.publish({ ...this.snapshot, [key]: value })
  }

  selectStrategy(strategyId: string): void {
    this.publish({ ...this.snapshot, selectedStrategyId: strategyId })
  }

  private publish(next: InvestmentUiSnapshot): void {
    if (next.route === this.snapshot.route
      && next.historyOpen === this.snapshot.historyOpen
      && next.reportsOpen === this.snapshot.reportsOpen
      && next.assistantMode === this.snapshot.assistantMode
      && next.assistantModule === this.snapshot.assistantModule
      && next.analysisQuery === this.snapshot.analysisQuery
      && next.backtestQuery === this.snapshot.backtestQuery
      && next.watchQuery === this.snapshot.watchQuery
      && next.chainQuery === this.snapshot.chainQuery
      && next.selectedStockCode === this.snapshot.selectedStockCode
      && next.selectedStrategyId === this.snapshot.selectedStrategyId
      && next.strategyResearchStage === this.snapshot.strategyResearchStage
      && next.evolutionReturnGroup === this.snapshot.evolutionReturnGroup) return
    this.snapshot = Object.freeze(next)
    for (const listener of [...this.listeners]) listener()
  }
}
