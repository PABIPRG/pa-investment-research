import { useState, type FormEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './web-auth.module.css'

type SessionState =
  | { state: 'disabled' }
  | { state: 'unavailable'; reason: 'configuration' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; username: string; csrfToken: string; expiresAt: number }

type LoginPhase = 'ready' | 'submitting' | 'invalid' | 'limited' | 'unavailable' | 'expired' | 'success'

interface LoginGateProps {
  initialPhase: LoginPhase
  onLogin: (username: string, password: string) => Promise<'success' | 'invalid' | 'limited' | 'unavailable'>
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
            <Input autoComplete="username" autoFocus disabled={submitting || phase === 'unavailable'}
              value={username} onChange={(event) => { setUsername(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span>密码</span>
            <Input type="password" autoComplete="current-password" disabled={submitting || phase === 'unavailable'}
              value={password} onChange={(event) => { setPassword(event.target.value) }} />
          </label>
          {message !== undefined && <p className={phase === 'success' ? css.success : css.message} role="status">{message}</p>}
          <Button className={css.submit} variant="primary" type="submit"
            disabled={submitting || phase === 'unavailable' || username === '' || password === ''}>
            {submitting ? '正在验证…' : '登录'}
          </Button>
          {(phase === 'unavailable' || phase === 'limited') && (
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

function installBridge(): void {
  ;(globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: unknown }).__DSH_WEB_AUTH__ = {
    csrfToken: () => csrfToken,
    unauthorized: () => {
      clearTimeout(expiryWatch)
      sessionStorage.setItem('dsh-auth-reason', 'expired')
      location.reload()
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
      if (!response.ok) return 'invalid'
      const state = await response.json() as SessionState
      if (state.state !== 'signed-in') return 'unavailable'
      csrfToken = state.csrfToken
      watchExpiry(state)
      setTimeout(() => { void enterApp(onAuthenticated, true) }, 350)
      return 'success'
    } catch { return 'unavailable' }
  }} />)
}

async function enterApp(onAuthenticated: () => Promise<void>, showLogout: boolean): Promise<void> {
  authRoot?.unmount(); authRoot = undefined
  await onAuthenticated()
  if (!showLogout) return
  const control = document.createElement('div')
  control.id = 'web-session-control'
  document.body.append(control)
  const logout = async (): Promise<void> => {
    clearTimeout(expiryWatch)
    await fetch('/auth/logout', { method: 'POST', headers: csrfToken === undefined ? {} : { 'x-dsh-csrf': csrfToken } })
    csrfToken = undefined
    location.reload()
  }
  createRoot(control).render(
    <Button size="sm" variant="outline" className={css.logout} onClick={() => { void logout() }}>退出登录</Button>,
  )
}

/** Resolve the auth gate before the existing Web application boot begins. */
export async function bootstrapWebAuth(el: HTMLElement, onAuthenticated: () => Promise<void>): Promise<void> {
  installBridge()
  showGate(el, 'submitting', onAuthenticated)
  try {
    const state = await readSession()
    if (state.state === 'disabled') { await enterApp(onAuthenticated, false); return }
    if (state.state === 'signed-in') {
      csrfToken = state.csrfToken; watchExpiry(state); await enterApp(onAuthenticated, true); return
    }
    const reason = sessionStorage.getItem('dsh-auth-reason')
    sessionStorage.removeItem('dsh-auth-reason')
    showGate(el, state.state === 'unavailable' ? 'unavailable' : reason === 'expired' ? 'expired' : 'ready', onAuthenticated)
  } catch { showGate(el, 'unavailable', onAuthenticated) }
}
