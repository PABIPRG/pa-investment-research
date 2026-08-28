/**
 * Electron main startup: module evaluation must finish before the readiness
 * tick, the application scheme's privileges must be claimed in that same
 * pre-ready window, and the shared Web profile boots without Cordis HMR.
 *
 * One spec file owns all three because importing `../src/main.ts` starts the
 * application: a second file importing it would race this one for whichever
 * mocks the module body observes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_SCHEME } from '../src/protocol.ts'

const originalArgv = [...process.argv]

interface StartupOptions {
  readonly profile: string
  readonly patchFiles: readonly string[]
  readonly restart: () => Promise<void>
  readonly watchPatches: boolean
  readonly instanceMode?: string
  readonly onInstanceConflict?: (owner: { mode: 'web' | 'electron'; pid: number }) => Promise<string>
}

afterEach(() => {
  process.argv = [...originalArgv]
})

const mocks = vi.hoisted(() => {
  const ready = Promise.withResolvers<undefined>()
  return {
    ready,
    requestSingleInstanceLock: vi.fn(() => true),
    registerSchemesAsPrivileged: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    runProfile: vi.fn((_options: StartupOptions) => new Promise<never>(() => {})),
  }
})

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    quit: vi.fn(),
    whenReady: () => mocks.ready.promise,
  },
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: mocks.registerSchemesAsPrivileged, handle: vi.fn() },
  shell: {},
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadLayeredEnv: vi.fn(() => ({ values: {}, sources: {} })),
}))

vi.mock('@deepseek-ai/dsh/profile-boot', () => ({
  runProfile: mocks.runProfile,
}))

describe('Electron main startup', () => {
  it('claims the scheme privileges and finishes evaluation before readiness, then boots the selected profile', async () => {
    process.argv = ['/electron', '/app', '--profile', 'investment-research']
    const loading = import('../src/main.ts')
    await vi.waitFor(
      () => { expect(mocks.requestSingleInstanceLock).toHaveBeenCalledOnce() },
      { timeout: 5_000 },
    )

    const state = await Promise.race([
      loading.then(() => 'loaded' as const),
      new Promise<'pending'>((resolve) => { setImmediate(() => { resolve('pending') }) }),
    ])

    expect(state).toBe('loaded')
    expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    }])
    expect(mocks.runProfile).not.toHaveBeenCalled()

    mocks.ready.resolve(undefined)

    await vi.waitFor(() => { expect(mocks.runProfile).toHaveBeenCalledOnce() })
    const startupOptions = mocks.runProfile.mock.calls[0]?.[0]
    expect(startupOptions).toMatchObject({
      profile: 'investment-research',
      patchFiles: [expect.stringMatching(/electron\.patch\.yml$/u)],
      watchPatches: false,
      instanceMode: 'electron',
    })
    expect(startupOptions?.restart).toEqual(expect.any(Function))
    await expect(startupOptions?.onInstanceConflict?.({ mode: 'web', pid: 123 })).resolves.toBe('replace')
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: '检测到Web 版投研正在运行',
      buttons: ['停止Web 版并启动 Electron', '取消'],
    }))
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(startupOptions?.onInstanceConflict?.({ mode: 'web', pid: 123 })).resolves.toBe('cancel')
  })
})
