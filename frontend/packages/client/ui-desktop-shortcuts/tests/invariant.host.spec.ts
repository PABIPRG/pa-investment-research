import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as DesktopShortcutsInvariant from '@deepseek-ai/dsh-client-ui-desktop-shortcuts/invariant'

describe('desktop shortcut invariant companion', () => {
  it('registers package ownership and keeps the Host apply optional', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(DesktopShortcutsInvariant).await()).resolves.toBeDefined()

    const { apply } = await import('@deepseek-ai/dsh-client-ui-desktop-shortcuts')
    apply(new Context())
    expect(true).toBe(true)
  })
})
