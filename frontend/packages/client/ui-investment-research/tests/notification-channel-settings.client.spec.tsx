// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { NotificationChannelRequest, NotificationChannelResult } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { NotificationChannelSettings } from '../src/client/NotificationChannelSettings.tsx'

afterEach(cleanup)
function result(configured = false): NotificationChannelResult {
  return { applied: true, writable: true, deliveryEnabled: true, channels: [
    { channel: 'serverchan', configured, enabled: configured, revision: configured ? 'one' : '', fields: {}, secretConfigured: configured },
    { channel: 'wecom', configured: false, enabled: false, revision: '', fields: {}, secretConfigured: false },
    { channel: 'email', configured: false, enabled: false, revision: '', fields: {}, secretConfigured: false },
  ] }
}

describe('NotificationChannelSettings', () => {
  it('ignores an old poll after saving a new revision and query never sends a new test', async () => {
    const request = vi.fn(async (input: NotificationChannelRequest) => {
      const status = result(true)
      if (input.action === 'save') status.channels[0] = { ...status.channels[0]!, revision: 'two', enabled: false }
      return { ...status, ...(input.action === 'test' ? { testNotificationId: 'test-one' } : {}) }
    })
    const delayed = Promise.withResolvers<{ deliverySummary: { serverchan: string } }>()
    const requestData = vi.fn(async () => ({ deliverySummary: { serverchan: 'pending' } }))
    render(<NotificationChannelSettings request={request} requestData={requestData} onStatus={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '发送测试' }))
    await screen.findByText(/测试已入队/)
    await waitFor(() =>{  expect((screen.getByRole('button', { name: '停用' }) as HTMLButtonElement).disabled).toBe(false) })
    requestData.mockReturnValueOnce(delayed.promise)
    fireEvent.click(screen.getByRole('button', { name: '查询本次测试' }))
    expect(request.mock.calls.filter(([input]) => input.action === 'test')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '停用' }))
    await screen.findByRole('button', { name: '启用' })
    await act(async () => { delayed.resolve({ deliverySummary: { serverchan: 'sent' } }); await delayed.promise })
    expect(screen.queryByText(/渠道服务已接受测试/)).toBeNull()
    expect(screen.queryByRole('button', { name: '查询本次测试' })).toBeNull()
  })

  it('invalidates a previous test when refresh observes a different configuration revision', async () => {
    let revision = 'one'
    const request = vi.fn(async (input: NotificationChannelRequest) => {
      const status = result(true)
      status.channels[0]!.revision = revision
      return { ...status, ...(input.action === 'test' ? { testNotificationId: 'test-one' } : {}) }
    })
    render(<NotificationChannelSettings request={request} requestData={vi.fn(async () => ({ deliverySummary: { serverchan: 'sent' } }))} onStatus={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '发送测试' }))
    await screen.findByText(/渠道服务已接受测试/)
    await waitFor(() =>{  expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(false) })
    revision = 'two'
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    await waitFor(() =>{  expect(screen.queryByText(/渠道服务已接受测试/)).toBeNull() })
    expect(request.mock.calls.filter(([input]) => input.action === 'test')).toHaveLength(1)
  })

  it('saves via the dedicated callback, clears secrets, and preserves blank secrets while editing', async () => {
    const request = vi.fn(async (input: NotificationChannelRequest) => result(input.action === 'save'))
    render(<NotificationChannelSettings request={request} requestData={vi.fn()} onStatus={vi.fn()} />)
    const card = within(screen.getByRole('region', { name: 'Server 酱配置' }))
    await waitFor(() =>{  expect((card.getByRole('button', { name: '配置' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(card.getByRole('button', { name: '配置' }))
    const input = card.getByLabelText('Server 酱 · SendKey') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'SCT-test-only' } })
    fireEvent.click(card.getByRole('button', { name: '保存配置' }))
    await waitFor(() =>{  expect(request).toHaveBeenCalledWith({ action: 'save', channel: 'serverchan', revision: '', enabled: true, fields: { sendkey: 'SCT-test-only' } }) })
    await screen.findByText(/配置已保存并生效/)
    expect(card.queryByLabelText('Server 酱 · SendKey')).toBeNull()
    fireEvent.click(card.getByRole('button', { name: '编辑配置' }))
    expect(card.getByLabelText<HTMLInputElement>('Server 酱 · SendKey').value).toBe('')
    fireEvent.click(card.getByRole('button', { name: '保存配置' }))
    await waitFor(() =>{  expect(request).toHaveBeenLastCalledWith({ action: 'save', channel: 'serverchan', revision: 'one', enabled: true, fields: {} }) })
  })

  it('does not claim queued tests succeeded and reuses the request id after ambiguous submission', async () => {
    let tests = 0
    const request = vi.fn(async (input: NotificationChannelRequest) => {
      if (input.action === 'test' && tests++ === 0) throw new Error('测试提交未确认')
      return { ...result(true), ...(input.action === 'test' ? { testNotificationId: 'test-one' } : {}) }
    })
    const requestData = vi.fn(async () => ({ deliverySummary: { serverchan: 'pending' } }))
    render(<NotificationChannelSettings request={request} requestData={requestData} onStatus={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '发送测试' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '发送测试' }))
    await screen.findByText(/测试已入队/)
    const attempts = request.mock.calls.map(([input]) => input).filter(input => input.action === 'test')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual(attempts[1])
    expect(screen.queryByText(/渠道服务已接受测试/)).toBeNull()
    requestData.mockResolvedValue({ deliverySummary: { serverchan: 'sent' } })
    fireEvent.click(screen.getByRole('button', { name: '更新状态' }))
    await screen.findByText(/渠道服务已接受测试/)
  })

  it('blocks tests when worker is disabled and requires explicit remove confirmation', async () => {
    const request = vi.fn(async () => ({ ...result(true), deliveryEnabled: false }))
    render(<NotificationChannelSettings request={request} requestData={vi.fn()} onStatus={vi.fn()} />)
    const test = await screen.findByRole('button', { name: '发送测试' }) as HTMLButtonElement
    expect(test.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }))
    fireEvent.click(screen.getByRole('button', { name: '移除配置' }))
    expect(request).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }))
    await waitFor(() =>{  expect(request).toHaveBeenCalledWith({ action: 'remove', channel: 'serverchan', revision: 'one' }) })
  })
})
