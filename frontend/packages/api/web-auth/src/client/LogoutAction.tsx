import { useState } from 'react'
import { IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './LogoutAction.module.css'

interface WebAuthBridge {
  enabled(): boolean
  logout(): Promise<'signed-out' | 'error'>
}

function bridge(): WebAuthBridge | undefined {
  return (globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: WebAuthBridge }).__DSH_WEB_AUTH__
}

/** Sidebar footer action for ending the current Web administrator session. */
export function LogoutAction({ wide }: PropsRuntime<'sidebar.footer.action'>) {
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'error'>('idle')
  const auth = bridge()
  if (auth?.enabled() !== true) return null
  const label = phase === 'submitting' ? '正在退出…' : phase === 'error' ? '退出失败，重试' : '退出登录'
  const submit = async (): Promise<void> => {
    if (phase === 'submitting') return
    setPhase('submitting')
    const result = await auth.logout()
    if (result === 'error') setPhase('error')
  }
  return (
    <Tooltip label={label} side="right" delayMs={500}>
      <button
        type="button"
        className={`${css.action} ${wide ? css.wide : css.rail} ${phase === 'error' ? css.error : ''}`}
        aria-label={label}
        aria-live="polite"
        disabled={phase === 'submitting'}
        onClick={() => { void submit() }}
      >
        <IconUserOutline16 size={16} />
        {wide && <span className={css.label}>{label}</span>}
      </button>
    </Tooltip>
  )
}
