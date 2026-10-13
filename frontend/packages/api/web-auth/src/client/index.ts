import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PasswordSection } from './PasswordSection.tsx'
import { LogoutAction } from './LogoutAction.tsx'

export { LogoutAction } from './LogoutAction.tsx'

export const inject = ['slots']

/** Register the signed-in administrator's logout action in the sidebar footer. */
export function apply(ctx: ClientContext): void {
  const auth = (globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: {
    enabled(): boolean
    account?(): { username: string; canChangePassword: boolean } | undefined
    changePassword(current: string, next: string, confirmation: string): Promise<string>
  } }).__DSH_WEB_AUTH__
  const account = auth?.account?.()
  if (auth?.enabled() === true && account !== undefined) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'account-security', label: '账号安全', order: 5,
      inject: () => ({
        ...account, onSubmit: (current: string, next: string, confirmation: string) => auth.changePassword(current, next, confirmation),
      }),
    }, PasswordSection))
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'web-auth-logout',
    order: 100,
  }, LogoutAction))
}
