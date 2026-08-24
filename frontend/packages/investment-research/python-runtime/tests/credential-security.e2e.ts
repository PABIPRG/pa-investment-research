import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  backendLogPaths,
  InvestmentBackendManager,
  ownedBackendStatePath,
} from '../src/index.ts'
import type { PythonBackendDefinition } from '../src/index.ts'
import { fakeHandle } from './fixtures/fake-handle.ts'

const CANARY = 'sk-dsh-secret-canary-security-scan'
const DEEPSEEK_API_KEY = 'DEEPSEEK_API_KEY' as CredentialRef
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('investment credential negative scan', () => {
  it('keeps an owned credential out of argv, state, logs, readiness, errors, snapshots, and test diagnostics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-investment-secret-scan-'))
    roots.push(home)
    const projectDir = join(home, 'backend project')
    const pythonExecutable = join(projectDir, 'env', 'bin', 'python')
    await mkdir(join(projectDir, 'env', 'bin'), { recursive: true })
    const handle = fakeHandle()
    handle.stdoutChunks.push(`child diagnostic before ${CANARY} after\n`)
    const specs: SubprocessSpawnSpec[] = []
    const subprocess = {
      spawn(spec: SubprocessSpawnSpec) {
        specs.push(spec)
        return handle
      },
    } as unknown as SubprocessRuntime
    let probes = 0
    const manager = new InvestmentBackendManager({
      subprocess,
      config: { dshHome: home, healthPollMs: 1 },
      checkHealth: async () => probes++ === 0
        ? { status: 'refused', healthUrl: 'http://127.0.0.1:18000/health', error: new Error('refused') }
        : { status: 'healthy', healthUrl: 'http://127.0.0.1:18000/health', httpStatus: 200 },
      resolvePaths: () => ({ source: 'source', projectDir, pythonExecutable }),
      executableExists: async () => true,
      sleep: async () => {},
      resolveCredential: async () => ({ value: CANARY, source: 'test' }),
      describeCredential: async () => ({ configured: true, source: 'test', writable: true }),
    })
    const definition: PythonBackendDefinition = {
      id: 'trading-core',
      service: 'trading-core',
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:18000',
      projectDir,
      repositoryPath: ['unused'],
      module: 'adapter.app:app',
      healthPath: '/health',
      healthOk: { status: 'ok' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
      managedEnv: { ADAPTER_RUNNER: 'fake' },
      credentialEnv: [
        { ref: DEEPSEEK_API_KEY, env: 'DEEPSEEK_API_KEY', role: 'required' },
        { ref: DEEPSEEK_API_KEY, env: 'OPENAI_API_KEY', role: 'required' },
      ],
    }
    manager.register(definition)
    manager.registerCapability({ backendId: 'trading-core', toolCount: 9, llm: 'required' })
    const lease = await manager.acquire('trading-core')

    expect(specs).toHaveLength(1)
    expect(specs[0]?.env).toEqual({
      ADAPTER_RUNNER: 'fake',
      DEEPSEEK_API_KEY: CANARY,
      OPENAI_API_KEY: CANARY,
    })
    expect(specs[0]?.argv).not.toContain(CANARY)

    manager.credentialUpdated(DEEPSEEK_API_KEY)
    let preflightFailure: Error | undefined
    try {
      manager.assertCapability('trading-core', 'llm-required')
    } catch (error) {
      preflightFailure = error as Error
    }
    expect(preflightFailure).toBeInstanceOf(Error)
    expect(preflightFailure?.message).toMatch(/restart/i)

    const state = await readFile(ownedBackendStatePath(home, 'trading-core'), 'utf8')
    const log = await readFile(backendLogPaths(home, 'trading-core').active, 'utf8')
    const readinessSnapshot = manager.readiness()
    expect(log).toContain('[REDACTED]')
    expect(readinessSnapshot.backends[0]).toMatchObject({
      backendId: 'trading-core',
      restartRequired: true,
      credentials: [{ ref: DEEPSEEK_API_KEY, status: 'restart-required' }],
      capability: { status: 'unavailable' },
    })

    const diagnosticCorpus = JSON.stringify({
      argv: specs[0]?.argv,
      cwd: specs[0]?.cwd,
      state,
      log,
      readinessSnapshot,
      error: preflightFailure?.message,
    })
    expect(diagnosticCorpus).not.toContain(CANARY)

    handle.exit()
    await lease.release()
    await expect(readFile(ownedBackendStatePath(home, 'trading-core'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await manager.dispose()
  })
})
