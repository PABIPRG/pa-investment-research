import { useState, type FormEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './web-auth.module.css'

type SessionState =
  | { state: 'disabled' }
  | { state: 'unavailable'; reason: 'configuration' | 'transport' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; username: string; csrfToken: string; expiresAt: number }

type LoginPhase = 'ready' | 'submitting' | 'invalid' | 'limited' | 'unavailable' | 'network' | 'transport' | 'expired' | 'success'

interface LoginGateProps {
  initialPhase: LoginPhase
  onLogin: (username: string, password: string) => Promise<'success' | 'invalid' | 'limited' | 'unavailable' | 'network' | 'transport'>
  onRetry: () => void
}

export function LoginGate({ initialPhase, onLogin, onRetry }: LoginGateProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState(initialPhase)
  const submitting = phase === 'submitting'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setPhase('submitting')
    setPhase(await onLogin(username, password))
  }
  const message = phase === 'invalid' ? '用户名或密码不正确，请重试。'
    : phase === 'limited' ? '尝试次数过多，请稍后再试。'
      : phase === 'unavailable' ? '管理员登录尚未配置完成，请联系部署管理员。'
        : phase === 'network' ? '无法连接到登录服务，请检查网络后重试。'
          : phase === 'transport' ? '当前连接未经过受信任的 HTTPS 入口，请使用部署管理员提供的安全地址。'
            : phase === 'expired' ? '登录已过期，请重新登录。'
              : phase === 'success' ? '验证成功，正在进入工作台…' : undefined
  return (
    <main className={css.page}>
      <section className={css.card} aria-labelledby="web-auth-title">
        <div className={css.brandMark} aria-hidden="true">DS</div>
        <p className={css.eyebrow}>DeepSeek Harness</p>
        <h1 id="web-auth-title" className={css.title}>管理员登录</h1>
        <p className={css.subtitle}>登录后可访问此设备上的投研工作台。</p>
        <form className={css.form} onSubmit={event => void submit(event)}>
          <label className={css.field}>
            <span>用户名</span>
            <Input autoComplete="username" autoFocus disabled={submitting || phase === 'unavailable' || phase === 'transport'}
              value={username} onChange={(event) => { setUsername(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span>密码</span>
            <Input type="password" autoComplete="current-password" disabled={submitting || phase === 'unavailable' || phase === 'transport'}
              value={password} onChange={(event) => { setPassword(event.target.value) }} />
          </label>
          {message !== undefined && <p className={phase === 'success' ? css.success : css.message} role="status">{message}</p>}
          <Button className={css.submit} variant="primary" type="submit"
            disabled={submitting || phase === 'unavailable' || phase === 'transport' || username === '' || password === ''}>
            {submitting ? '正在验证…' : '登录'}
          </Button>
          {(phase === 'unavailable' || phase === 'network' || phase === 'transport' || phase === 'limited') && (
            <Button className={css.retry} variant="ghost" type="button" onClick={onRetry}>重新检查</Button>
          )}
        </form>
        <p className={css.privacy}>会话仅保存在当前浏览器与服务进程中。</p>
      </section>
    </main>
  )
}

let csrfToken: string | undefined
let authRoot: Root | undefined
let expiryWatch: ReturnType<typeof setTimeout> | undefined

async function readSession(): Promise<SessionState> {
  const response = await fetch('/auth/session', { headers: { accept: 'application/json' } })
  return await response.json() as SessionState
}

async function loadBootManifest(): Promise<boolean> {
  try {
    const response = await fetch('/auth/boot', { headers: { accept: 'application/json' } })
    if (!response.ok) return false
    ;(globalThis as typeof globalThis & { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = await response.json()
    return true
  } catch { return false }
}

function installBridge(): void {
  ;(globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: unknown }).__DSH_WEB_AUTH__ = {
    csrfToken: () => csrfToken,
    unauthorized: () => {
      clearTimeout(expiryWatch)
      sessionStorage.setItem('dsh-auth-reason', 'expired')
      location.reload()
    },
    enabled: () => csrfToken !== undefined,
    logout: async () => {
      try {
        const response = await fetch('/auth/logout', {
          method: 'POST', headers: csrfToken === undefined ? {} : { 'x-dsh-csrf': csrfToken },
        })
        if (!response.ok && response.status !== 401) return 'error'
        clearTimeout(expiryWatch)
        csrfToken = undefined
        location.reload()
        return 'signed-out'
      } catch { return 'error' }
    },
  }
}

function watchExpiry(state: Extract<SessionState, { state: 'signed-in' }>): void {
  clearTimeout(expiryWatch)
  const delay = Math.max(250, state.expiresAt - Date.now() + 50)
  const verifyExpiry = async (): Promise<void> => {
    try {
      const latest = await readSession()
      if (latest.state === 'signed-in') { csrfToken = latest.csrfToken; watchExpiry(latest); return }
    } catch { /* the reload below presents the retryable unavailable state */ }
    sessionStorage.setItem('dsh-auth-reason', 'expired')
    location.reload()
  }
  expiryWatch = setTimeout(() => { void verifyExpiry() }, delay)
}

function showGate(el: HTMLElement, initialPhase: LoginPhase, onAuthenticated: () => Promise<void>): void {
  authRoot ??= createRoot(el)
  const retry = () => { void bootstrapWebAuth(el, onAuthenticated) }
  authRoot.render(<LoginGate key={initialPhase} initialPhase={initialPhase} onRetry={retry} onLogin={async (username, password) => {
    try {
      const response = await fetch('/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
      })
      if (response.status === 429) return 'limited'
      if (response.status === 503) return 'unavailable'
      if (response.status === 403) return 'transport'
      if (!response.ok) return 'invalid'
      const state = await response.json() as SessionState
      if (state.state !== 'signed-in') return 'unavailable'
      csrfToken = state.csrfToken
      watchExpiry(state)
      if (!await loadBootManifest()) return 'network'
      setTimeout(() => { void enterApp(onAuthenticated) }, 350)
      return 'success'
    } catch { return 'network' }
  }} />)
}

async function enterApp(onAuthenticated: () => Promise<void>): Promise<void> {
  authRoot?.unmount(); authRoot = undefined
  await onAuthenticated()
}

/** Resolve the auth gate before the existing Web application boot begins. */
export async function bootstrapWebAuth(el: HTMLElement, onAuthenticated: () => Promise<void>): Promise<void> {
  installBridge()
  showGate(el, 'submitting', onAuthenticated)
  try {
    const state = await readSession()
    if (state.state === 'disabled') {
      if (!await loadBootManifest()) { showGate(el, 'network', onAuthenticated); return }
      await enterApp(onAuthenticated); return
    }
    if (state.state === 'signed-in') {
      csrfToken = state.csrfToken; watchExpiry(state)
      if (!await loadBootManifest()) { showGate(el, 'network', onAuthenticated); return }
      await enterApp(onAuthenticated); return
    }
    const reason = sessionStorage.getItem('dsh-auth-reason')
    sessionStorage.removeItem('dsh-auth-reason')
    showGate(el, state.state === 'unavailable'
      ? state.reason === 'transport' ? 'transport' : 'unavailable'
      : reason === 'expired' ? 'expired' : 'ready', onAuthenticated)
  } catch { showGate(el, 'network', onAuthenticated) }
}
