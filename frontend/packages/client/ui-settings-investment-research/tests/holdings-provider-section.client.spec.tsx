// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoldingsProviderSection } from '../src/client/HoldingsProviderSection.tsx'

describe('macOS 持仓长期授权设置', () => {
  afterEach(() => { Reflect.deleteProperty(window, '__DSH_ELECTRON__'); vi.restoreAllMocks() })

  it('展示并关闭由主进程持有的长期授权', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const native = vi.fn(async (input: { action: string }) => input.action === 'consent_status'
      ? { persistent_authorization: true }
      : { persistent_authorization: false })
    Object.defineProperty(window, '__DSH_ELECTRON__', { value: { holdingsAction: native }, configurable: true })
    const requestData = vi.fn(async () => ({ effective: { HOLDINGS_PROVIDER: 'mac_ths' } }))

    render(<HoldingsProviderSection t={key => key} requestData={requestData} brokerSync providers={['mac_ths']} />)

    const revoke = await screen.findByRole('button', { name: '关闭长期授权' })
    expect(screen.getByText(/应用仍不会定时或在后台自动读取/)).toBeTruthy()
    fireEvent.click(revoke)
    await waitFor(() => { expect(native).toHaveBeenCalledWith({ action: 'revoke_consent', account_mode: 'simulated' }) })
    expect(await screen.findByText('已关闭同花顺长期读取授权。')).toBeTruthy()
  })
})
