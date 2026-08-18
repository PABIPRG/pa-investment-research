/** Electron main-process Connection provider over in-process Fetch and event streams. */

import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it } from 'vitest'
import { ElectronConnectionService } from '../src/index.ts'

function apiProxy(): ApiProxy {
  const hostFrame = {
    rpcId: RpcId('host-frame'),
    payload: { type: 'host/session-status' as const, sessionId: 'session-1', running: true },
  }
  return {
    events: {
      async *mux() {},
      async *host() { yield hostFrame },
    },
  } as unknown as ApiProxy
}

describe('Electron Connection service', () => {
  it('dispatches generic RPC registrations and withdraws them', async () => {
    const ctx = new Context()
    ctx.provide('apiProxy', apiProxy())
    const service = new ElectronConnectionService(ctx)
    const calls: unknown[] = []
    const remove = service.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    }, { authority: 'loopback' })
    const envelope: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('electron-rpc'),
      method: 'goals/create',
      payload: { title: 'desktop' },
    }
    const request = new Request('http://dsh.internal/rpc/goals/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    const withdrawnRequest = request.clone()

    const response = await service.fetch(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'electron-rpc',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{ endpoint: 'goals/create', payload: { title: 'desktop' } }])
    await remove()
    expect((await service.fetch(withdrawnRequest)).status).toBe(404)
  })

  it('exposes the ApiProxy event streams without a WebSocket carrier', async () => {
    const ctx = new Context()
    ctx.provide('apiProxy', apiProxy())
    const service = new ElectronConnectionService(ctx)
    const frames = []

    for await (const frame of service.openStream('host', new AbortController().signal)) {
      frames.push(frame)
    }

    expect(frames).toEqual([{
      rpcId: 'host-frame',
      payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
    }])
  })
})
