/** Package-owned companion for the industry-chain lifecycle registration. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-industry-chain'

export const name = 'investment-industry-chain-invariant'
export const inject = ['invariants']

// No runtime invariant: the backend registration and lease share one Cordis effect lifetime.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
