import { describe, expect, it } from 'vitest'
import { assertModelEdits, projectModelNamespace } from '../src/model-admin-policy.ts'
const view = { ns: 'llm-pi-ai', schema: {}, value: { providers: { acme: { apiKeyEnv: 'ACME_API_KEY', headers: { authorization: 'secret-value' }, models: [{ id: 'm' }] } } }, user: {}, revision: 0, applies: 'live' as const, secrets: [] }
describe('model administration scope', () => {
  it('rejects unrelated namespaces, ancestor replacement and unsafe keys', () => {
    for (const [ns, path] of [['web-auth', ['passwordHash']], ['llm-pi-ai', []], ['llm-pi-ai', ['providers', '__proto__']]] as const) {
      expect(() => assertModelEdits(ns, [{ op: 'set', path: [...path], value: {} }], [])).toThrow()
    }
  })
  it('accepts a custom provider but rejects arbitrary credential references and headers', () => {
    const write = (value: unknown) => assertModelEdits('llm-pi-ai', [{ op: 'set', path: ['providers', 'acme'], value }], [])
    expect(() => write({ apiKeyEnv: 'ACME_API_KEY', models: [{ id: 'm' }] })).not.toThrow()
    expect(() => write({ apiKeyEnv: 'PATH' })).toThrow()
    expect(() => write({ headers: { authorization: 'secret-value' } })).toThrow()
  })
  it('removes non-model namespaces and unapproved fields from every layer', () => {
    expect(projectModelNamespace({ ...view, ns: 'web-auth' })).toBeUndefined()
    const projected = projectModelNamespace(view)
    expect(JSON.stringify(projected)).not.toContain('secret-value')
    expect(projected?.value).toEqual({ providers: { acme: { apiKeyEnv: 'ACME_API_KEY', models: [{ id: 'm' }] } } })
  })
})
