import { describe, expect, it, vi } from 'vitest'
import { InvestmentUiState } from '../src/client/state.ts'

describe('InvestmentUiState', () => {
  it('starts on the research dashboard and publishes profile navigation', () => {
    const state = new InvestmentUiState()
    const listener = vi.fn()
    const unsubscribe = state.subscribe(listener)

    expect(state.getSnapshot()).toEqual({
      route: 'dashboard',
      historyOpen: false,
      stockQuery: '',
    })

    state.setHistory(true)
    state.navigate('watch', '600519')

    expect(listener).toHaveBeenCalledTimes(2)
    expect(state.getSnapshot()).toEqual({
      route: 'watch',
      historyOpen: false,
      stockQuery: '600519',
    })

    unsubscribe()
    state.navigate('portfolio')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not publish a duplicate history state', () => {
    const state = new InvestmentUiState()
    const listener = vi.fn()
    state.subscribe(listener)

    state.setHistory(false)

    expect(listener).not.toHaveBeenCalled()
  })
})
