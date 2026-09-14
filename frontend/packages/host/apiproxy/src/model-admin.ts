/** Restricted administrator facade over authoritative settings and credential operations. */
import type { ApiProxy } from './api/index.ts'
import type { ModelAdminApi } from './api/model-admin.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from './api/settings.ts'
import type { RpcRequest, RpcResponse } from './api/rpc.ts'
import { assertModelEdits, modelCredentialRefs, projectModelNamespace } from './model-admin-policy.ts'
import { discoverPublicModels, modelEndpoint } from './model-admin-discovery.ts'

function denied<T>(request: RpcRequest<unknown>, message = '无权访问此模型配置范围'): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

/** Preserve fields the remote projection deliberately does not offer for editing. */
function preserveModelMetadata(ns: string, ops: SettingsPathOpView[], views: SettingsNamespaceView[]): SettingsPathOpView[] {
  const value = views.find(view => view.ns === ns)?.value
  const at = (path: string[]): unknown => path.reduce<unknown>((node, key) =>
    node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined, value)
  const mergeModels = (old: unknown, next: unknown): unknown => {
    if (!Array.isArray(old) || !Array.isArray(next)) return next
    return next.map((model: Record<string, unknown>) => ({
      ...old.find((prior: Record<string, unknown>) => prior['id'] === model['id']), ...model,
    }))
  }
  return ops.map(op => {
    if (op.op !== 'set') return op
    if (op.path.at(-1) === 'models') return { ...op, value: mergeModels(at(op.path), op.value) }
    if (ns === 'llm-pi-ai' && op.path.length === 2) {
      const prior = at(op.path) as Record<string, unknown> | undefined
      const next = op.value as Record<string, unknown>
      return { ...op, value: { ...prior, ...next,
        ...next['models'] === undefined ? {} : { models: mergeModels(prior?.['models'], next['models']) },
      } }
    }
    return op
  })
}

/** Build a model-only facade; underlying generic operations are never exposed by transport aliases.
 * @param getApi - Authoritative operations resolved after assembly.
 * @returns Model-scoped administration operations.
 */
export function createModelAdmin(getApi: () => ApiProxy): ModelAdminApi {
  const describe: ModelAdminApi['describe'] = async (request) => {
    const result = await getApi().settings.describe(request)
    if (!result.result.ok) return denied(request, '模型配置暂不可用，请重试')
    return { rpcId: request.rpcId, result: { ok: true, value: {
      writable: result.result.value.writable, hasDocument: false,
      namespaces: result.result.value.namespaces.flatMap(view => {
        const projected = projectModelNamespace(view)
        return projected ? [projected] : []
      }),
    } } }
  }
  const allowedRef = async (request: RpcRequest<unknown>, refs: string[]): Promise<boolean> => {
    const snapshot = await describe({ rpcId: request.rpcId, payload: {} })
    if (!snapshot.result.ok) return false
    const allowed = modelCredentialRefs(snapshot.result.value.namespaces)
    return refs.every(ref => allowed.has(ref))
  }
  return {
    describe,
    async mutate(request) {
      const snapshot = await getApi().settings.describe({ rpcId: request.rpcId, payload: {} })
      if (!snapshot.result.ok) return denied(request)
      try {
        assertModelEdits(request.payload.ns, request.payload.ops, snapshot.result.value.namespaces)
        for (const op of request.payload.ops) {
          if (op.op !== 'set') continue
          const value = op.path.at(-1) === 'baseURL' ? op.value
            : typeof op.value === 'object' && op.value !== null ? (op.value as Record<string, unknown>)['baseURL'] : undefined
          if (typeof value === 'string') modelEndpoint(value)
        }
      } catch (error) {
        return denied(request, error instanceof Error ? error.message : '模型配置被拒绝')
      }
      const result = await getApi().settings.mutate({ ...request, payload: { ...request.payload,
        ops: preserveModelMetadata(request.payload.ns, request.payload.ops, snapshot.result.value.namespaces),
      } })
      if (!result.result.ok) return denied(request, '保存失败：配置可能已更新，请重新加载后重试')
      const projected = projectModelNamespace(result.result.value)
      return projected ? { rpcId: request.rpcId, result: { ok: true, value: projected } } : denied(request)
    },
    async describeCredentials(request) {
      if (!await allowedRef(request, request.payload.refs)) return denied(request)
      const result = await getApi().credentials.describe(request)
      if (!result.result.ok) return denied(request, '凭证状态暂不可用')
      return { rpcId: request.rpcId, result: { ok: true, value: { credentials: Object.fromEntries(
        Object.entries(result.result.value.credentials).map(([ref, value]) => [ref, { configured: value.configured, writable: value.writable }]),
      ) } } }
    },
    async setCredential(request) {
      if (!await allowedRef(request, [request.payload.ref])) return denied(request)
      const result = await getApi().credentials.set(request)
      return result.result.ok ? result : denied(request, '密钥保存失败：请检查配置是否只读并重试')
    },
    async unsetCredential(request) {
      if (!await allowedRef(request, [request.payload.ref])) return denied(request)
      const result = await getApi().credentials.unset(request)
      return result.result.ok ? result : denied(request, '密钥移除失败：请检查配置是否只读并重试')
    },
    async discoverModels(request, signal) {
      const { settingsNs, baseURL, api, apiKey } = request.payload
      if (settingsNs !== 'llm-pi-ai') return denied(request, '此提供方请手动添加模型')
      // No stored credential may be forwarded to a caller-selected draft URL.
      if (!baseURL) return getApi().llm.discoverModels({ ...request, payload: { settingsNs, ...request.payload.provider ? { provider: request.payload.provider } : {} } }, signal)
      if (api && !['openai-completions', 'openai-responses'].includes(api)) return denied(request, '此协议请手动添加模型')
      try {
        const models = await discoverPublicModels(baseURL, apiKey, signal)
        return { rpcId: request.rpcId, result: { ok: true, value: { models } } }
      } catch {
        return denied(request, '模型发现失败：仅支持公网 HTTPS，禁止重定向；请检查地址和密钥，或手动添加模型')
      }
    },
  }
}
