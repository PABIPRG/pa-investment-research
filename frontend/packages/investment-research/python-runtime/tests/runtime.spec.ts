import { access, mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { InvestmentPythonRuntime } from '../src/index.ts'
import { InvestmentBackendManager } from '../src/runtime.ts'
import type { BackendHealthResult, PythonBackendDefinition } from '../src/types.ts'
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

    const timeout = await harness([refused])
    timeout.manager.register(definition)
    timeout.handle.autoExitOnTerminate = true
    await expect(timeout.manager.acquire('trading-core')).rejects.toThrow(/timed out/)

    const mismatch = await harness([refused, { status: 'occupied', healthUrl: 'x', httpStatus: 200 }])
    mismatch.manager.register(definition)
    mismatch.handle.exit()
    await expect(mismatch.manager.acquire('trading-core')).rejects.toThrow(/occupied/)
  })

  it('disposal blocks new acquires and awaits owned process-tree exit', async () => {
    const { manager, handle } = await harness([refused, healthy])
    manager.register(definition)
    await manager.acquire('trading-core')
    let disposed = false
    const disposing = manager.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(handle.terminateCalls).toBe(1)
    await expect(manager.acquire('trading-core')).rejects.toThrow(/disposed/)
    handle.exit()
    await disposing
    expect(disposed).toBe(true)
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
    expect(signalled.specs[0]?.signal).toBe(signal)
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
    await expect(rejected.manager.acquire('trading-core')).rejects.toThrow(/REDACTED.*transport failed/)

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
