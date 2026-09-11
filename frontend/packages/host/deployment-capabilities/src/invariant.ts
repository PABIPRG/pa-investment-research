/** Package-owned invariant companion for the immutable deployment capability service. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-deployment-capabilities'

export const name = 'host-deployment-capabilities-invariant'
export const inject = ['invariants']

/** No runtime invariant: the service publishes one frozen snapshot and has no mutable state to audit. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
