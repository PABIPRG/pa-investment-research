/** Electron application main process: boots the Host tree, binds IPC, and opens the local renderer. */

import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import type { IpcMainEvent, WebContents } from 'electron'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {
  ElectronStreamEvent,
  ElectronStreamKind,
} from '@deepseek-ai/dsh-client-connection/electron-bridge'
import type { HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { appIdentity } from './app-identity.ts'
import { resolveElectronProfile } from './args.ts'
import { ElectronConnectionService } from './index.ts'
import { APP_INDEX_URL, APP_SCHEME, createAppProtocolHandler } from './protocol.ts'
import {
  STREAM_CLOSE_CHANNEL,
  STREAM_EVENT_CHANNEL,
  STREAM_OPEN_CHANNEL,
} from './ipc.ts'

const APP_MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))
const ELECTRON_PATCH = fileURLToPath(new URL('../electron.patch.yml', import.meta.url))
const RENDERER_DIR = fileURLToPath(new URL('../renderer/', import.meta.url))
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const PROFILE = resolveElectronProfile()

interface StreamOpenRequest {
  kind: ElectronStreamKind
  id: string
}

interface IpcBinding {
  dispose(): Promise<void>
}

// Privilege registration is a pre-readiness call, so it belongs to module
// evaluation rather than to the startup task below. `standard` gives the
// renderer a real origin that resolves absolute paths; `secure` keeps it a
// secure context; `supportFetchAPI` lets the shared client code reach the Host
// through ordinary Fetch.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  void runApplication()
}

async function runApplication(): Promise<void> {
  const lifecycleReady = Promise.withResolvers<void>()
  void lifecycleReady.promise.catch(() => {})
  let ipc: IpcBinding | undefined
  let profileShutdown: { shutdown(code: number): Promise<void> } | undefined
  let disposePromise: Promise<void> | undefined
  let restartPromise: Promise<void> | undefined
  let normalQuitPromise: Promise<void> | undefined
  let quitCommitted = false
  let failureReported = false
  const failLoud = (): void => {
    if (failureReported) return
    failureReported = true
    app.exit(1)
  }
  const consume = (pending: Promise<void>): void => {
    void pending.catch(failLoud)
  }
  const disposeOnce = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    disposePromise = (async () => {
      await lifecycleReady.promise
      if (ipc === undefined || profileShutdown === undefined) {
        throw new Error('dsh-electron: restart lifecycle did not initialize')
      }
      await ipc.dispose()
      await profileShutdown.shutdown(0)
    })()
    return disposePromise
  }
  const quitOnce = (): Promise<void> => {
    if (normalQuitPromise !== undefined) return normalQuitPromise
    normalQuitPromise = (async () => {
      await disposeOnce()
      if (restartPromise !== undefined || quitCommitted) return
      quitCommitted = true
      app.quit()
    })()
    return normalQuitPromise
  }
  function restartOnce(): Promise<void> {
    if (restartPromise !== undefined) return restartPromise
    restartPromise = (async () => {
      await disposeOnce()
      app.relaunch({ args: process.argv.slice(1) })
      quitCommitted = true
      app.quit()
    })()
    return restartPromise
  }
  const requestRestart = (): void => { consume(restartOnce()) }
  app.on('before-quit', (event) => {
    if (quitCommitted) return
    event.preventDefault()
    consume(quitOnce())
  })
  app.on('window-all-closed', () => { consume(quitOnce()) })
  try {
    await app.whenReady()
    app.dock?.setIcon(appIdentity.runtimeIconPath)
    const { ctx, shutdown } = await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: PROFILE,
      patchFiles: [ELECTRON_PATCH],
      args: [],
      installAnchor: APP_MANIFEST,
      restart: requestRestart,
      watchPatches: false,
    })
    profileShutdown = shutdown
    const connection = ctx.get('connection')
    if (!(connection instanceof ElectronConnectionService)) {
      throw new Error('dsh-electron: Electron connection provider did not activate')
    }
    protocol.handle(APP_SCHEME, createAppProtocolHandler({
      rendererDir: RENDERER_DIR,
      connection,
      modules: ctx.clientModules,
      fetchFile: fileUrl => net.fetch(fileUrl),
    }))
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      icon: appIdentity.runtimeIconPath,
      backgroundColor: '#111827',
      webPreferences: {
        preload: PRELOAD,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    ipc = bindIpc(window.webContents, connection)
    hardenNavigation(window)
    window.once('ready-to-show', () => { window.show() })
    await window.loadURL(APP_INDEX_URL)

    app.on('second-instance', () => {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    lifecycleReady.resolve()
  } catch (error) {
    lifecycleReady.reject(error)
    throw error
  }
}

function hardenNavigation(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, target) => {
    if (target === APP_INDEX_URL) return
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const protocol = new URL(url).protocol
    if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

function bindIpc(contents: WebContents, connection: ElectronConnectionService): IpcBinding {
  const streams = new Map<string, AbortController>()
  const pumps = new Set<Promise<void>>()
  const ownsEvent = (event: IpcMainEvent): boolean => event.sender === contents && event.senderFrame === contents.mainFrame

  const closeStream = (event: IpcMainEvent, value: unknown): void => {
    if (!ownsEvent(event) || typeof value !== 'string') return
    streams.get(value)?.abort()
  }
  const openStream = (event: IpcMainEvent, value: unknown): void => {
    if (!ownsEvent(event)) return
    const request = parseStreamOpen(value)
    if (request === undefined) return
    if (streams.has(request.id)) {
      sendStreamEvent(contents, request.id, { type: 'error', message: 'duplicate stream id' })
      sendStreamEvent(contents, request.id, { type: 'end' })
      return
    }
    const abort = new AbortController()
    streams.set(request.id, abort)
    sendStreamEvent(contents, request.id, { type: 'open' })
    const pump = pumpStream(contents, request, connection, abort).finally(() => {
      if (streams.get(request.id) === abort) streams.delete(request.id)
      pumps.delete(pump)
    })
    pumps.add(pump)
  }
  ipcMain.on(STREAM_OPEN_CHANNEL, openStream)
  ipcMain.on(STREAM_CLOSE_CHANNEL, closeStream)

  return {
    async dispose(): Promise<void> {
      ipcMain.off(STREAM_OPEN_CHANNEL, openStream)
      ipcMain.off(STREAM_CLOSE_CHANNEL, closeStream)
      for (const abort of streams.values()) abort.abort()
      await Promise.all(pumps)
    },
  }
}

async function pumpStream(
  contents: WebContents,
  request: StreamOpenRequest,
  connection: ElectronConnectionService,
  abort: AbortController,
): Promise<void> {
  try {
    for await (const frame of connection.openStream(request.kind, abort.signal)) {
      sendStreamEvent(contents, request.id, { type: 'message', message: toServerRequest(frame) })
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      sendStreamEvent(contents, request.id, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    abort.abort()
    sendStreamEvent(contents, request.id, { type: 'end' })
  }
}

function toServerRequest(frame: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function sendStreamEvent(contents: WebContents, id: string, event: ElectronStreamEvent): void {
  if (!contents.isDestroyed()) contents.send(STREAM_EVENT_CHANNEL, { id, event })
}

function parseStreamOpen(value: unknown): StreamOpenRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const request = value as Partial<StreamOpenRequest>
  if ((request.kind !== 'mux' && request.kind !== 'host') || typeof request.id !== 'string') {
    return undefined
  }
  return request as StreamOpenRequest
}
