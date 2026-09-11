import { describe, it, expect, vi, beforeEach } from 'vitest'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), showMessageBox: vi.fn(), showOpenDialog: vi.fn(), openExternal: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler }, dialog: mocks, shell: mocks }))
import { bindHoldingsNative } from '../src/holdings-native.ts'
import type { BrowserWindow } from 'electron'

describe('holdings native consent', () => {
  beforeEach(() => { vi.clearAllMocks() })
  function setup() {
    const window = { webContents: { mainFrame: {} }, isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    const run = vi.fn().mockResolvedValue({ preview_token: 'p' })
    const dispose = bindHoldingsNative(window as unknown as BrowserWindow, run)
    const invoke = mocks.handle.mock.calls[0]![1] as (event: unknown, value: unknown) => Promise<unknown>
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    return { window, run, dispose, call: (input: unknown) => invoke(event, input), invoke }
  }
  it('cancellation never reaches native executor', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    const test = setup()
    expect(await test.call({ action: 'read', account_mode: 'simulated' })).toEqual({ canceled: true })
    expect(test.run).not.toHaveBeenCalled()
    expect(mocks.showMessageBox.mock.calls[0]![1].detail).toContain('交易 → 模拟 → 股票 → 持仓')
    expect(mocks.showMessageBox.mock.calls[0]![1].detail).toContain('返回投研智能体')
    test.dispose()
    expect(mocks.removeHandler).toHaveBeenCalled()
  })
  it('each invocation asks again and restores window even on failure', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    await test.call({ action: 'read', account_mode: 'real' })
    test.run.mockRejectedValueOnce(new Error('failed'))
    await expect(test.call({ action: 'read', account_mode: 'real' })).rejects.toThrow('failed')
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
    expect(test.window.focus).toHaveBeenCalledTimes(2)
  })
  it('disposal waits for the permitted operation and focus restoration', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const test = setup()
    const completion = Promise.withResolvers<unknown>()
    test.run.mockReturnValue(completion.promise)
    const operation = test.call({ action: 'read', account_mode: 'simulated' })
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
  it('rejects foreign frames, arbitrary paths and commands before any action', async () => {
    const test = setup()
    await expect(test.invoke({}, { action: 'read', account_mode: 'real' })).rejects.toThrow('无权')
    await expect(test.call({ action: 'launch', account_mode: 'real', client_path: '/tmp/evil' })).rejects.toThrow('不接受')
    await expect(test.call({ action: 'exec', account_mode: 'real' })).rejects.toThrow('不支持')
    expect(test.run).not.toHaveBeenCalled()
  })
})
