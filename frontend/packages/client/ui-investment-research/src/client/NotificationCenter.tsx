import { useCallback, useEffect, useMemo, useState } from 'react'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord, productErrorText, records, text } from './data.ts'
import type { RequestData } from './research-types.ts'
import type { InvestmentNavigationContext, InvestmentRoute } from './state.ts'
import css from './NotificationCenter.module.css'

type NotificationView = 'all' | 'unread' | 'actionable'
type NotificationCategory = 'market_risk' | 'holding_plan' | 'holdings_sync' | 'research'
type NotificationSeverity = 'action_required' | 'important' | 'information'
type NotificationChannel = 'browser' | 'macos' | 'serverchan' | 'wecom' | 'email'

interface NotificationItem {
  readonly id: string
  readonly category: NotificationCategory
  readonly severity: NotificationSeverity
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly lastOccurredAt: string
  readonly readAt?: string
  readonly occurrenceCount: number
  readonly action: { readonly kind: string; readonly id: string }
  readonly deliverySummary: Readonly<Record<string, string>>
}

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  market_risk: '行情与风险', holding_plan: '持仓计划', holdings_sync: '持仓同步', research: '投研进展',
}
const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  browser: '浏览器', macos: 'macOS 系统', serverchan: 'Server 酱', wecom: '企业微信', email: '邮件',
}
const SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  action_required: '需要处理', important: '重要', information: '信息',
}
const DELIVERY_LABELS: Record<string, string> = {
  pending: '等待投递', leased: '投递中', retry_wait: '等待重试', sent: '已送达',
  dead_letter: '投递失败', suppressed: '已抑制', cancelled: '已取消',
}

function parseItem(value: unknown): NotificationItem | undefined {
  const row = asRecord(value)
  const id = text(row.id, '')
  const category = text(row.category, '') as NotificationCategory
  const severity = text(row.severity, '') as NotificationSeverity
  if (id === '' || !(category in CATEGORY_LABELS) || !(severity in SEVERITY_LABELS)) return undefined
  const action = asRecord(row.action)
  const readAt = text(row.readAt, '')
  return {
    id,
    category,
    severity,
    title: text(row.title, '通知'),
    summary: text(row.summary, ''),
    body: text(row.body, text(row.summary, '')),
    lastOccurredAt: text(row.lastOccurredAt, ''),
    ...(readAt === '' ? {} : { readAt }),
    occurrenceCount: typeof row.occurrenceCount === 'number' ? row.occurrenceCount : 1,
    action: { kind: text(action.kind, 'none'), id: text(action.id, '') },
    deliverySummary: Object.fromEntries(Object.entries(asRecord(row.deliverySummary)).flatMap(([key, candidate]) => (
      typeof candidate === 'string' ? [[key, candidate]] : []
    ))),
  }
}

function parseList(value: unknown): { items: NotificationItem[]; unreadCount: number; nextCursor?: string } {
  const result = asRecord(value)
  const nextCursor = text(result.nextCursor, '')
  return {
    items: records(result.items).flatMap(item => parseItem(item) ?? []),
    unreadCount: typeof result.unreadCount === 'number' ? result.unreadCount : 0,
    ...(nextCursor === '' ? {} : { nextCursor }),
  }
}

function displayTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚刚'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function BellIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.6 8.2c0-3.2 2-5.2 5.4-5.2s5.4 2 5.4 5.2v3.2l1.4 2.1H3.2l1.4-2.1V8.2Z" />
      <path d="M8 15.5c.4.9 1.1 1.4 2 1.4s1.6-.5 2-1.4" />
    </svg>
  )
}

function deviceId(): string {
  const key = 'pa-investment-notification-device.v1'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const created = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `browser-${Date.now()}`
  window.localStorage.setItem(key, created)
  return created
}

function vapidKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const bytes = atob((value + padding).replace(/-/gu, '+').replace(/_/gu, '/'))
  const result = new ArrayBuffer(bytes.length)
  const view = new Uint8Array(result)
  for (let index = 0; index < bytes.length; index += 1) view[index] = bytes.charCodeAt(index)
  return result
}

async function enableBrowserPush(requestData: RequestData, publicKey: string): Promise<'enabled' | 'denied' | 'unavailable'> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || publicKey === '') return 'unavailable'
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission
  if (permission !== 'granted') return 'denied'
  const registration = await navigator.serviceWorker.register('/investment-notification-sw.js')
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKey(publicKey),
  })
  await requestData({
    operation: 'trading-core.notification-subscribe',
    input: {
      channel: 'browser',
      device_id: deviceId(),
      subscription: subscription.toJSON() as never,
    },
  })
  return 'enabled'
}

