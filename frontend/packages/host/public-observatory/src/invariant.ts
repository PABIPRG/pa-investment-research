/** Package-owned invariant companion for the public read gateway. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'host-public-observatory-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: the HTTP gateway emits no durable or Cordis events.
 * Its request limits and publication acceptance are enforced at the carriers;
 * backend lease ownership remains with the Python runtime's own companion.
 */
const install: InvariantInstaller = () => {}

/**
 * Reserve ownership of this package's invariant registration.
 * @param ctx - context containing the invariant registry.
 * @returns disposer for the package registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-host-public-observatory', install))
