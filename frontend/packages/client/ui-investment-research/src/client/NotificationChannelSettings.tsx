import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NotificationChannelResult, NotificationChannelStatus, NotificationExternalChannel } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { RequestData, RequestNotificationChannels } from './research-types.ts'
import { asRecord, productErrorText, text } from './data.ts'
import css from './NotificationChannelSettings.module.css'

interface ChannelDefinition {
  channel: NotificationExternalChannel
  title: string
  subtitle: string
  fields: { key: string; label: string; secret?: boolean; placeholder: string }[]
}
const CHANNELS: ChannelDefinition[] = [
  { channel: 'serverchan', title: 'Server 酱', subtitle: '发送到 SendKey 绑定的接收通道', fields: [
    { key: 'sendkey', label: 'SendKey', secret: true, placeholder: 'SCT 开头的完整 SendKey' },
  ] },
  { channel: 'wecom', title: '企业微信', subtitle: '发送到群机器人所在的群', fields: [
    { key: 'key', label: '机器人 Webhook', secret: true, placeholder: '粘贴完整 Webhook 地址或 key' },
  ] },
  { channel: 'email', title: '邮件', subtitle: '通过 SMTP + STARTTLS 发送到指定邮箱', fields: [
    { key: 'host', label: 'SMTP 服务器', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'STARTTLS 端口', placeholder: '587（不支持 465）' },
    { key: 'username', label: 'SMTP 登录账号', placeholder: '发件邮箱的登录账号' },
    { key: 'password', label: 'SMTP 授权码 / 密码', secret: true, placeholder: '邮箱提供的专用授权码' },
    { key: 'sender', label: '发件人邮箱', placeholder: 'sender@example.com' },
    { key: 'recipient', label: '收件人邮箱', placeholder: 'receiver@example.com' },
  ] },
]

interface TestState { channel: NotificationExternalChannel; revision: string; id: string; state: string; generation: number }

