import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'api-web-auth-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const auth = ctx.get('webAuth') as { enabled?: unknown; available?: unknown } | undefined
    if (auth !== undefined && (typeof auth.enabled !== 'boolean' || typeof auth.available !== 'boolean')) {
      fail('webAuth service must expose boolean enabled and available state')
    }
  }, { global: true })
}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-api-web-auth', install))
