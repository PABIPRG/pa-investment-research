/**
 * Electron main startup: module evaluation must finish before the readiness
 * tick, the application scheme's privileges must be claimed in that same
 * pre-ready window, and the shared Web profile boots without Cordis HMR.
 *
 * One spec file owns all three because importing `../src/main.ts` starts the
 * application: a second file importing it would race this one for whichever
 * mocks the module body observes.
 */

import { describe, expect, it, vi } from 'vitest'
import { APP_SCHEME } from '../src/protocol.ts'

const mocks = vi.hoisted(() => {
  const ready = Promise.withResolvers<undefined>()
  return {
    ready,
    requestSingleInstanceLock: vi.fn(() => true),
    registerSchemesAsPrivileged: vi.fn(),
    runProfile: vi.fn(() => new Promise<never>(() => {})),
  }
})

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    quit: vi.fn(),
    whenReady: () => mocks.ready.promise,
  },
  BrowserWindow: vi.fn(),
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
  it('claims the scheme privileges and finishes evaluation before readiness, then boots the web profile', async () => {
    const loading = import('../src/main.ts')
    await vi.waitFor(() => { expect(mocks.requestSingleInstanceLock).toHaveBeenCalledOnce() })

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
    expect(mocks.runProfile).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'web',
      watchPatches: false,
    }))
  })
})
