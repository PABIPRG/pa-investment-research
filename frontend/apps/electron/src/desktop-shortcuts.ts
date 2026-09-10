/** Focus-local Electron shortcut execution and settings synchronization. */

import type { BrowserWindow, IpcMain, IpcMainEvent, Input } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import {
  DESKTOP_SHORTCUTS_HOST_NAMESPACE,
  effectiveShortcutBindings,
  normalizeShortcutInput,
  type DesktopShortcutAction,
  type DesktopShortcutBindings,
  type DesktopShortcutPlatform,
  type DesktopShortcutSettings,
} from '@deepseek-ai/dsh-client-ui-desktop-shortcuts'
import { SHORTCUT_ACTION_CHANNEL, SHORTCUT_CAPTURE_CHANNEL } from './ipc.ts'

type ShortcutInputEvent = Pick<Input, 'type' | 'code'> & Partial<Pick<
  Input,
  'control' | 'alt' | 'shift' | 'meta' | 'isAutoRepeat'
>>

/** Match one Electron input record against the active platform bindings. */
export function shortcutActionForInput(
  bindings: DesktopShortcutBindings,
  platform: DesktopShortcutPlatform,
  input: ShortcutInputEvent,
): DesktopShortcutAction | undefined {
  if (input.type !== 'keyDown' || input.isAutoRepeat === true) return undefined
  const normalized = normalizeShortcutInput(input, platform)
  if (!normalized.ok) return undefined
  return (Object.entries(bindings) as [DesktopShortcutAction, string][])
    .find(([, binding]) => binding === normalized.binding)?.[0]
}

/** Mutable executor kept independent from Electron registration for focused tests. */
export class DesktopShortcutController {
  private capturing = false

  constructor(
    private readonly window: BrowserWindow,
    private readonly platform: DesktopShortcutPlatform,
    private bindings: DesktopShortcutBindings,
  ) {}

  /** Replace the complete effective binding map after a settings commit. */
  setBindings(bindings: DesktopShortcutBindings): void {
    this.bindings = bindings
  }

  /** Suspend or resume matching while the renderer records a replacement key. */
  setCapturing(capturing: boolean): void {
    this.capturing = capturing
  }

  /** Handle one pre-renderer input event; returns whether it was consumed. */
  handle(input: ShortcutInputEvent): boolean {
    if (this.capturing) return false
    const action = shortcutActionForInput(this.bindings, this.platform, input)
    if (action === undefined) return false
    this.execute(action)
    return true
  }

  /** Execute one known desktop action at its owning process. */
  execute(action: DesktopShortcutAction): void {
    switch (action) {
      case 'openSettings':
        this.window.webContents.send(SHORTCUT_ACTION_CHANNEL, action)
        return
      case 'toggleFullScreen':
        this.window.setFullScreen(!this.window.isFullScreen())
        return
      case 'minimizeWindow':
        this.window.minimize()
        return
      default:
        action satisfies never
    }
  }
}

/** Register the focused-window listener, capture IPC, and live Host settings adoption. */
export function bindDesktopShortcuts(
  window: BrowserWindow,
  ipcMain: IpcMain,
  ctx: Context,
  platform: DesktopShortcutPlatform = currentPlatform(),
): { dispose(): void } {
  const settings = ctx.get('settings')
  const read = (): DesktopShortcutSettings =>
    (settings?.get(DESKTOP_SHORTCUTS_HOST_NAMESPACE) as DesktopShortcutSettings | undefined) ?? {}
  const controller = new DesktopShortcutController(window, platform, effectiveShortcutBindings(read(), platform))
  const onInput = (event: { preventDefault(): void }, input: Input): void => {
    if (controller.handle(input)) event.preventDefault()
  }
  const onCapture = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return
    if (typeof value === 'boolean') controller.setCapturing(value)
  }
  const offSettings = settings === undefined
    ? () => {}
    : ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== DESKTOP_SHORTCUTS_HOST_NAMESPACE) return
      controller.setBindings(effectiveShortcutBindings(next as DesktopShortcutSettings, platform))
    })
  window.webContents.on('before-input-event', onInput)
  ipcMain.on(SHORTCUT_CAPTURE_CHANNEL, onCapture)
  return {
    dispose(): void {
      offSettings()
      ipcMain.off(SHORTCUT_CAPTURE_CHANNEL, onCapture)
      window.webContents.off('before-input-event', onInput)
    },
  }
}

function currentPlatform(): DesktopShortcutPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform
  return 'linux'
}
