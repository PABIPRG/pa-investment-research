import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

export type InvestmentRoute =
  | 'assistant'
  | 'opportunity'
  | 'stock-detail'
  | 'portfolio'
  | 'framework'
  | 'projects'
  | 'tasks'
  | 'knowledge'

export interface InvestmentUiSnapshot {
  readonly route: InvestmentRoute
  readonly historyOpen: boolean
  readonly reportsOpen: boolean
  /** Drafts intentionally stay independent so typing in one module cannot mutate another. */
  readonly analysisQuery: string
  readonly watchQuery: string
  readonly chainQuery: string
  readonly selectedStockCode: string
  readonly selectedStrategyId: string
}

export type InvestmentDraftKey = 'analysisQuery' | 'watchQuery' | 'chainQuery'

export interface InvestmentNavigationContext {
  readonly stockCode?: string
  readonly strategyId?: string
}

const INITIAL: InvestmentUiSnapshot = Object.freeze({
  route: 'assistant',
  historyOpen: false,
  reportsOpen: false,
  analysisQuery: '',
  watchQuery: '',
  chainQuery: '',
  selectedStockCode: '',
  selectedStrategyId: '',
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
    this.publish({
      ...this.snapshot,
      route,
      historyOpen: false,
      reportsOpen: false,
      selectedStockCode: context.stockCode ?? this.snapshot.selectedStockCode,
      // Entering the shadow workbench from the sidebar means "all active
      // strategies". Only the deliberate lifecycle hand-off carries a
      // concrete strategy id; a stale candidate selected while backtesting
      // must never leak into paper validation.
      selectedStrategyId: context.strategyId
        ?? (route === 'projects' ? '' : this.snapshot.selectedStrategyId),
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
      && next.analysisQuery === this.snapshot.analysisQuery
      && next.watchQuery === this.snapshot.watchQuery
      && next.chainQuery === this.snapshot.chainQuery
      && next.selectedStockCode === this.snapshot.selectedStockCode
      && next.selectedStrategyId === this.snapshot.selectedStrategyId) return
    this.snapshot = Object.freeze(next)
    for (const listener of [...this.listeners]) listener()
  }
}
