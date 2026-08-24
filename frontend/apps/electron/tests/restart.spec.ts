/**
 * Restart orchestration imports the self-starting Electron main module in an
 * isolated module graph, so its Electron mocks cannot share startup state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAM_OPEN_CHANNEL } from '../src/ipc.ts'

const originalArgv = [...process.argv]

interface RestartHarness {
  app: {
    on: ReturnType<typeof vi.fn>
    quit: ReturnType<typeof vi.fn>
    relaunch: ReturnType<typeof vi.fn>
  }
  connection: { openStream: ReturnType<typeof vi.fn> }
  contents: { mainFrame: object }
  events: string[]
  earlyRestart?: Promise<{ error?: unknown }>
  handlers: Map<string, (event: { preventDefault(): void }, value?: unknown) => unknown>
  ipcMain: { off: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  ready: PromiseWithResolvers<void>
  restart(): Promise<void>
  runProfile: ReturnType<typeof vi.fn>
  shutdown: { shutdown: ReturnType<typeof vi.fn> }
}

function deferred(): PromiseWithResolvers<void> {
  return Promise.withResolvers<void>()
}

async function start(options: { restartDuringProfileBoot?: boolean } = {}): Promise<RestartHarness> {
  vi.resetModules()
  const ready = deferred()
  const teardown = deferred()
  const streamOpened = deferred()
  const handlers = new Map<string, (event: { preventDefault(): void }, value?: unknown) => unknown>()
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
    on: vi.fn((name: string, listener: (event: { preventDefault(): void }, value?: unknown) => void) => {
      handlers.set(name, listener)
    }),
    quit: vi.fn(() => { events.push('quit') }),
    relaunch: vi.fn((options: unknown) => { events.push(`relaunch:${JSON.stringify(options)}`) }),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: () => ready.promise,
  }
  const ipcMain = {
    off: vi.fn(),
    on: vi.fn((name: string, listener: (event: { sender: typeof contents; senderFrame: object }, value: unknown) => void) => {
      handlers.set(name, listener as (event: { preventDefault(): void }, value?: unknown) => unknown)
    }),
  }
  const connection = {
    openStream: vi.fn(async function *(_kind: string, signal: AbortSignal) {
      events.push('stream-open')
      streamOpened.resolve()
      await new Promise<void>((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
      events.push('stream-aborted-and-drained')
    }),
  }
  class ElectronConnectionService {}
  Object.setPrototypeOf(connection, ElectronConnectionService.prototype)
  const shutdown = {
    shutdown: vi.fn(async () => {
      events.push('profile-shutdown-start')
      await teardown.promise
      events.push('profile-shutdown-complete-owned-process-exited')
    }),
  }
  let earlyRestart: Promise<{ error?: unknown }> | undefined
  const runProfile = vi.fn(async (profileOptions: { restart?: () => unknown }) => {
    if (options.restartDuringProfileBoot === true) {
      try {
        earlyRestart = Promise.resolve(profileOptions.restart?.()).then(
          () => ({}),
          error => ({ error }),
        )
      } catch (error) {
        earlyRestart = Promise.resolve({ error })
      }
    }
    return { ctx: { get: () => connection }, shutdown }
  })

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

  process.argv = ['/electron', '/app', '--profile', 'investment-research']
  await import('../src/main.ts')
  ready.resolve()
  await vi.waitFor(() => { expect(runProfile).toHaveBeenCalledOnce() })
  await vi.waitFor(() => { expect(handlers.get('before-quit')).toBeTypeOf('function') })

  const restart = runProfile.mock.calls[0]?.[0].restart as unknown as () => Promise<void>
  return {
    app,
    connection,
    contents,
    earlyRestart,
    events,
    handlers,
    ipcMain,
    ready,
    restart,
    runProfile,
    shutdown,
    ...{ teardown, streamOpened },
  } as RestartHarness & { teardown: PromiseWithResolvers<void>; streamOpened: PromiseWithResolvers<void> }
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
  it('aborts and drains IPC before profile quiescence, then relaunches once with one profile argv pair', async () => {
    const harness = await start() as RestartHarness & {
      streamOpened: PromiseWithResolvers<void>
      teardown: PromiseWithResolvers<void>
    }
    const stream = harness.handlers.get(STREAM_OPEN_CHANNEL)
    stream?.({ sender: harness.contents, senderFrame: harness.contents.mainFrame }, { id: 'request-1', kind: 'host' })
    await harness.streamOpened.promise

    expect(harness.restart).toBeTypeOf('function')
    const first = harness.restart()
    const second = harness.restart()
    expect(second).toBe(first)
    await vi.waitFor(() => {
      expect(harness.events).toEqual([
        'stream-open',
        'stream-aborted-and-drained',
        'profile-shutdown-start',
      ])
    })
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()

    harness.teardown.resolve()
    await first

    expect(harness.events).toEqual([
      'stream-open',
      'stream-aborted-and-drained',
      'profile-shutdown-start',
      'profile-shutdown-complete-owned-process-exited',
      'relaunch:{"args":["/app","--profile","investment-research"]}',
      'quit',
    ])
    expect(harness.app.relaunch).toHaveBeenCalledWith({
      args: ['/app', '--profile', 'investment-research'],
    })
    expect(harness.shutdown.shutdown).toHaveBeenCalledOnce()
    expect(harness.ipcMain.off).toHaveBeenCalledTimes(2)
  })

  it('shares teardown with concurrent before-quit and window-all-closed, and never relaunches after teardown rejects', async () => {
    const harness = await start() as RestartHarness & { teardown: PromiseWithResolvers<void> }
    const beforeQuit = harness.handlers.get('before-quit')
    const windowAllClosed = harness.handlers.get('window-all-closed')
    const event = { preventDefault: vi.fn() }
    const ordinaryQuit = beforeQuit?.(event) as Promise<void>
    const windowQuit = windowAllClosed?.({ preventDefault: vi.fn() }) as Promise<void>
    expect(ordinaryQuit).toBeInstanceOf(Promise)
    expect(windowQuit).toBeInstanceOf(Promise)
    expect(harness.restart).toBeTypeOf('function')
    const restart = harness.restart()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(harness.shutdown.shutdown).toHaveBeenCalledOnce() })

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.teardown.reject(new Error('profile teardown failed'))
    await expect(restart).rejects.toThrow('profile teardown failed')
    await expect(ordinaryQuit).rejects.toThrow('profile teardown failed')
    await expect(windowQuit).rejects.toThrow('profile teardown failed')
    await vi.waitFor(() => {
      expect(harness.app.relaunch).not.toHaveBeenCalled()
    })
    expect(error).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
    expect(harness.shutdown.shutdown).toHaveBeenCalledOnce()
    expect(harness.ipcMain.off).toHaveBeenCalledTimes(2)
  })

  it('accepts a restart request made while the Profile is still booting', async () => {
    const harness = await start({ restartDuringProfileBoot: true }) as RestartHarness & {
      teardown: PromiseWithResolvers<void>
    }
    await vi.waitFor(() => { expect(harness.shutdown.shutdown).toHaveBeenCalledOnce() })
    const beforeTeardown = await Promise.race([
      harness.earlyRestart ?? Promise.resolve({ error: new Error('missing restart') }),
      new Promise<'pending'>(resolve => { setImmediate(() => { resolve('pending') }) }),
    ])
    expect(beforeTeardown).toBe('pending')
    harness.teardown.resolve()
    expect(await harness.earlyRestart).toEqual({})
    await vi.waitFor(() => { expect(harness.app.relaunch).toHaveBeenCalledOnce() })
  })
})
