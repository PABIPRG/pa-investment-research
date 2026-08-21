import { getWatchlist, setWatchlist } from '../src/client.ts'

/** Adapter response shape used by the watchlist e2e workflow. */
export interface WatchlistState {
  tickers?: string[]
}

/** Adapter response shape returned after replacing the watchlist. */
export interface WatchlistSaved {
  saved?: number
}

/**
 * Replace and read back the adapter watchlist, then restore its original value.
 * Restoration runs after both successful and failed verification requests.
 */
export async function roundTripWatchlist(
  adapterUrl: string,
  replacement: string[],
  signal: AbortSignal,
): Promise<{ original: WatchlistState; saved: WatchlistSaved; persisted: WatchlistState }> {
  const original = (await getWatchlist(adapterUrl, signal)) as WatchlistState
  try {
    const saved = (await setWatchlist(adapterUrl, replacement, signal)) as WatchlistSaved
    const persisted = (await getWatchlist(adapterUrl, signal)) as WatchlistState
    return { original, saved, persisted }
  } finally {
    await setWatchlist(adapterUrl, original.tickers ?? [], signal)
  }
}
