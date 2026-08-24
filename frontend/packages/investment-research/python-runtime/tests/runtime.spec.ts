import { access, mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { InvestmentPythonRuntime } from '../src/index.ts'
import { InvestmentBackendManager } from '../src/runtime.ts'
import type { BackendHealthResult, PythonBackendDefinition } from '../src/types.ts'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import { apply as applyInvariant, inject as invariantInject, name as invariantName } from '../src/invariant.ts'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { ownedBackendStatePath, writeOwnedBackendState } from '../src/state.ts'
import { fakeHandle } from './fixtures/fake-handle.ts'

const definition: PythonBackendDefinition = {
  id: 'trading-core',
  service: 'trading-core',
  mode: 'managed',
  baseUrl: 'http://127.0.0.1:8000',
  repositoryPath: ['backend', 'dsh-trading-core'],
  module: 'adapter.app:app',
  healthPath: '/health',
  healthOk: { status: 'ok' },
  initCommand: { posix: './init.sh', windows: 'init.bat' },
  managedEnv: { ADAPTER_RUNNER: 'runner-name' },
}

const healthy: BackendHealthResult = { status: 'healthy', healthUrl: 'http://127.0.0.1:8000/health', httpStatus: 200 }
const refused: BackendHealthResult = { status: 'refused', healthUrl: 'http://127.0.0.1:8000/health', error: new Error('refused') }

function credentialRef(value: string): CredentialRef {
  return value as CredentialRef
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function harness(health: BackendHealthResult[] = [healthy]) {
  const home = await mkdtemp(join(tmpdir(), 'investment-runtime-'))
  const projectDir = join(home, 'repo', 'backend')
  const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
  await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
  await access(join(projectDir, 'env', 'bin'))
  const handle = fakeHandle()
  const specs: SubprocessSpawnSpec[] = []
  const subprocess = {
    spawn(spec: SubprocessSpawnSpec) { specs.push(spec); return handle },
  } as unknown as SubprocessRuntime
  let probe = 0
  const manager = new InvestmentBackendManager({
    subprocess,
    config: { dshHome: home, startupTimeoutMs: 50, healthPollMs: 1, shutdownGraceMs: 5, logTailBytes: 128, logMaxBytes: 1024 },
    checkHealth: async () => health[Math.min(probe++, health.length - 1)]!,
    resolvePaths: () => ({ projectDir, pythonExecutable }),
    executableExists: async () => true,
    sleep: async () => {},
    now: (() => { let value = 0; return () => ++value })(),
  })
  return { manager, handle, specs, subprocess, home, projectDir }
}

class StubSubprocess extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> { return command }
  spawn(): never { throw new Error('unexpected spawn') }
  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> { throw new Error('unexpected terminal') }
}

describe('InvestmentBackendManager', () => {
  it('single-flights concurrent acquire, refcounts leases, and stops only after the last release', async () => {
    const { manager, handle, specs } = await harness([refused, refused, healthy])
    manager.register(definition)
    const [first, second] = await Promise.all([
      manager.acquire('trading-core'),
      manager.acquire('trading-core'),
    ])
    const third = await manager.acquire('trading-core')
    expect(specs).toHaveLength(1)
    expect(first.ownership).toBe('owned')
    await first.release()
    expect(handle.terminateCalls).toBe(0)
    await second.release()
    expect(handle.terminateCalls).toBe(0)
    handle.exit()
    await third.release()
    expect(handle.terminateCalls).toBe(1)
  })

  it('isolates caller cancellation from a shared startup and the acquired child lifetime', async () => {
    const ready = Promise.withResolvers<BackendHealthResult>()
    const base = await harness()
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess: base.subprocess,
      config: { dshHome: base.home },
      checkHealth: async () => probes++ === 0 ? refused : ready.promise,
      resolvePaths: () => ({ projectDir: base.projectDir, pythonExecutable: join(base.projectDir, 'env', 'bin', 'python') }),
      executableExists: async () => true,
    })
    manager.register(definition)
    const controller = new AbortController()
    const cancelled = manager.acquire('trading-core', controller.signal)
    const surviving = manager.acquire('trading-core')
    await vi.waitFor(() => { expect(base.specs).toHaveLength(1) })
    controller.abort(new Error('caller cancelled'))
    await expect(cancelled).rejects.toThrow('caller cancelled')
    ready.resolve(healthy)
    const lease = await surviving
    expect(base.specs[0]?.signal).not.toBe(controller.signal)
    expect(base.handle.terminateCalls).toBe(0)
    base.handle.exit()
    await lease.release()
  })

  it('makes a new acquire wait for the previous owned teardown', async () => {
    const current = await harness([refused, healthy, healthy])
    current.manager.register(definition)
    const lease = await current.manager.acquire('trading-core')
    const releasing = lease.release()
    let reacquired = false
    const next = current.manager.acquire('trading-core').then((value) => {
      reacquired = true
      return value
    })
    await Promise.resolve()
    expect(reacquired).toBe(false)
    current.handle.exit()
    await releasing
    const nextLease = await next
    expect(nextLease.ownership).toBe('attached')
    await nextLease.release()
  })

  it('makes disposal await an owned teardown already in progress', async () => {
    const current = await harness([refused, healthy])
    current.manager.register(definition)
    const lease = await current.manager.acquire('trading-core')
    const releasing = lease.release()
    const acquiring = current.manager.acquire('trading-core')
    let disposed = false
    const disposing = current.manager.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    current.handle.exit()
    await releasing
    await expect(acquiring).rejects.toThrow(/disposed/)
    await disposing
    expect(disposed).toBe(true)
  })

  it('never spawns external, attached, occupied, or unavailable endpoints', async () => {
    for (const [mode, result, ownership] of [
      ['external', healthy, 'external'],
      ['managed', healthy, 'attached'],
    ] as const) {
      const { manager, specs } = await harness([result])
      manager.register({ ...definition, mode })
      const lease = await manager.acquire('trading-core')
      expect(lease.ownership).toBe(ownership)
      expect(specs).toHaveLength(0)
      await lease.release()
    }
    for (const result of [
      { status: 'occupied', healthUrl: 'x', httpStatus: 503 },
      { status: 'unavailable', healthUrl: 'x', error: new Error('network') },
    ] as const) {
      const { manager, specs } = await harness([result])
      manager.register(definition)
      await expect(manager.acquire('trading-core')).rejects.toThrow(/occupied|unavailable/)
      expect(specs).toHaveLength(0)
    }
  })

  it('re-verifies reused attached and external entries before adding a lease', async () => {
    for (const mode of ['managed', 'external'] as const) {
      const occupied: BackendHealthResult = { status: 'occupied', healthUrl: 'x', httpStatus: 200 }
      const { manager } = await harness([healthy, occupied])
      manager.register({ ...definition, mode })
      const lease = await manager.acquire('trading-core')
      await expect(manager.acquire('trading-core')).rejects.toThrow(/occupied/)
      await lease.release()
    }
    const verified = await harness([healthy, healthy])
    verified.manager.register({ ...definition, mode: 'external' })
    const first = await verified.manager.acquire('trading-core')
    const second = await verified.manager.acquire('trading-core', new AbortController().signal)
    await first.release()
    await second.release()
  })

  it('counts identical registrations and rejects conflicting definitions', async () => {
    const { manager } = await harness()
    const unregisterFirst = manager.register(definition)
    const unregisterSecond = manager.register({ ...definition })
    expect(() => manager.register({ ...definition, baseUrl: 'http://127.0.0.1:8001' })).toThrow(/conflict/)
    unregisterFirst()
    await expect(manager.acquire('trading-core')).resolves.toMatchObject({ ownership: 'attached' })
    unregisterSecond()
    unregisterSecond()
    await expect(manager.acquire('trading-core')).rejects.toThrow(/not registered/)
  })

  it('rejects invalid credential environment target names', async () => {
    const { manager } = await harness()
    expect(() => manager.register({
      ...definition,
      credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'TRADING-API-KEY', role: 'required' }],
    })).toThrow(/invalid credential environment/i)
  })

  it('rejects duplicate credential environment targets', async () => {
    const { manager } = await harness()
    expect(() => manager.register({
      ...definition,
      credentialEnv: [
        { ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' },
        { ref: credentialRef('trading-api-secret'), env: 'TRADING_API_KEY', role: 'enhancement' },
      ],
    })).toThrow(/duplicate credential environment/i)
  })

  it('rejects credential targets that collide with managed environment entries', async () => {
    const { manager } = await harness()
    expect(() => manager.register({
      ...definition,
      managedEnv: { TRADING_API_KEY: 'runner-name' },
      credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' }],
    })).toThrow(/managed environment/i)
  })

  it('uses injected Windows environment-key semantics while POSIX preserves exact keys', async () => {
    const credentialEnv = [{ ref: credentialRef('trading-api-key'), env: 'trading_api_key', role: 'required' }] as const
    const posix = await harness()
    expect(() => posix.manager.register({ ...definition, managedEnv: { TRADING_API_KEY: 'runner-name' }, credentialEnv })).not.toThrow()

    const windows = new InvestmentBackendManager({
      subprocess: posix.subprocess,
      config: { dshHome: posix.home },
      normalizeEnvironmentKey: key => key.toUpperCase(),
    })
    expect(() => windows.register({ ...definition, managedEnv: { TRADING_API_KEY: 'runner-name' }, credentialEnv })).toThrow(/managed environment/i)
    expect(() => windows.register({
      ...definition,
      credentialEnv: [
        { ref: credentialRef('trading-api-key'), env: 'trading_api_key', role: 'required' },
        { ref: credentialRef('trading-api-secret'), env: 'TRADING_API_KEY', role: 'enhancement' },
      ],
    })).toThrow(/duplicate credential environment/i)
  })

  it('treats normalized equivalent credential mappings as identical registrations and rejects other mappings', async () => {
    const current = await harness()
    const manager = new InvestmentBackendManager({
      subprocess: current.subprocess,
      config: { dshHome: current.home },
      checkHealth: async () => healthy,
      normalizeEnvironmentKey: key => key.toUpperCase(),
    })
    const first = manager.register({
      ...definition,
      credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'trading_api_key', role: 'required' }],
    })
    const second = manager.register({
      ...definition,
      credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' }],
    })
    expect(() => manager.register({
      ...definition,
      credentialEnv: [{ ref: credentialRef('trading-api-secret'), env: 'TRADING_API_KEY', role: 'required' }],
    })).toThrow(/conflict/)
    first()
    await expect(manager.acquire('trading-core')).resolves.toMatchObject({ ownership: 'attached' })
    second()
  })

  it('resolves each credential only for an owned spawn after a refused health probe', async () => {
    const secret = 'credential-value-must-stay-private'
    for (const [mode, health] of [
      ['managed', healthy],
      ['external', healthy],
    ] as const) {
      const current = await harness([health])
      const resolveCredential = vi.fn(async () => secret)
      const manager = new InvestmentBackendManager({
        subprocess: current.subprocess,
        config: { dshHome: current.home },
        checkHealth: async () => health,
        resolveCredential,
      })
      manager.register({
        ...definition,
        mode,
        credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' }],
      })
      const lease = await manager.acquire('trading-core')
      expect(resolveCredential).not.toHaveBeenCalled()
      expect(current.specs).toHaveLength(0)
      await lease.release()
    }

    const current = await harness()
    const events: string[] = []
    let probes = 0
    const resolveCredential = vi.fn(async (ref: CredentialRef) => {
      events.push(`resolve:${ref}`)
      return secret
    })
    const manager = new InvestmentBackendManager({
      subprocess: current.subprocess,
      config: { dshHome: current.home },
      checkHealth: async () => {
        const result = probes++ === 0 ? refused : healthy
        events.push(`health:${result.status}`)
        return result
      },
      resolveCredential,
    })
    manager.register({
      ...definition,
      credentialEnv: [
        { ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' },
        { ref: credentialRef('trading-api-key'), env: 'TRADING_API_SECRET', role: 'enhancement' },
      ],
    })
    current.handle.stderrChunks.push('ordinary diagnostic')
    const lease = await manager.acquire('trading-core')
    expect(events).toEqual(['health:refused', 'resolve:trading-api-key', 'health:healthy'])
    expect(resolveCredential).toHaveBeenCalledTimes(1)
    expect(current.specs[0]?.env).toMatchObject({
      ADAPTER_RUNNER: 'runner-name',
      TRADING_API_KEY: secret,
      TRADING_API_SECRET: secret,
    })
    expect(JSON.stringify(manager.invariantSnapshot())).not.toContain(secret)
    await expect(readFile(ownedBackendStatePath(current.home, 'trading-core'), 'utf8')).resolves.not.toContain(secret)
    await expect(readFile(join(current.home, 'investment-research', 'trading-core', 'backend.log'), 'utf8')).resolves.not.toContain(secret)
    current.handle.exit()
    await lease.release()
  })

  it('omits unresolved credentials from the owned child environment and redacts resolver values from spawn errors', async () => {
    const unresolved = await harness([refused, healthy])
    const resolveUndefined = vi.fn(async () => undefined)
    const unresolvedManager = new InvestmentBackendManager({
      subprocess: unresolved.subprocess,
      config: { dshHome: unresolved.home },
      checkHealth: async () => unresolved.specs.length === 0 ? refused : healthy,
      resolveCredential: resolveUndefined,
    })
    unresolvedManager.register({
      ...definition,
      managedEnv: undefined,
      credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' }],
    })
    const unresolvedLease = await unresolvedManager.acquire('trading-core')
    expect(resolveUndefined).toHaveBeenCalledOnce()
    expect(unresolved.specs[0]).not.toHaveProperty('env')
    unresolved.handle.exit()
    await unresolvedLease.release()

    const secret = 'credential-value-must-be-redacted'
    const failed = await harness([refused])
    failed.subprocess.spawn = () => { throw new Error(`spawn failed with ${secret}`) }
    const failedManager = new InvestmentBackendManager({
      subprocess: failed.subprocess,
      config: { dshHome: failed.home },
      checkHealth: async () => refused,
      resolveCredential: async () => secret,
    })
    failedManager.register({
      ...definition,
      credentialEnv: [{ ref: credentialRef('trading-api-key'), env: 'TRADING_API_KEY', role: 'required' }],
    })
    await expect(failedManager.acquire('trading-core')).rejects.not.toThrow(secret)
  })

  it('uses argv without a shell and forwards only the explicit managed environment', async () => {
    const { manager, handle, specs } = await harness([refused, healthy])
    manager.register(definition)
    const lease = await manager.acquire('trading-core')
    expect(specs[0]).toMatchObject({
      argv: [expect.stringContaining('python'), '-m', 'uvicorn', 'adapter.app:app', '--host', '127.0.0.1', '--port', '8000'],
      env: { ADAPTER_RUNNER: 'runner-name' },
      graceMs: 5,
    })
    expect(specs[0]).not.toHaveProperty('shell')
    handle.exit()
    await lease.release()
  })

  it('reports missing venv initialization, child early exit tail, startup timeout, and health mismatch', async () => {
    const missing = await harness([refused])
    missing.manager.register(definition)
    missing.manager.internals.executableExists = async () => false
    await expect(missing.manager.acquire('trading-core')).rejects.toThrow(/init\.sh/)

    const early = await harness([refused, refused])
    early.manager.register(definition)
    early.handle.stderrChunks.push('bounded failure detail')
    early.handle.exit({ exitCode: 2, signal: null })
    await expect(early.manager.acquire('trading-core')).rejects.toThrow(/bounded failure detail/)
    expect(early.handle.waitForExitCalls).toBe(1)

    const timeout = await harness([refused])
    timeout.manager.register(definition)
    timeout.handle.autoExitOnTerminate = true
    await expect(timeout.manager.acquire('trading-core')).rejects.toThrow(/timed out/)

    const mismatch = await harness([refused, { status: 'occupied', healthUrl: 'x', httpStatus: 200 }])
    mismatch.manager.register(definition)
    mismatch.handle.exit()
    await expect(mismatch.manager.acquire('trading-core')).rejects.toThrow(/occupied/)
  })

  it('rejects a new lease when an active owned backend is no longer healthy', async () => {
    const current = await harness([refused, healthy, { status: 'occupied', healthUrl: 'x', httpStatus: 200 }])
    current.manager.register(definition)
    const lease = await current.manager.acquire('trading-core')
    await expect(current.manager.acquire('trading-core')).rejects.toThrow(/occupied/)
    current.handle.exit()
    await lease.release()
  })

  it('restarts acquisition when the verified active entry was released during its health probe', async () => {
    const gate = Promise.withResolvers<BackendHealthResult>()
    const current = await harness()
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess: current.subprocess,
      config: { dshHome: current.home },
      checkHealth: async () => probes++ === 1 ? gate.promise : healthy,
    })
    manager.register(definition)
    const first = await manager.acquire('trading-core')
    const acquiring = manager.acquire('trading-core')
    await Promise.resolve()
    await first.release()
    gate.resolve(healthy)
    const second = await acquiring
    expect(second.ownership).toBe('attached')
    await second.release()
  })

  it('aborts and awaits an active-entry health probe during disposal', async () => {
    const gate = Promise.withResolvers<BackendHealthResult>()
    const current = await harness()
    let probes = 0
    let probeSignal: AbortSignal | undefined
    const manager = new InvestmentBackendManager({
      subprocess: current.subprocess,
      config: { dshHome: current.home },
      checkHealth: async (_definition, options) => {
        if (probes++ === 0) return healthy
        probeSignal = options?.signal
        return gate.promise
      },
    })
    manager.register({ ...definition, mode: 'external' })
    await manager.acquire('trading-core')
    const acquiring = manager.acquire('trading-core')
    await vi.waitFor(() => { expect(probeSignal).toBeDefined() })
    let disposed = false
    const disposing = manager.dispose().then(() => { disposed = true })
    await expect(acquiring).rejects.toThrow(/disposed/)
    expect(probeSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    gate.resolve(healthy)
    await disposing
    expect(disposed).toBe(true)
  })

  it('normalizes a non-Error caller cancellation while probing an active entry', async () => {
    const gate = Promise.withResolvers<BackendHealthResult>()
    const current = await harness()
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess: current.subprocess,
      config: { dshHome: current.home },
      checkHealth: async () => probes++ === 0 ? healthy : gate.promise,
    })
    manager.register({ ...definition, mode: 'external' })
    await manager.acquire('trading-core')
    const controller = new AbortController()
    const acquiring = manager.acquire('trading-core', controller.signal)
    await Promise.resolve()
    controller.abort('caller cancelled')
    await expect(acquiring).rejects.toThrow('caller cancelled')
    gate.resolve(healthy)
    await manager.dispose()
  })

  it('disposal blocks new acquires and awaits owned process-tree exit', async () => {
    const { manager, handle } = await harness([refused, healthy])
    manager.register(definition)
    const lease = await manager.acquire('trading-core')
    let disposed = false
    const disposing = manager.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(handle.terminateCalls).toBe(1)
    await expect(manager.acquire('trading-core')).rejects.toThrow(/disposed/)
    handle.exit()
    await disposing
    expect(disposed).toBe(true)
    await lease.release()
    expect(handle.terminateCalls).toBe(1)
  })

  it('disposes an unreleased external lease without trying to terminate it', async () => {
    const current = await harness([healthy])
    current.manager.register({ ...definition, mode: 'external' })
    const lease = await current.manager.acquire('trading-core')
    await current.manager.dispose()
    await lease.release()
    expect(current.handle.terminateCalls).toBe(0)
  })

  it('publishes explicit schema defaults', () => {
    expect(InvestmentPythonRuntime.Config({})).toEqual({
      startupTimeoutMs: 30_000,
      healthPollMs: 250,
      shutdownGraceMs: 5_000,
      logTailBytes: 65_536,
      logMaxBytes: 4_194_304,
    })
  })

  it('covers default dependencies, cancellation, idempotent disposal, and disposed registration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-runtime-defaults-'))
    const subprocess = { spawn: vi.fn() } as unknown as SubprocessRuntime
    const manager = new InvestmentBackendManager({ subprocess, config: { dshHome: home } })
    expect(await manager.internals.executableExists(import.meta.filename)).toBe(true)
    expect(await manager.internals.executableExists(join(home, 'missing-python'))).toBe(false)
    await manager.internals.sleep(1)
    expect(manager.internals.now()).toBeTypeOf('number')
    expect(manager.invariantSnapshot()).toEqual({ active: [], flights: [] })
    manager.register(definition)
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(manager.acquire('trading-core', aborted.signal)).rejects.toThrow('cancelled')
    await manager.dispose()
    await manager.dispose()
    expect(() => manager.register(definition)).toThrow(/disposed/)
  })

  it('stops a flight that completes after disposal began', async () => {
    const gate = Promise.withResolvers<BackendHealthResult>()
    const { subprocess, home } = await harness()
    const manager = new InvestmentBackendManager({
      subprocess,
      config: { dshHome: home },
      checkHealth: async () => gate.promise,
    })
    manager.register({ ...definition, mode: 'external' })
    const acquiring = manager.acquire('trading-core')
    await Promise.resolve()
    const disposing = manager.dispose()
    gate.resolve(healthy)
    await expect(acquiring).rejects.toThrow(/disposed/)
    await disposing
  })

  it('forwards a caller signal, omits absent env, diagnoses spawn throws and rejected children, and notes old state', async () => {
    const signalled = await harness([refused, healthy])
    const { managedEnv: _managedEnv, ...definitionWithoutEnv } = definition
    void _managedEnv
    signalled.manager.register(definitionWithoutEnv)
    const signal = new AbortController().signal
    const lease = await signalled.manager.acquire('trading-core', signal)
    expect(signalled.specs[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(signalled.specs[0]?.signal).not.toBe(signal)
    expect(signalled.specs[0]).not.toHaveProperty('env')
    signalled.handle.exit()
    await lease.release()
    await lease.release()

    const broken = await harness([refused])
    broken.manager.register(definition)
    broken.subprocess.spawn = () => { throw new Error('spawn runner-name failed') }
    await expect(broken.manager.acquire('trading-core')).rejects.toThrow(/spawn failed.*REDACTED/)

    const rejected = await harness([refused, refused])
    rejected.manager.register(definition)
    Object.defineProperty(rejected.handle, 'collected', { value: {} })
    void rejected.handle.done.catch(() => {})
    rejected.handle.fail(new Error('runner-name transport failed'))
    await expect(rejected.manager.acquire('trading-core', new AbortController().signal)).rejects.toThrow(/REDACTED.*transport failed/)

    const old = await harness([refused, healthy])
    await writeOwnedBackendState(ownedBackendStatePath(old.home, 'trading-core'), {
      version: 1,
      id: 'trading-core',
      service: 'trading-core',
      pid: 9,
      baseUrl: definition.baseUrl,
      projectDir: old.projectDir,
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    old.manager.register(definition)
    const oldLease = await old.manager.acquire('trading-core')
    old.handle.exit()
    await oldLease.release()
  })

  it('rolls back owned children after cancellation, log I/O failure, and state publication failure', async () => {
    const cancelled = await harness()
    const ready = Promise.withResolvers<BackendHealthResult>()
    let probes = 0
    const cancelledManager = new InvestmentBackendManager({
      subprocess: cancelled.subprocess,
      config: { dshHome: cancelled.home },
      checkHealth: async () => probes++ === 0 ? refused : ready.promise,
      resolvePaths: () => ({ projectDir: cancelled.projectDir, pythonExecutable: join(cancelled.projectDir, 'env', 'bin', 'python') }),
      executableExists: async () => true,
    })
    cancelledManager.register(definition)
    cancelled.handle.autoExitOnTerminate = true
    const controller = new AbortController()
    const acquiring = cancelledManager.acquire('trading-core', controller.signal)
    await vi.waitFor(() => { expect(cancelled.specs).toHaveLength(1) })
    controller.abort(new Error('cancel startup'))
    ready.resolve(refused)
    await expect(acquiring).rejects.toThrow('cancel startup')
    expect(cancelled.handle.waitForExitCalls).toBe(1)

    const logFailure = await harness([refused, healthy])
    await mkdir(join(logFailure.home, 'investment-research', 'trading-core', 'backend.log'), { recursive: true })
    logFailure.handle.stderrChunks.push('cannot append this chunk')
    logFailure.handle.autoExitOnTerminate = true
    logFailure.manager.register(definition)
    await expect(logFailure.manager.acquire('trading-core')).rejects.toThrow()
    expect(logFailure.handle.waitForExitCalls).toBe(1)

    const stateFailure = await harness()
    const publish = Promise.withResolvers<BackendHealthResult>()
    let stateProbes = 0
    const stateManager = new InvestmentBackendManager({
      subprocess: stateFailure.subprocess,
      config: { dshHome: stateFailure.home },
      checkHealth: async () => stateProbes++ === 0 ? refused : publish.promise,
      resolvePaths: () => ({ projectDir: stateFailure.projectDir, pythonExecutable: join(stateFailure.projectDir, 'env', 'bin', 'python') }),
      executableExists: async () => true,
    })
    stateFailure.handle.autoExitOnTerminate = true
    stateManager.register(definition)
    const publishing = stateManager.acquire('trading-core')
    await vi.waitFor(() => { expect(stateFailure.specs).toHaveLength(1) })
    await mkdir(ownedBackendStatePath(stateFailure.home, 'trading-core'), { recursive: true })
    publish.resolve(healthy)
    await expect(publishing).rejects.toThrow()
    expect(stateFailure.handle.waitForExitCalls).toBe(1)
  })

  it('reports a process-tree wait failure while retaining owned state for retry', async () => {
    const current = await harness([refused, healthy])
    current.manager.register(definition)
    const lease = await current.manager.acquire('trading-core')
    void current.handle.done.catch(() => {})
    current.handle.fail(new Error('tree wait failed'))
    await expect(lease.release()).rejects.toThrow('tree wait failed')
    expect(current.manager.invariantSnapshot().active).toHaveLength(1)
    await expect(access(ownedBackendStatePath(current.home, 'trading-core'))).resolves.toBeUndefined()
    await expect(current.manager.dispose()).rejects.toThrow('runtime disposal failed')
    expect(current.manager.invariantSnapshot().active).toHaveLength(1)
  })

  it('delegates the public Service API and awaits its Cordis teardown effect', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ service: 'trading-core', status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const ctx = new Context()
    const subprocessFiber = await ctx.plugin(StubSubprocess)
    const runtimeFiber = await ctx.plugin(InvestmentPythonRuntime)
    const runtime = ctx.investmentPythonRuntime
    const unregister = runtime.register({ ...definition, mode: 'external' })
    const lease = await runtime.acquire('trading-core')
    expect(runtime.invariantSnapshot().active).toHaveLength(1)
    await lease.release()
    unregister()
    await runtimeFiber.dispose()
    await subprocessFiber.dispose()

    const directContext = new Context()
    new StubSubprocess(directContext)
    const direct = new InvestmentPythonRuntime(directContext)
    expect(direct.invariantSnapshot()).toEqual({ active: [], flights: [] })
  })

  it('registers and exercises the invariant companion', async () => {
    let installer!: InvariantInstaller
    const unregister = vi.fn()
    const ctx = {
      invariants: {
        register(packageName: string, candidate: InvariantInstaller) {
          expect(packageName).toBe('@deepseek-ai/dsh-investment-python-runtime')
          installer = candidate
          return unregister
        },
      },
    } as unknown as Context
    expect(invariantName).toBe('investment-python-runtime-invariant')
    expect(invariantInject).toEqual(['invariants'])
    await expect(applyInvariant(ctx)).resolves.toBe(unregister)
    expect(installer.inject).toEqual(['investmentPythonRuntime'])

    const fail = (message: string): never => { throw new Error(message) }
    const snapshotContext = (active: unknown[], flights: string[] = []) => ({
      investmentPythonRuntime: { invariantSnapshot: () => ({ active, flights }) },
    }) as unknown as Context
    const attached = { definition, ownership: 'attached', refs: 0 }
    await expect(Promise.resolve(installer(snapshotContext([attached]), fail))).resolves.toBeUndefined()
    await expect(Promise.resolve(installer(snapshotContext([attached], ['market-watch']), fail))).resolves.toBeUndefined()
    for (const [entry, message] of [
      [{ ...attached, refs: -1 }, /negative lease/],
      [{ ...attached, ownership: 'owned' }, /without a live handle/],
      [{ ...attached, handle: fakeHandle() }, /attached with an owned handle/],
    ] as const) {
      expect(() => installer(snapshotContext([entry]), fail)).toThrow(message)
    }
    expect(() => installer(snapshotContext([attached], ['trading-core']), fail)).toThrow(/starting and running/)
  })
})
