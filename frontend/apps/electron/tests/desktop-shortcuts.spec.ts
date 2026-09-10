import { describe, expect, it, vi } from 'vitest'
import {
  bindDesktopShortcuts,
  DesktopShortcutController,
  shortcutActionForInput,
} from '../src/desktop-shortcuts.ts'
import { DESKTOP_SHORTCUTS_HOST_NAMESPACE } from '@deepseek-ai/dsh-client-ui-desktop-shortcuts'

describe('Electron desktop shortcut matching', () => {
  it('matches normalized keyDown input and ignores repeats and keyUp events', () => {
    const bindings = {
      openSettings: 'Meta+Comma',
      toggleFullScreen: 'Control+Meta+KeyF',
      minimizeWindow: 'Meta+KeyM',
    } as const

    expect(shortcutActionForInput(bindings, 'darwin', {
      type: 'keyDown', code: 'Comma', meta: true,
    })).toBe('openSettings')
    expect(shortcutActionForInput(bindings, 'darwin', {
      type: 'keyDown', code: 'Comma', meta: true, isAutoRepeat: true,
    })).toBeUndefined()
    expect(shortcutActionForInput(bindings, 'darwin', {
      type: 'keyUp', code: 'Comma', meta: true,
    })).toBeUndefined()
  })
})

describe('DesktopShortcutController', () => {
  it('opens Settings in the renderer and executes window actions in the main process', () => {
    const send = vi.fn()
    const window = {
      isFullScreen: vi.fn(() => false),
      minimize: vi.fn(),
      setFullScreen: vi.fn(),
      webContents: { send },
    }
    const controller = new DesktopShortcutController(window as never, 'darwin', {
      openSettings: 'Meta+Comma',
      toggleFullScreen: 'Control+Meta+KeyF',
      minimizeWindow: 'Meta+KeyM',
    })

    controller.execute('openSettings')
    controller.execute('toggleFullScreen')
    controller.execute('minimizeWindow')

    expect(send).toHaveBeenCalledWith('dsh:electron:shortcut-action', 'openSettings')
    expect(window.setFullScreen).toHaveBeenCalledWith(true)
    expect(window.minimize).toHaveBeenCalledOnce()
  })

  it('suspends execution while the renderer records a replacement binding', () => {
    const controller = new DesktopShortcutController({ webContents: { send: vi.fn() } } as never, 'win32', {
      openSettings: 'Control+Comma',
      toggleFullScreen: 'F11',
    })
    controller.setCapturing(true)

    expect(controller.handle({ type: 'keyDown', code: 'F11' })).toBe(false)
  })
})

describe('bindDesktopShortcuts', () => {
  it('adopts Host updates, consumes matched input, and releases every listener', () => {
    let beforeInput: ((event: { preventDefault(): void }, input: unknown) => void) | undefined
    let capture: ((event: unknown, value: unknown) => void) | undefined
    let settingsUpdated: ((namespace: unknown, next: unknown) => void) | undefined
    const webContents = {
      mainFrame: {},
      on: vi.fn((_name: string, listener: typeof beforeInput) => { beforeInput = listener }),
      off: vi.fn(),
      send: vi.fn(),
    }
    const window = {
      webContents,
      isFullScreen: vi.fn(() => false),
      setFullScreen: vi.fn(),
      minimize: vi.fn(),
    }
    const ipcMain = {
      on: vi.fn((_name: string, listener: typeof capture) => { capture = listener }),
      off: vi.fn(),
    }
    const offSettings = vi.fn()
    const settings = { get: vi.fn(() => ({})) }
    const ctx = {
      get: vi.fn(() => settings),
      on: vi.fn((_name: string, listener: typeof settingsUpdated) => {
        settingsUpdated = listener
        return offSettings
      }),
    }
    const binding = bindDesktopShortcuts(window as never, ipcMain as never, ctx as never, 'win32')
    const initialEvent = { preventDefault: vi.fn() }
    beforeInput?.(initialEvent, { type: 'keyDown', code: 'F11' })
    expect(window.setFullScreen).toHaveBeenCalledWith(true)
    expect(initialEvent.preventDefault).toHaveBeenCalledOnce()

    settingsUpdated?.(DESKTOP_SHORTCUTS_HOST_NAMESPACE, {
      bindings: { win32: { toggleFullScreen: 'Control+Shift+KeyF' } },
    })
    const updatedEvent = { preventDefault: vi.fn() }
    beforeInput?.(updatedEvent, { type: 'keyDown', code: 'KeyF', control: true, shift: true })
    expect(window.setFullScreen).toHaveBeenCalledTimes(2)
    expect(updatedEvent.preventDefault).toHaveBeenCalledOnce()

    capture?.({ sender: webContents, senderFrame: webContents.mainFrame }, true)
    const ignored = { preventDefault: vi.fn() }
    beforeInput?.(ignored, { type: 'keyDown', code: 'KeyF', control: true, shift: true })
    expect(ignored.preventDefault).not.toHaveBeenCalled()

    binding.dispose()
    expect(offSettings).toHaveBeenCalledOnce()
    expect(ipcMain.off).toHaveBeenCalledOnce()
    expect(webContents.off).toHaveBeenCalledOnce()
  })
})
