import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import InvestmentPythonRuntime, { backendLogPaths, ownedBackendStatePath } from '../src/index.ts'
import type { PythonBackendDefinition } from '../src/index.ts'

const python = process.env.DSH_INVESTMENT_TEST_PYTHON
const fixture = fileURLToPath(new URL('./fixtures/fake-project/', import.meta.url))
const execFileAsync = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const CANARY = 'sk-dsh-secret-canary-managed-runner'

class FakeCredentials extends CredentialProvider {
  resolve(_ref: CredentialRef): Promise<ResolvedCredential> {
    return Promise.resolve({ value: CANARY, source: 'test' })
  }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: true, source: 'test', writable: true })
  }

  set(): Promise<void> { return Promise.resolve() }
  unset(): Promise<void> { return Promise.resolve() }
}

async function importLocalRuntime(): Promise<typeof import('../../../subprocess/subprocess-local/src/index.ts')> {
  const dlopen: typeof process.dlopen = process.dlopen.bind(process)
  process.dlopen = ((module, filename, flags) => {
    if (filename.includes('node-pty') && filename.endsWith('.node')) {
      (module as { exports: unknown }).exports = {}
      return
    }
    dlopen(module, filename, flags)
  })
  try {
    return await import('../../../subprocess/subprocess-local/src/index.ts')
  } finally {
    process.dlopen = dlopen
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate a loopback port')
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  }))
  return address.port
}

describe.skipIf(python === undefined)('managed fake Python runner', () => {
  it('owns both fake backends and forwards each credential allowlist without exposing it in argv or diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh investment 运行时 '))
    roots.push(root)
    const projectDir = join(root, 'fake project')
    await cp(fixture, projectDir, { recursive: true })
    await execFileAsync(python!, ['-m', 'venv', join(projectDir, 'env')])
    const [tradingPort, marketPort] = await Promise.all([freePort(), freePort()])
    const home = join(root, 'dsh home')
    const ctx = new Context()
    contexts.push(ctx)
    new FakeCredentials(ctx)
    const { default: LocalSubprocessRuntime } = await importLocalRuntime()
    await ctx.plugin(LocalSubprocessRuntime)
    const specs: SubprocessSpawnSpec[] = []
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    ctx.subprocess.spawn = (spec) => {
      specs.push(spec)
      return spawn(spec)
    }
    const runtime = new InvestmentPythonRuntime(ctx, {
      dshHome: home,
      startupTimeoutMs: 10_000,
      healthPollMs: 20,
      shutdownGraceMs: 2_000,
    })
    const trading: PythonBackendDefinition = {
      id: 'trading-core',
      service: 'trading-core',
      mode: 'managed',
      baseUrl: `http://127.0.0.1:${tradingPort}`,
      projectDir,
      repositoryPath: ['unused'],
      module: 'adapter.app:app',
      healthPath: '/health',
      healthOk: { service: 'trading-core', status: 'ok' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
      managedEnv: { FAKE_ENV_MARKER: 'trading-visible' },
      credentialEnv: [
        { ref: 'DEEPSEEK_API_KEY' as CredentialRef, env: 'DEEPSEEK_API_KEY', role: 'required' },
        { ref: 'DEEPSEEK_API_KEY' as CredentialRef, env: 'OPENAI_API_KEY', role: 'required' },
      ],
    }
    const market: PythonBackendDefinition = {
      id: 'market-watch',
      service: 'market-watch',
      mode: 'managed',
      baseUrl: `http://127.0.0.1:${marketPort}`,
      projectDir,
      repositoryPath: ['unused'],
      module: 'market_watch.app:app',
      healthPath: '/health',
      healthOk: { service: 'market-watch', ok: true },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
      managedEnv: { FAKE_ENV_MARKER: 'market-visible', MW_LLM_ENABLED: 'true' },
      credentialEnv: [
        { ref: 'DEEPSEEK_API_KEY' as CredentialRef, env: 'DEEPSEEK_API_KEY', role: 'enhancement' },
      ],
    }
    const unregister = [runtime.register(trading), runtime.register(market)]
    const leases = await Promise.all([runtime.acquire('trading-core'), runtime.acquire('market-watch')])
    expect(leases.map(lease => lease.ownership)).toEqual(['owned', 'owned'])
    await expect(fetch(`${leases[0]!.baseUrl}/health`).then(response => response.json()))
      .resolves.toMatchObject({ service: 'trading-core', status: 'ok', env: 'trading-visible' })
    await expect(fetch(`${leases[1]!.baseUrl}/health`).then(response => response.json()))
      .resolves.toMatchObject({ service: 'market-watch', ok: true })

    expect(specs).toHaveLength(2)
    const byModule = new Map(specs.map(spec => [spec.argv[3], spec]))
    expect(byModule.get('adapter.app:app')?.env).toEqual({
      FAKE_ENV_MARKER: 'trading-visible',
      DEEPSEEK_API_KEY: CANARY,
      OPENAI_API_KEY: CANARY,
    })
    expect(byModule.get('market_watch.app:app')?.env).toEqual({
      FAKE_ENV_MARKER: 'market-visible',
      MW_LLM_ENABLED: 'true',
      DEEPSEEK_API_KEY: CANARY,
    })
    expect(specs.flatMap(spec => spec.argv)).not.toContain(CANARY)

    for (const id of ['trading-core', 'market-watch'] as const) {
      await expect(access(ownedBackendStatePath(home, id))).resolves.toBeUndefined()
      const log = await readFile(backendLogPaths(home, id).active, 'utf8')
      expect(log).toContain('fake uvicorn ready')
      expect(log).not.toContain(CANARY)
    }
    expect(JSON.stringify(runtime.readiness())).not.toContain(CANARY)

    await Promise.all(leases.map(lease => lease.release()))
    for (const definition of [trading, market]) {
      await expect(access(ownedBackendStatePath(home, definition.id))).rejects.toThrow()
      await expect(fetch(`${definition.baseUrl}/health`)).rejects.toThrow()
    }
    unregister.forEach(dispose => dispose())
  }, 30_000)
})
