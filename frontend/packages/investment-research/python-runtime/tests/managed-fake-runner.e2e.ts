import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvestmentPythonRuntime, { backendLogPaths, ownedBackendStatePath } from '../src/index.ts'
import type { PythonBackendDefinition } from '../src/index.ts'

const python = process.env.DSH_INVESTMENT_TEST_PYTHON
const fixture = fileURLToPath(new URL('./fixtures/fake-project/', import.meta.url))
const execFileAsync = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []

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
  it('owns one real subprocess tree, writes diagnostics, and removes state after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh investment 运行时 '))
    roots.push(root)
    const projectDir = join(root, 'fake project')
    await cp(fixture, projectDir, { recursive: true })
    await execFileAsync(python!, ['-m', 'venv', join(projectDir, 'env')])
    const port = await freePort()
    const home = join(root, 'dsh home')
    const ctx = new Context()
    contexts.push(ctx)
    const { default: LocalSubprocessRuntime } = await importLocalRuntime()
    await ctx.plugin(LocalSubprocessRuntime)
    new InvestmentPythonRuntime(ctx, {
      dshHome: home,
      startupTimeoutMs: 10_000,
      healthPollMs: 20,
      shutdownGraceMs: 2_000,
    })
    const definition: PythonBackendDefinition = {
      id: 'trading-core',
      service: 'trading-core',
      mode: 'managed',
      baseUrl: `http://127.0.0.1:${port}`,
      projectDir,
      repositoryPath: ['unused'],
      module: 'adapter.app:app',
      healthPath: '/health',
      healthOk: { service: 'trading-core', status: 'ok' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
      managedEnv: { FAKE_ENV_MARKER: 'matrix-visible' },
    }
    const unregister = ctx.investmentPythonRuntime.register(definition)
    const lease = await ctx.investmentPythonRuntime.acquire('trading-core')
    expect(lease.ownership).toBe('owned')
    await expect(fetch(`${lease.baseUrl}/health`).then(response => response.json()))
      .resolves.toMatchObject({ service: 'trading-core', status: 'ok', env: 'matrix-visible' })
    const statePath = ownedBackendStatePath(home, 'trading-core')
    await expect(access(statePath)).resolves.toBeUndefined()
    await expect(readFile(backendLogPaths(home, 'trading-core').active, 'utf8'))
      .resolves.toContain('fake uvicorn ready')

    await lease.release()
    await expect(access(statePath)).rejects.toThrow()
    await expect(fetch(`${definition.baseUrl}/health`)).rejects.toThrow()
    unregister()
  }, 30_000)
})
