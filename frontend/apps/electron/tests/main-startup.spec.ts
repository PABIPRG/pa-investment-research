/**
 * Electron main startup: module evaluation must finish before the readiness
 * tick, the application scheme's privileges must be claimed in that same
 * pre-ready window, and the shared Web profile boots without Cordis HMR.
 *
 * One spec file owns all three because importing `../src/main.ts` starts the
 * application: a second file importing it would race this one for whichever
 * mocks the module body observes.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_SCHEME } from '../src/protocol.ts'

const originalArgv = [...process.argv]
const homes: string[] = []

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
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const mocks = vi.hoisted(() => {
  const ready = Promise.withResolvers<undefined>()
  return {
    ready,
    healProfilesModuleFallback: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    registerSchemesAsPrivileged: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    runProfile: vi.fn((_options: StartupOptions) => new Promise<never>(() => {})),
  }
})

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    setPath: vi.fn(),
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
  healProfilesModuleFallback: mocks.healProfilesModuleFallback,
  loadLayeredEnv: vi.fn(() => ({ values: {}, sources: {} })),
}))

vi.mock('@deepseek-ai/dsh/profile-boot', () => ({
  runProfile: mocks.runProfile,
}))

describe('Electron main startup', () => {
  it('claims the scheme privileges and finishes evaluation before readiness, then boots the selected profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'electron-startup-trace-'))
    homes.push(root)
    vi.stubEnv('DSH_DESKTOP_SMOKE', '1')
    vi.stubEnv('DSH_DESKTOP_SMOKE_ROOT', root)
    vi.stubEnv('DSH_DESKTOP_SMOKE_ITERATION', '1')
    vi.stubEnv('DSH_HOME', join(root, 'dsh-home'))
    const stages = () => readFileSync(join(root, 'startup-phases.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { stage: string; iteration: string; pid: number })
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
    expect(stages().map(entry => entry.stage)).toEqual(['entry-start', 'application-import-start', 'main-module-ready', 'instance-lock-start', 'instance-lock-acquired', 'electron-ready-wait', 'application-imported'])
    expect(stages().every(entry => entry.iteration === '1' && entry.pid === process.pid)).toBe(true)
    expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    }])
    expect(mocks.runProfile).not.toHaveBeenCalled()

    mocks.ready.resolve(undefined)

    await vi.waitFor(() => { expect(mocks.runProfile).toHaveBeenCalledOnce() })
    expect(stages().slice(-2).map(entry => entry.stage)).toEqual(['electron-ready', 'profile-start'])
    expect(mocks.healProfilesModuleFallback).toHaveBeenCalledWith(fileURLToPath(new URL('../package.json', import.meta.url)))
    const startupOptions = mocks.runProfile.mock.calls[0]?.[0]
    expect(startupOptions).toMatchObject({
      profile: 'investment-research',
      patchFiles: [expect.stringMatching(/electron\.patch\.yml$/u)],
      watchPatches: false,
      instanceMode: 'electron',
    })
    expect(startupOptions).not.toHaveProperty('installAnchor')
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