export interface NotificationCenterProps {
  readonly requestData: RequestData
  readonly navigate: (route: InvestmentRoute, context?: InvestmentNavigationContext) => void
}

export function NotificationCenter({ requestData, navigate }: NotificationCenterProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [tab, setTab] = useState<'notifications' | 'settings'>('notifications')
  const [view, setView] = useState<NotificationView>('all')
  const [category, setCategory] = useState<NotificationCategory | ''>('')
  const [severity, setSeverity] = useState<NotificationSeverity | ''>('')
  const [unreadItems, setUnreadItems] = useState<NotificationItem[]>([])
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [nextCursor, setNextCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedDetail, setSelectedDetail] = useState<NotificationItem>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preferences, setPreferences] = useState<Record<string, boolean>>({})
  const [preferenceBusy, setPreferenceBusy] = useState('')
  const [deliveryBusy, setDeliveryBusy] = useState('')
  const [archivedUndo, setArchivedUndo] = useState<NotificationItem>()
  const [pushState, setPushState] = useState<'checking' | 'enabled' | 'denied' | 'unavailable'>('checking')

  const refreshUnread = useCallback(async (): Promise<void> => {
    try {
      const parsed = parseList(await requestData({
        operation: 'trading-core.notifications', input: { view: 'unread', archived: false, limit: 6 },
      }))
      setUnreadItems(parsed.items)
      setUnreadCount(parsed.unreadCount)
    } catch {
      // The bell remains usable and retries on the next interval/open.
    }
  }, [requestData])

  const refreshList = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const input: Record<string, string | number | boolean> = { view, archived: false, limit: 50 }
      if (category) input.category = category
      if (severity) input.severity = severity
      const parsed = parseList(await requestData({
        operation: 'trading-core.notifications', input: input,
      }))
      setItems(parsed.items)
      setUnreadCount(parsed.unreadCount)
      setNextCursor(parsed.nextCursor)
    } catch (reason) {
      setError(productErrorText(reason, '通知暂时无法载入，请稍后重试。'))
    } finally {
      setLoading(false)
    }
  }, [category, requestData, severity, view])

  const loadMore = (): void => {
    if (!nextCursor || loading) return
    setLoading(true)
    const input: Record<string, string | number | boolean> = {
      view, archived: false, limit: 50, cursor: nextCursor,
    }
    if (category) input.category = category
    if (severity) input.severity = severity
    void requestData({
      operation: 'trading-core.notifications', input: input,
    }).then((value) => {
      const parsed = parseList(value)
      setItems(current => [...current, ...parsed.items.filter(item => !current.some(existing => existing.id === item.id))])
      setUnreadCount(parsed.unreadCount)
      setNextCursor(parsed.nextCursor)
    }, (reason: unknown) => { setError(productErrorText(reason, '更多通知暂时无法载入。')) })
      .finally(() => { setLoading(false) })
  }

  const loadPreferences = useCallback(async (): Promise<void> => {
    try {
      const response = asRecord(await requestData({ operation: 'trading-core.notification-preferences' }))
      setPreferences(Object.fromEntries(records(response.items).map(item => [
        `${text(item.category, '')}:${text(item.channel, '')}`,
        item.enabled === true,
      ])))
    } catch (reason) {
      setError(productErrorText(reason, '通知设置暂时无法载入。'))
    }
  }, [requestData])

  const openNotificationById = useCallback(async (notificationId: string): Promise<void> => {
    setSelectedId(notificationId)
    setSelectedDetail(undefined)
    setTab('notifications')
    setModalOpen(true)
    try {
      await requestData({
        operation: 'trading-core.notification-read', input: { notification_id: notificationId, read: true },
      })
      const detail = parseItem(await requestData({
        operation: 'trading-core.notification', input: { notification_id: notificationId },
      }))
      if (!detail) throw new Error('通知详情格式无效')
      setSelectedDetail(detail)
      await refreshUnread()
    } catch (reason) {
      setError(productErrorText(reason, '通知详情暂时无法载入，请稍后重试。'))
    }
  }, [refreshUnread, requestData])

  useEffect(() => {
    void refreshUnread()
    const timer = window.setInterval(() => { void refreshUnread() }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [refreshUnread])

  useEffect(() => {
    if (!modalOpen || tab !== 'notifications') return
    void refreshList()
  }, [modalOpen, refreshList, tab])

  useEffect(() => {
    if (!modalOpen || tab !== 'settings') return
    void loadPreferences()
  }, [loadPreferences, modalOpen, tab])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return
    let active = true
    void requestData({ operation: 'trading-core.notification-capabilities' })
      .then(async (value) => {
        const browserPush = asRecord(asRecord(value).browserPush)
        if (browserPush.available !== true) return 'unavailable' as const
        return enableBrowserPush(requestData, text(browserPush.vapidPublicKey, ''))
      })
      .then((result) => { if (active) setPushState(result) })
      .catch(() => { if (active) setPushState('unavailable') })
    const receive = (event: MessageEvent): void => {
      const id = text(asRecord(event.data).notificationId, '')
      if (id === '') return
      void openNotificationById(id)
    }
    const serviceWorker = (navigator as unknown as { serviceWorker?: ServiceWorkerContainer }).serviceWorker
    serviceWorker?.addEventListener('message', receive)
    return () => {
      active = false
      serviceWorker?.removeEventListener('message', receive)
    }
  }, [openNotificationById, requestData])

  useEffect(() => {
    const bridge = (window as Window & { __DSH_ELECTRON__?: unknown }).__DSH_ELECTRON__ as {
      watchNativeNotifications?: (id: string, listener: (notificationId: string) => void) => void
      unwatchNativeNotifications?: (id: string) => void
    } | undefined
    if (bridge?.watchNativeNotifications === undefined) return
    const listenerId = `investment-notifications-${Math.random().toString(36).slice(2)}`
    bridge.watchNativeNotifications(listenerId, (notificationId) => {
      void openNotificationById(notificationId)
    })
    return () => { bridge.unwatchNativeNotifications?.(listenerId) }
  }, [openNotificationById])

  const selected = useMemo(
    () => selectedDetail
      ?? items.find(item => item.id === selectedId)
      ?? unreadItems.find(item => item.id === selectedId),
    [items, selectedDetail, selectedId, unreadItems],
  )

  const openItem = useCallback((item: NotificationItem): void => {
    setMenuOpen(false)
    setTab('notifications')
    setSelectedId(item.id)
    setSelectedDetail(item.readAt ? item : { ...item, readAt: new Date().toISOString() })
    setModalOpen(true)
    if (item.readAt) return
    setItems(current => current.map(candidate => candidate.id === item.id
      ? { ...candidate, readAt: new Date().toISOString() }
      : candidate))
    setUnreadItems(current => current.filter(candidate => candidate.id !== item.id))
    setUnreadCount(current => Math.max(0, current - 1))
    void requestData({
      operation: 'trading-core.notification-read', input: { notification_id: item.id, read: true },
    }).then(() => refreshUnread(), () => { void refreshList() })
  }, [refreshList, refreshUnread, requestData])

  const openAll = (): void => {
    setMenuOpen(false)
    setSelectedId(undefined)
    setSelectedDetail(undefined)
    setTab('notifications')
    setModalOpen(true)
  }

  const markAllRead = (): void => {
    void requestData({ operation: 'trading-core.notifications-read-all' }).then(() => {
      setItems(current => current.map(item => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })))
      setUnreadItems([])
      setUnreadCount(0)
    }, (reason: unknown) => { setError(productErrorText(reason)) })
  }

  const archiveSelected = (): void => {
    if (!selected) return
    void requestData({
      operation: 'trading-core.notification-archive',
      input: { notification_id: selected.id, archived: true },
    }).then(() => {
      setArchivedUndo(selected)
      setItems(current => current.filter(item => item.id !== selected.id))
      setUnreadItems(current => current.filter(item => item.id !== selected.id))
      setSelectedId(undefined)
      setSelectedDetail(undefined)
      void refreshUnread()
    }, (reason: unknown) => { setError(productErrorText(reason)) })
  }

  const restoreArchived = (): void => {
    if (!archivedUndo) return
    const item = archivedUndo
    void requestData({
      operation: 'trading-core.notification-archive',
      input: { notification_id: item.id, archived: false },
    }).then(() => {
      setArchivedUndo(undefined)
      void refreshList()
      void refreshUnread()
    }, (reason: unknown) => { setError(productErrorText(reason, '无法撤销归档，请稍后重试。')) })
  }

  const retryDelivery = (channel: string): void => {
    if (!selected) return
    setDeliveryBusy(channel)
    void requestData({
      operation: 'trading-core.notification-delivery-retry',
      input: { notification_id: selected.id, channel },
    }).then(() => {
      setDeliveryBusy('')
      void refreshList()
    }, (reason: unknown) => {
      setDeliveryBusy('')
      setError(productErrorText(reason, '投递重试失败，请稍后再试。'))
    })
  }

  const followAction = (): void => {
    if (!selected) return
    const mapping: Record<string, InvestmentRoute> = {
      security: 'stock-detail', 'portfolio-plan': 'portfolio', 'holdings-sync': 'portfolio',
      report: 'portfolio', evolution: 'tasks',
    }
    const route = mapping[selected.action.kind]
    if (!route) return
    setModalOpen(false)
    navigate(route, route === 'stock-detail' ? { stockCode: selected.action.id } : undefined)
  }

  const updatePreference = (categoryValue: NotificationCategory, channel: NotificationChannel): void => {
    const key = `${categoryValue}:${channel}`
    const enabled = !(preferences[key] ?? false)
    setPreferenceBusy(key)
    void requestData({
      operation: 'trading-core.notification-preference-update',
      input: { category: categoryValue, channel, enabled },
    }).then((value) => {
      const response = asRecord(value)
      setPreferences(Object.fromEntries(records(response.items).map(item => [
        `${text(item.category, '')}:${text(item.channel, '')}`,
        item.enabled === true,
      ])))
      setPreferenceBusy('')
    }, (reason: unknown) => {
      setError(productErrorText(reason, '通知设置保存失败，请稍后重试。'))
      setPreferenceBusy('')
    })
  }

  const menuItems = unreadItems.length === 0
    ? [{ id: 'empty', label: <span className={css.menuEmpty}>暂无未读消息</span>, disabled: true }]
    : unreadItems.map(item => ({
      id: item.id,
      label: (
        <span className={css.menuItem}>
          <strong>{item.title}</strong>
          <small>{item.summary}</small>
          <time>{displayTime(item.lastOccurredAt)}</time>
        </span>
      ),
    }))

  return (
    <>
      <Menu
        open={menuOpen}
        align="end"
        portal
        className={css.menuRoot ?? ''}
        items={menuItems}
        footer={[{ id: 'view-all', label: '查看全部通知' }]}
        onClose={() => { setMenuOpen(false) }}
        onSelect={(id: string) => {
          if (id === 'view-all') { openAll(); return }
          const item = unreadItems.find(candidate => candidate.id === id)
          if (item) openItem(item)
        }}
        anchor={(
          <button
            type="button"
            className={css.bell}
            aria-label={`消息中心${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen(current => !current)
              if (!menuOpen) void refreshUnread()
            }}
          >
            <BellIcon />
            {unreadCount > 0 && <span className={css.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
        )}
      />
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false) }}
        title="通知中心"
        closeLabel="关闭通知中心"
        headless
        className={css.dialog}
      >
        <header className={css.header}>
          <div><h2>通知中心</h2><p>{unreadCount > 0 ? `${unreadCount} 条未读` : '所有通知均已读'}</p></div>
          <div className={css.tabs} role="tablist" aria-label="通知中心视图">
            <button type="button" role="tab" aria-selected={tab === 'notifications'} onClick={() => { setTab('notifications') }}>通知</button>
            <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => { setTab('settings') }}>设置</button>
          </div>
          <button type="button" className={css.close} aria-label="关闭通知中心" onClick={() => { setModalOpen(false) }}>×</button>
        </header>
        {tab === 'settings'
          ? (
            <section className={css.settings}>
              <div className={css.settingsIntro}>
                <div><h3>通知渠道</h3><p>站内信始终保留；这里控制后续事件是否投递到外部渠道。</p></div>
                <span data-state={pushState}>浏览器推送：{pushState === 'enabled' ? '已启用' : pushState === 'denied' ? '已拒绝' : pushState === 'checking' ? '检查中' : '未配置'}</span>
              </div>
              {error && <div className={css.error} role="alert">{error}</div>}
              <div className={css.preferenceTable} role="table" aria-label="通知渠道设置">
                <div className={css.preferenceHead} role="row"><span>类型</span>{Object.values(CHANNEL_LABELS).map(label => <span key={label}>{label}</span>)}</div>
                {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map(categoryValue => (
                  <div className={css.preferenceRow} role="row" key={categoryValue}>
                    <strong>{CATEGORY_LABELS[categoryValue]}</strong>
                    {(Object.keys(CHANNEL_LABELS) as NotificationChannel[]).map((channel) => {
                      const key = `${categoryValue}:${channel}`
                      return (
                        <label key={channel}>
                          <input
                            type="checkbox"
                            checked={preferences[key] ?? false}
                            disabled={preferenceBusy === key}
                            onChange={() => { updatePreference(categoryValue, channel) }}
                          />
                          <span>{CHANNEL_LABELS[channel]}</span>
                        </label>
                      )
                    })}
                  </div>
                ))}
              </div>
            </section>
          )
          : (
            <div className={css.workspace} data-detail-open={selected !== undefined}>
              <section className={css.listPane} aria-label="通知列表">
                {archivedUndo && <div className={css.undo} role="status">已归档“{archivedUndo.title}”<button type="button" onClick={restoreArchived}>撤销</button></div>}
                <div className={css.filters}>
                  <select aria-label="阅读状态" value={view} onChange={(event) => { setView(event.target.value as NotificationView) }}>
                    <option value="all">全部状态</option><option value="unread">未读</option><option value="actionable">需要处理</option>
                  </select>
                  <select aria-label="通知类型" value={category} onChange={(event) => { setCategory(event.target.value as NotificationCategory | '') }}>
                    <option value="">全部类型</option>{Object.entries(CATEGORY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                  <select aria-label="重要程度" value={severity} onChange={(event) => { setSeverity(event.target.value as NotificationSeverity | '') }}>
                    <option value="">全部级别</option>{Object.entries(SEVERITY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                  <button type="button" onClick={markAllRead} disabled={unreadCount === 0}>全部已读</button>
                </div>
                {error && <div className={css.error} role="alert">{error}<button type="button" onClick={() => { void refreshList() }}>重试</button></div>}
                {loading && items.length === 0
                  ? <div className={css.status} role="status">正在载入通知…</div>
                  : items.length === 0
                    ? <div className={css.status}><strong>这里暂时没有通知</strong><span>新的行情、计划、同步和投研进展会出现在这里。</span></div>
                    : (
                      <div className={css.list}>
                        {items.map(item => (
                          <button
                            type="button"
                            key={item.id}
                            className={css.listItem}
                            data-unread={!item.readAt}
                            aria-current={selectedId === item.id}
                            onClick={() => { openItem(item) }}
                          >
                            <span className={css.listMeta}>
                              <em>{CATEGORY_LABELS[item.category]}</em>
                              <time>{displayTime(item.lastOccurredAt)}</time>
                            </span>
                            <strong>{item.title}{item.occurrenceCount > 1 ? ` ×${item.occurrenceCount}` : ''}</strong>
                            <small>{item.summary}</small>
                          </button>
                        ))}
                        {nextCursor && <button type="button" className={css.loadMore} disabled={loading} onClick={loadMore}>{loading ? '正在载入…' : '载入更多通知'}</button>}
                      </div>
                    )}
              </section>
              <section className={css.detailPane} aria-label="通知详情">
                {selected
                  ? (
                    <article>
                      <button type="button" className={css.back} onClick={() => { setSelectedId(undefined); setSelectedDetail(undefined) }}>← 返回通知列表</button>
                      <div className={css.detailMeta}>
                        <span data-severity={selected.severity}>{SEVERITY_LABELS[selected.severity]}</span>
                        <time>{displayTime(selected.lastOccurredAt)}</time>
                      </div>
                      <h3>{selected.title}</h3>
                      <p>{selected.body}</p>
                      {Object.keys(selected.deliverySummary).length > 0 && (
                        <dl className={css.delivery}>
                          {Object.entries(selected.deliverySummary).map(([channel, status]) => (
                            <div key={channel}>
                              <dt>{Object.hasOwn(CHANNEL_LABELS, channel) ? CHANNEL_LABELS[channel as NotificationChannel] : channel}</dt>
                              <dd>
                                {DELIVERY_LABELS[status] ?? status}
                                {status === 'dead_letter' && <button type="button" disabled={deliveryBusy === channel} onClick={() => { retryDelivery(channel) }}>{deliveryBusy === channel ? '重试中…' : '重试'}</button>}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {Object.values(selected.deliverySummary).includes('dead_letter') && <p className={css.retryHint}>投递结果不明确时，人工重试可能造成重复发送。</p>}
                      <div className={css.detailActions}>
                        {selected.action.kind !== 'none' && <button type="button" className={css.primary} onClick={followAction}>前往相关内容</button>}
                        <button type="button" onClick={archiveSelected}>归档</button>
                      </div>
                    </article>
                  )
                  : <div className={css.detailEmpty}><strong>选择一条通知</strong><span>详情会在通知中心内显示，不会打开侧边栏。</span></div>}
              </section>
            </div>
          )}
      </Modal>
    </>
  )
}
