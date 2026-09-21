import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildInvestmentPythonSidecar,
  downloadFileWithRetry,
  type InvestmentSidecarLock,
} from './build-investment-python-sidecar.ts'

const roots: string[] = []
const TARGET = 'darwin-arm64'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
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
    'backend/industry-chain/requirements.txt': 'gamma==3 --hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n',
  }
  for (const [path, value] of Object.entries(requirements)) await write(join(root, ...path.split('/')), value)
  await write(join(root, 'backend/dsh-trading-core/adapter/app.py'), 'safe trading')
  await write(join(root, 'backend/market-watch/market_watch/app.py'), 'safe market')
  await write(join(root, 'backend/industry-chain/industry_chain/app.py'), 'safe industry')
  await write(join(root, 'backend/dsh-trading-core/.env'), 'SECRET_CANARY')
  await write(join(root, 'backend/dsh-trading-core/env/private.py'), 'SECRET_CANARY')
  await write(join(root, 'backend/dsh-trading-core/data/cache.json'), 'SECRET_CANARY')
  await write(join(root, 'backend/industry-chain/dsh-plugin/node_modules/cordis/index.js'), 'SECRET_CANARY')
  await write(join(root, 'backend/dsh-trading-core/tests/test_app.py'), 'SECRET_CANARY')
  await write(join(root, 'backend/market-watch/market_watch/__pycache__/app.pyc'), 'SECRET_CANARY')
  await write(join(root, 'backend/market-watch/logs/runtime.log'), 'SECRET_CANARY')
  for (const path of [
    'docs/private.MD', '.env.production', 'config/models.json', 'config/backend.env',
    'adapter/.env.local', 'adapter/credentials.json', 'adapter/id_rsa',
    'adapter/holdings.pabackup', 'adapter/app.py.bak', 'adapter/private.pem',
  ]) await write(join(root, 'backend/dsh-trading-core', path), 'SECRET_CANARY')
  const archiveValue = Buffer.from('fixture archive')
  const archiveUrl = 'https://fixtures.invalid/python.tar.gz'
  const requirementsLockPath = `frontend/config/investment-python-requirements/${TARGET}.txt`
  const requirementsLock = 'alpha==1\nbeta==2\ngamma==3\n'
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
      'linux-x64': targetLock,
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
      await write(
        join(destination, 'python/install/lib/python3.10/__pycache__/_collections_abc.cpython-310.pyc'),
        'runtime bytecode cache',
      )
      await write(join(destination, 'python/install/lib/python3.10/site.pyc'), 'runtime bytecode cache')
    },
    runCommand,
  }
  return { root, lock, cache, output, dependencies, runCommand }
}

