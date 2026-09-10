/** Cross-process desktop shortcut settings, defaults, and normalization. */

/** Desktop platforms supported by the Electron distribution. */
export type DesktopShortcutPlatform = 'darwin' | 'win32' | 'linux'

/** Settings namespace id shared with the browser scope without importing Host runtime code. */
export const DESKTOP_SHORTCUTS_NAMESPACE = 'ui-desktop-shortcuts'

/** User-addressable application actions. */
export const DESKTOP_SHORTCUT_ACTIONS = [
  'openSettings',
  'toggleFullScreen',
  'minimizeWindow',
] as const

/** A user-addressable application action. */
export type DesktopShortcutAction = typeof DESKTOP_SHORTCUT_ACTIONS[number]

/** Canonical binding strings by action; an absent entry has no application-owned binding. */
export type DesktopShortcutBindings = Partial<Record<DesktopShortcutAction, string>>

/** Durable per-platform custom binding layers. */
export interface DesktopShortcutSettings {
  bindings?: Partial<Record<DesktopShortcutPlatform, DesktopShortcutBindings>>
}

/** Keyboard input fields shared by DOM and Electron key events. */
export interface ShortcutInput {
  code: string
  control?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

/** Why a captured key cannot become an application shortcut. */
export type ShortcutInputFailure = 'key-required' | 'modifier-required' | 'unsupported-key' | 'system-reserved'

/** Result of normalizing one captured key. */
export type ShortcutInputResult =
  | { ok: true; binding: string }
  | { ok: false; reason: ShortcutInputFailure }

/** Platform-native application defaults. */
export const DEFAULT_SHORTCUTS: Readonly<Record<DesktopShortcutPlatform, Readonly<DesktopShortcutBindings>>> = {
  darwin: {
    openSettings: 'Meta+Comma',
    toggleFullScreen: 'Control+Meta+KeyF',
    minimizeWindow: 'Meta+KeyM',
  },
  win32: {
    openSettings: 'Control+Comma',
    toggleFullScreen: 'F11',
  },
  linux: {
    openSettings: 'Control+Comma',
    toggleFullScreen: 'F11',
  },
}

const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight',
])
const SUPPORTED_CODE = new RegExp([
  '^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|',
  'Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|',
  'Backslash|Minus|Equal|Backquote)$',
].join(''), 'u')

const SYSTEM_RESERVED: Readonly<Record<DesktopShortcutPlatform, ReadonlySet<string>>> = {
  darwin: new Set(['Meta+KeyQ', 'Meta+KeyW']),
  win32: new Set(['Alt+F4']),
  linux: new Set(['Alt+F4']),
}

/**
 * Resolve platform defaults plus its custom layer without mutating either input.
 * @param settings - durable platform-specific overrides.
 * @param platform - active desktop operating system.
 * @returns the complete effective action map for that platform.
 */
export function effectiveShortcutBindings(
  settings: DesktopShortcutSettings,
  platform: DesktopShortcutPlatform,
): DesktopShortcutBindings {
  return { ...DEFAULT_SHORTCUTS[platform], ...settings.bindings?.[platform] }
}

/**
 * Find the other action already using a candidate binding.
 * @param bindings - complete effective binding map.
 * @param action - action currently being edited.
 * @param candidate - normalized binding proposed for the action.
 * @returns the conflicting action, or undefined when the binding is free.
 */
export function shortcutConflict(
  bindings: DesktopShortcutBindings,
  action: DesktopShortcutAction,
  candidate: string,
): DesktopShortcutAction | undefined {
  return DESKTOP_SHORTCUT_ACTIONS.find(other => other !== action && bindings[other] === candidate)
}

/**
 * Convert one DOM/Electron input record to the persisted canonical representation.
 * @param input - physical key and modifier fields from the active renderer or Electron event.
 * @param platform - active desktop operating system.
 * @returns either one canonical binding or a user-addressable validation failure.
 */
export function normalizeShortcutInput(
  input: ShortcutInput,
  platform: DesktopShortcutPlatform,
): ShortcutInputResult {
  if (MODIFIER_CODES.has(input.code) || input.code === '') return { ok: false, reason: 'key-required' }
  if (!SUPPORTED_CODE.test(input.code)) return { ok: false, reason: 'unsupported-key' }
  const modifiers = [
    input.control === true ? 'Control' : undefined,
    input.alt === true ? 'Alt' : undefined,
    input.shift === true ? 'Shift' : undefined,
    input.meta === true ? 'Meta' : undefined,
  ].filter((value): value is string => value !== undefined)
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(input.code)) {
    return { ok: false, reason: 'modifier-required' }
  }
  const binding = [...modifiers, input.code].join('+')
  if (SYSTEM_RESERVED[platform].has(binding)) return { ok: false, reason: 'system-reserved' }
  return { ok: true, binding }
}

/**
 * Parse and validate one persisted binding, requiring its canonical spelling.
 * @param binding - candidate persisted binding.
 * @param platform - platform whose reserved combinations apply.
 * @returns the canonical binding or the validation failure.
 */
export function parseShortcutBinding(
  binding: string,
  platform: DesktopShortcutPlatform,
): ShortcutInputResult {
  const parts = binding.split('+')
  const code = parts.pop() ?? ''
  const input: ShortcutInput = {
    code,
    control: parts.includes('Control'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta'),
  }
  const normalized = normalizeShortcutInput(input, platform)
  if (!normalized.ok) return normalized
  return normalized.binding === binding ? normalized : { ok: false, reason: 'unsupported-key' }
}

/**
 * Validate the durable section, including collisions introduced against defaults.
 * @param settings - complete durable settings section to validate.
 */
export function validateDesktopShortcutSettings(settings: DesktopShortcutSettings): void {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const custom = settings.bindings?.[platform]
    if (custom !== undefined) {
      for (const action of DESKTOP_SHORTCUT_ACTIONS) {
        const binding = custom[action]
        if (binding === undefined) continue
        const parsed = parseShortcutBinding(binding, platform)
        if (!parsed.ok) {
          if (parsed.reason === 'modifier-required') {
            throw new Error(`desktop shortcut ${platform}.${action} requires a modifier`)
          }
          throw new Error(`desktop shortcut ${platform}.${action} is invalid: ${parsed.reason}`)
        }
      }
    }
    const used = new Map<string, DesktopShortcutAction>()
    for (const action of DESKTOP_SHORTCUT_ACTIONS) {
      const binding = effectiveShortcutBindings(settings, platform)[action]
      if (binding === undefined) continue
      const existing = used.get(binding)
      if (existing !== undefined) {
        throw new Error(`desktop shortcut ${platform}.${action} duplicates ${existing}`)
      }
      used.set(binding, action)
    }
  }
}

/**
 * Format a canonical binding as keycap labels in native modifier notation.
 * @param binding - canonical persisted binding.
 * @param platform - platform whose modifier labels should be displayed.
 * @returns ordered labels suitable for individual keycaps.
 */
export function formatShortcut(binding: string, platform: DesktopShortcutPlatform): string[] {
  return binding.split('+').map((part) => {
    if (part === 'Meta') return platform === 'darwin' ? '⌘' : 'Super'
    if (part === 'Control') return platform === 'darwin' ? '⌃' : 'Ctrl'
    if (part === 'Alt') return platform === 'darwin' ? '⌥' : 'Alt'
    if (part === 'Shift') return platform === 'darwin' ? '⇧' : 'Shift'
    if (part.startsWith('Key')) return part.slice(3)
    if (part.startsWith('Digit')) return part.slice(5)
    return ({
      Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
    } as Record<string, string>)[part] ?? part
  })
}
