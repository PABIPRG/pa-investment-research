/** Loopback addresses selected together for one desktop runtime's backend peers. */
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import type { InvestmentBackendId } from './types.ts'

/**
 * Select distinct ephemeral endpoints without contacting or stopping existing services.
 * A subsequent bind race is detected by the child's per-start health identity.
 * @returns addresses stable for the lifetime of one manager.
 */
export async function allocateBackendEndpoints(): Promise<Readonly<Record<InvestmentBackendId, string>>> {
  const reservations: Server[] = []
  const endpoints = {} as Record<InvestmentBackendId, string>
  try {
    for (const id of ['trading-core', 'market-watch', 'industry-chain'] as const) {
      const server = createServer()
      reservations.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('investment Python runtime: missing loopback port')
      endpoints[id] = `http://127.0.0.1:${address.port}`
    }
    return Object.freeze(endpoints)
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return }
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })))
  }
}
