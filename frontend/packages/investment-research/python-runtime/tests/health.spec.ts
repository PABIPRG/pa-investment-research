import { describe, expect, it } from 'vitest'
import { checkBackendHealth } from '../src/health.ts'
import type { PythonBackendDefinition } from '../src/types.ts'

const definition: PythonBackendDefinition = {
  id: 'trading-core',
  service: 'trading-core',
  mode: 'managed',
  baseUrl: 'http://127.0.0.1:8000',
  repositoryPath: ['backend', 'dsh-trading-core'],
  module: 'adapter.app:app',
  healthPath: '/health',
  healthOk: { status: 'ok' },
  initCommand: { posix: './init.sh', windows: 'init.bat' },
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return async (input) => {
    if (String(input) !== 'http://127.0.0.1:8000/health') {
      return new Response(JSON.stringify({ service: 'wrong-route' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('investment backend health classification', () => {
  it('classifies an identity and health-field match as healthy', async () => {
    await expect(checkBackendHealth(definition, {
      fetch: jsonFetch({ service: 'trading-core', status: 'ok', extra: true }),
    })).resolves.toMatchObject({ status: 'healthy' })
  })

  it('classifies non-2xx HTTP as occupied instead of spawnable', async () => {
    await expect(checkBackendHealth(definition, {
      fetch: jsonFetch({ service: 'trading-core', status: 'starting' }, 503),
    })).resolves.toMatchObject({ status: 'occupied', httpStatus: 503 })
  })

  it.each([
    { body: { service: 'market-watch', status: 'ok' }, mismatch: 'service identity' },
    { body: { service: 'trading-core', status: 'starting' }, mismatch: 'health fields' },
  ] as const)('classifies mismatched $mismatch as occupied', async ({ body }) => {
    await expect(checkBackendHealth(definition, { fetch: jsonFetch(body) }))
      .resolves.toMatchObject({ status: 'occupied' })
  })

  it('classifies only a stable ECONNREFUSED cause as refused', async () => {
    const cause = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    const fetchError = new TypeError('fetch failed', { cause })
    const refusingFetch: typeof fetch = async () => { throw fetchError }

    await expect(checkBackendHealth(definition, { fetch: refusingFetch }))
      .resolves.toMatchObject({ status: 'refused' })
  })

  it.each([
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    new TypeError('unsupported protocol response'),
  ])('keeps non-refusal network and protocol failures unavailable', async (fetchError) => {
    const failingFetch: typeof fetch = async () => { throw fetchError }
    await expect(checkBackendHealth(definition, { fetch: failingFetch }))
      .resolves.toMatchObject({ status: 'unavailable' })
  })

  it('keeps an invalid JSON response unavailable', async () => {
    const invalidJsonFetch: typeof fetch = async () => new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    await expect(checkBackendHealth(definition, { fetch: invalidJsonFetch }))
      .resolves.toMatchObject({ status: 'unavailable' })
  })

  it('keeps a non-object JSON response unavailable', async () => {
    await expect(checkBackendHealth(definition, { fetch: jsonFetch(null) }))
      .resolves.toMatchObject({ status: 'unavailable' })
  })
})
