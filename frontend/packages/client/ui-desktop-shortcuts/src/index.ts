/** Host registration for Electron desktop shortcut preferences. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DESKTOP_SHORTCUTS_NAMESPACE,
  validateDesktopShortcutSettings,
  type DesktopShortcutBindings,
  type DesktopShortcutSettings,
} from './shortcuts.ts'

/** Branded Host namespace for platform-specific desktop shortcut overrides. */
export const DESKTOP_SHORTCUTS_HOST_NAMESPACE = settingsNamespace(DESKTOP_SHORTCUTS_NAMESPACE)

const ShortcutBindingsSchema: z<DesktopShortcutBindings> = z.object({
  openSettings: z.string(),
  toggleFullScreen: z.string(),
  minimizeWindow: z.string(),
})

/** Durable schema; defaults stay platform-derived rather than being copied into user data. */
export const DesktopShortcutSettingsSchema: z<DesktopShortcutSettings> = z.object({
  bindings: z.object({
    darwin: ShortcutBindingsSchema,
    win32: ShortcutBindingsSchema,
    linux: ShortcutBindingsSchema,
  }),
})

export {
  DEFAULT_SHORTCUTS,
  DESKTOP_SHORTCUT_ACTIONS,
  DESKTOP_SHORTCUTS_NAMESPACE,
  effectiveShortcutBindings,
  formatShortcut,
  normalizeShortcutInput,
  parseShortcutBinding,
  shortcutConflict,
  validateDesktopShortcutSettings,
  type DesktopShortcutAction,
  type DesktopShortcutBindings,
  type DesktopShortcutPlatform,
  type DesktopShortcutSettings,
  type ShortcutInput,
  type ShortcutInputFailure,
  type ShortcutInputResult,
} from './shortcuts.ts'

/** Register the settings namespace when the Host settings provider is present. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      DESKTOP_SHORTCUTS_HOST_NAMESPACE,
      DesktopShortcutSettingsSchema,
      { validate: validateDesktopShortcutSettings },
    )
  })
}