export function NotificationChannelSettings({ request, requestData, onStatus }: {
  request?: RequestNotificationChannels | undefined
  requestData: RequestData
  onStatus: (status: NotificationChannelResult | undefined) => void
}) {
  const [status, setStatus] = useState<NotificationChannelResult>()
  const [editing, setEditing] = useState<NotificationExternalChannel>()
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<NotificationExternalChannel>()
  const [test, setTest] = useState<TestState>()
  const [resetting, setResetting] = useState(false)
  const testGeneration = useRef(0)
  const testRequest = useRef<{ channel: NotificationExternalChannel; revision: string; id: string }>()
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])

  const accept = useCallback((result: NotificationChannelResult) => {
    const attempt = testRequest.current
    if (attempt && result.channels.find(item => item.channel === attempt.channel)?.revision !== attempt.revision) {
      testGeneration.current += 1
      testRequest.current = undefined
      setTest(undefined)
    }
    setStatus(result)
    onStatus(result)
  }, [onStatus])
  const refresh = useCallback(async () => {
    if (!request) return
    setEditing(undefined)
    setFields({})
    setBusy(true)
    setError('')
    try {
      const result = await request({ action: 'describe' })
      if (active.current) accept(result)
    } catch (reason) { if (active.current) setError(productErrorText(reason, '渠道配置暂不可用，请重试。')) }
    finally { if (active.current) setBusy(false) }
  }, [request, accept])
  useEffect(() => { void refresh() }, [refresh])

  const pollTest = useCallback(async (candidate: TestState) => {
    try {
      const response = asRecord(await requestData({ operation: 'trading-core.notification', input: { notification_id: candidate.id } }))
      if (active.current && testGeneration.current === candidate.generation) setTest({ ...candidate, state: text(asRecord(response.deliverySummary)[candidate.channel], 'pending') })
    } catch { if (active.current && testGeneration.current === candidate.generation) setError('暂时无法查询测试结果，请检查通知中心或点击更新状态；不会自动重发。') }
  }, [requestData])
  useEffect(() => {
    if (!test || !['pending', 'leased', 'retry_wait'].includes(test.state)) return
    const timer = window.setInterval(() => { void pollTest(test) }, 2_000)
    const deadline = window.setTimeout(() => { window.clearInterval(timer) }, 30_000)
    return () => { window.clearInterval(timer); window.clearTimeout(deadline) }
  }, [test?.id, test?.channel, test?.state, test?.generation, pollTest])

  const commit = async (current: NotificationChannelStatus | undefined, channel: NotificationExternalChannel, action: 'save' | 'remove', enabled = true, values = fields) => {
    if (!request || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await request(action === 'remove'
        ? { action, channel, revision: current?.revision ?? '' }
        : { action, channel, revision: current?.revision ?? '', enabled, fields: values })
      if (!active.current) return
      accept(result)
      setEditing(undefined); setFields({}); setRemoving(undefined); setTest(undefined)
      testRequest.current = undefined; testGeneration.current += 1
      setNotice(result.applied ? (action === 'remove' ? '配置已移除，后续不再向此渠道投递。' : !enabled ? '渠道已停用，尚未发送的旧任务已取消。' : '配置已保存并生效，无需重启。请选择下方通知类型，或先发送测试。') : '配置已保存，但后台同步未确认。请点击刷新状态重试同步。')
    } catch (reason) { if (active.current) setError(productErrorText(reason, '未能保存渠道配置，请重试。')) }
    finally { if (active.current) setBusy(false) }
  }

  const sendTest = async (current: NotificationChannelStatus) => {
    if (!request || busy) return
    const previous = testRequest.current
    const attempt = previous?.channel === current.channel && previous.revision === current.revision ? previous
      : { channel: current.channel, revision: current.revision, id: crypto.randomUUID() }
    testRequest.current = attempt
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await request({ action: 'test', channel: current.channel, revision: current.revision, requestId: attempt.id })
      if (!active.current) return
      accept(result)
      if (result.testNotificationId) {
        const next: TestState = { channel: current.channel, revision: current.revision, id: result.testNotificationId, state: 'pending', generation: ++testGeneration.current }
        setTest(next)
        await pollTest(next)
      }
    } catch (reason) { if (active.current) setError(productErrorText(reason, '测试提交未确认，请先检查接收端。再次点击会查询同一请求，不会另发一条。')) }
    finally { if (active.current) setBusy(false) }
  }

  return <section className={css.root} aria-label="外部渠道配置">
    <div className={css.heading}><h3>接收渠道</h3><Button variant="outline" disabled={busy || !request} onClick={() => { void refresh() }}>刷新状态</Button></div>
    {!request && <p role="status">当前实例暂未提供渠道配置，请联系实例管理员更新应用。</p>}
    {request && !status && !error && <p role="status">正在读取渠道状态…</p>}
    {status?.configurationInvalid && <div className={css.confirm} role="alert"><p>当前实例的渠道配置无法读取，其他投研功能不受影响。请重置后重新填写；后台同步未确认时，旧投递配置可能仍在生效。</p>
      {!resetting ? <Button disabled={!status.writable || busy} onClick={() => { setResetting(true) }}>重置渠道配置</Button> : <>
        <p>确认清空当前实例三个外部渠道的凭据？通知记录和类型偏好会保留。</p>
        <div className={css.actions}><Button disabled={busy} onClick={() => {
          if (!request) return
          setBusy(true); setError('')
          void request({ action: 'reset' }).then((result) => {
            if (active.current) { accept(result); setResetting(false) }
          }, (reason: unknown) => {
            if (active.current) setError(productErrorText(reason, '重置未成功，请重试。'))
          }).finally(() => { if (active.current) setBusy(false) })
        }}>确认重置</Button><Button onClick={() => { setResetting(false) }}>取消</Button></div></>}
    </div>}
    {status && !status.applied && !status.configurationInvalid && <p role="alert">后台同步未确认，外部渠道暂不可启用。请刷新状态重试。</p>}
    {status?.applied && !status.deliveryEnabled && <p role="alert">后台投递服务已停用。配置仍可保存，但不会发送外部通知；请由实例管理员恢复投递服务。</p>}
    {status && !status.writable && <p>当前配置来自只读凭据来源，仅可查看状态或测试，不能在此修改。</p>}
    {error && <p className={css.error} role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {CHANNELS.map(({ channel, title, subtitle, fields: fieldDefinitions }) => {
      const current = status?.channels.find(item => item.channel === channel)
      const thisTest = test?.channel === channel ? test : undefined
      const pending = thisTest && ['pending', 'leased', 'retry_wait'].includes(thisTest.state)
      return <section key={channel} className={css.card} aria-label={`${title}配置`}>
        <div className={css.cardHeader}>
          <div><h4>{title}<span>{current?.configured ? current.enabled ? '已配置 · 已启用' : '已配置 · 已停用' : '未配置'}</span></h4><p>{subtitle}</p></div>
          <div className={css.actions}>
            <Button variant="outline" disabled={!status?.writable || status.configurationInvalid || busy} onClick={() => { setEditing(channel); setFields({ ...(current?.fields ?? {}), ...(channel === 'email' && !current?.configured ? { port: '587' } : {}) }); setError(''); setNotice(''); setRemoving(undefined) }}>{current?.configured ? '编辑配置' : '配置'}</Button>
            {current?.configured && <Button variant="outline" disabled={busy || !status?.applied || !status.deliveryEnabled || !current.enabled} onClick={() => { if (thisTest) void pollTest(thisTest); else void sendTest(current) }}>{thisTest ? '查询本次测试' : '发送测试'}</Button>}
            {current?.configured && <Button disabled={busy || !status?.writable} onClick={() => { void commit(current, channel, 'save', !current.enabled, current.fields) }}>{current.enabled ? '停用' : '启用'}</Button>}
          </div>
        </div>
        {editing === channel && <form className={css.form} onSubmit={(event) => { event.preventDefault(); void commit(current, channel, 'save', current?.configured ? current.enabled : true) }}>
          <div className={css.fields}>{fieldDefinitions.map(field => <label key={field.key}>
            <span>{field.label}</span>
            <Input aria-label={`${title} · ${field.label}`} type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} required={!field.secret || !current?.secretConfigured} value={fields[field.key] ?? ''} placeholder={field.secret && current?.secretConfigured ? '已保存，留空保留原值' : field.placeholder} onChange={(event) => { setFields(values => ({ ...values, [field.key]: event.target.value })) }} disabled={busy} />
          </label>)}</div>
          <p>密钥不回显。保存或停用会取消旧配置的待发任务；已开始发送的消息无法撤回。</p>
          <div className={css.actions}><Button type="submit" variant="primary" disabled={busy}>{busy ? '保存中…' : '保存配置'}</Button><Button disabled={busy} onClick={() => { setEditing(undefined); setFields({}); setRemoving(undefined); setError('') }}>取消</Button>
            {current?.configured && <Button disabled={busy} onClick={() => { setRemoving(channel) }}>移除配置</Button>}</div>
          {removing === channel && <div className={css.confirm} role="alert"><p>确认移除当前实例的 {title} 配置？此操作会停止后续投递。</p><Button disabled={busy} onClick={() => { void commit(current, channel, 'remove') }}>确认移除</Button><Button onClick={() => { setRemoving(undefined) }}>保留配置</Button></div>}
        </form>}
        {thisTest && <div className={css.test} role="status">
          <p>{pending ? '测试已入队，等待后台发送；尚未确认成功。' : thisTest.state === 'sent' ? '渠道服务已接受测试，请到接收端核对。' : thisTest.state === 'dead_letter' ? '测试未确认成功，请检查凭据、服务权限和接收端；不会自动重试，消息也可能已经送达。' : '测试已取消或受规则限制，未确认发送。'}</p>
          <div className={css.actions}><Button onClick={() => { void pollTest(thisTest) }}>更新状态</Button>
            {!pending && <Button onClick={() => { testRequest.current = undefined; testGeneration.current += 1; setTest(undefined); setNotice('可重新发送测试。请先核对接收端，避免重复消息。') }}>准备新的测试</Button>}</div>
        </div>}
      </section>
    })}
  </section>
}
