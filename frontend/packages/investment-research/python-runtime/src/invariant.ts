/** Package-owned companion for investment Python Runtime registrations. @module @deepseek-ai/dsh-investment-python-runtime/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-python-runtime'

/** Cordis companion plugin name. */
export const name = 'investment-python-runtime-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * Verify ownership, refcount, and single-flight relations without touching
 * the operating system or treating persisted pids as authority.
 */
const install: InvariantInstaller = Object.assign((
  ctx: Parameters<InvariantInstaller>[0],
  fail: Parameters<InvariantInstaller>[1],
) => {
  const snapshot = ctx.investmentPythonRuntime.invariantSnapshot()
  const running = new Set(snapshot.active.map(entry => entry.definition.id))
  for (const entry of snapshot.active) {
    const id = entry.definition.id
    if (entry.refs < 0) fail(`investment Python backend "${id}" has a negative lease count`)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- invariant snapshots may be forged or corrupted at runtime.
    if (entry.ownership === 'owned' && entry.handle === undefined) {
      fail(`investment Python backend "${id}" is owned without a live handle`)
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- invariant snapshots may be forged or corrupted at runtime.
    if (entry.ownership !== 'owned' && entry.handle !== undefined) {
      fail(`investment Python backend "${id}" is attached with an owned handle`)
    }
  }
  for (const id of snapshot.flights) {
    if (running.has(id)) fail(`investment Python backend "${id}" is both starting and running`)
  }
}, {
  inject: ['investmentPythonRuntime'] as const,
})

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the package registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
