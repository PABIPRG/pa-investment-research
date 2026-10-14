/** Load the application before Electron readiness, retaining smoke import failures. */
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const root = process.env.DSH_DESKTOP_SMOKE === '1' ? process.env.DSH_DESKTOP_SMOKE_ROOT : undefined
if (process.env.DSH_DESKTOP_SMOKE === '1') {
  assert(root && isAbsolute(root), 'desktop smoke requires an absolute temporary root')
  assert.equal(process.env.DSH_HOME, join(root, 'dsh-home'), 'desktop smoke must use its own DSH_HOME')
}
const iteration = process.env.DSH_DESKTOP_SMOKE_ITERATION === '2' ? '2' : '1'
function trace(stage: string): void {
  if (root === undefined) return
  appendFileSync(join(root, 'startup-phases.log'), `${JSON.stringify({
    at: new Date().toISOString(), pid: process.pid, iteration, stage,
  })}\n`, { encoding: 'utf8', mode: 0o600 })
}
trace('entry-start')
try {
  trace('application-import-start')
  // Electron waits for this import before ready; scheme privileges and paths
  // must be configured before that event.
  await import('./application.ts')
  trace('application-imported')
} catch (error) {
  if (root === undefined) throw error
  trace('application-import-failed')
  writeFileSync(join(root, `entry-failure-${iteration}.log`),
    error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
  process.exit(1)
}
