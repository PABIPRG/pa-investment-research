import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), showMessageBox: vi.fn(), showOpenDialog: vi.fn(), openExternal: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler }, dialog: mocks, shell: mocks }))
import { bindHoldingsNative, createHoldingsConsentStore } from '../src/holdings-native.ts'
import type { BrowserWindow } from 'electron'

describe('holdings native consent', () => {
  beforeEach(() => { vi.clearAllMocks() })
  function setup() {
    const window = { webContents: { mainFrame: {} }, isDestroyed: () => false, isFocused: () => true, show: vi.fn(), focus: vi.fn() }
    const consent = { persistent: false, setPersistent: vi.fn(async (value: boolean) => { consent.persistent = value }) }
    const run = vi.fn().mockImplementation(async (request: { action: string }) => request.action === 'commit'
      ? { saved: 1 }
      : { preview_token: 'backend-secret', items: [{ ticker: '000001', quantity: 1, cost_price: 2 }] })
    const dispose = bindHoldingsNative(window as unknown as BrowserWindow, run, consent)
    const invoke = mocks.handle.mock.calls[0]![1] as (event: unknown, value: unknown) => Promise<unknown>
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    return { window, run, consent, dispose, call: (input: unknown) => invoke(event, input), invoke }
  }
  it('cancellation never reaches native executor', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    const test = setup()
    expect(await test.call({ action: 'read', account_mode: 'simulated', authorization: 'once' })).toEqual({ canceled: true })
    expect(test.run).not.toHaveBeenCalled()
    expect(mocks.showMessageBox.mock.calls[0]![1].detail).toContain('交易 → 模拟 → 股票 → 持仓')
    expect(mocks.showMessageBox.mock.calls[0]![1].detail).toContain('返回投研智能体')
    test.dispose()
    expect(mocks.removeHandler).toHaveBeenCalled()
  })
  it('single-use authorization asks again and restores window even on failure', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    await test.call({ action: 'read', account_mode: 'real', authorization: 'once' })
    test.run.mockRejectedValueOnce(new Error('failed'))
    await expect(test.call({ action: 'read', account_mode: 'real', authorization: 'once' })).rejects.toThrow('failed')
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
    expect(test.window.focus).toHaveBeenCalledTimes(2)
  })
  it('persistent authorization is established by native confirmation and can be revoked', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    await test.call({ action: 'read', account_mode: 'real', authorization: 'persistent' })
    expect(test.consent.setPersistent).toHaveBeenCalledWith(true)
    await test.call({ action: 'read', account_mode: 'real', authorization: 'persistent' })
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    expect(await test.call({ action: 'consent_status', account_mode: 'real' })).toEqual({ persistent_authorization: true })
    expect(await test.call({ action: 'revoke_consent', account_mode: 'real' })).toEqual({ persistent_authorization: false })
    expect(test.consent.setPersistent).toHaveBeenLastCalledWith(false)
  })
  it('keeps backend preview tokens in the main process and commits by opaque session id', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    const preview = await test.call({ action: 'read', account_mode: 'simulated', authorization: 'once' }) as Record<string, unknown>
    expect(preview.preview_token).toBeUndefined()
    expect(preview.session_id).toEqual(expect.any(String))
    await test.call({ action: 'commit', account_mode: 'simulated', session_id: preview.session_id })
    expect(test.run).toHaveBeenLastCalledWith({ action: 'commit', account_mode: 'simulated', preview_token: 'backend-secret', time_overrides: {} })
    await expect(test.call({ action: 'commit', account_mode: 'simulated', session_id: preview.session_id })).rejects.toThrow(/预览/)
  })
  it('disposal waits for the permitted operation and focus restoration', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    const completion = Promise.withResolvers<unknown>()
    test.run.mockImplementation((request: { action: string }) => request.action === 'cancel_read'
      ? Promise.resolve({ canceled: true })
      : completion.promise)
    const operation = test.call({ action: 'read', account_mode: 'simulated', authorization: 'once' })
    await vi.waitFor(() => { expect(test.run).toHaveBeenCalledTimes(1) })
    let disposed = false
    const disposal = test.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    completion.resolve({ preview_token: 'p' })
    await operation
    await disposal
    expect(test.window.focus).toHaveBeenCalledOnce()
    expect(disposed).toBe(true)
  })
  it('cancels an active read through the private backend operation and restores focus', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    const completion = Promise.withResolvers<unknown>()
    test.run.mockImplementation((request: { action: string }, signal?: AbortSignal) => {
      if (request.action === 'cancel_read') return Promise.resolve({ canceled: true })
      signal?.addEventListener('abort', () => { completion.reject(signal.reason) }, { once: true })
      return completion.promise
    })
    const reading = test.call({ action: 'read', account_mode: 'simulated', authorization: 'once' })
    await vi.waitFor(() => { expect(test.run).toHaveBeenCalledTimes(1) })

    await expect(test.call({ action: 'cancel_read', account_mode: 'simulated' })).resolves.toEqual({ canceled: true })
    await expect(reading).resolves.toEqual({ canceled: true })
    expect(test.run.mock.calls[1]?.[0]).toMatchObject({ action: 'cancel_read', operation_id: expect.any(String) })
    expect(test.window.focus).toHaveBeenCalledOnce()
  })
  it('rejects foreign frames, arbitrary paths and commands before any action', async () => {
    const test = setup()
    await expect(test.invoke({}, { action: 'read', account_mode: 'real' })).rejects.toThrow('无权')
    await expect(test.call({ action: 'launch', account_mode: 'real', client_path: '/tmp/evil' })).rejects.toThrow('不接受')
    await expect(test.call({ action: 'cancel_read', account_mode: 'real', operation_id: 'renderer-owned' })).rejects.toThrow('不接受')
    await expect(test.call({ action: 'exec', account_mode: 'real' })).rejects.toThrow('不支持')
    expect(test.run).not.toHaveBeenCalled()
  })
})

describe('holdings consent persistence', () => {
  it('restores a durable authorization and allows explicit revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holdings-consent-'))
    try {
      const path = join(directory, 'consent.json')
      const first = await createHoldingsConsentStore(path)
      expect(first.persistent).toBe(false)
      await first.setPersistent(true)
      const restored = await createHoldingsConsentStore(path)
      expect(restored.persistent).toBe(true)
      await restored.setPersistent(false)
      expect((await createHoldingsConsentStore(path)).persistent).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
