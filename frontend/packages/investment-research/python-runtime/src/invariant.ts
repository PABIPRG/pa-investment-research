/** Package-owned companion for investment Python Runtime registrations. @module @deepseek-ai/dsh-investment-python-runtime/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-python-runtime'

/** Cordis companion plugin name. */
export const name = 'investment-python-runtime-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: pure resolution and health classification own no
 * mutable cross-service relation; lifecycle-owned process state is separate.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the package registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
