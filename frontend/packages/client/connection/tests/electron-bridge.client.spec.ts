/** Electron renderer carrier: same-origin unary Fetch and callback stream lifecycle. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ElectronRendererBridge,
  ElectronStreamEvent,
} from '../src/electron-bridge.ts'
import {
  ElectronApiClient,
  electronBridge,
} from '../src/client/electron-api-client.ts'

const STREAMS_ONLY: ElectronRendererBridge = {
  version: 1,
  openStream: () => {},
  closeStream: () => {},
}

describe('Electron renderer bridge', () => {
  afterEach(() => {
    delete (globalThis as { __DSH_ELECTRON__?: unknown }).__DSH_ELECTRON__
    vi.unstubAllGlobals()
  })

  it('recognizes only the fixed preload surface', () => {
    const holder = globalThis as { __DSH_ELECTRON__?: unknown }
    holder.__DSH_ELECTRON__ = { version: 1, openStream() {} }
    expect(electronBridge()).toBeUndefined()
    holder.__DSH_ELECTRON__ = STREAMS_ONLY
    expect(electronBridge()).toBe(STREAMS_ONLY)
  })

  it('sends unary requests through ordinary Fetch rather than the bridge', async () => {
    const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const client = new ElectronApiClient(STREAMS_ONLY)

    await client.sessions.list({}).catch(() => undefined)

    expect(fetch).toHaveBeenCalledOnce()
    const [input] = fetch.mock.calls[0] as unknown as [URL]
    expect(input.pathname).toBe('/api/session.list')
  })

  it('opens, validates, and closes a Host event stream', async () => {
    let listener: ((event: ElectronStreamEvent) => void) | undefined
    let streamId: string | undefined
    const closeStream = vi.fn()
    const bridge: ElectronRendererBridge = {
      version: 1,
      openStream(kind, id, next) {
        expect(kind).toBe('host')
        streamId = id
        listener = next
      },
      closeStream,
    }
    const client = new ElectronApiClient(bridge)
    const opened = vi.fn()
    const iterator = client.events.host({}, new AbortController().signal, opened)[Symbol.asyncIterator]()
    const first = iterator.next()
    listener?.({ type: 'open' })
    listener?.({
      type: 'message',
      message: {
        type: 'server-request',
        rpcId: 'host-frame-1',
        method: 'host/session-status',
        payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
      },
    })

    await expect(first).resolves.toEqual({
      done: false,
      value: {
        rpcId: 'host-frame-1',
        payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
      },
    })
    expect(opened).toHaveBeenCalledOnce()
    listener?.({ type: 'end' })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(closeStream).toHaveBeenCalledWith(streamId)
  })
})
