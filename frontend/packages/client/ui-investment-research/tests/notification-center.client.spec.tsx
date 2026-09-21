// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { NotificationCenter } from '../src/client/NotificationCenter.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as Window & { __DSH_ELECTRON__?: unknown }).__DSH_ELECTRON__
})

const ITEMS = [
  {
    id: 'c709d1d2-58c1-4d08-940c-20868df4dc44',
    category: 'market_risk', severity: 'important', title: '贵州茅台触发跌幅预警',
    summary: '日内跌幅达到 3%', body: '日内跌幅达到 3%，请复核持仓风险。',
    lastOccurredAt: '2026-09-15T10:00:00+08:00', readAt: null, occurrenceCount: 1,
    action: { kind: 'security', id: '600519' }, deliverySummary: { browser: 'sent' },
  },
  {
    id: '2c970df3-d362-4fcc-9c69-379a5b31fb55',
    category: 'research', severity: 'information', title: '盘前简报已生成',
    summary: '市场风险偏好回暖', body: '市场风险偏好回暖。',
    lastOccurredAt: '2026-09-15T09:00:00+08:00', readAt: null, occurrenceCount: 1,
    action: { kind: 'report', id: 'brief:pre:2026-09-15' }, deliverySummary: {},
  },
]

function requestMock() {
  return vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
    if (request.operation === 'trading-core.notification-capabilities') {
      return { browserPush: { available: false, vapidPublicKey: '' }, channels: [] }
    }
    if (request.operation === 'trading-core.notifications') {
      return { items: ITEMS, unreadCount: 2, nextCursor: null }
    }
    if (request.operation === 'trading-core.notification-read') {
      return { ...ITEMS[0], readAt: '2026-09-15T10:01:00+08:00' }
    }
    if (request.operation === 'trading-core.notification-preferences') return { items: [] }
    return {}
  })
}

