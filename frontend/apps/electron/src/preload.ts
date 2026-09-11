/** Sandboxed preload: the Host event downlinks, which have no URL form. */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronRendererBridge,
  ElectronStreamEvent,
  ElectronStreamKind,
} from '@deepseek-ai/dsh-client-connection/electron-bridge'
import {
  HOLDINGS_NATIVE_CHANNEL,
  STREAM_CLOSE_CHANNEL,
  STREAM_EVENT_CHANNEL,
  STREAM_OPEN_CHANNEL,
  SHORTCUT_ACTION_CHANNEL,
  SHORTCUT_CAPTURE_CHANNEL,
} from './ipc.ts'

interface StreamEnvelope {
  id: string
  event: ElectronStreamEvent
}

const streamListeners = new Map<string, (event: ElectronStreamEvent) => void>()
const shortcutListeners = new Map<string, (action: string) => void>()

ipcRenderer.on(STREAM_EVENT_CHANNEL, (_event, value: unknown) => {
  if (!isStreamEnvelope(value)) return
  const listener = streamListeners.get(value.id)
  if (listener === undefined) return
  listener(value.event)
  if (value.event.type === 'end') streamListeners.delete(value.id)
})

ipcRenderer.on(SHORTCUT_ACTION_CHANNEL, (_event, value: unknown) => {
  if (typeof value !== 'string') return
  for (const listener of shortcutListeners.values()) listener(value)
})

const bridge: ElectronRendererBridge = {
  version: 1,
  holdingsAction: input => ipcRenderer.invoke(HOLDINGS_NATIVE_CHANNEL, input),
  platform: desktopPlatform(process.platform),
  openStream(kind: ElectronStreamKind, id: string, listener: (event: ElectronStreamEvent) => void): void {
    if (streamListeners.has(id)) throw new Error(`dsh-electron preload: duplicate stream id ${JSON.stringify(id)}`)
    streamListeners.set(id, listener)
    ipcRenderer.send(STREAM_OPEN_CHANNEL, { kind, id })
  },
  closeStream(id: string): void {
    streamListeners.delete(id)
    ipcRenderer.send(STREAM_CLOSE_CHANNEL, id)
  },
  setShortcutCapture(active: boolean): void {
    ipcRenderer.send(SHORTCUT_CAPTURE_CHANNEL, active)
  },
  watchShortcutActions(id: string, listener: (action: string) => void): void {
    if (shortcutListeners.has(id)) throw new Error(`dsh-electron preload: duplicate shortcut listener ${JSON.stringify(id)}`)
    shortcutListeners.set(id, listener)
  },
  unwatchShortcutActions(id: string): void {
    shortcutListeners.delete(id)
  },
}

contextBridge.exposeInMainWorld('__DSH_ELECTRON__', bridge)

function desktopPlatform(platform: NodeJS.Platform): 'darwin' | 'win32' | 'linux' {
  if (platform === 'darwin' || platform === 'win32') return platform
  return 'linux'
}

function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as { id?: unknown; event?: unknown }
  if (typeof envelope.id !== 'string' || typeof envelope.event !== 'object' || envelope.event === null) return false
  const type = (envelope.event as { type?: unknown }).type
  return type === 'open' || type === 'message' || type === 'error' || type === 'end'
}
