import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CredentialInfo, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import { InvestmentBackendManager } from '../src/runtime.ts'
import type {
  BackendHealthResult,
  InvestmentBackendId,
  InvestmentCapabilityDefinition,
  InvestmentReadinessSnapshot,
  PythonBackendDefinition,
  PythonBackendLease,
} from '../src/types.ts'
import { fakeHandle } from './fixtures/fake-handle.ts'

const SECRET = 'sentinel-investment-secret-must-never-leak'
const DEEPSEEK_API_KEY = 'DEEPSEEK_API_KEY' as CredentialRef
const SECOND_API_KEY = 'SECOND_API_KEY' as CredentialRef
const UNRELATED_API_KEY = 'UNRELATED_API_KEY' as CredentialRef
const healthy: BackendHealthResult = {
  status: 'healthy',
  healthUrl: 'http://127.0.0.1:8000/health',
  httpStatus: 200,
}
const refused: BackendHealthResult = {
  status: 'refused',
  healthUrl: 'http://127.0.0.1:8000/health',
  error: new Error('refused'),
}
const occupied: BackendHealthResult = {
  status: 'occupied',
  healthUrl: 'http://127.0.0.1:8000/health',
  httpStatus: 503,
}

const definitions: Record<InvestmentBackendId, PythonBackendDefinition> = {
  'trading-core': {
    id: 'trading-core',
    service: 'trading-core',
    mode: 'managed',
    baseUrl: 'http://127.0.0.1:8000',
    repositoryPath: ['backend', 'dsh-trading-core'],
    module: 'adapter.app:app',
    healthPath: '/health',
    healthOk: { status: 'ok' },
    initCommand: { posix: './init.sh', windows: 'init.bat' },
    credentialEnv: [
      { ref: DEEPSEEK_API_KEY, env: 'DEEPSEEK_API_KEY', role: 'required' },
      { ref: DEEPSEEK_API_KEY, env: 'OPENAI_API_KEY', role: 'required' },
    ],
  },
  'market-watch': {
    id: 'market-watch',
    service: 'market-watch',
    mode: 'managed',
    baseUrl: 'http://127.0.0.1:8010',
    repositoryPath: ['backend', 'market-watch'],
    module: 'market_watch.app:app',
    healthPath: '/health',
    healthOk: { status: 'ok' },
    initCommand: { posix: './init.sh', windows: 'init.bat' },
    credentialEnv: [{ ref: DEEPSEEK_API_KEY, env: 'DEEPSEEK_API_KEY', role: 'enhancement' }],
  },
}

interface ReadinessManager {
  registerCapability(definition: InvestmentCapabilityDefinition): () => void
  assertCapability(backendId: InvestmentBackendId, use: 'llm-required' | 'llm-enhancement' | 'non-llm'): void
  credentialUpdated(ref: CredentialRef): void
  readiness(): InvestmentReadinessSnapshot
}

interface ManagedHarness {
  manager: InvestmentBackendManager & ReadinessManager
  lease: PythonBackendLease
  resolveCredential: ReturnType<typeof vi.fn<(ref: CredentialRef) => Promise<ResolvedCredential | undefined>>>
  describeCredential: ReturnType<typeof vi.fn<(ref: CredentialRef) => Promise<CredentialInfo>>>
  handle: ReturnType<typeof fakeHandle>
}

async function managedHarness(
  id: InvestmentBackendId,
  credential: ResolvedCredential | undefined,
  info: CredentialInfo,
): Promise<ManagedHarness> {
  const home = await mkdtemp(join(tmpdir(), 'investment-readiness-'))
  const projectDir = join(home, 'backend')
  const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
  await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
  const handle = fakeHandle()
  const subprocess = {
    spawn: vi.fn((_spec: SubprocessSpawnSpec) => handle),
  } as unknown as SubprocessRuntime
  let probe = 0
  const resolveCredential = vi.fn(async (_ref: CredentialRef) => credential)
  const describeCredential = vi.fn(async (_ref: CredentialRef) => info)
  const manager = new InvestmentBackendManager({
    subprocess,
    config: { dshHome: home, healthPollMs: 1 },
    checkHealth: async () => probe++ === 0 ? refused : healthy,
    resolvePaths: () => ({ projectDir, pythonExecutable }),
    executableExists: async () => true,
    sleep: async () => {},
    resolveCredential,
    describeCredential,
  }) as InvestmentBackendManager & ReadinessManager
  manager.register(definitions[id])
  const lease = await manager.acquire(id)
  return { manager, lease, resolveCredential, describeCredential, handle }
}

