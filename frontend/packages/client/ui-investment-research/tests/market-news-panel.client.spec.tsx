// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MarketNewsPanel } from '../src/client/MarketNewsPanel.tsx'
import type { RequestData } from '../src/client/research-types.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MarketNewsPanel', () => {
  it('loads only when active and exposes only safe external article links', async () => {
    const requestData = vi.fn<RequestData>(() => Promise.resolve({
      status: 'ready',
      items: [
        { id: 'safe', title: '安全原文', source: '测试源', url: 'https://example.com/news' },
        { id: 'unsafe', title: '不安全地址', source: '测试源', url: 'javascript:alert(1)' },
      ],
    }))
    const view = render(<MarketNewsPanel requestData={requestData} active={false} />)

    expect(requestData).not.toHaveBeenCalled()
    view.rerender(<MarketNewsPanel requestData={requestData} active />)

    const safe = await screen.findByRole('link', { name: '安全原文（打开原文）' })
    expect(safe.getAttribute('href')).toBe('https://example.com/news')
    expect(screen.queryByRole('link', { name: /不安全地址/ })).toBeNull()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'market-watch.news-flash',
      input: { limit: 12, enrich: false, personal: false },
    })
  })

  it('retries an unavailable market-news response without duplicating a busy request', async () => {
    let resolveRetry!: (value: unknown) => void
    const retry = new Promise<unknown>((resolve) => { resolveRetry = resolve })
    const requestData = vi.fn<RequestData>()
      .mockResolvedValueOnce({ status: 'unavailable', message: '行情源维护中', items: [] })
      .mockReturnValueOnce(retry)

    render(<MarketNewsPanel requestData={requestData} />)
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: '重试市场资讯' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(requestData).toHaveBeenCalledTimes(2)
    expect(button.disabled).toBe(true)

    await act(async () => {
      resolveRetry({ status: 'ready', items: [{ id: 'fresh', title: '刷新后的快讯' }] })
    })
    await waitFor(() => { expect(screen.getByText('刷新后的快讯')).toBeTruthy() })
  })
})