describe('investment Python sidecar builder', () => {
  it('builds a stable descriptor from offline cache and excludes generated or sensitive backend files', async () => {
    const setup = await fixture()
    const options = { target: TARGET, output: setup.output, cache: setup.cache, offline: true }
    let activeHashes = 0
    let peakHashes = 0
    const descriptorFileSha256 = vi.fn(async (path: string) => {
      activeHashes += 1
      peakHashes = Math.max(peakHashes, activeHashes)
      try {
        return hash(await readFile(path))
      } finally {
        activeHashes -= 1
      }
    })
    const dependencies = { ...setup.dependencies, descriptorFileSha256 }

    const first = await buildInvestmentPythonSidecar(options, dependencies)
    const firstJson = await readFile(join(setup.output, 'runtime.json'), 'utf8')
    const second = await buildInvestmentPythonSidecar(options, dependencies)
    const secondJson = await readFile(join(setup.output, 'runtime.json'), 'utf8')

    expect(secondJson).toBe(firstJson)
    expect(second).toEqual(first)
    expect(first.python).toEqual({
      version: '3.10.18', platform: 'darwin', arch: 'arm64', executable: 'runtime/bin/python3',
    })
    expect(first.backends).toEqual({
      'trading-core': { projectDir: 'backends/dsh-trading-core', module: 'adapter.app:app' },
      'market-watch': { projectDir: 'backends/market-watch', module: 'market_watch.app:app' },
      'industry-chain': { projectDir: 'backends/industry-chain', module: 'industry_chain.app:app' },
    })
    expect(first.files.map(entry => entry.path)).toEqual([...first.files.map(entry => entry.path)].sort())
    expect(first.files.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'backends/dsh-trading-core/adapter/app.py',
      'backends/market-watch/market_watch/app.py',
      'backends/industry-chain/industry_chain/app.py',
      'runtime/bin/python3',
      'site-packages/native-extension.so',
    ]))
    expect(firstJson).not.toContain('SECRET_CANARY')
    const backendFiles = first.files.filter(entry => entry.path.startsWith('backends/'))
    expect(backendFiles.map(entry => entry.path)).toEqual([
      'backends/dsh-trading-core/adapter/app.py',
      'backends/industry-chain/industry_chain/app.py',
      'backends/market-watch/market_watch/app.py',
    ])
    for (const file of backendFiles) {
      expect(await readFile(join(setup.output, file.path), 'utf8')).not.toContain('SECRET_CANARY')
    }
    expect(first.files.some(
      entry => /(?:^|\/)(?:env|data|logs|node_modules|tests|__pycache__)(?:\/|$)|\.env$|\.pyc$|\.log$/u.test(entry.path),
    )).toBe(false)
    expect(setup.runCommand).toHaveBeenCalledWith(
      expect.stringContaining(join('runtime', 'bin', 'python3')),
      expect.arrayContaining(['--no-compile']),
      expect.any(String),
    )
    expect(setup.runCommand.mock.calls[0]?.[1]).not.toContain('--require-hashes')
    expect(setup.runCommand.mock.calls[0]?.[1]).not.toContain('--only-binary=:all:')
    expect(descriptorFileSha256).toHaveBeenCalled()
    expect(peakHashes).toBe(1)
  })

  it('does not replace the previous output when runtime code contains a credential', async () => {
    const setup = await fixture()
    const options = { target: TARGET, output: setup.output, cache: setup.cache, offline: true }
    await buildInvestmentPythonSidecar(options, setup.dependencies)
    const previous = await readFile(join(setup.output, 'runtime.json'), 'utf8')
    await write(join(setup.root, 'backend/dsh-trading-core/adapter/app.py'), 'api_key = "private-canary-123"')
    await expect(buildInvestmentPythonSidecar(options, setup.dependencies)).rejects.toThrow(/credential-literal/)
    expect(await readFile(join(setup.output, 'runtime.json'), 'utf8')).toBe(previous)
  })

  it('blocks unreviewed dependency tests before replacing the packaged output', async () => {
    const setup = await fixture()
    const options = { target: TARGET, output: setup.output, cache: setup.cache, offline: true }
    await buildInvestmentPythonSidecar(options, setup.dependencies)
    const previous = await readFile(join(setup.output, 'runtime.json'), 'utf8')
    const runCommand = async (_command: string, args: readonly string[]) => {
      const sitePackages = args[args.indexOf('--target') + 1]!
      await write(join(sitePackages, 'py_vapid/tests/test_vapid.py'), 'unreviewed fixture')
      return 0
    }
    await expect(buildInvestmentPythonSidecar(options, { ...setup.dependencies, runCommand }))
      .rejects.toThrow(/unreviewed py-vapid/)
    expect(await readFile(join(setup.output, 'runtime.json'), 'utf8')).toBe(previous)
  })

  it('fails closed for missing targets, cache/hash failures, requirements drift, and traversal', async () => {
    const setup = await fixture()
    const options = { target: TARGET, output: setup.output, cache: setup.cache, offline: true }
    const missingTargetLock = {
      ...setup.lock,
      targets: Object.fromEntries(Object.entries(setup.lock.targets).filter(([target]) => target !== TARGET)),
    }
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

  it('replaces a corrupt cached archive with a verified download', async () => {
    const setup = await fixture()
    const archive = join(setup.cache, `${TARGET}-python.tar.gz`)
    await writeFile(archive, 'corrupt')
    const download = vi.fn(async (_url: string, destination: string) => {
      await writeFile(destination, 'fixture archive')
    })

    await buildInvestmentPythonSidecar({
      target: TARGET, output: setup.output, cache: setup.cache,
    }, { ...setup.dependencies, download })

    expect(download).toHaveBeenCalledOnce()
    expect(await readFile(archive, 'utf8')).toBe('fixture archive')
  })

  it('publishes concurrent verified downloads without exposing partial cache files', async () => {
    const setup = await fixture()
    const archive = join(setup.cache, `${TARGET}-python.tar.gz`)
    await rm(archive)
    let arrivals = 0
    let releaseDownloads: (() => void) | undefined
    const bothDownloadsStarted = new Promise<void>((resolvePromise) => { releaseDownloads = resolvePromise })
    const download = vi.fn(async (_url: string, destination: string) => {
      await writeFile(destination, 'fixture archive')
      arrivals += 1
      if (arrivals === 2) releaseDownloads?.()
      await bothDownloadsStarted
    })

    await Promise.all([
      buildInvestmentPythonSidecar({
        target: TARGET, output: join(setup.root, 'output-one'), cache: setup.cache,
      }, { ...setup.dependencies, download }),
      buildInvestmentPythonSidecar({
        target: TARGET, output: join(setup.root, 'output-two'), cache: setup.cache,
      }, { ...setup.dependencies, download }),
    ])

    expect(download).toHaveBeenCalledTimes(2)
    expect(await readFile(archive, 'utf8')).toBe('fixture archive')
    expect(await readdir(setup.cache)).toEqual([`${TARGET}-python.tar.gz`])
  })

  it('retries only bounded transient download failures and removes partial files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'investment download retry '))
    roots.push(root)
    const destination = join(root, 'python.tar.gz')
    const delays: number[] = []
    const transient = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket reset for https://example.invalid/python.tar.gz?token=private'), {
        code: 'ECONNRESET',
      }),
    })
    const fetchImplementation = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(new Response('fixture archive', { status: 200 }))

    await downloadFileWithRetry(
      'https://example.invalid/python.tar.gz?token=private',
      destination,
      {
        fetchImplementation,
        maxAttempts: 2,
        wait: async (delay) => { delays.push(delay) },
      },
    )

    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([250])
    expect(await readFile(destination, 'utf8')).toBe('fixture archive')
  })

  it('does not retry permanent HTTP failures and redacts URL secrets from diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'investment download failure '))
    roots.push(root)
    const destination = join(root, 'python.tar.gz')
    const fetchImplementation = vi.fn(async () => new Response('not found', { status: 404 }))

    const failure = await downloadFileWithRetry(
      'https://user:password@example.invalid/python.tar.gz?token=private#fragment',
      destination,
      { fetchImplementation, maxAttempts: 3, wait: async () => {} },
    ).catch((error: unknown) => error)

    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(String(failure)).toContain('https://example.invalid/python.tar.gz')
    expect(String(failure)).toContain('HTTP 404')
    expect(String(failure)).not.toMatch(/user|password|token|private|fragment/u)
  })

  it('stops transient download retries at the configured limit and reports the cause chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'investment download exhausted '))
    roots.push(root)
    const destination = join(root, 'python.tar.gz')
    const delays: number[] = []
    const transient = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('timeout for https://example.invalid/python.tar.gz?token=private'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    })
    const fetchImplementation = vi.fn(async () => { throw transient })

    const failure = await downloadFileWithRetry(
      'https://example.invalid/python.tar.gz?token=private',
      destination,
      {
        fetchImplementation,
        maxAttempts: 3,
        wait: async (delay) => { delays.push(delay) },
      },
    ).catch((error: unknown) => error)

    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([250, 500])
    expect(String(failure)).toContain('TypeError: fetch failed')
    expect(String(failure)).toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(String(failure)).not.toMatch(/token|private/u)
  })

  it('emits the Linux platform identity for the container target', async () => {
    const setup = await fixture()
    const target = 'linux-x64'
    const targetLock = setup.lock.targets[target]
    const archive = join(setup.cache, `${target}-${basename(new URL(targetLock.archiveUrl).pathname)}`)
    await writeFile(archive, 'fixture archive')
    const descriptor = await buildInvestmentPythonSidecar({
      target, output: setup.output, cache: setup.cache, offline: true,
    }, setup.dependencies)

    expect(descriptor.python).toEqual({
      version: '3.10.18', platform: 'linux', arch: 'x64', executable: 'runtime/bin/python3',
    })
  })
})
