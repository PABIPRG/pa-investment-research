/** Cross-surface ownership and graceful replacement for the investment product. */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export type InvestmentInstanceMode = 'web' | 'electron'
export type InvestmentInstanceConflictDecision = 'replace' | 'cancel'

export interface InvestmentInstanceOwner {
  readonly version: 1
  readonly instanceId: string
  readonly mode: InvestmentInstanceMode
  readonly pid: number
  readonly startedAt: string
  readonly projectDir: string
}

interface InvestmentInstanceRecord extends InvestmentInstanceOwner {
  readonly controlPort: number
  readonly controlToken: string
}

export interface InvestmentInstanceLease {
  readonly owner: InvestmentInstanceOwner
  onStopRequested(handler: () => void): void
  release(): Promise<void>
}

export interface CoordinateInvestmentInstanceOptions {
  readonly mode: InvestmentInstanceMode
  readonly dshHome?: string
  readonly projectDir?: string
  readonly pid?: number
  readonly stopTimeoutMs?: number
  readonly pollMs?: number
  readonly onConflict?: (
    owner: InvestmentInstanceOwner,
  ) => Promise<InvestmentInstanceConflictDecision> | InvestmentInstanceConflictDecision
}

export const INVESTMENT_INSTANCE_CONFLICT_CODE = 'DSH_INVESTMENT_INSTANCE_CONFLICT'
export const INVESTMENT_INSTANCE_STOP_FAILED_CODE = 'DSH_INVESTMENT_INSTANCE_STOP_FAILED'

const OWNER_FILENAME = 'owner.json'
const LOCK_DIRECTORY = 'application.lock'
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 100
const INCOMPLETE_OWNER_RETRIES = 10

export class InvestmentInstanceConflictError extends Error {
  readonly code = INVESTMENT_INSTANCE_CONFLICT_CODE

  constructor(readonly owner: InvestmentInstanceOwner) {
    super(
      `investment-research: a ${owner.mode} instance is already running (pid ${String(owner.pid)}); `
      + 'close it first or approve replacing the existing instance',
    )
    this.name = 'InvestmentInstanceConflictError'
  }
}

export class InvestmentInstanceStopError extends Error {
  readonly code = INVESTMENT_INSTANCE_STOP_FAILED_CODE

  constructor(readonly owner: InvestmentInstanceOwner, detail: string) {
    super(
      `investment-research: could not stop the existing ${owner.mode} instance `
      + `(pid ${String(owner.pid)}): ${detail}`,
    )
    this.name = 'InvestmentInstanceStopError'
  }
}

/** Stable directory containing the exclusive application-instance lease. */
export function investmentInstanceLockDirectory(dshHome = resolveDshHome()): string {
  return join(dshHome, 'investment-research', LOCK_DIRECTORY)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOwner(value: unknown): value is InvestmentInstanceRecord {
  return isRecord(value)
    && value.version === 1
    && typeof value.instanceId === 'string'
    && (value.mode === 'web' || value.mode === 'electron')
    && typeof value.pid === 'number'
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.startedAt === 'string'
    && typeof value.projectDir === 'string'
    && typeof value.controlPort === 'number'
    && Number.isInteger(value.controlPort)
    && value.controlPort > 0
    && value.controlPort <= 65_535
    && typeof value.controlToken === 'string'
    && value.controlToken.length >= 32
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readOwner(lockDir: string): Promise<InvestmentInstanceRecord | undefined> {
  let text: string
  try {
    text = await readFile(join(lockDir, OWNER_FILENAME), 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error(`investment-research: invalid application instance record at ${lockDir}`)
  }
  if (!isOwner(value)) {
    throw new Error(`investment-research: invalid application instance record at ${lockDir}`)
  }
  return value
}

async function readSettledOwner(lockDir: string, pollMs: number): Promise<InvestmentInstanceRecord | undefined> {
  for (let attempt = 0; attempt < INCOMPLETE_OWNER_RETRIES; attempt += 1) {
    const owner = await readOwner(lockDir)
    if (owner !== undefined) return owner
    await delay(pollMs)
  }
  return undefined
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(`Bearer ${expected}`)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

interface ControlServer {
  readonly server: Server
  readonly port: number
  readonly token: string
  onStopRequested(handler: () => void): void
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

async function createControlServer(): Promise<ControlServer> {
  const token = randomBytes(32).toString('hex')
  let handler: (() => void) | undefined
  let requested = false
  let dispatched = false
  const dispatch = (): void => {
    if (!requested || dispatched || handler === undefined) return
    dispatched = true
    queueMicrotask(handler)
  }
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/stop') {
      response.writeHead(404).end()
      return
    }
    if (!tokenMatches(request.headers.authorization, token)) {
      response.writeHead(403).end()
      return
    }
    requested = true
    response.writeHead(202).end()
    dispatch()
  })
  server.unref()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('investment-research: failed to create the local instance control channel')
  }
  return {
    server,
    port: address.port,
    token,
    onStopRequested(next) {
      handler = next
      dispatch()
    },
  }
}

async function writeOwner(lockDir: string, owner: InvestmentInstanceRecord): Promise<void> {
  const temporary = join(lockDir, `.owner-${owner.instanceId}.tmp`)
  await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, join(lockDir, OWNER_FILENAME))
}

