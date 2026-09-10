/** Electron-only Settings section and shortcut-action bridge. */

import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DESKTOP_SHORTCUTS_NAMESPACE,
  type DesktopShortcutAction,
  type DesktopShortcutBindings,
  type DesktopShortcutPlatform,
  type DesktopShortcutSettings,
} from '../shortcuts.ts'
import { ShortcutsSection, type ShortcutsSectionInjected } from './ShortcutsSection.tsx'
import { en, zh, type DesktopShortcutsKey } from './locales.ts'

export type { ShortcutsSectionInjected, ShortcutsSectionProps } from './ShortcutsSection.tsx'
export type { DesktopShortcutsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop shortcut section copy. */
    'settings.desktop-shortcuts': DesktopShortcutsKey
  }
}

const NS = 'settings.desktop-shortcuts'
const ACTION_LISTENER_ID = 'desktop-shortcuts-settings'

/** Required services for the Electron-only settings surface and Host persistence. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsUi']

/** Register the section only when the trusted Electron preload bridge is present. */
export function apply(ctx: ClientContext): void {
  const bridge = (ctx.get('connection') as ConnectionHandle).desktop
  if (bridge === undefined) return

  const host = ctx.settingsScope.bind<DesktopShortcutSettings>({
    namespace: DESKTOP_SHORTCUTS_NAMESPACE,
  })
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-desktop-shortcuts: dictionaries')
  ctx.effect(() => {
    bridge.watchShortcutActions(ACTION_LISTENER_ID, (action) => {
      if (action === 'openSettings') ctx.settingsUi.open('shortcuts')
    })
    return () => {
      bridge.setShortcutCapture(false)
      bridge.unwatchShortcutActions(ACTION_LISTENER_ID)
    }
  }, 'ui-desktop-shortcuts: preload actions')

  const injected = (): ShortcutsSectionInjected => ({
    hooks: { shortcuts: host },
    platform: bridge.platform,
    setCapture: (active) => { bridge.setShortcutCapture(active) },
    setBinding: (action, binding) => writeBinding(host, bridge.platform, action, binding),
    resetBinding: action => resetBinding(host, bridge.platform, action),
    resetAll: () => resetPlatform(host, bridge.platform),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'shortcuts',
    order: 5,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ShortcutsSection))
}

async function writeBinding(
  host: SettingsScope<DesktopShortcutSettings>,
  platform: DesktopShortcutPlatform,
  action: DesktopShortcutAction,
  binding: string,
): Promise<boolean> {
  const bindings = cloneBindings(host.getSnapshot().value)
  bindings[platform] = { ...bindings[platform], [action]: binding }
  await host.set('bindings', bindings)
  return host.getSnapshot().value?.bindings?.[platform]?.[action] === binding
}

async function resetBinding(
  host: SettingsScope<DesktopShortcutSettings>,
  platform: DesktopShortcutPlatform,
  action: DesktopShortcutAction,
): Promise<boolean> {
  const bindings = cloneBindings(host.getSnapshot().value)
  const current = withoutAction(bindings[platform] ?? {}, action)
  const next = Object.keys(current).length === 0
    ? withoutPlatform(bindings, platform)
    : { ...bindings, [platform]: current }
  await persistBindings(host, next)
  return host.getSnapshot().value?.bindings?.[platform]?.[action] === undefined
}

async function resetPlatform(
  host: SettingsScope<DesktopShortcutSettings>,
  platform: DesktopShortcutPlatform,
): Promise<boolean> {
  const bindings = withoutPlatform(cloneBindings(host.getSnapshot().value), platform)
  await persistBindings(host, bindings)
  return host.getSnapshot().value?.bindings?.[platform] === undefined
}

function cloneBindings(settings: DesktopShortcutSettings | undefined): Partial<
  Record<DesktopShortcutPlatform, DesktopShortcutBindings>
> {
  return Object.fromEntries(Object.entries(settings?.bindings ?? {}).map(([platform, values]) => [
    platform,
    { ...values },
  ]))
}

function withoutAction(
  bindings: DesktopShortcutBindings,
  action: DesktopShortcutAction,
): DesktopShortcutBindings {
  return Object.fromEntries(Object.entries(bindings).filter(([candidate]) => candidate !== action))
}

function withoutPlatform(
  bindings: Partial<Record<DesktopShortcutPlatform, DesktopShortcutBindings>>,
  platform: DesktopShortcutPlatform,
): Partial<Record<DesktopShortcutPlatform, DesktopShortcutBindings>> {
  return Object.fromEntries(Object.entries(bindings).filter(([candidate]) => candidate !== platform))
}

async function persistBindings(
  host: SettingsScope<DesktopShortcutSettings>,
  bindings: Partial<Record<DesktopShortcutPlatform, DesktopShortcutBindings>>,
): Promise<void> {
  if (Object.keys(bindings).length === 0) await host.unset('bindings')
  else await host.set('bindings', bindings)
}
