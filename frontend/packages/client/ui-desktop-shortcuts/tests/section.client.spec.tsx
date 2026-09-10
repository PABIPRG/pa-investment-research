// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ShortcutsSection } from '../src/client/ShortcutsSection.tsx'
import { en } from '../src/client/locales.ts'
import type { DesktopShortcutsKey } from '../src/client/locales.ts'
import type { DesktopShortcutSettings } from '../src/shortcuts.ts'

afterEach(cleanup)

function mount(platform: 'darwin' | 'win32' = 'darwin', settings: DesktopShortcutSettings = {}) {
  const setCapture = vi.fn()
  const setBinding = vi.fn(async () => true)
  const resetBinding = vi.fn(async () => true)
  const resetAll = vi.fn(async () => true)
  render(<ShortcutsSection
    close={() => {}}
    openSection={() => {}}
    platform={platform}
    setCapture={setCapture}
    setBinding={setBinding}
    resetBinding={resetBinding}
    resetAll={resetAll}
    useSessions={(() => undefined) as never}
    useWorkspaces={(() => undefined) as never}
    useShortcuts={select => select({
      status: 'ready', value: settings, base: {}, user: {}, revision: 1, writable: true, mode: 'host',
    })}
    t={key => en[key as DesktopShortcutsKey]}
  />)
  return { setCapture, setBinding, resetBinding, resetAll }
}

describe('desktop shortcut Settings section', () => {
  it('shows native macOS defaults and records a valid replacement', async () => {
    const { setCapture, setBinding } = mount()
    expect(screen.getAllByText('⌘')).toHaveLength(3)
    const editor = screen.getByRole('button', { name: 'Change：Open Settings' })
    fireEvent.click(editor)
    expect(setCapture).toHaveBeenCalledWith(true)
    fireEvent.keyDown(editor, { code: 'KeyK', key: 'k', metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(setBinding).toHaveBeenCalledWith('openSettings', 'Shift+Meta+KeyK')
    })
    expect(setCapture).toHaveBeenLastCalledWith(false)
  })

  it('keeps Windows minimize system-managed and refuses collisions while recording', () => {
    const { setBinding } = mount('win32')
    expect(screen.getByText('System managed')).toBeTruthy()
    const editor = screen.getByRole('button', { name: 'Change：Open Settings' })
    fireEvent.click(editor)
    fireEvent.keyDown(editor, { code: 'F11', key: 'F11' })
    expect(screen.getByRole('alert').textContent).toContain('Toggle full screen')
    expect(setBinding).not.toHaveBeenCalled()
  })

  it('requires confirmation before resetting all current-platform customizations', async () => {
    const { resetAll } = mount('darwin', {
      bindings: { darwin: { openSettings: 'Meta+Shift+Comma' } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset this system' }))
    const confirmation = screen.getByRole('alertdialog')
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Reset' }))
    await vi.waitFor(() => { expect(resetAll).toHaveBeenCalledOnce() })
  })
})
