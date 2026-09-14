/** Model-only projection and write authorization over the existing settings owner. */
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView, SettingsPathOpView } from './api/settings.ts'

const fields = new Set(['apiKeyEnv', 'displayName', 'api', 'baseURL', 'models'])
const modelFields = new Set(['id', 'name', 'description', 'contextWindow', 'maxTokens'])
const routePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const unsafe = new Set(['__proto__', 'prototype', 'constructor'])

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型配置必须是对象')
  return value as Record<string, unknown>
}

/** Conventional reference owned by one model route.
 * @param route - Validated model route identifier.
 * @returns The route-owned credential reference.
 */
export function modelKeyRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString()
  } catch { return undefined }
}

function profile(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record(value)).filter(([key]) => fields.has(key)).map(([key, item]) => [
    key, key === 'baseURL' ? safeEndpoint(item) : key === 'models' && Array.isArray(item)
      ? item.map(model => Object.fromEntries(Object.entries(record(model)).filter(([field]) => modelFields.has(field))))
      : item,
  ]))
}

/** Returns only model-editable fields, with no custom headers or unrelated namespaces.
 * @param view - Redacted authoritative settings descriptor.
 * @returns A model-only descriptor, or undefined for other namespaces.
 */
export function projectModelNamespace(view: SettingsNamespaceView): SettingsNamespaceView | undefined {
  if (!['llm-deepseek', 'llm-pi-ai'].includes(view.ns)) return undefined
  const layer = (value: unknown): unknown => {
    if (value === undefined) return undefined
    if (view.ns === 'llm-deepseek') return profile(value)
    const providers = record(value)['providers']
    return { providers: providers === undefined ? {} : Object.fromEntries(Object.entries(record(providers))
      .filter(([route]) => routePattern.test(route) && !unsafe.has(route)).map(([route, entry]) => [route, profile(entry)])) }
  }
  // Schema metadata may contain default values and credentials. Supply only the
  // protocol enum needed by the existing editor, never the deployment schema.
  const source = new Schema(view.schema as Schema)
  const originalProfile = view.ns === 'llm-pi-ai' ? source.dict?.['providers']?.inner : source
  const originalApi = originalProfile?.dict?.['api']
  const protocols = originalApi?.list?.flatMap(node => typeof node.value === 'string' ? [node.value] : []) ?? []
  const model = Schema.object({ id: Schema.string().required(), name: Schema.string(), description: Schema.string(), contextWindow: Schema.number().min(1), maxTokens: Schema.number().min(1) })
  const safeProfile = Schema.object({ apiKeyEnv: Schema.string(), displayName: Schema.string(), baseURL: Schema.string(), models: Schema.array(model), ...protocols.length ? { api: Schema.union(protocols) } : {} })
  const schema = (view.ns === 'llm-pi-ai' ? Schema.object({ providers: Schema.dict(safeProfile) }) : safeProfile).toJSON()
  return { ns: view.ns, schema, value: layer(view.value),
    ...view.base === undefined ? {} : { base: layer(view.base) },
    ...view.user === undefined ? {} : { user: layer(view.user) },
    applies: view.applies, revision: view.revision, secrets: [] }
}

/** Rejects writes outside model profiles and references not owned by the edited route.
 * @param ns - Requested settings namespace.
 * @param ops - Path edits received over RPC.
 * @param views - Current model descriptors for reference ownership.
 */
export function assertModelEdits(ns: string, ops: readonly SettingsPathOpView[], views: readonly SettingsNamespaceView[]): void {
  if (!['llm-deepseek', 'llm-pi-ai'].includes(ns) || ops.length === 0 || ops.length > 100) throw new Error('无权修改此配置范围')
  for (const op of ops) {
    if (op.path.some(part => unsafe.has(part))) throw new Error('无效配置路径')
    const pi = ns === 'llm-pi-ai'
    const route = pi ? op.path[1] : 'deepseek-official'
    if (route === undefined || !routePattern.test(route) || (pi && op.path[0] !== 'providers')) throw new Error('无效提供方路径')
    const path = pi ? op.path.slice(2) : op.path
    if (path.length > 1 || (path.length === 1 && !fields.has(path[0]!)) || (!pi && path.length === 0)) throw new Error('无权修改此配置字段')
    if (op.op === 'unset') continue
    const changes = path.length === 0 ? record(op.value) : { [path[0]!]: op.value }
    const current = views.find(view => view.ns === ns)?.value
    const prior = current === undefined ? undefined : pi ? record(record(current)['providers'] ?? {})[route] : current
    const previousRef = prior === undefined ? undefined : record(prior)['apiKeyEnv']
    for (const [field, value] of Object.entries(changes)) {
      if (!fields.has(field)) throw new Error('无权修改此配置字段')
      if (field === 'apiKeyEnv' && value !== modelKeyRef(route) && value !== previousRef) throw new Error('凭证引用不属于此模型提供方')
      if (field === 'models') {
        if (!Array.isArray(value) || value.length > 1000) throw new Error('无效模型列表')
        for (const model of value) if (Object.keys(record(model)).some(key => !modelFields.has(key))) throw new Error('无权修改此模型字段')
      }
      if (field !== 'models' && typeof value !== 'string') throw new Error('无效模型配置值')
    }
  }
}

/** References are derived from registered model profiles, never caller-selected environment names.
 * @param views - Current model descriptors.
 * @returns References owned by those profiles.
 */
export function modelCredentialRefs(views: readonly SettingsNamespaceView[]): Set<string> {
  const refs = new Set<string>()
  for (const view of views) {
    const projected = projectModelNamespace(view)
    if (!projected) continue
    const profiles = view.ns === 'llm-deepseek' ? [record(projected.value)] : Object.values(record(record(projected.value)['providers']))
    for (const entry of profiles) {
      const ref = record(entry)['apiKeyEnv']
      if (typeof ref === 'string') refs.add(ref)
    }
  }
  return refs
}