function registerCapability(manager: ReadinessManager, definition: InvestmentCapabilityDefinition): () => void {
  return manager.registerCapability(definition)
}

describe('investment readiness and capability preflight', () => {
  it('marks an owned flight restart-required when its resolved credential changes before active publication', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-readiness-flight-update-'))
    const projectDir = join(home, 'backend')
    const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
    await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const resolved = Promise.withResolvers<ResolvedCredential | undefined>()
    const health = Promise.withResolvers<BackendHealthResult>()
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess: { spawn } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => probes++ === 0 ? refused : health.promise,
      resolvePaths: () => ({ projectDir, pythonExecutable }),
      executableExists: async () => true,
      resolveCredential: async () => resolved.promise,
      describeCredential: async () => ({ configured: true, source: 'file', writable: true }),
    }) as InvestmentBackendManager & ReadinessManager
    manager.register(definitions['trading-core'])
    const acquiring = manager.acquire('trading-core')
    resolved.resolve({ value: SECRET, source: 'file' })
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce() })
    manager.credentialUpdated(DEEPSEEK_API_KEY)
    health.resolve(healthy)
    const lease = await acquiring
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    expect(manager.readiness().backends[0]?.restartRequired).toBe(true)
    expect(() => manager.assertCapability('trading-core', 'llm-required')).toThrow(/restart/i)
    expect(() => manager.assertCapability('trading-core', 'llm-enhancement')).toThrow(/restart/i)
    expect(JSON.stringify(manager.readiness())).not.toContain(SECRET)

    handle.exit()
    await lease.release()
  })

  it('does not mark restart-required when the update precedes credential resolution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-readiness-before-resolve-'))
    const projectDir = join(home, 'backend')
    const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
    await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
    const handle = fakeHandle()
    let probes = 0
    const resolveCredential = vi.fn(async () => ({ value: SECRET, source: 'file' }))
    const manager = new InvestmentBackendManager({
      subprocess: { spawn: vi.fn(() => handle) } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => probes++ === 0 ? refused : healthy,
      resolvePaths: () => ({ projectDir, pythonExecutable }),
      executableExists: async () => true,
      resolveCredential,
      describeCredential: async () => ({ configured: true, source: 'file', writable: true }),
    }) as InvestmentBackendManager & ReadinessManager
    manager.register(definitions['trading-core'])
    manager.credentialUpdated(DEEPSEEK_API_KEY)
    const lease = await manager.acquire('trading-core')
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    expect(resolveCredential).toHaveBeenCalledOnce()
    expect(manager.readiness().backends[0]?.restartRequired).toBe(false)
    expect(() => manager.assertCapability('trading-core', 'llm-required')).not.toThrow()

    handle.exit()
    await lease.release()
  })

  it('marks an active backend failed after a non-healthy re-probe and rejects every capability use', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-readiness-reprobe-'))
    const projectDir = join(home, 'backend')
    const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
    await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
    const handle = fakeHandle()
    const results = [refused, healthy, occupied]
    let probe = 0
    const manager = new InvestmentBackendManager({
      subprocess: { spawn: vi.fn(() => handle) } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => results[Math.min(probe++, results.length - 1)]!,
      resolvePaths: () => ({ projectDir, pythonExecutable }),
      executableExists: async () => true,
      resolveCredential: async () => ({ value: SECRET, source: 'file' }),
      describeCredential: async () => ({ configured: true, source: 'file', writable: true }),
    }) as InvestmentBackendManager & ReadinessManager
    manager.register(definitions['trading-core'])
    const lease = await manager.acquire('trading-core')
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    await expect(manager.acquire('trading-core')).rejects.toThrow(/occupied/)
    const snapshot = manager.readiness()
    expect(snapshot.backends[0]).toMatchObject({
      ownership: 'owned',
      backendStatus: 'failed',
      capability: { status: 'unavailable' },
    })
    for (const use of ['llm-required', 'llm-enhancement', 'non-llm'] as const) {
      const error = (() => {
        try {
          manager.assertCapability('trading-core', use)
        } catch (reason) {
          return reason as Error
        }
        throw new Error(`expected ${use} rejection`)
      })()
      expect(error.message).toMatch(/trading-core.*health/i)
      expect(error.message).not.toContain(SECRET)
    }
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)

    handle.exit()
    await lease.release()
  })

  it('keeps cleanup-failure ownership for teardown but projects it failed and rejects every capability use', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-readiness-cleanup-failure-'))
    const projectDir = join(home, 'backend')
    const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
    await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
    const handle = fakeHandle()
    void handle.done.catch(() => {})
    handle.fail(new Error(`cleanup wait failed ${SECRET}`))
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess: { spawn: vi.fn(() => handle) } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => probes++ === 0 ? refused : occupied,
      resolvePaths: () => ({ projectDir, pythonExecutable }),
      executableExists: async () => true,
      resolveCredential: async () => ({ value: SECRET, source: 'file' }),
      describeCredential: async () => ({ configured: true, source: 'file', writable: true }),
    }) as InvestmentBackendManager & ReadinessManager
    manager.register(definitions['trading-core'])
    const startupError = await manager.acquire('trading-core').catch(reason => reason as Error)
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    expect(startupError).toBeInstanceOf(AggregateError)
    expect(startupError.message).not.toContain(SECRET)
    const snapshot = manager.readiness()
    expect(snapshot.backends[0]).toMatchObject({
      ownership: 'owned',
      backendStatus: 'failed',
      capability: { status: 'unavailable' },
    })
    for (const use of ['llm-required', 'llm-enhancement', 'non-llm'] as const) {
      expect(() => manager.assertCapability('trading-core', use)).toThrow(/health/i)
    }
    expect(JSON.stringify({ snapshot, active: manager.invariantSnapshot() })).not.toContain(SECRET)
  })

  it('rejects required use with the actual missing ref when another required ref is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'investment-readiness-multiple-required-'))
    const projectDir = join(home, 'backend')
    const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
    await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
    const handle = fakeHandle()
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess: { spawn: vi.fn(() => handle) } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => probes++ === 0 ? refused : healthy,
      resolvePaths: () => ({ projectDir, pythonExecutable }),
      executableExists: async () => true,
      resolveCredential: async ref => ref === DEEPSEEK_API_KEY
        ? { value: SECRET, source: 'file' }
        : undefined,
      describeCredential: async ref => ref === DEEPSEEK_API_KEY
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true },
    }) as InvestmentBackendManager & ReadinessManager
    manager.register({
      ...definitions['trading-core'],
      credentialEnv: [
        { ref: DEEPSEEK_API_KEY, env: 'DEEPSEEK_API_KEY', role: 'required' },
        { ref: SECOND_API_KEY, env: 'SECOND_API_KEY', role: 'required' },
      ],
    })
    const lease = await manager.acquire('trading-core')
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    const snapshot = manager.readiness()
    expect(snapshot.backends[0]).toMatchObject({
      credentials: [
        { ref: DEEPSEEK_API_KEY, configured: true, status: 'configured' },
        { ref: SECOND_API_KEY, configured: false, status: 'missing' },
      ],
      capability: { status: 'unavailable' },
    })
    expect(() => manager.assertCapability('trading-core', 'llm-required')).toThrow(SECOND_API_KEY)
    expect(() => manager.assertCapability('trading-core', 'llm-enhancement')).not.toThrow()
    expect(() => manager.assertCapability('trading-core', 'non-llm')).not.toThrow()
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)

    handle.exit()
    await lease.release()
  })

  it('keeps keyless owned tools published while projecting required unavailable and enhancement template-only', async () => {
    const stock = await managedHarness('trading-core', undefined, { configured: false, writable: true })
    const market = await managedHarness('market-watch', undefined, { configured: false, writable: true })
    registerCapability(stock.manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })
    registerCapability(market.manager, { backendId: 'market-watch', toolCount: 11, llm: 'enhancement' })

    expect(stock.manager.readiness().backends[0]).toMatchObject({
      backendId: 'trading-core',
      backendStatus: 'healthy-owned',
      credentials: [{ ref: DEEPSEEK_API_KEY, configured: false, writable: true, status: 'missing' }],
      capability: { llm: 'required', toolCount: 9, status: 'unavailable' },
      restartRequired: false,
    })
    expect(market.manager.readiness().backends[0]).toMatchObject({
      backendId: 'market-watch',
      backendStatus: 'healthy-owned',
      credentials: [{ ref: DEEPSEEK_API_KEY, configured: false, writable: true, status: 'missing' }],
      capability: { llm: 'enhancement', toolCount: 11, status: 'market-template-only' },
      restartRequired: false,
    })

    stock.handle.exit()
    market.handle.exit()
    await stock.lease.release()
    await market.lease.release()
  })

  it('projects configured and read-only owned credentials without retaining or serializing their value', async () => {
    const stock = await managedHarness('trading-core', { value: SECRET, source: 'file' }, {
      configured: true,
      source: 'file',
      writable: true,
    })
    const market = await managedHarness('market-watch', { value: SECRET, source: 'env' }, {
      configured: true,
      source: 'env',
      writable: false,
    })
    registerCapability(stock.manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })
    registerCapability(market.manager, { backendId: 'market-watch', toolCount: 11, llm: 'enhancement' })

    const stockSnapshot = stock.manager.readiness()
    const marketSnapshot = market.manager.readiness()
    expect(stockSnapshot.backends[0]).toMatchObject({
      credentials: [{ ref: DEEPSEEK_API_KEY, configured: true, source: 'file', writable: true, status: 'configured' }],
      capability: { toolCount: 9, status: 'stock-full' },
    })
    expect(marketSnapshot.backends[0]).toMatchObject({
      credentials: [{ ref: DEEPSEEK_API_KEY, configured: true, source: 'env', writable: false, status: 'read-only' }],
      capability: { toolCount: 11, status: 'market-full' },
    })
    expect(JSON.stringify({ stockSnapshot, marketSnapshot, active: stock.manager.invariantSnapshot() })).not.toContain(SECRET)
    expect(stock.resolveCredential).toHaveBeenCalledOnce()
    expect(stock.describeCredential).toHaveBeenCalledOnce()

    stock.handle.exit()
    market.handle.exit()
    await stock.lease.release()
    await market.lease.release()
  })

  it('marks only active owned backends that used the updated ref and blocks new LLM-dependent calls', async () => {
    const stock = await managedHarness('trading-core', { value: SECRET, source: 'file' }, {
      configured: true,
      source: 'file',
      writable: true,
    })
    registerCapability(stock.manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    stock.manager.credentialUpdated(UNRELATED_API_KEY)
    expect(stock.manager.readiness().backends[0]?.restartRequired).toBe(false)
    stock.manager.credentialUpdated(DEEPSEEK_API_KEY)
    expect(stock.manager.readiness().backends[0]).toMatchObject({
      restartRequired: true,
      credentials: [{ ref: DEEPSEEK_API_KEY, status: 'restart-required' }],
      capability: { status: 'unavailable' },
    })
    expect(() => stock.manager.assertCapability('trading-core', 'llm-required')).toThrow(/restart/i)
    expect(() => stock.manager.assertCapability('trading-core', 'llm-enhancement')).toThrow(/restart/i)
    expect(() => stock.manager.assertCapability('trading-core', 'non-llm')).not.toThrow()

    stock.handle.exit()
    await stock.lease.release()
  })

  it('rejects missing required credentials but allows enhancement template fallback and non-LLM use', async () => {
    const stock = await managedHarness('trading-core', undefined, { configured: false, writable: true })
    const market = await managedHarness('market-watch', undefined, { configured: false, writable: true })
    registerCapability(stock.manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })
    registerCapability(market.manager, { backendId: 'market-watch', toolCount: 11, llm: 'enhancement' })

    expect(() => stock.manager.assertCapability('trading-core', 'llm-required')).toThrow(/DEEPSEEK_API_KEY/)
    expect(() => market.manager.assertCapability('market-watch', 'llm-enhancement')).not.toThrow()
    expect(() => stock.manager.assertCapability('trading-core', 'non-llm')).not.toThrow()

    stock.handle.exit()
    market.handle.exit()
    await stock.lease.release()
    await market.lease.release()
  })

  it.each([
    ['attached', 'managed'],
    ['external', 'external'],
  ] as const)('projects %s credentials as external-managed and never reads the local provider', async (ownership, mode) => {
    const home = await mkdtemp(join(tmpdir(), 'investment-readiness-external-'))
    const resolveCredential = vi.fn(async () => ({ value: SECRET, source: 'file' }))
    const describeCredential = vi.fn(async () => ({ configured: true, source: 'file', writable: true }))
    const manager = new InvestmentBackendManager({
      subprocess: { spawn: vi.fn() } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => healthy,
      resolveCredential,
      describeCredential,
    }) as InvestmentBackendManager & ReadinessManager
    manager.register({ ...definitions['trading-core'], mode })
    const lease = await manager.acquire('trading-core')
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })

    expect(lease.ownership).toBe(ownership)
    expect(manager.readiness().backends[0]).toMatchObject({
      backendStatus: ownership === 'attached' ? 'healthy-attached' : 'external',
      credentials: [{ ref: DEEPSEEK_API_KEY, status: 'external-managed' }],
      capability: { toolCount: 9, status: 'stock-full' },
      restartRequired: false,
    })
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(describeCredential).not.toHaveBeenCalled()
    manager.credentialUpdated(DEEPSEEK_API_KEY)
    expect(manager.readiness().backends[0]?.restartRequired).toBe(false)
    expect(() => manager.assertCapability('trading-core', 'llm-required')).not.toThrow()
    await lease.release()
  })

  it('reference-counts identical capability registrations and rejects conflicts without dangling tool counts', async () => {
    const current = await managedHarness('trading-core', undefined, { configured: false, writable: true })
    const first = registerCapability(current.manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })
    const second = registerCapability(current.manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })
    expect(() => registerCapability(current.manager, {
      backendId: 'trading-core',
      toolCount: 10,
      llm: 'required',
    })).toThrow(/conflict/i)
    expect(current.manager.readiness().backends[0]?.capability?.toolCount).toBe(9)
    first()
    expect(current.manager.readiness().backends[0]?.capability?.toolCount).toBe(9)
    second()
    second()
    expect(current.manager.readiness().backends[0]?.capability).toBeNull()

    current.handle.exit()
    await current.lease.release()
  })

  it.each([
    ['posix', path.posix, '/var/lib/dsh'],
    ['win32', path.win32, 'C:\\Users\\dsh'],
  ] as const)('renders actionable secret-free %s preflight errors with the Runtime log path', async (_name, formatter, home) => {
    const resolveLogPaths = (dshHome: string, id: InvestmentBackendId) => {
      const directory = formatter.join(dshHome, 'investment-research', id)
      return {
        active: formatter.join(directory, 'backend.log'),
        previous: formatter.join(directory, 'backend.previous.log'),
      }
    }
    const manager = new InvestmentBackendManager({
      subprocess: { spawn: vi.fn() } as unknown as SubprocessRuntime,
      config: { dshHome: home },
      checkHealth: async () => healthy,
      resolveLogPaths,
    }) as InvestmentBackendManager & ReadinessManager
    manager.register({ ...definitions['trading-core'], mode: 'external' })
    const lease = await manager.acquire('trading-core')
    registerCapability(manager, { backendId: 'trading-core', toolCount: 9, llm: 'required' })
    await lease.release()

    const error = (() => {
      try {
        manager.assertCapability('trading-core', 'llm-required')
      } catch (reason) {
        return reason as Error
      }
      throw new Error('expected preflight rejection')
    })()
    expect(error.message).toContain('trading-core')
    expect(error.message).toContain('DEEPSEEK_API_KEY')
    expect(error.message).toMatch(/Models/)
    expect(error.message).toContain(resolveLogPaths(home, 'trading-core').active)
    expect(error.message).not.toContain(SECRET)
    expect(JSON.stringify(manager.readiness())).not.toContain(SECRET)
  })
})
