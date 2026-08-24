import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildInvestmentPythonSidecar,
  type InvestmentSidecarLock,
} from './build-investment-python-sidecar.ts'

const roots: string[] = []
const TARGET = 'darwin-arm64'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function write(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'investment sidecar builder '))
  roots.push(root)
  const requirements = {
    'backend/dsh-trading-core/requirements.txt': 'alpha==1 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
    'backend/market-watch/requirements.txt': 'beta==2 --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
  }
  for (const [path, value] of Object.entries(requirements)) await write(join(root, ...path.split('/')), value)
  await write(join(root, 'backend/dsh-trading-core/adapter/app.py'), 'safe trading')
  await write(join(root, 'backend/market-watch/market_watch/app.py'), 'safe market')
  await write(join(root, 'backend/dsh-trading-core/.env'), 'SECRET_CANARY')
  await write(join(root, 'backend/dsh-trading-core/env/private.py'), 'SECRET_CANARY')
  await write(join(root, 'backend/dsh-trading-core/data/cache.json'), 'SECRET_CANARY')
  await write(join(root, 'backend/dsh-trading-core/tests/test_app.py'), 'SECRET_CANARY')
  await write(join(root, 'backend/market-watch/market_watch/__pycache__/app.pyc'), 'SECRET_CANARY')
  await write(join(root, 'backend/market-watch/logs/runtime.log'), 'SECRET_CANARY')
  const archiveValue = Buffer.from('fixture archive')
  const archiveUrl = 'https://fixtures.invalid/python.tar.gz'
  const requirementsLockPath = `frontend/config/investment-python-requirements/${TARGET}.txt`
  const requirementsLock = 'alpha==1\n'
  await write(join(root, ...requirementsLockPath.split('/')), requirementsLock)
  const targetLock = {
    pythonVersion: '3.10.18',
    archiveUrl,
    archiveSha256: hash(archiveValue),
    archiveRuntimeRoot: 'python/install',
    archiveExecutable: 'python/install/bin/python3',
    requirementsLock: requirementsLockPath,
    requirementsSha256: hash(requirementsLock),
  }
  const lock: InvestmentSidecarLock = {
    schemaVersion: 1,
    requirements: Object.fromEntries(Object.entries(requirements).map(([path, value]) => [path, hash(value)])),
    targets: {
      'darwin-arm64': targetLock,
      'darwin-x64': targetLock,
      'win32-x64': { ...targetLock, archiveExecutable: 'python/install/python.exe' },
    },
  }
  const cache = join(root, 'cache')
  await mkdir(cache)
  await writeFile(join(cache, `${TARGET}-${basename(new URL(archiveUrl).pathname)}`), archiveValue)
  const output = join(root, 'output')
  const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
    const sitePackages = args[args.indexOf('--target') + 1]!
    await write(join(sitePackages, 'native-extension.so'), 'native')
    return 0
  })
  const dependencies = {
    repoRoot: root,
    lock,
    listArchive: async () => ['python/', 'python/install/', 'python/install/bin/python3'],
    extractArchive: async (_archive: string, destination: string) => {
      await write(join(destination, 'python/install/bin/python3'), 'python')
    },
    runCommand,
  }
  return { root, lock, cache, output, dependencies, runCommand }
}

describe('investment Python sidecar builder', () => {
  it('builds a stable descriptor from offline cache and excludes generated or sensitive backend files', async () => {
    const setup = await fixture()
    const options = { target: TARGET, output: setup.output, cache: setup.cache, offline: true }

    const first = await buildInvestmentPythonSidecar(options, setup.dependencies)
    const firstJson = await readFile(join(setup.output, 'runtime.json'), 'utf8')
    const second = await buildInvestmentPythonSidecar(options, setup.dependencies)
    const secondJson = await readFile(join(setup.output, 'runtime.json'), 'utf8')

    expect(secondJson).toBe(firstJson)
    expect(second).toEqual(first)
    expect(first.python).toEqual({
      version: '3.10.18', platform: 'darwin', arch: 'arm64', executable: 'runtime/bin/python3',
    })
    expect(first.files.map(entry => entry.path)).toEqual([...first.files.map(entry => entry.path)].sort())
    expect(first.files.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'backends/dsh-trading-core/adapter/app.py',
      'backends/market-watch/market_watch/app.py',
      'runtime/bin/python3',
      'site-packages/native-extension.so',
    ]))
    expect(firstJson).not.toContain('SECRET_CANARY')
    expect(first.files.some(entry => /(?:^|\/)(?:env|data|logs|tests|__pycache__)(?:\/|$)|\.env$|\.pyc$|\.log$/u.test(entry.path))).toBe(false)
    expect(setup.runCommand).toHaveBeenCalledWith(
      expect.stringContaining(join('runtime', 'bin', 'python3')),
      expect.arrayContaining(['--no-compile']),
      expect.any(String),
    )
    expect(setup.runCommand.mock.calls[0]?.[1]).not.toContain('--require-hashes')
    expect(setup.runCommand.mock.calls[0]?.[1]).not.toContain('--only-binary=:all:')
  })

  it('fails closed for missing targets, cache/hash failures, requirements drift, and traversal', async () => {
    const setup = await fixture()
    const options = { target: TARGET, output: setup.output, cache: setup.cache, offline: true }
    const missingTargetLock = { ...setup.lock, targets: { ...setup.lock.targets } } as unknown as {
      targets: Record<string, unknown>
    }
    delete missingTargetLock.targets[TARGET]
    await expect(buildInvestmentPythonSidecar(options, {
      ...setup.dependencies,
      lock: missingTargetLock as unknown as InvestmentSidecarLock,
    })).rejects.toThrow(/no target/u)

    await rm(setup.cache, { recursive: true })
    await expect(buildInvestmentPythonSidecar(options, setup.dependencies)).rejects.toThrow(/offline cache miss/u)

    await mkdir(setup.cache, { recursive: true })
    await writeFile(join(setup.cache, `${TARGET}-python.tar.gz`), 'wrong')
    await expect(buildInvestmentPythonSidecar(options, setup.dependencies)).rejects.toThrow(/offline cache miss/u)

    await write(join(setup.root, 'backend/dsh-trading-core/requirements.txt'), 'drift')
    await expect(buildInvestmentPythonSidecar(options, setup.dependencies)).rejects.toThrow(/requirements drift/u)
  })

  it('checks downloaded hashes and archive entry traversal before extraction', async () => {
    const setup = await fixture()
    const archive = join(setup.cache, `${TARGET}-python.tar.gz`)
    await rm(archive)
    const extractArchive = vi.fn()
    await expect(buildInvestmentPythonSidecar({
      target: TARGET, output: setup.output, cache: setup.cache,
    }, {
      ...setup.dependencies,
      download: async (_url, destination) => { await writeFile(destination, 'wrong') },
      extractArchive,
    })).rejects.toThrow(/archive hash mismatch/u)
    expect(extractArchive).not.toHaveBeenCalled()

    await writeFile(archive, 'fixture archive')
    await expect(buildInvestmentPythonSidecar({
      target: TARGET, output: setup.output, cache: setup.cache, offline: true,
    }, {
      ...setup.dependencies,
      listArchive: async () => ['python/install/bin/python3', '../escape'],
      extractArchive,
    })).rejects.toThrow(/unsafe archive entry/u)
    expect(extractArchive).not.toHaveBeenCalled()
  })
})
