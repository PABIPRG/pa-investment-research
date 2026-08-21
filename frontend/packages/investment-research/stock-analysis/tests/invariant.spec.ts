import { describe, expect, it, vi } from 'vitest'
import * as MarketInvariant from '../../market-watch/src/invariant.ts'
import * as StockInvariant from '../src/invariant.ts'

describe('investment research invariant companions', () => {
  it.each([
    [StockInvariant, '@deepseek-ai/dsh-investment-stock-analysis', 'investment-stock-analysis-invariant'],
    [MarketInvariant, '@deepseek-ai/dsh-investment-market-watch', 'investment-market-watch-invariant'],
  ])('registers the no-op companion for %s', async (invariant, packageName, pluginName) => {
    const register = vi.fn((_name: string, install: (ctx: unknown) => void) => {
      install({})
      return () => {}
    })

    const dispose = await invariant.apply({ invariants: { register } } as never)

    expect(invariant.name).toBe(pluginName)
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(packageName, expect.any(Function))
    dispose()
  })
})
