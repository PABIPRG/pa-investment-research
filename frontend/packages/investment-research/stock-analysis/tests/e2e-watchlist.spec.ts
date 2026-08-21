import { afterEach, describe, expect, it, vi } from 'vitest'
import { roundTripWatchlist } from './e2e-watchlist.ts'

const BASE = 'http://adapter.test'

afterEach(() => vi.unstubAllGlobals())

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('adapter e2e watchlist cleanup', () => {
  it('回读临时列表失败时仍恢复原 watchlist', async () => {
    let tickers = ['daily-1', 'daily-2']
    let reads = 0
    const writes: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        reads += 1
        if (reads === 2) throw new Error('verification failed')
        return response({ tickers: [...tickers] })
      }
      if (typeof init.body !== 'string') throw new TypeError('expected a JSON request body')
      const body = JSON.parse(init.body) as { tickers: string[] }
      tickers = [...body.tickers]
      writes.push([...tickers])
      return response({ saved: tickers.length })
    }))

    await expect(roundTripWatchlist(
      BASE,
      ['600519', '000858', '300750'],
      new AbortController().signal,
    )).rejects.toThrow('verification failed')

    expect(writes).toEqual([
      ['600519', '000858', '300750'],
      ['daily-1', 'daily-2'],
    ])
    expect(tickers).toEqual(['daily-1', 'daily-2'])
  })
})
