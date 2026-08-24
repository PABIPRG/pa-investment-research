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