async function quarantineStaleLock(lockDir: string): Promise<boolean> {
  const quarantine = `${lockDir}.stale-${randomUUID()}`
  try {
    await rename(lockDir, quarantine)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
  await rm(quarantine, { recursive: true, force: true })
  return true
}

async function releaseOwnedLock(lockDir: string, instanceId: string): Promise<void> {
  const current = await readOwner(lockDir)
  if (current === undefined || current.instanceId !== instanceId) return
  const released = `${lockDir}.released-${instanceId}`
  try {
    await rename(lockDir, released)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  await rm(released, { recursive: true, force: true })
}

type ClaimResult =
  | Readonly<{ kind: 'acquired'; lease: InvestmentInstanceLease }>
  | Readonly<{ kind: 'conflict'; record: InvestmentInstanceRecord }>

function publicOwner(record: InvestmentInstanceRecord): InvestmentInstanceOwner {
  return Object.freeze({
    version: record.version,
    instanceId: record.instanceId,
    mode: record.mode,
    pid: record.pid,
    startedAt: record.startedAt,
    projectDir: record.projectDir,
  })
}

async function tryClaim(options: CoordinateInvestmentInstanceOptions, pollMs: number): Promise<ClaimResult> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const lockDir = investmentInstanceLockDirectory(dshHome)
  const instanceRoot = join(dshHome, 'investment-research')
  await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
  const control = await createControlServer()
  try {
    for (;;) {
      try {
        await mkdir(lockDir, { mode: 0o700 })
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        const owner = await readSettledOwner(lockDir, pollMs)
        if (owner === undefined) {
          throw new Error(`investment-research: incomplete application instance record at ${lockDir}`)
        }
        if (processIsAlive(owner.pid)) {
          await closeServer(control.server)
          return { kind: 'conflict', record: owner }
        }
        if (!await quarantineStaleLock(lockDir)) continue
        continue
      }

      const owner: InvestmentInstanceRecord = Object.freeze({
        version: 1,
        instanceId: randomUUID(),
        mode: options.mode,
        pid: options.pid ?? process.pid,
        startedAt: new Date().toISOString(),
        projectDir: options.projectDir ?? process.cwd(),
        controlPort: control.port,
        controlToken: control.token,
      })
      try {
        await writeOwner(lockDir, owner)
      } catch (error) {
        await quarantineStaleLock(lockDir)
        throw error
      }
      let released: Promise<void> | undefined
      return {
        kind: 'acquired',
        lease: {
          owner: publicOwner(owner),
          onStopRequested: (handler) => { control.onStopRequested(handler) },
          release() {
            released ??= (async () => {
              await releaseOwnedLock(lockDir, owner.instanceId)
              await closeServer(control.server)
            })()
            return released
          },
        },
      }
    }
  } catch (error) {
    await closeServer(control.server)
    throw error
  }
}

async function requestStop(owner: InvestmentInstanceRecord, timeoutMs: number): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, timeoutMs)
  timeout.unref()
  try {
    const response = await fetch(`http://127.0.0.1:${String(owner.controlPort)}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.controlToken}` },
      signal: controller.signal,
    })
    if (response.status !== 202) {
      throw new Error(`control channel returned HTTP ${String(response.status)}`)
    }
  } catch (error) {
    const detail = controller.signal.aborted
      ? 'the graceful stop request timed out'
      : `the graceful stop request failed: ${error instanceof Error ? error.message : String(error)}`
    throw new InvestmentInstanceStopError(publicOwner(owner), detail)
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForRelease(
  dshHome: string,
  owner: InvestmentInstanceRecord,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const lockDir = investmentInstanceLockDirectory(dshHome)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await readOwner(lockDir)
    if (current === undefined || current.instanceId !== owner.instanceId) return
    await delay(pollMs)
  }
  throw new InvestmentInstanceStopError(publicOwner(owner), 'the instance did not exit before the timeout')
}

/**
 * Claim the investment product across Web and Electron, optionally replacing a
 * live owner only after the caller confirms and the owner acknowledges a local,
 * authenticated graceful-stop request.
 */
export async function coordinateInvestmentInstance(
  options: CoordinateInvestmentInstanceOptions,
): Promise<InvestmentInstanceLease> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const timeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  for (;;) {
    const result = await tryClaim({ ...options, dshHome }, pollMs)
    if (result.kind === 'acquired') return result.lease
    const owner = publicOwner(result.record)
    const decision = await options.onConflict?.(owner) ?? 'cancel'
    if (decision !== 'replace') throw new InvestmentInstanceConflictError(owner)
    await requestStop(result.record, timeoutMs)
    await waitForRelease(dshHome, result.record, timeoutMs, pollMs)
  }
}
