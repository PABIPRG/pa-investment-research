/** Browser plugin artifacts must not retain Node built-in requires. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readBundle(): string | undefined {
  try {
    return readFileSync(resolve('packages/client/ui-investment-research/lib/client.js'), 'utf8')
  } catch {
    return undefined
  }
}

describe('investment research client artifact', () => {
  const bundle = readBundle()

  it.skipIf(bundle === undefined)('does not require Node stream at plugin load time', () => {
    expect(bundle).not.toMatch(/require\(["'](?:node:)?stream["']\)/)
  })
})
