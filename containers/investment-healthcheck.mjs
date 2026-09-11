#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const timeoutMs = Number(process.env.DSH_HEALTH_TIMEOUT_MS ?? '2000')

const checks = [
  ['web', process.env.DSH_HEALTH_WEB_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3080'}/healthz`, value => value?.status === 'ok'],
  ['trading-core', process.env.DSH_HEALTH_TRADING_URL ?? 'http://127.0.0.1:8000/health', value => value?.status === 'ok' && value?.service === 'trading-core'],
  ['market-watch', process.env.DSH_HEALTH_MARKET_URL ?? 'http://127.0.0.1:8100/health', value => value?.ok === true && value?.service === 'market-watch'],
  ['industry-chain', process.env.DSH_HEALTH_INDUSTRY_URL ?? 'http://127.0.0.1:8200/health', value => value?.ok === true && value?.service === 'industry-chain'],
]

/** Check the authenticated Web carrier and all three private backend identities. */
export async function checkReadiness() {
  const failures = []
  await Promise.all(checks.map(async ([name, url, accepts]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      const value = response.ok ? await response.json() : undefined
      if (!response.ok || !accepts(value)) failures.push(name)
    } catch {
      failures.push(name)
    }
  }))
  if (failures.length > 0) throw new Error(`services not ready: ${failures.sort().join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await checkReadiness()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
