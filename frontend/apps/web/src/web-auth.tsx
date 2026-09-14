import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './web-auth.module.css'

type SessionState =
  | { state: 'disabled' }
  | { state: 'unavailable'; reason: 'configuration' | 'transport' }
  | { state: 'signed-out'; captchaRequired?: boolean }
  | { state: 'signed-in'; username: string; csrfToken: string; expiresAt: number }

type LoginPhase = 'ready' | 'submitting' | 'invalid' | 'limited' | 'unavailable' | 'network' | 'transport' | 'expired' | 'success'
  | 'captcha-required' | 'captcha-invalid' | 'captcha-expired'
interface Captcha { id: string; image: string; expiresAt: number }
interface Proof { id: string; answer: string }
interface LoginOutcome { phase: LoginPhase; captcha?: Captcha; captchaRequired?: boolean }

interface LoginGateProps {
  initialPhase: LoginPhase
  initialCaptchaRequired?: boolean
  onLogin: (username: string, password: string, captcha?: Proof) => Promise<LoginOutcome>
  onRefresh: () => Promise<LoginOutcome>
  onRetry: () => void
}

export function LoginGate({ initialPhase, initialCaptchaRequired = false, onLogin, onRefresh, onRetry }: LoginGateProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState(initialPhase)
  const [captcha, setCaptcha] = useState<Captcha>()
  const [required, setRequired] = useState(initialCaptchaRequired)
  const [answer, setAnswer] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [expired, setExpired] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const form = useRef<HTMLFormElement>(null)
  const busy = useRef(false)
  const focusCaptcha = () => { form.current?.querySelector<HTMLInputElement>('#web-auth-captcha')?.focus() }
  const accept = (outcome: LoginOutcome) => {
    setPhase(outcome.phase)
    setAnswer('')
    if (outcome.captcha !== undefined) {
      setRequired(true); setCaptcha(outcome.captcha); setExpired(false); setImageFailed(false)
      setAnnouncement('验证码已更新，请输入图片中的 6 位数字。')
    } else if (outcome.captchaRequired === false || outcome.phase === 'success') {
      setRequired(false); setCaptcha(undefined)
    }
  }
  const refresh = async () => {
    if (busy.current) return
    busy.current = true; setRefreshing(true); setAnnouncement('正在刷新验证码…')
    try { accept(await onRefresh()) }
    catch { setPhase('network'); setAnnouncement('验证码刷新失败，请重试。') }
    finally { busy.current = false; setRefreshing(false); focusCaptcha() }
  }
  useEffect(() => { if (initialCaptchaRequired) void refresh() }, [])
  useEffect(() => {
    if (captcha === undefined) return
    focusCaptcha()
    const timer = setTimeout(() => { setExpired(true); setPhase('captcha-expired') }, Math.max(0, captcha.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [captcha])
  useEffect(() => {
    if (refreshing || !['invalid', 'network', 'captcha-invalid', 'captcha-required'].includes(phase)) return
    if (required) focusCaptcha()
    else form.current?.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')?.focus()
  }, [phase, refreshing, required])
  const submitting = phase === 'submitting'
  const blocked = submitting || refreshing || phase === 'success' || phase === 'unavailable' || phase === 'transport'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy.current || blocked || (required && (captcha === undefined || expired || imageFailed || !/^\d{6}$/.test(answer)))) return
    busy.current = true; setPhase('submitting'); setAnnouncement('正在验证…')
    try { accept(await onLogin(username, password, required && captcha !== undefined ? { id: captcha.id, answer } : undefined)) }
    catch { setPhase('network') }
    finally { busy.current = false; setAnnouncement('') }
  }
  const message = phase === 'invalid' ? '用户名或密码不正确，请重试。'
    : phase === 'limited' ? '尝试次数过多，请稍后再试。'
      : phase === 'unavailable' ? '管理员登录尚未配置完成，请联系部署管理员。'
        : phase === 'network' ? '无法连接到登录服务，请检查网络后重试。'
          : phase === 'transport' ? '当前连接未经过受信任的 HTTPS 入口，请使用部署管理员提供的安全地址。'
            : phase === 'expired' ? '登录已过期，请重新登录。'
              : phase === 'captcha-required' ? '请先完成验证码，再验证用户名和密码。'
                : phase === 'captcha-invalid' ? '验证码不正确，图片已更新，请重试。'
                  : phase === 'captcha-expired' ? '验证码已过期，请使用新图片；若未更新，请点击换一张。'
                    : phase === 'success' ? '验证成功，正在进入工作台…' : undefined
  return (
    <main className={css.page}>
      <section className={css.card} aria-labelledby="web-auth-title">
        <img className={css.brandMark} src="/icons/app-icon-001/icon-192.png" alt="投研智能体" />
        <p className={css.eyebrow}>投研智能体</p>
        <h1 id="web-auth-title" className={css.title}>管理员登录</h1>
        <p className={css.subtitle}>登录后可访问此设备上的投研工作台。</p>
        <form ref={form} className={css.form} onSubmit={event => void submit(event)} aria-busy={submitting || refreshing}>
          <label className={css.field}>
            <span>用户名</span>
            <Input autoComplete="username" autoFocus disabled={blocked}
              value={username} onChange={event => { setUsername(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span>密码</span>
            <Input type="password" autoComplete="current-password" disabled={blocked}
              value={password} onChange={event => { setPassword(event.target.value) }} />
          </label>
          {required && <div className={css.captcha}>
            <label className={css.captchaLabel} htmlFor="web-auth-captcha"><span>验证码</span></label>
            <div className={css.challengeRow}>
              <div className={css.challengeImage}>
                {captcha !== undefined && !imageFailed
                  ? <img src={captcha.image} alt="登录验证码，6 位数字" width="216" height="64" onError={() => { setImageFailed(true) }} />
                  : <span>{imageFailed ? '图片加载失败，请换一张' : '请点击换一张获取验证码'}</span>}
              </div>
              <Button type="button" variant="ghost" disabled={blocked} onClick={() => void refresh()}>
                {refreshing ? '刷新中…' : '换一张'}
              </Button>
            </div>
            <Input id="web-auth-captcha" inputMode="numeric" autoComplete="off" maxLength={6}
              aria-describedby="web-auth-captcha-help" disabled={blocked} value={answer}
              onChange={event => { setAnswer(event.target.value.replace(/[^0-9]/g, '').slice(0, 6)) }} />
            <p id="web-auth-captcha-help" className={css.captchaHelp}>输入图片中的 6 位数字，2 分钟内有效。看不清可换一张。图片验证暂不支持读屏识别，请联系部署管理员协助。</p>
          </div>}
          <p className={phase === 'success' ? css.success : phase === 'ready' || phase === 'submitting' ? css.status : css.message} role="status" aria-live="polite" aria-atomic="true">{submitting || refreshing ? announcement : message ?? announcement}</p>
          <Button className={css.submit} variant="primary" type="submit"
            disabled={blocked || username === '' || password === '' || (required && (captcha === undefined || expired || imageFailed || !/^\d{6}$/.test(answer)))}>
            {submitting ? '正在验证…' : phase === 'success' ? '正在进入…' : '登录'}
          </Button>
          {(phase === 'unavailable' || phase === 'network' || phase === 'transport' || phase === 'limited') && (
            <Button className={css.retry} variant="ghost" type="button" disabled={submitting || refreshing} onClick={onRetry}>重新检查</Button>
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

function showGate(el: HTMLElement, initialPhase: LoginPhase, onAuthenticated: () => Promise<void>, captchaRequired = false): void {
  authRoot ??= createRoot(el)
  const retry = () => { void bootstrapWebAuth(el, onAuthenticated) }
  const failure = (status: number, body: { code?: string; captcha?: Captcha }): LoginOutcome => ({
    phase: status === 429 ? 'limited' : status === 503 ? 'unavailable' : status === 403 ? 'transport'
      : body.code === 'captcha-required' || body.code === 'captcha-invalid' || body.code === 'captcha-expired' ? body.code : 'invalid',
    ...(body.captcha === undefined ? {} : { captcha: body.captcha }),
  })
  authRoot.render(<LoginGate key={`${initialPhase}-${String(captchaRequired)}`} initialPhase={initialPhase}
    initialCaptchaRequired={captchaRequired} onRetry={retry} onRefresh={async () => {
      const response = await fetch('/auth/captcha', { method: 'POST', headers: { accept: 'application/json' } })
      const body = await response.json() as { code?: string; captcha?: Captcha; captchaRequired?: boolean }
      if (!response.ok) return failure(response.status, body)
      return { phase: 'ready', ...body }
    }} onLogin={async (username, password, captcha) => {
      try {
        const response = await fetch('/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, captcha }),
        })
        if (!response.ok) return failure(response.status, await response.json() as { code?: string; captcha?: Captcha })
        const state = await response.json() as SessionState
        if (state.state !== 'signed-in') return { phase: 'unavailable' }
        csrfToken = state.csrfToken
        watchExpiry(state)
        if (!await loadBootManifest()) return { phase: 'network' }
        setTimeout(() => { void enterApp(onAuthenticated) }, 350)
        return { phase: 'success' }
      } catch { return { phase: 'network' } }
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
      : reason === 'expired' ? 'expired' : 'ready', onAuthenticated, state.state === 'signed-out' && state.captchaRequired === true)
  } catch { showGate(el, 'network', onAuthenticated) }
}
