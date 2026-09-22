import { describe, expect, it, vi } from 'vitest'
import { handlePublicObservatoryRequest } from '../src/index.ts'
import * as Plugin from '../src/index.ts'

const baseConfig = {
  enabled: true,
  allowedOrigins: ['https://pair-observe.xiexin.dev'],
  trustedHosts: ['pair-api.xiexin.dev'],
  trustedProxyAddresses: [],
  timeoutMs: 5_000,
  maxResponseBytes: 1_000_000,
}

function facts(method = 'GET', origin = 'https://pair-observe.xiexin.dev') {
  return {
    method,
    headers: { host: 'pair-api.xiexin.dev', origin },
    socket: { remoteAddress: '10.0.0.8' },
  }
}

describe('handlePublicObservatoryRequest', () => {
  it('proxies only a fixed read path and returns exact CORS plus ETag', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('http://127.0.0.1:4321/public/performance/v1/overview?date=2026-09-18')
      return new Response(JSON.stringify({ availability: 'available', data_revision: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const response = await handlePublicObservatoryRequest(
      new Request('https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-09-18', {
        headers: { origin: 'https://pair-observe.xiexin.dev' },
      }),
      facts(),
      baseConfig,
      async () => ({ baseUrl: 'http://127.0.0.1:4321' }),
      fetchImpl,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://pair-observe.xiexin.dev')
    expect(response.headers.get('vary')).toBe('Origin')
    expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{32}"$/)
    expect(await response.json()).toEqual({ availability: 'available', data_revision: 7 })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects unknown routes, query keys, methods, and origins before acquiring the backend', async () => {
    const acquire = vi.fn()
    const cases: Array<[Request, ReturnType<typeof facts>, number]> = [
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/private'), facts(), 404],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-09-18&debug=1'), facts(), 422],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/activities?as_of=2026-09-18&limit=1&limit=99999'), facts(), 422],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-09-18&date=2026-09-17'), facts(), 422],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-02-30'), facts(), 422],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/equity?from=2020-01-01&to=2026-09-20'), facts(), 422],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-09-18', { method: 'POST' }), facts('POST'), 405],
      [new Request('https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-09-18'), facts('GET', 'https://evil.example'), 403],
    ]
    for (const [request, requestFacts, status] of cases) {
      const response = await handlePublicObservatoryRequest(
        request, requestFacts, baseConfig, acquire,
      )
      expect(response.status).toBe(status)
    }
    expect(acquire).not.toHaveBeenCalled()
  })

  it('serves an exact preflight without touching the backend', async () => {
    const acquire = vi.fn()
    const requestFacts = {
      ...facts('OPTIONS'),
      headers: {
        host: 'pair-api.xiexin.dev',
        origin: 'https://pair-observe.xiexin.dev',
        'access-control-request-method': 'GET',
      },
    }
    const response = await handlePublicObservatoryRequest(
      new Request('https://pair-api.xiexin.dev/api/public/performance/v1/equity', {
        method: 'OPTIONS',
        headers: requestFacts.headers,
      }),
      requestFacts,
      baseConfig,
      acquire,
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('returns sanitized 503 with CORS and no-store when the backend fails', async () => {
    const response = await handlePublicObservatoryRequest(
      new Request('https://pair-api.xiexin.dev/api/public/performance/v1/calendar?month=2026-09', { headers: { origin: baseConfig.allowedOrigins[0]! } }),
      facts(),
      baseConfig,
      async () => ({ baseUrl: 'http://127.0.0.1:4321' }),
      async () => { throw new Error('private backend path') },
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'temporarily-unavailable',
      message: '公开数据暂时不可用，请稍后重试。',
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe(baseConfig.allowedOrigins[0])
  })

  it('preserves named injection and Config for the real Loader', () => {
    expect('default' in Plugin).toBe(false)
  })

  it.each([false, true])('cancels an oversized stream before buffering its entire body (length header: %s)', async (declared) => {
    let bytesRead = 0
    const cancel = vi.fn()
    const upstream = new Response(new ReadableStream({
      pull(controller) { bytesRead += 600; controller.enqueue(new Uint8Array(600)) },
      cancel,
    }), { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '999999' } : {}) } })
    const response = await handlePublicObservatoryRequest(
      new Request('https://pair-api.xiexin.dev/api/public/performance/v1/calendar?month=2026-09'), facts(),
      { ...baseConfig, maxResponseBytes: 1024 },
      async () => ({ baseUrl: 'http://127.0.0.1:4321' }), async () => upstream,
    )
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('response-too-large')
    expect(bytesRead).toBeLessThanOrEqual(2400)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['endpoint', 'headers', 'body'] as const)('bounds the entire request when %s hangs', async (stage) => {
    const cancel = vi.fn()
    const stalled = () => new Promise<never>(() => {})
    const response = await handlePublicObservatoryRequest(
      new Request('https://pair-api.xiexin.dev/api/public/performance/v1/calendar?month=2026-09'), facts(),
      { ...baseConfig, timeoutMs: 20 },
      stage === 'endpoint' ? stalled : async () => ({ baseUrl: 'http://127.0.0.1:4321' }),
      stage === 'headers' ? stalled : async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }),
    )
    expect(response.status).toBe(503)
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not follow backend redirects and does not forward browser credentials', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 302 }))
    const response = await handlePublicObservatoryRequest(
      new Request('https://pair-api.xiexin.dev/api/public/performance/v1/calendar?month=2026-09', {
        headers: { authorization: 'Bearer private', cookie: 'private=1' },
      }), facts(), baseConfig,
      async () => ({ baseUrl: 'http://127.0.0.1:4321' }), fetchImpl,
    )
    expect(response.status).toBe(503)
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBe('omit')
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
  })
})
