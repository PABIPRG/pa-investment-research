/** Package-owned invariant companion for industry-chain registration. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-industry-chain'

export const name = 'investment-industry-chain-invariant'
export const inject = ['invariants']

// No independent relation: the backend, lease, and capability share one Cordis effect.
const install: InvariantInstaller = () => {}

/** Reserve invariant ownership for this package. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
