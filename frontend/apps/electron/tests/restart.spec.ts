/** Electron restart orchestration through a self-starting, isolated main module. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessShutdown } from '../../cli/src/process-shutdown.ts'
import { STREAM_CLOSE_CHANNEL, STREAM_OPEN_CHANNEL } from '../src/ipc.ts'

const originalArgv = [...process.argv]
const WINDOWS_ARGV = [
  'C:\\Program Files\\DSH & Research\\dsh.exe',
  'C:\\Program Files\\DSH & Research\\app.asar',
  '--profile',
  'investment-research',
  '--note',
  'M&A & signals',
]

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

interface RestartHarness {
  app: { exit: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; relaunch: ReturnType<typeof vi.fn> }
  contents: { mainFrame: object }
  emit(name: string, ...args: unknown[]): void
  events: string[]
  forceExit: ReturnType<typeof vi.fn>
  ready: Deferred
  restart?: () => void
  shutdown: { shutdown: ReturnType<typeof vi.fn> }
  streamOpened: Deferred
  teardown: Deferred
}

function deferred(): Deferred {
  const values = Promise.withResolvers<void>()
  return values
}

async function start(): Promise<RestartHarness> {
  vi.resetModules()
  const ready = deferred()
  const teardown = deferred()
  const streamOpened = deferred()
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const events: string[] = []
  const contents = {
    isDestroyed: () => false,
    mainFrame: {},
    on: vi.fn(),
    send: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn() },
    setWindowOpenHandler: vi.fn(),
  }
  const window = {
    focus: vi.fn(),
    isMinimized: () => false,
    loadURL: vi.fn(async () => {}),
    once: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    webContents: contents,
  }
  const app = {
    exit: vi.fn((code: number) => { events.push(`fail-loud-exit:${code}`) }),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { handlers.set(name, listener) }),
    quit: vi.fn(() => { events.push('quit') }),
    relaunch: vi.fn((options: unknown) => { events.push(`relaunch:${JSON.stringify(options)}`) }),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: () => ready.promise,
  }
  const ipcMain = {
    off: vi.fn((name: string) => { events.push(`ipc-listener-removed:${name}`) }),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { handlers.set(name, listener) }),
  }
  const connection = {
    openStream: vi.fn(async function *(_kind: string, signal: AbortSignal) {
      events.push('stream-open')
      streamOpened.resolve()
      await new Promise<void>(resolve => { signal.addEventListener('abort', resolve, { once: true }) })
      events.push('stream-aborted-and-drained')
    }),
  }
  class ElectronConnectionService {}
  Object.setPrototypeOf(connection, ElectronConnectionService.prototype)
  const forceExit = vi.fn((code: number) => { events.push(`profile-force-exit:${code}`) })
  const shutdown = createProcessShutdown(async () => {
    events.push('profile-shutdown-start')
    await teardown.promise
    events.push('profile-shutdown-complete-owned-process-exited')
  }, forceExit, vi.fn(), 60_000)
  const shutdownCall = vi.fn((code: number) => shutdown.shutdown(code))
  const runProfile = vi.fn(async (options: { restart?: () => void }) => ({
    ctx: { get: () => connection },
    shutdown: { shutdown: shutdownCall },
    ...{ restart: options.restart },
  }))

  vi.doMock('electron', () => ({
    app,
    BrowserWindow: vi.fn(function BrowserWindow() { return window }),
    ipcMain,
    net: { fetch: vi.fn() },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    shell: { openExternal: vi.fn() },
  }))
  vi.doMock('@deepseek-ai/dsh-app-boot', () => ({ loadLayeredEnv: vi.fn(() => ({ sources: {}, values: {} })) }))
  vi.doMock('@deepseek-ai/dsh/profile-boot', () => ({ runProfile }))
  vi.doMock('../src/index.ts', () => ({ ElectronConnectionService }))
  vi.doMock('../src/protocol.ts', () => ({
    APP_INDEX_URL: 'dsh://app/index.html',
    APP_SCHEME: 'dsh',
    createAppProtocolHandler: vi.fn(),
  }))

  process.argv = [...WINDOWS_ARGV]
  await import('../src/main.ts')
  const emit = (name: string, ...args: unknown[]): void => { handlers.get(name)?.(...args) }
  return {
    app,
    contents,
    emit,
    events,
    forceExit,
    ready,
    get restart() { return runProfile.mock.calls[0]?.[0].restart as (() => void) | undefined },
    shutdown: { shutdown: shutdownCall },
    streamOpened,
    teardown,
  }
}

async function finishStartup(harness: RestartHarness): Promise<void> {
  harness.ready.resolve()
  await vi.waitFor(() => { expect(harness.restart).toBeTypeOf('function') })
}

afterEach(() => {
  process.argv = [...originalArgv]
  vi.doUnmock('electron')
  vi.doUnmock('@deepseek-ai/dsh-app-boot')
  vi.doUnmock('@deepseek-ai/dsh/profile-boot')
  vi.doUnmock('../src/index.ts')
  vi.doUnmock('../src/protocol.ts')
  vi.restoreAllMocks()
})

describe('Electron restart', () => {
  it('registers ordinary quit handlers before readiness and joins them to lifecycle teardown', async () => {
    const harness = await start()
    const beforeQuit = { preventDefault: vi.fn() }
    harness.emit('before-quit', beforeQuit)
    harness.emit('window-all-closed')
    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce()

    await finishStartup(harness)
    await vi.waitFor(() => { expect(harness.shutdown.shutdown).toHaveBeenCalledOnce() })
    harness.teardown.resolve()
    await vi.waitFor(() => { expect(harness.app.quit).toHaveBeenCalledOnce() })
  })

  it('removes IPC listeners before aborting streams, then relaunches with untouched Windows argv', async () => {
    const harness = await start()
    await finishStartup(harness)
    harness.emit(STREAM_OPEN_CHANNEL, {
      sender: harness.contents,
      senderFrame: harness.contents.mainFrame,
    }, { id: 'request-1', kind: 'host' })
    await harness.streamOpened.promise

    expect(harness.restart?.()).toBeUndefined()
    expect(harness.restart?.()).toBeUndefined()
    await vi.waitFor(() => {
      expect(harness.events).toEqual([
        'stream-open',
        `ipc-listener-removed:${STREAM_OPEN_CHANNEL}`,
        `ipc-listener-removed:${STREAM_CLOSE_CHANNEL}`,
        'stream-aborted-and-drained',
        'profile-shutdown-start',
      ])
    })
    harness.teardown.resolve()
    await vi.waitFor(() => { expect(harness.app.relaunch).toHaveBeenCalledOnce() })

    expect(harness.app.relaunch).toHaveBeenCalledWith({ args: WINDOWS_ARGV.slice(1) })
    expect(harness.app.relaunch.mock.calls[0]?.[0]).toEqual({
      args: [
        'C:\\Program Files\\DSH & Research\\app.asar',
        '--profile',
        'investment-research',
        '--note',
        'M&A & signals',
      ],
    })
    expect(WINDOWS_ARGV.filter(value => value === '--profile')).toHaveLength(1)
    expect(harness.app.quit).toHaveBeenCalledOnce()
  })

  it('uses the controller failure and one explicit fail-loud exit when teardown rejects', async () => {
    const harness = await start()
    await finishStartup(harness)
    harness.restart?.()
    harness.emit('before-quit', { preventDefault: vi.fn() })
    harness.emit('window-all-closed')
    await vi.waitFor(() => { expect(harness.shutdown.shutdown).toHaveBeenCalledOnce() })

    harness.teardown.reject(new Error('profile teardown failed'))
    await vi.waitFor(() => {
      expect(harness.forceExit).toHaveBeenCalledWith(1)
      expect(harness.app.exit).toHaveBeenCalledOnce()
      expect(harness.app.exit).toHaveBeenCalledWith(1)
    })
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
  })
})
