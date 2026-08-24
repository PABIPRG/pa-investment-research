/** Static patch-carrier invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-investment-runtime-bundle'

export const name = 'investment-runtime-bundle-invariant'
export const inject = ['invariants']

// No runtime invariant: this package only publishes cordis.patch.yml.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
