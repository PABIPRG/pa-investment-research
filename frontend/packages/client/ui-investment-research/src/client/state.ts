import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

export type InvestmentRoute =
  | 'assistant'
  | 'dashboard'
  | 'analysis'
  | 'watch'
  | 'strategy'
  | 'shadow'
  | 'evolution'
  | 'stock-detail'
  | 'portfolio'
  | 'chain'

export interface InvestmentUiSnapshot {
  readonly route: InvestmentRoute
  readonly historyOpen: boolean
  readonly stockQuery: string
}

const INITIAL: InvestmentUiSnapshot = Object.freeze({
  route: 'dashboard',
  historyOpen: false,
  stockQuery: '',
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

  navigate(route: InvestmentRoute, stockQuery = ''): void {
    this.publish({ route, historyOpen: false, stockQuery })
  }

  setHistory(open: boolean): void {
    this.publish({ ...this.snapshot, historyOpen: open })
  }

  private publish(next: InvestmentUiSnapshot): void {
    if (next.route === this.snapshot.route
      && next.historyOpen === this.snapshot.historyOpen
      && next.stockQuery === this.snapshot.stockQuery) return
    this.snapshot = Object.freeze(next)
    for (const listener of [...this.listeners]) listener()
  }
}
