import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DESKTOP_SHORTCUTS_HOST_NAMESPACE,
  apply,
} from '@deepseek-ai/dsh-client-ui-desktop-shortcuts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('desktop shortcut Host registration', () => {
  it('registers a validated namespace and removes it with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()

    expect(ctx.settings.get(DESKTOP_SHORTCUTS_HOST_NAMESPACE)).toBeDefined()
    await ctx.settings.update(DESKTOP_SHORTCUTS_HOST_NAMESPACE, {
      bindings: { darwin: { openSettings: 'Shift+Meta+Comma' } },
    })
    expect(ctx.settings.get(DESKTOP_SHORTCUTS_HOST_NAMESPACE)).toMatchObject({
      bindings: { darwin: { openSettings: 'Shift+Meta+Comma' } },
    })
    await expect(ctx.settings.update(DESKTOP_SHORTCUTS_HOST_NAMESPACE, {
      bindings: { darwin: { openSettings: 'Meta+KeyQ' } },
    })).rejects.toThrow(/system-reserved/u)

    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(DESKTOP_SHORTCUTS_HOST_NAMESPACE)
  })
})
