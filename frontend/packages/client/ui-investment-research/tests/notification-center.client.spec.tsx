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
