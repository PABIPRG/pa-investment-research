import { describe, expect, it, vi } from 'vitest'
import * as IndustryInvariant from '../src/invariant.ts'

describe('industry-chain invariant companion', () => {
  it('registers its no-op package ownership companion', async () => {
    const register = vi.fn((_name: string, install: (ctx: unknown) => void) => {
      install({})
      return () => {}
    })

    const dispose = await IndustryInvariant.apply({ invariants: { register } } as never)

    expect(IndustryInvariant.name).toBe('investment-industry-chain-invariant')
    expect(IndustryInvariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-investment-industry-chain',
      expect.any(Function),
    )
    dispose()
  })
})
