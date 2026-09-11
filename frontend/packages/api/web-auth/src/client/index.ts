import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { LogoutAction } from './LogoutAction.tsx'

export { LogoutAction } from './LogoutAction.tsx'

export const inject = ['slots']

/** Register the signed-in administrator's logout action in the sidebar footer. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'web-auth-logout',
    order: 100,
  }, LogoutAction))
}
