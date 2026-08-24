import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearOwnedBackendState,
  ownedBackendStatePath,
  readOwnedBackendState,
  writeOwnedBackendState,
} from '../src/state.ts'
import type { OwnedBackendState } from '../src/state.ts'

const state: OwnedBackendState = {
  version: 1,
  id: 'trading-core',
  service: 'trading-core',
  pid: 42,
  baseUrl: 'http://127.0.0.1:8000',
  projectDir: '/repo/backend/dsh-trading-core',
  startedAt: '2026-08-21T00:00:00.000Z',
}

describe('owned backend state', () => {
  it('uses the stable DSH_HOME path and owner-only permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-state-'))
    const path = ownedBackendStatePath(home, 'trading-core')
    expect(path).toBe(join(home, 'investment-research', 'trading-core', 'runtime.json'))
    await writeOwnedBackendState(path, state)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(home, 'investment-research', 'trading-core'))).mode & 0o777).toBe(0o700)
    }
  })

  it('treats malformed or old state as diagnostics and never exposes a kill target', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-state-'))
    const path = ownedBackendStatePath(home, 'market-watch')
    const marketState = { ...state, id: 'market-watch', service: 'market-watch' } as const
    await writeOwnedBackendState(path, marketState)
    expect(await readOwnedBackendState(path)).toEqual({ kind: 'current', state: marketState })
    await writeFile(path, '{"version":0,"pid":999999}')
    expect(await readOwnedBackendState(path)).toEqual({ kind: 'stale', raw: { version: 0, pid: 999999 } })
    await writeFile(path, 'not json')
    expect(await readOwnedBackendState(path)).toEqual({ kind: 'invalid' })
    await writeFile(path, 'null')
    expect(await readOwnedBackendState(path)).toEqual({ kind: 'stale', raw: null })
  })

  it('only clears state that still matches the in-memory owned process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-state-'))
    const path = ownedBackendStatePath(home, 'trading-core')
    await writeOwnedBackendState(path, state)
    expect(await clearOwnedBackendState(path, { ...state, pid: 7 })).toBe(false)
    expect(await readOwnedBackendState(path)).toEqual({ kind: 'current', state })
    await chmod(path, 0o644)
    expect(await clearOwnedBackendState(path, state)).toBe(true)
    expect(await readOwnedBackendState(path)).toEqual({ kind: 'missing' })
  })

  it('surfaces state read errors other than absence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-state-'))
    const directory = join(home, 'runtime.json')
    await mkdir(directory)
    await expect(readOwnedBackendState(directory)).rejects.toThrow()
  })
})
