/** Package-owned invariant companion for desktop shortcuts. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-desktop-shortcuts'

/** Cordis companion plugin name. */
export const name = 'client-ui-desktop-shortcuts-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Schema validation and the Electron matcher own the runtime invariants directly. */
const install: InvariantInstaller = () => {
  // No runtime invariant: validation and action matching are enforced at their owning boundaries.
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
