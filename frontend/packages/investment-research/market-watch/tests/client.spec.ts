import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addAlert,
  dailyBrief,
  httpJson,
  listAlerts,
  newsExpress,
  removeAlert,
  scanMovers,
  techSignal,
  watchAdd,
  watchList,
  watchOverview,
  watchRemove,
} from '../src/client.ts'

const BASE = 'http://market.test'

afterEach(() => vi.unstubAllGlobals())

describe('market-watch adapter client', () => {
  it('sends every preserved JSON endpoint its method and body', async () => {
    const calls: Array<[string, string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, String(init.method), init.body as string | undefined])
      return new Response(JSON.stringify({ ok: true, items: [], count: 0 }), { status: 200 })
    }))
    const signal = new AbortController().signal

    await Promise.all([
      watchAdd(BASE, { code: '600519', name: '茅台' }, signal),
      watchRemove(BASE, { code: '600519' }, signal),
      watchList(BASE, signal),
      addAlert(BASE, { name: '突破', conditions: [] }, signal),
      listAlerts(BASE, signal),
      removeAlert(BASE, 'rule 1', signal),
      scanMovers(BASE, { kind: 'gainers', top_n: 3 }, signal),
      watchOverview(BASE, signal),
      techSignal(BASE, { code: '600519', lookback: 60 }, signal),
      newsExpress(BASE, signal),
      dailyBrief(BASE, { period: 'post', manual: true }, signal),
    ])

    expect(calls).toEqual([
      [`${BASE}/watchlist/add`, 'POST', '{"code":"600519","name":"茅台"}'],
      [`${BASE}/watchlist/remove`, 'POST', '{"code":"600519"}'],
      [`${BASE}/watchlist`, 'GET', undefined],
      [`${BASE}/alerts`, 'POST', '{"name":"突破","conditions":[]}'],
      [`${BASE}/alerts`, 'GET', undefined],
      [`${BASE}/alerts/rule 1`, 'DELETE', undefined],
      [`${BASE}/scan`, 'POST', '{"kind":"gainers","top_n":3}'],
      [`${BASE}/overview`, 'GET', undefined],
      [`${BASE}/tech-signal`, 'POST', '{"code":"600519","lookback":60}'],
      [`${BASE}/news/express`, 'POST', undefined],
      [`${BASE}/brief/generate`, 'POST', '{"period":"post","manual":true}'],
    ])
  })

  it('returns parsed JSON and exposes adapter failure text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: ['600519'] }), { status: 200 })))
    await expect(httpJson(BASE, '/watchlist')).resolves.toEqual({ items: ['600519'] })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })))
    await expect(httpJson(BASE, '/watchlist')).rejects.toThrow('适配器 HTTP 502: down')
  })
})