describe('NotificationCenter', () => {
  it.each([
    ['security', '查看个股详情', 'stock-detail', { stockCode: '600519' }],
    ['portfolio-plan', '查看持仓止盈止损', 'dashboard', { holdingsFlow: 'view' }],
    ['report', '查看研究报告', 'dashboard', { openReports: true }],
    ['evolution', '查看自进化进展', 'tasks', undefined],
  ] as const)('uses the business destination for %s', async (kind, label, route, context) => {
    const item = { ...ITEMS[0], action: { kind, id: '600519' } }
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.notifications') return { items: [item], unreadCount: 1 }
      if (request.operation === 'trading-core.notification-read') return item
      return {}
    })
    const navigate = vi.fn()
    render(<NotificationCenter requestData={requestData} navigate={navigate} />)
    fireEvent.click(await screen.findByRole('button', { name: '消息中心，1 条未读' }))
    fireEvent.click(await screen.findByText('贵州茅台触发跌幅预警'))
    fireEvent.click(await screen.findByRole('button', { name: label }))
    expect(navigate).toHaveBeenCalledWith(route, context)
  })

  it('opens the existing holdings sync flow from an actionable notification', async () => {
    const item = { ...ITEMS[0], category: 'holdings_sync', severity: 'action_required',
      title: '持仓读取超时', summary: '同花顺未能在限定时间内完成读取。',
      body: '当前持仓保持不变。请在同花顺打开持仓页面，再重新读取。',
      action: { kind: 'holdings-sync', id: 'mac_ths' }, deliverySummary: { macos: 'pending' } }
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.notifications') return { items: [item], unreadCount: 1 }
      if (request.operation === 'trading-core.notification-read') return item
      return {}
    })
    const navigate = vi.fn()
    render(<NotificationCenter requestData={requestData} navigate={navigate} />)
    fireEvent.click(await screen.findByRole('button', { name: '消息中心，1 条未读' }))
    fireEvent.click(await screen.findByText(item.title))
    expect(await screen.findByText('系统通知发送状态')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '前往持仓同步' }))
    expect(navigate).toHaveBeenCalledWith('dashboard', { holdingsFlow: 'sync' })
    expect(screen.queryByRole('dialog', { name: '通知中心' })).toBeNull()
  })

  it('opens the unread dropdown without marking anything read, then opens detail in the large modal', async () => {
    const requestData = requestMock()
    render(<NotificationCenter requestData={requestData} navigate={vi.fn()} />)

    const bell = await screen.findByRole('button', { name: '消息中心，2 条未读' })
    fireEvent.click(bell)
    expect(await screen.findByText('贵州茅台触发跌幅预警')).toBeTruthy()
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.notification-read')).toBe(false)

    fireEvent.click(screen.getByText('贵州茅台触发跌幅预警'))
    expect(await screen.findByRole('dialog', { name: '通知中心' })).toBeTruthy()
    expect(screen.getByText('日内跌幅达到 3%，请复核持仓风险。')).toBeTruthy()
    await waitFor(() => {
      expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.notification-read')).toBe(true)
    })
    expect(screen.queryByText('选择一条通知')).toBeNull()
  })

  it('view all opens the notification modal with no auto-selected detail and no read mutation', async () => {
    const requestData = requestMock()
    render(<NotificationCenter requestData={requestData} navigate={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '消息中心，2 条未读' }))
    fireEvent.click(await screen.findByText('查看全部通知'))

    expect(await screen.findByRole('dialog', { name: '通知中心' })).toBeTruthy()
    expect(screen.getByText('选择一条通知')).toBeTruthy()
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.notification-read')).toBe(false)
  })

  it('returns focus to the persistent bell after closing view-all without changing the route', async () => {
    const navigate = vi.fn()
    render(<NotificationCenter requestData={requestMock()} navigate={navigate} />)
    const bell = await screen.findByRole('button', { name: '消息中心，2 条未读' })
    fireEvent.click(bell)
    const viewAll = await screen.findByRole('menuitem', { name: '查看全部通知' })
    viewAll.focus()
    fireEvent.click(viewAll)
    expect(await screen.findByRole('dialog', { name: '通知中心' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭通知中心' }))
    await waitFor(() => { expect(document.activeElement).toBe(bell) })
    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('offers an in-place undo after archiving a notification', async () => {
    const requestData = requestMock()
    render(<NotificationCenter requestData={requestData} navigate={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '消息中心，2 条未读' }))
    fireEvent.click(await screen.findByText('贵州茅台触发跌幅预警'))
    fireEvent.click(await screen.findByRole('button', { name: '归档' }))

    expect(await screen.findByText(/已归档“贵州茅台触发跌幅预警”/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => {
      const archiveCalls = requestData.mock.calls
        .map(([request]) => request)
        .filter(request => request.operation === 'trading-core.notification-archive')
      expect(archiveCalls).toHaveLength(2)
      expect(archiveCalls[0]?.input).toEqual({ notification_id: ITEMS[0]?.id, archived: true })
      expect(archiveCalls[1]?.input).toEqual({ notification_id: ITEMS[0]?.id, archived: false })
    })
  })

  it('puts app configuration before preferences and guidance without claiming credentials are configured', async () => {
    const requestData = requestMock()
    render(<NotificationCenter requestData={requestData} navigate={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '消息中心，2 条未读' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '查看全部通知' }))
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByText(/勾选渠道不代表已配置或发送成功/)).toBeTruthy()
    expect(screen.getByText('如何获取配置？')).toBeTruthy()
    expect(screen.queryByText(/backend.env/)).toBeNull()
    expect(screen.getByText(/此运行环境尚未提供本机渠道配置/)).toBeTruthy()
    const settingsTable = screen.getByRole('table', { name: '通知渠道设置' })
    const setup = screen.getByRole('region', { name: '外部渠道配置说明' })
    expect(settingsTable.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('region', { name: '外部渠道配置' }).compareDocumentPosition(settingsTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Server 酱 Turbo' }).getAttribute('href')).toBe('https://sct.ftqq.com/')
    expect(screen.getByText(/专用授权码/)).toBeTruthy()
    expect(screen.getByText(/不支持 465 隐式 TLS/)).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: '行情与风险 · 邮件' }) as HTMLInputElement).disabled).toBe(true)
    expect(requestData.mock.calls.every(([request]) => ['trading-core.notifications', 'trading-core.notification-preferences', 'trading-core.notification-capabilities'].includes(request.operation))).toBe(true)
  })

  it('loads detail by id when a macOS notification points outside the current list page', async () => {
    const external = {
      ...ITEMS[0],
      id: '5b49f931-b3ce-441a-a59e-1d7ac6c604f4',
      title: '旧通知仍可直达',
      body: '这条通知不在当前列表第一页。',
      readAt: '2026-09-15T10:02:00+08:00',
    }
    let listener: ((notificationId: string) => void) | undefined
    ;(window as Window & { __DSH_ELECTRON__?: unknown }).__DSH_ELECTRON__ = {
      watchNativeNotifications: (_id: string, receive: (notificationId: string) => void) => { listener = receive },
      unwatchNativeNotifications: vi.fn(),
    }
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.notification-capabilities') {
        return { browserPush: { available: false, vapidPublicKey: '' }, channels: [] }
      }
      if (request.operation === 'trading-core.notifications') return { items: [], unreadCount: 0 }
      if (request.operation === 'trading-core.notification') return external
      if (request.operation === 'trading-core.notification-read') return external
      return {}
    })
    render(<NotificationCenter requestData={requestData} navigate={vi.fn()} />)
    await waitFor(() => { expect(listener).toBeTypeOf('function') })

    await act(async () => { listener?.(external.id) })

    expect(await screen.findByRole('dialog', { name: '通知中心' })).toBeTruthy()
    expect(await screen.findByText('这条通知不在当前列表第一页。')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.notification', input: { notification_id: external.id },
    })
  })
})
