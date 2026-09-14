import { expect, it, vi } from 'vitest'
import type { ApiProxy } from '../src/api/index.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createModelAdmin } from '../src/model-admin.ts'

it('preserves unexposed model capabilities when the remote editor changes a capacity', async () => {
  const view = { ns: 'llm-pi-ai', schema: {}, value: { providers: { acme: { models: [{ id: 'm', input: ['text', 'image'], compat: { thinkingFormat: 'openai' }, contextWindow: 100 }] } } }, revision: 0, applies: 'live' as const, secrets: [] }
  const mutate = vi.fn(async (request: { rpcId: ReturnType<typeof RpcId> }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: view } }))
  const api = { settings: {
    describe: async (request: { rpcId: ReturnType<typeof RpcId> }) => ({ rpcId: request.rpcId, result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [view] } } }),
    mutate,
  } } as unknown as ApiProxy
  const admin = createModelAdmin(() => api)
  const response = await admin.mutate({ rpcId: RpcId('metadata'), payload: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme', 'models'], value: [{ id: 'm', contextWindow: 200 }] }] } })
  expect(response.result.ok).toBe(true)
  expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ ops: [{ op: 'set', path: ['providers', 'acme', 'models'], value: [{ id: 'm', input: ['text', 'image'], compat: { thinkingFormat: 'openai' }, contextWindow: 200 }] }] }) }))
})
