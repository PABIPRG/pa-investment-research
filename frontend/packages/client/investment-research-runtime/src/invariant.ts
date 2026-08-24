/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-investment-research-runtime`.
 * @module @deepseek-ai/dsh-client-investment-research-runtime/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-investment-research-runtime'

/** Cordis companion plugin name. */
export const name = 'client-investment-research-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the facade service, Remote contribution, and event
 * subscriptions share one Client plugin fiber and have no independent mutable
 * authority; lifecycle tests prove that disposing the fiber withdraws all three.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
