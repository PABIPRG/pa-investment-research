/** Electron API carrier: the Web upstream over the application scheme, with callback-driven IPC downlinks. */

import {
  hostFrameSchema,
  muxFrameSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import {
  serverRequestSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from './api.ts'
import { WebApiClient } from './web-api-client.ts'
import type {
  ElectronBridgeWindow,
  ElectronRendererBridge,
  ElectronStreamEvent,
  ElectronStreamKind,
} from '../electron-bridge.ts'

type StreamItem<F> = { kind: 'frame'; frame: RpcRequest<F> } | { kind: 'error'; error: Error } | { kind: 'end' }

/**
 * Return the preload bridge when this renderer belongs to the Electron shell.
 * @returns validated bridge, or `undefined` outside Electron.
 */
export function electronBridge(): ElectronRendererBridge | undefined {
  const candidate = (globalThis as ElectronBridgeWindow).__DSH_ELECTRON__
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const value = candidate as Partial<ElectronRendererBridge>
  return value.version === 1
    && typeof value.openStream === 'function'
    && typeof value.closeStream === 'function'
    ? value as ElectronRendererBridge
    : undefined
}

/**
 * Electron platform subclass.
 *
 * Unary requests keep the inherited Fetch path: the desktop shell serves the
 * Host from the renderer's own origin, so those requests are same-origin
 * exactly as in a browser. Only the downlinks differ, because the shell has no
 * listening socket to carry a WebSocket.
 */
export class ElectronApiClient extends WebApiClient {
  /** @param bridge - validated preload bridge installed by the Electron shell. */
  constructor(private readonly bridge: ElectronRendererBridge) {
    super()
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readStream('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readStream('host', signal, hostFrameSchema, onOpen)
  }

  private async *readStream<F extends MuxFrame | HostFrame>(
    kind: ElectronStreamKind,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const id = crypto.randomUUID()
    const inbox: StreamItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: StreamItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const onEvent = (event: ElectronStreamEvent): void => {
      switch (event.type) {
        case 'open':
          onOpen?.()
          return
        case 'end':
          enqueue({ kind: 'end' })
          return
        case 'error':
          enqueue({ kind: 'error', error: new Error(event.message) })
          return
        case 'message': {
          try {
            const full: ServerRequest = serverRequestSchema.parse(event.message)
            const frame = frameSchema.parse(full.payload)
            this.onEnvelope(full)
            enqueue({ kind: 'frame', frame: { rpcId: full.rpcId, payload: frame } })
          } catch (error) {
            console.error(`[client-connection] dropping malformed Electron ${kind} frame:`, error)
          }
          return
        }
        default:
          event satisfies never
      }
    }
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      this.bridge.closeStream(id)
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', close, { once: true })
    try {
      this.bridge.openStream(kind, id, onEvent)
      if (signal.aborted) close()
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'error') throw item.error
          yield item.frame
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', close)
      close()
    }
  }
}
