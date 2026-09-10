import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  effectiveShortcutBindings,
  formatShortcut,
  normalizeShortcutInput,
  shortcutConflict,
  validateDesktopShortcutSettings,
  type DesktopShortcutSettings,
} from '../src/shortcuts.ts'

describe('desktop shortcut defaults', () => {
  it('uses native macOS conventions and leaves system-owned minimize bindings unset elsewhere', () => {
    expect(DEFAULT_SHORTCUTS.darwin).toEqual({
      openSettings: 'Meta+Comma',
      toggleFullScreen: 'Control+Meta+KeyF',
      minimizeWindow: 'Meta+KeyM',
    })
    expect(DEFAULT_SHORTCUTS.win32).toEqual({
      openSettings: 'Control+Comma',
      toggleFullScreen: 'F11',
    })
    expect(DEFAULT_SHORTCUTS.linux).toEqual(DEFAULT_SHORTCUTS.win32)
  })

  it('overlays only the current platform customizations', () => {
    const settings: DesktopShortcutSettings = {
      bindings: {
        darwin: { openSettings: 'Meta+Shift+Comma' },
        win32: { minimizeWindow: 'Control+Alt+KeyM' },
      },
    }

    expect(effectiveShortcutBindings(settings, 'darwin')).toEqual({
      openSettings: 'Meta+Shift+Comma',
      toggleFullScreen: 'Control+Meta+KeyF',
      minimizeWindow: 'Meta+KeyM',
    })
    expect(effectiveShortcutBindings(settings, 'win32')).toEqual({
      openSettings: 'Control+Comma',
      toggleFullScreen: 'F11',
      minimizeWindow: 'Control+Alt+KeyM',
    })
  })

  it('reports the action occupying a candidate binding', () => {
    expect(shortcutConflict(DEFAULT_SHORTCUTS.darwin, 'minimizeWindow', 'Meta+Comma')).toBe('openSettings')
    expect(shortcutConflict(DEFAULT_SHORTCUTS.darwin, 'minimizeWindow', 'Meta+Shift+KeyM')).toBeUndefined()
  })
})

describe('shortcut input normalization', () => {
  it('normalizes modifier order and formats platform-native labels', () => {
    expect(normalizeShortcutInput({ code: 'KeyF', control: true, meta: true }, 'darwin'))
      .toEqual({ ok: true, binding: 'Control+Meta+KeyF' })
    expect(formatShortcut('Control+Meta+KeyF', 'darwin')).toEqual(['⌃', '⌘', 'F'])
    expect(formatShortcut('Control+Shift+Comma', 'win32')).toEqual(['Ctrl', 'Shift', ','])
  })

  it('allows bare function keys but refuses typing keys, modifiers, and OS-reserved bindings', () => {
    expect(normalizeShortcutInput({ code: 'F11' }, 'linux')).toEqual({ ok: true, binding: 'F11' })
    expect(normalizeShortcutInput({ code: 'KeyK' }, 'linux')).toEqual({ ok: false, reason: 'modifier-required' })
    expect(normalizeShortcutInput({ code: 'MetaLeft', meta: true }, 'darwin')).toEqual({ ok: false, reason: 'key-required' })
    expect(normalizeShortcutInput({ code: 'KeyW', meta: true }, 'darwin')).toEqual({ ok: false, reason: 'system-reserved' })
    expect(normalizeShortcutInput({ code: 'F4', alt: true }, 'win32')).toEqual({ ok: false, reason: 'system-reserved' })
  })
})

describe('desktop shortcut settings validation', () => {
  it('rejects collisions after defaults and overrides are resolved', () => {
    expect(() => {
      validateDesktopShortcutSettings({
        bindings: { win32: { minimizeWindow: 'Control+Comma' } },
      })
    }).toThrow(/duplicates openSettings/u)
  })

  it('rejects malformed persisted bindings before they reach the Electron matcher', () => {
    expect(() => {
      validateDesktopShortcutSettings({
        bindings: { linux: { openSettings: 'KeyK' } },
      })
    }).toThrow(/requires a modifier/u)
  })
})
