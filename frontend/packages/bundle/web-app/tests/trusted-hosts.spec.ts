/** Explicit public-authority resolution for the /api browser-trust fence. */

import { describe, expect, it } from 'vitest'
import { resolveWebTrust } from '../src/index.ts'

describe('resolveWebTrust', () => {
  it('uses only explicitly configured public authorities for an all-interfaces bind', () => {
    expect(resolveWebTrust('0.0.0.0', ['harness.internal:3080']))
      .toEqual({ trustedHosts: ['harness.internal:3080'] })
  })

  it('preserves explicit authorities without deriving LAN IP literals', () => {
    expect(resolveWebTrust('127.0.0.1', [])).toEqual({ trustedHosts: [] })
    expect(resolveWebTrust('127.0.0.1', ['lab.internal']))
      .toEqual({ trustedHosts: ['lab.internal'] })
  })
})
