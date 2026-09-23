import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { NotificationChannelRequest, NotificationChannelResult, NotificationExternalChannel } from './types.ts'

export const NOTIFICATION_CHANNEL_CREDENTIAL = credentialRef('INVESTMENT_NOTIFICATION_CHANNELS')
const CHANNELS: NotificationExternalChannel[] = ['serverchan', 'wecom', 'email']
const SECRET_FIELDS = { serverchan: 'sendkey', wecom: 'key', email: 'password' } as const
const FIELD_NAMES = {
  serverchan: ['sendkey'], wecom: ['key'], email: ['host', 'port', 'username', 'password', 'sender', 'recipient'],
} as const
interface ChannelConfiguration { revision: string; enabled: boolean; fields: Record<string, string> }
type Snapshot = Partial<Record<NotificationExternalChannel, ChannelConfiguration>>
type CredentialStore = Pick<CredentialProvider, 'resolve' | 'describe' | 'set'>
const configurationSchema = z.object({
  revision: z.string().regex(/^[\w-]{1,80}$/u), enabled: z.boolean(), fields: z.record(z.string(), z.string()),
}).strict()
const documentSchema = z.object({ version: z.literal(1), channels: z.object({
  serverchan: configurationSchema.optional(), wecom: configurationSchema.optional(), email: configurationSchema.optional(),
}).strict() }).strict()

/** A deliberate, credential-free error that may cross the Remote boundary. */
export class NotificationSettingsError extends Error {}

function normalizeFields(channel: NotificationExternalChannel, input: unknown): Record<string, string> {
  const parsed = z.record(z.string(), z.string().max(4096).regex(/^[^\r\n\0]*$/u)).safeParse(input)
  if (!parsed.success || Object.keys(parsed.data).some(key => !(FIELD_NAMES[channel] as readonly string[]).includes(key))) {
    throw new NotificationSettingsError('渠道参数格式不正确，请检查后重试。')
  }
  const normalized = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [key, key === 'password' ? value : value.trim()]))
  if (channel === 'wecom' && normalized.key?.startsWith('https://')) {
    try {
      const url = new URL(normalized.key)
      if (url.origin !== 'https://qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' || url.username || url.password || url.hash) throw new Error()
      normalized.key = url.searchParams.get('key') ?? ''
    } catch {
      throw new NotificationSettingsError('请填写企业微信官方机器人的 Webhook 地址或 key。')
    }
  }
  return normalized
}

function validateFields(channel: NotificationExternalChannel, fields: Record<string, string>): void {
  if (Object.keys(fields).length !== FIELD_NAMES[channel].length || FIELD_NAMES[channel].some(key => !fields[key])) throw new NotificationSettingsError('请填写完整的渠道参数。')
  if (channel === 'serverchan' && !/^SCT[A-Za-z0-9_-]+$/u.test(fields.sendkey ?? '')) throw new NotificationSettingsError('请填写 Server 酱 Turbo 的 SCT 开头 SendKey。')
  if (channel === 'wecom' && !/^[A-Za-z0-9_-]+$/u.test(fields.key ?? '')) throw new NotificationSettingsError('请填写有效的企业微信机器人 Webhook 或 key。')
  if (channel === 'email') {
    if (!/^[A-Za-z0-9.-]{1,253}$/u.test(fields.host ?? '')) throw new NotificationSettingsError('请填写 SMTP 服务器域名，不要填写网址。')
    if (!/^\d+$/u.test(fields.port ?? '') || Number(fields.port) < 1 || Number(fields.port) > 65535 || Number(fields.port) === 465) throw new NotificationSettingsError('请输入 STARTTLS 端口（通常为 587），不支持 465 隐式 TLS。')
    if (['sender', 'recipient'].some(key => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(fields[key] ?? ''))) throw new NotificationSettingsError('发件人和收件人必须是单个有效邮箱地址。')
  }
}

