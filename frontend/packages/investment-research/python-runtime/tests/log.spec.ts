import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackendLog, backendLogPaths, safeErrorMessage } from '../src/log.ts'

describe('BackendLog', () => {
  it('writes source-prefixed lines, keeps a bounded byte tail, and uses stable paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-log-'))
    const paths = backendLogPaths(home, 'trading-core')
    expect(paths.active).toBe(join(home, 'investment-research', 'trading-core', 'backend.log'))
    expect(paths.previous).toBe(join(home, 'investment-research', 'trading-core', 'backend.previous.log'))
    const log = await BackendLog.open(paths, { tailBytes: 12, maxBytes: 1024 })
    await log.append('stdout', 'alpha\n')
    await log.append('stderr', 'beta\n')
    const content = await readFile(paths.active, 'utf8')
    expect(content).toContain('[stdout] alpha')
    expect(content).toContain('[stderr] beta')
    expect(Buffer.byteLength(log.tail())).toBeLessThanOrEqual(12)
  })

  it('rotates an oversized active file before the next run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-log-'))
    const paths = backendLogPaths(home, 'market-watch')
    const first = await BackendLog.open(paths, { tailBytes: 64, maxBytes: 4 })
    await first.append('runtime', 'oversized')
    const second = await BackendLog.open(paths, { tailBytes: 64, maxBytes: 4 })
    await second.append('runtime', 'new')
    expect(await readFile(paths.previous, 'utf8')).toContain('oversized')
    expect(await readFile(paths.active, 'utf8')).toContain('new')
    expect((await stat(paths.active)).isFile()).toBe(true)
  })

  it('redacts environment values from diagnostics', () => {
    const secret = 'do-not-leak-this-value'
    const message = safeErrorMessage(new Error(`spawn failed: ${secret}`), { ADAPTER_RUNNER: secret })
    expect(message).toContain('spawn failed')
    expect(message).not.toContain(secret)
    expect(message).toContain('[REDACTED]')
    expect(safeErrorMessage(404, { EMPTY: '', MISSING: undefined })).toBe('404')
  })

  it('surfaces unexpected filesystem errors and ignores empty appends', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-log-'))
    await expect(BackendLog.open({ active: '\0', previous: join(home, 'previous') }, {
      tailBytes: 8,
      maxBytes: 8,
    })).rejects.toThrow()
    const paths = backendLogPaths(home, 'trading-core')
    const log = await BackendLog.open(paths, { tailBytes: 8, maxBytes: 8 })
    await log.append('runtime', '')
    expect(log.tail()).toBe('')
  })
})
