/** Static patch-carrier invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-market-watch-bundle'

export const name = 'investment-market-watch-bundle-invariant'
export const inject = ['invariants']

// This package owns no runtime state: it only publishes cordis.patch.yml.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