/** Owns persistence, version fencing and live synchronization, never environment files. */
export class NotificationSettings {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly credentials: CredentialStore, private readonly token: string, private readonly request = fetch) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation)
    this.pending = next.catch(() => {})
    return next
  }

  private async read(): Promise<Snapshot> {
    const stored = await this.credentials.resolve(NOTIFICATION_CHANNEL_CREDENTIAL)
    if (!stored) return {}
    try {
      const document = documentSchema.parse(JSON.parse(stored.value) as unknown)
      const snapshot: Snapshot = {}
      for (const [channel, config] of Object.entries(document.channels)) {
        if (config === undefined) continue
        const fields = normalizeFields(channel as NotificationExternalChannel, config.fields)
        validateFields(channel as NotificationExternalChannel, fields)
        snapshot[channel as NotificationExternalChannel] = { ...config, fields }
      }
      return snapshot
    } catch {
      throw new NotificationSettingsError('已保存的渠道配置无法读取，请检查当前实例的凭据存储。')
    }
  }

  private async call(baseUrl: string, operation: 'validate' | 'apply' | 'test', body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const response = await this.request(new URL(`/internal/notification-channels/${operation}`, baseUrl), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Notification-Token': this.token },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
      // Do not return/log provider, validation or HTTP bodies: they may contain submitted secrets.
      if (!response.ok) throw new Error()
      return await response.json() as Record<string, unknown>
    } catch {
      throw new NotificationSettingsError(operation === 'validate'
        ? '配置未通过校验：请检查必填项、SCT SendKey、企业微信 key 或邮箱与 STARTTLS 端口（不支持 465）。'
        : operation === 'test' ? '测试提交未确认。请先检查通知中心和接收端；再次查询会复用本次请求，避免重复发送。'
          : '配置同步未成功，请重试；未确认生效前不要开启新的通知类型。')
    }
  }

  sync(baseUrl: string, signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      // Corrupt/unreadable credentials must fail closed for external delivery, not disable holdings/research.
      const snapshot = await this.read().catch((): Snapshot => ({}))
      await this.call(baseUrl, 'apply', snapshot, signal)
    })
  }

  execute(baseUrl: string, request: NotificationChannelRequest): Promise<NotificationChannelResult> {
    return this.serial(async () => {
      if (!['describe', 'reset', 'save', 'remove', 'test'].includes(request.action)) throw new NotificationSettingsError('不支持的渠道操作。')
      const { snapshot, configurationInvalid } = request.action === 'reset'
        ? { snapshot: {} as Snapshot, configurationInvalid: false }
        : await this.read().then(
          snapshot => ({ snapshot, configurationInvalid: false }),
          () => ({ snapshot: {} as Snapshot, configurationInvalid: true }),
        )
      const info = await this.credentials.describe(NOTIFICATION_CHANNEL_CREDENTIAL)
      if (configurationInvalid && request.action !== 'describe') throw new NotificationSettingsError('当前实例的渠道配置无法读取，请先在设置中重置渠道配置。')
      if (request.action === 'reset') {
        if (!info.writable) throw new NotificationSettingsError('此配置由只读凭据来源管理，无法在当前应用修改。')
        try { await this.credentials.set(NOTIFICATION_CHANNEL_CREDENTIAL, JSON.stringify({ version: 1, channels: {} })) }
        catch { throw new NotificationSettingsError('渠道配置未重置，请检查当前实例的存储权限后重试。') }
      }
      if (request.action !== 'describe' && request.action !== 'reset') {
        if (!CHANNELS.includes(request.channel)) throw new NotificationSettingsError('不支持的通知渠道。')
        const previous = snapshot[request.channel]
        if ((previous?.revision ?? '') !== request.revision) throw new NotificationSettingsError('渠道配置已在其他窗口更新，请刷新后重试。')
        if (request.action === 'save' || request.action === 'remove') {
          if (!info.writable) throw new NotificationSettingsError('此配置由只读凭据来源管理，无法在当前应用修改。')
          if (request.action === 'remove') Reflect.deleteProperty(snapshot, request.channel)
          else {
            if (typeof request.enabled !== 'boolean') throw new NotificationSettingsError('启用状态不正确。')
            const fields = normalizeFields(request.channel, request.fields)
            const secret = SECRET_FIELDS[request.channel]
            if (!fields[secret] && previous?.fields[secret]) fields[secret] = previous.fields[secret]
            validateFields(request.channel, fields)
            snapshot[request.channel] = { revision: randomUUID(), enabled: request.enabled, fields }
          }
          await this.call(baseUrl, 'validate', snapshot)
          try { await this.credentials.set(NOTIFICATION_CHANNEL_CREDENTIAL, JSON.stringify({ version: 1, channels: snapshot })) }
          catch { throw new NotificationSettingsError('渠道配置未保存，请检查当前实例的存储权限后重试。') }
        }
      }
      let applied = true
      let deliveryEnabled = false
      try {
        const result = await this.call(baseUrl, 'apply', snapshot)
        deliveryEnabled = result.deliveryEnabled === true
      } catch { applied = false }
      let testNotificationId: string | undefined
      if (request.action === 'test') {
        if (!applied || !deliveryEnabled) throw new NotificationSettingsError('后台投递尚未就绪，不能发送测试。')
        if (!/^[\w-]{1,80}$/u.test(request.requestId)) throw new NotificationSettingsError('测试请求标识不正确。')
        const result = await this.call(baseUrl, 'test', { channel: request.channel, revision: request.revision, requestId: request.requestId })
        if (typeof result.id !== 'string') throw new NotificationSettingsError('测试提交未确认，请先检查通知中心。')
        testNotificationId = result.id
      }
      return {
        writable: info.writable, applied: applied && !configurationInvalid, deliveryEnabled, configurationInvalid,
        ...(testNotificationId ? { testNotificationId } : {}),
        channels: CHANNELS.map((channel) => {
          const config = snapshot[channel]
          return { channel, configured: !!config, enabled: config?.enabled ?? false, revision: config?.revision ?? '',
            secretConfigured: !!config?.fields[SECRET_FIELDS[channel]],
            // Only explicit non-secret fields are returned, never arbitrary stored properties.
            fields: channel === 'email' && config
              ? Object.fromEntries(['host', 'port', 'username', 'sender', 'recipient'].map(key => [key, config.fields[key] ?? ''])) : {},
          }
        }),
      }
    })
  }
}
