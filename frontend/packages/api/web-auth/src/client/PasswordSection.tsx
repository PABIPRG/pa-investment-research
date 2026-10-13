import { useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './PasswordSection.module.css'

type PasswordSectionProps = PropsRuntime<'settings.section'> & {
  username: string
  canChangePassword: boolean
  onSubmit: (current: string, next: string, confirmation: string) => Promise<string>
}
const errors = {
  'current-password-invalid': '当前密码不正确，请重新输入。',
  'password-weak': '新密码至少 12 个字符，不能全部为空白或重复同一字符。',
  'password-mismatch': '两次输入的新密码不一致。',
  'password-unchanged': '新密码必须与当前密码不同。',
  'password-change-disabled': '此实例尚未启用自助改密，请联系部署管理员。',
  'password-save-failed': '密码未能保存，原密码仍有效。请稍后重试或联系部署管理员。',
  'rate-limited': '尝试次数过多或已有修改正在进行，请稍后重试。',
  'password-change-expired': '登录已过期，请重新登录后修改。',
  unknown: '连接中断，修改结果尚未确认，请重新登录确认。',
}

/** The authentication owner contributes a credential form, never a settings document field. */
export function PasswordSection({ username, canChangePassword, onSubmit }: PasswordSectionProps) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy.current || !canChangePassword) return
    const characters = Array.from(next)
    const error = next !== confirmation ? 'password-mismatch'
      : characters.length < 12 || next.trim() === '' || new Set(characters).size === 1 ? 'password-weak'
        : current === next ? 'password-unchanged' : undefined
    if (error !== undefined) { setMessage(errors[error]); return }
    busy.current = true; setPending(true); setMessage('正在保存新密码…')
    try {
      const result = await onSubmit(current, next, confirmation)
      setMessage(result === 'changed' ? '密码已更新，请重新登录。' : (errors as Record<string, string>)[result] ?? '修改未完成，请重新登录后重试。')
      setCurrent(''); setNext(''); setConfirmation('')
    } catch { setMessage(errors.unknown); setCurrent(''); setNext(''); setConfirmation('') }
    finally { busy.current = false; setPending(false) }
  }
  return <section className={css.section} aria-labelledby="account-security-title">
    <h2 className={css.title} id="account-security-title">账号安全</h2>
    <p className={css.description}>用户名：<strong className={css.username}>{username}</strong>。如需修改用户名，请联系部署管理员。</p>
    <h3 className={css.subtitle}>修改密码</h3>
    <p className={css.description} id="password-change-help">新密码至少 12 个字符，不能全部为空白或重复同一字符。修改成功后，此实例所有已登录设备都需要重新登录，研究数据不会改变。</p>
    {!canChangePassword ? <p className={css.description} role="status">此实例尚未启用自助改密，请联系部署管理员。</p>
      : <form className={css.form} onSubmit={event => void submit(event)} aria-busy={pending} aria-describedby="password-change-help">
        <label className={css.field}><span>当前密码</span><Input type="password" autoComplete="current-password" required maxLength={4096} disabled={pending} value={current} onChange={(event) => { setCurrent(event.target.value) }} /></label>
        <label className={css.field}><span>新密码</span><Input type="password" autoComplete="new-password" required maxLength={4096} disabled={pending} value={next} onChange={(event) => { setNext(event.target.value) }} /></label>
        <label className={css.field}><span>确认新密码</span><Input type="password" autoComplete="new-password" required maxLength={4096} disabled={pending} value={confirmation} onChange={(event) => { setConfirmation(event.target.value) }} /></label>
        <p className={css.message} role="status" aria-live="polite">{message}</p>
        <div className={css.actions}>
          <Button type="submit" variant="primary" disabled={pending || !current || !next || !confirmation}>{pending ? '正在保存…' : '保存新密码'}</Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => { setCurrent(''); setNext(''); setConfirmation(''); setMessage('') }}>清空</Button>
        </div>
      </form>}
  </section>
}
