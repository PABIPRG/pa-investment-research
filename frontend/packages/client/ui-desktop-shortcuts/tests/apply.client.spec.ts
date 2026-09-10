// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsUiRuntime } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import { ShortcutsSection, type ShortcutsSectionInjected } from '../src/client/ShortcutsSection.tsx'
import type { DesktopShortcutSettings } from '../src/shortcuts.ts'

usePinnedBrowserLanguages('zh-CN')

afterEach(() => {
  delete (globalThis as { __DSH_ELECTRON__?: unknown }).__DSH_ELECTRON__
})

async function bench(withBridge = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('remote', {} as never)
  const host = stubSettingsScope<DesktopShortcutSettings>()
  host.publish({ status: 'ready', value: {}, writable: true, revision: 1 })
  host.set.mockImplementation((field: string, value: unknown) => {
    expect(field).toBe('bindings')
    host.publish({ value: { bindings: value } as DesktopShortcutSettings })
  })
  host.unset.mockImplementation((field: string) => {
    expect(field).toBe('bindings')
    host.publish({ value: {} })
  })
  ctx.provide('settingsScope', { bind: () => host.scope } as never)
  const settingsUi = new SettingsUiRuntime(ctx)
  let shortcutAction: ((action: string) => void) | undefined
  const bridge = {
    version: 1 as const,
    platform: 'darwin' as const,
    openStream: vi.fn(),
    closeStream: vi.fn(),
    setShortcutCapture: vi.fn(),
    watchShortcutActions: vi.fn((_id: string, listener: (action: string) => void) => {
      shortcutAction = listener
    }),
    unwatchShortcutActions: vi.fn(),
  }
  ctx.provide('connection', withBridge ? { desktop: bridge } as never : {} as never)
  return { ctx, slots, locale, host, settingsUi, bridge, shortcutAction: () => shortcutAction }
}

describe('desktop shortcut client registration', () => {
  it('declares its settings, transport, and navigation dependencies', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsUi'])
  })

  it('registers only in Electron, persists current-platform overrides, and handles open Settings', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ShortcutsSection)
    expect(entry.options).toMatchObject({ id: 'shortcuts', order: 5 })
    expect(entry.locale).toBe('settings.desktop-shortcuts')
    expect(resolveSlotLabel(entry.options.label)).toBe('快捷键')
    const face = (entry.inject as unknown as () => ShortcutsSectionInjected)()
    await expect(face.setBinding('openSettings', 'Shift+Meta+Comma')).resolves.toBe(true)
    b.host.publish({
      value: { bindings: { darwin: { openSettings: 'Shift+Meta+Comma' }, linux: { toggleFullScreen: 'F10' } } },
    })
    await expect(face.resetBinding('openSettings')).resolves.toBe(true)
    expect(b.host.set).toHaveBeenLastCalledWith('bindings', { linux: { toggleFullScreen: 'F10' } })

    b.shortcutAction()?.('openSettings')
    expect(b.settingsUi.requests.getSnapshot()).toEqual({ revision: 1, sectionId: 'shortcuts' })

    await fiber.dispose()
    expect(b.bridge.setShortcutCapture).toHaveBeenLastCalledWith(false)
    expect(b.bridge.unwatchShortcutActions).toHaveBeenCalledWith('desktop-shortcuts-settings')
  })

  it('contributes no settings section to an ordinary browser', async () => {
    const b = await bench(false)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toEqual([])
  })
})
