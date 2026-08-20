/** Package-owned companion for market-watch registrations. @module @deepseek-ai/dsh-investment-market-watch/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-market-watch'

/** Cordis companion plugin name. */
export const name = 'investment-market-watch-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: in phase one every tool registration is owned by this
 * plugin's current Cordis effect; it creates no independent event or
 * cross-service data relation to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the package registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
