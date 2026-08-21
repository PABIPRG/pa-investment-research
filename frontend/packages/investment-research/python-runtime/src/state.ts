import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { InvestmentBackendId } from './types.ts'

/** Durable diagnostic record for one process owned by this runtime instance. */
export interface OwnedBackendState {
  readonly version: 1
  readonly id: InvestmentBackendId
  readonly service: InvestmentBackendId
  readonly pid: number
  readonly baseUrl: string
  readonly projectDir: string
  readonly startedAt: string
}

/** Non-authoritative state read used only for diagnostics and matched cleanup. */
export type OwnedBackendStateRead =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'stale'; raw: unknown }>
  | Readonly<{ kind: 'current'; state: OwnedBackendState }>

/**
 * Resolve one backend's state file beneath DSH_HOME.
 * @param dshHome - explicit Harness home.
 * @param id - backend whose state path is required.
 * @returns stable runtime state path.
 */
export function ownedBackendStatePath(dshHome: string, id: InvestmentBackendId): string {
  return join(dshHome, 'investment-research', id, 'runtime.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBackendId(value: unknown): value is InvestmentBackendId {
  return value === 'trading-core' || value === 'market-watch'
}

function isOwnedBackendState(value: unknown): value is OwnedBackendState {
  return isRecord(value)
    && value.version === 1
    && isBackendId(value.id)
    && isBackendId(value.service)
    && typeof value.pid === 'number'
    && typeof value.baseUrl === 'string'
    && typeof value.projectDir === 'string'
    && typeof value.startedAt === 'string'
}

/**
 * Atomically publish owner-only runtime state.
 * @param path - exact state file path.
 * @param state - current in-memory owned process identity.
 */
export async function writeOwnedBackendState(path: string, state: OwnedBackendState): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Read state as diagnostics; a stale pid is never an authority to terminate anything.
 * @param path - exact state file path.
 * @returns classified diagnostic state without process authority.
 */
export async function readOwnedBackendState(path: string): Promise<OwnedBackendStateRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { kind: 'invalid' }
  }
  return isOwnedBackendState(value) ? { kind: 'current', state: value } : { kind: 'stale', raw: value }
}

function stateMatches(left: OwnedBackendState, right: OwnedBackendState): boolean {
  return left.version === right.version
    && left.id === right.id
    && left.service === right.service
    && left.pid === right.pid
    && left.baseUrl === right.baseUrl
    && left.projectDir === right.projectDir
    && left.startedAt === right.startedAt
}

/**
 * Remove state only when it still names the exact in-memory owned process.
 * @param path - exact state file path.
 * @param expected - current in-memory owned process identity.
 * @returns whether the matching record was removed.
 */
export async function clearOwnedBackendState(path: string, expected: OwnedBackendState): Promise<boolean> {
  const current = await readOwnedBackendState(path)
  if (current.kind !== 'current' || !stateMatches(current.state, expected)) return false
  await rm(path, { force: true })
  return true
}
