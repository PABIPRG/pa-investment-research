/** Electron desktop shortcut editor rendered as one Settings section. */

import { useEffect, useState, type KeyboardEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DESKTOP_SHORTCUT_ACTIONS,
  effectiveShortcutBindings,
  formatShortcut,
  normalizeShortcutInput,
  shortcutConflict,
  type DesktopShortcutAction,
  type DesktopShortcutPlatform,
  type DesktopShortcutSettings,
  type ShortcutInputFailure,
} from '../shortcuts.ts'
import type { DesktopShortcutsKey } from './locales.ts'
import css from './ShortcutsSection.module.css'

/** Settings and Electron actions injected by the plugin registration. */
export interface ShortcutsSectionInjected {
  hooks: {
    shortcuts: Pick<SettingsScope<DesktopShortcutSettings>, 'getSnapshot' | 'subscribe'>
  }
  platform: DesktopShortcutPlatform
  setCapture: (active: boolean) => void
  setBinding: (action: DesktopShortcutAction, binding: string) => Promise<boolean>
  resetBinding: (action: DesktopShortcutAction) => Promise<boolean>
  resetAll: () => Promise<boolean>
}

/** Full section props. */
export type ShortcutsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.desktop-shortcuts'>
  & InjectFace<ShortcutsSectionInjected>

const ACTION_COPY: Readonly<Record<DesktopShortcutAction, {
  label: DesktopShortcutsKey
  description: DesktopShortcutsKey
}>> = {
  openSettings: { label: 'openSettings', description: 'openSettingsDescription' },
  toggleFullScreen: { label: 'toggleFullScreen', description: 'toggleFullScreenDescription' },
  minimizeWindow: { label: 'minimizeWindow', description: 'minimizeWindowDescription' },
}

const FAILURE_COPY: Readonly<Record<ShortcutInputFailure, DesktopShortcutsKey>> = {
  'key-required': 'keyRequired',
  'modifier-required': 'modifierRequired',
  'unsupported-key': 'unsupportedKey',
  'system-reserved': 'systemReserved',
}

function interpolate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)
}

/** Render the platform-specific shortcut editor. */
export function ShortcutsSection({
  platform, setCapture, setBinding, resetBinding, resetAll, useShortcuts, t,
}: ShortcutsSectionProps) {
  const snapshot = useShortcuts(value => value)
  const [recording, setRecording] = useState<DesktopShortcutAction | undefined>()
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const settings = snapshot.value ?? {}
  const effective = effectiveShortcutBindings(settings, platform)
  const custom = settings.bindings?.[platform] ?? {}
  const writable = snapshot.status === 'ready' && snapshot.writable
  const platformLabel = t(platform === 'darwin' ? 'platformDarwin' : platform === 'win32' ? 'platformWin32' : 'platformLinux')

  useEffect(() => () => { setCapture(false) }, [setCapture])

  const stopRecording = (): void => {
    setRecording(undefined)
    setCapture(false)
  }
  const runWrite = async (write: () => Promise<boolean>, success: DesktopShortcutsKey): Promise<void> => {
    stopRecording()
    setBusy(true)
    setNotice('')
    setError('')
    const saved = await write()
    setBusy(false)
    if (saved) setNotice(t(success))
    else setError(t('saveFailed'))
  }
  const onRecord = (action: DesktopShortcutAction, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (recording !== action) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      stopRecording()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      void runWrite(() => resetBinding(action), 'resetSaved')
      return
    }
    const result = normalizeShortcutInput({
      code: event.code,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    }, platform)
    if (!result.ok) {
      setError(t(FAILURE_COPY[result.reason]))
      return
    }
    const conflict = shortcutConflict(effective, action, result.binding)
    if (conflict !== undefined) {
      setError(interpolate(t('conflict'), { action: t(ACTION_COPY[conflict].label) }))
      return
    }
    void runWrite(() => setBinding(action, result.binding), 'saved')
  }

  return (
    <section className={css.section} aria-labelledby="desktop-shortcuts-title">
      <div className={css.headingRow}>
        <div>
          <h2 className={css.title} id="desktop-shortcuts-title">{t('title')}</h2>
          <p className={css.intro}>{t('description')}</p>
          <p className={css.platform}>{interpolate(t('platformSummary'), { platform: platformLabel })}</p>
        </div>
      </div>

      {snapshot.status === 'loading' && <p className={css.state} role="status">{t('loading')}</p>}
      {(snapshot.status === 'unavailable' || (snapshot.status === 'ready' && !snapshot.writable)) && (
        <p className={css.warning} role="status">{t('unavailable')}</p>
      )}

      <div className={css.rows}>
        {DESKTOP_SHORTCUT_ACTIONS.map((action) => {
          const binding = effective[action]
          const isRecording = recording === action
          const isCustom = custom[action] !== undefined
          return (
            <div className={css.row} key={action}>
              <div className={css.rowCopy}>
                <div className={css.rowTitle}>
                  {t(ACTION_COPY[action].label)}
                  {isCustom && <span className={css.badge}>{t('custom')}</span>}
                </div>
                <p className={css.rowDescription}>{t(ACTION_COPY[action].description)}</p>
              </div>
              <button
                type="button"
                className={css.binding}
                disabled={!writable || busy}
                aria-label={`${t('edit')}：${t(ACTION_COPY[action].label)}`}
                aria-pressed={isRecording}
                onClick={() => {
                  setRecording(action)
                  setCapture(true)
                  setNotice('')
                  setError('')
                }}
                onBlur={() => { if (isRecording) stopRecording() }}
                onKeyDown={(event) => { onRecord(action, event) }}
              >
                {isRecording
                  ? <span className={css.recording}>{t('recording')}</span>
                  : binding === undefined
                    ? <span className={css.systemManaged}>{t('systemManaged')}</span>
                    : <span className={css.keycaps}>{formatShortcut(binding, platform).map(key => <kbd key={key}>{key}</kbd>)}</span>}
              </button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t('resetOne')}：${t(ACTION_COPY[action].label)}`}
                disabled={!writable || busy || !isCustom}
                onClick={() => { void runWrite(() => resetBinding(action), 'resetSaved') }}
              >
                {t('resetOne')}
              </Button>
            </div>
          )
        })}
      </div>

      {confirmReset && (
        <div
          className={css.confirmation}
          role="alertdialog"
          aria-label={t('resetAll')}
          aria-describedby="desktop-shortcuts-reset-description"
        >
          <p id="desktop-shortcuts-reset-description">{t('resetConfirm')}</p>
          <div className={css.confirmActions}>
            <Button size="sm" variant="ghost" onClick={() => { setConfirmReset(false) }}>{t('cancel')}</Button>
            <Button
              size="sm"
              variant="primary"
              autoFocus
              disabled={busy}
              onClick={() => {
                setConfirmReset(false)
                void runWrite(resetAll, 'resetSaved')
              }}
            >
              {t('confirm')}
            </Button>
          </div>
        </div>
      )}
      {error !== '' && <p className={css.error} role="alert">{error}</p>}
      {notice !== '' && <p className={css.success} role="status" aria-live="polite">{notice}</p>}
      <div className={css.footer}>
        <Button
          variant="outline"
          disabled={!writable || busy || Object.keys(custom).length === 0}
          onClick={() => { setConfirmReset(true); setNotice(''); setError('') }}
        >
          {t('resetAll')}
        </Button>
      </div>
    </section>
  )
}
