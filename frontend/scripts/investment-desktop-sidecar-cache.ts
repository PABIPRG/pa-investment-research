/** Reuse a verified, pre-application-signing desktop sidecar; workflow scope owns producer trust. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashSidecarFile, mapSidecarFiles } from '../apps/electron/src/sidecar-file-hashes.ts'
import { backendPathAllowed, scanPackagedBackends } from './investment-backend-package-policy.ts'
import type { BuildInvestmentSidecarOptions, InvestmentSidecarLock } from './build-investment-python-sidecar.ts'

const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const
const backends = ['dsh-trading-core', 'market-watch', 'industry-chain'] as const
const fixedInputs = [
  '.github/workflows/investment-sidecar.yml',
  'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml', 'frontend/.npmrc',
  'frontend/scripts/build-investment-python-sidecar.ts', 'frontend/scripts/investment-backend-package-policy.ts',
  'frontend/scripts/investment-container-test-payloads.ts', 'frontend/scripts/investment-desktop-sidecar-cache.ts',
  'frontend/apps/electron/src/sidecar-file-hashes.ts', 'frontend/config/investment-python-runtime-lock.json',
]
const backendDescriptor = {
  'trading-core': { projectDir: 'backends/dsh-trading-core', module: 'adapter.app:app' },
  'market-watch': { projectDir: 'backends/market-watch', module: 'market_watch.app:app' },
  'industry-chain': { projectDir: 'backends/industry-chain', module: 'industry_chain.app:app' },
}

/** Explicit inputs for an isolated desktop cache; downloadCache keeps its existing archive-only meaning. */
export interface DesktopSidecarOptions {
  repoRoot: string
  target: string
  compatibility: string
  cacheRoot: string
  downloadCache: string
}

interface Entry {
  path: string
  kind: 'directory' | 'file'
  mode: number
  size?: number
  sha256?: string
}

interface ExpectedInputs {
  fingerprint: string
  target: string
  compatibility: string
  python: { version: string; platform: string; arch: string; executable: string }
}

function desktopTarget(value: string): typeof targets[number] {
  if (!targets.includes(value as typeof targets[number])) throw new Error('unsupported desktop sidecar target')
  return value as typeof targets[number]
}

function safePath(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || posix.isAbsolute(value)
    || posix.normalize(value) !== value || value.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('invalid desktop sidecar relative path')
  }
  return value
}

function modeBits(mode: number, target: string): number {
  // Node exposes only owner read/write permissions on Windows; POSIX keeps all bits.
  return mode & (target.startsWith('win32-') ? 0o600 : 0o7777)
}

async function regularFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('cache input is not an independent regular file')
}

async function runtimeLock(repoRoot: string, target: string): Promise<InvestmentSidecarLock> {
  const path = join(repoRoot, 'frontend/config/investment-python-runtime-lock.json')
  await regularFile(path)
  const lock = JSON.parse(await readFile(path, 'utf8')) as {
    schemaVersion?: unknown
    targets?: Partial<InvestmentSidecarLock['targets']>
    requirements?: Record<string, string>
  }
  const targetLock = lock.targets?.[desktopTarget(target)]
  if (lock.schemaVersion !== 1 || !targetLock || !/^3\.10\.\d+$/u.test(targetLock.pythonVersion)
    || !/^[a-f0-9]{64}$/u.test(targetLock.archiveSha256) || !/^[a-f0-9]{64}$/u.test(targetLock.requirementsSha256)) {
    throw new Error('invalid desktop sidecar lock')
  }
  safePath(targetLock.requirementsLock)
  safePath(targetLock.archiveRuntimeRoot)
  safePath(targetLock.archiveExecutable)
  if (!targetLock.archiveExecutable.startsWith(`${targetLock.archiveRuntimeRoot}/`)) throw new Error('invalid locked Python executable')
  if (!lock.requirements || Object.values(lock.requirements).some(value => !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error('invalid desktop sidecar requirement identities')
  }
  return lock as InvestmentSidecarLock
}

async function walk(
  root: string,
  target: string,
  accept: (path: string, directory: boolean) => boolean = () => true,
): Promise<Entry[]> {
  const entries: Entry[] = []
  async function visit(path: string): Promise<void> {
    if (path) safePath(path)
    const absolute = join(root, path)
    const info = await lstat(absolute)
    if (path && !accept(path, info.isDirectory()) && !(info.isSymbolicLink() && accept(path, true))) return
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('sidecar contains a link or special entry')
    if (info.isFile() && info.nlink !== 1) throw new Error('sidecar contains a hard-linked file')
    entries.push({ path, kind: info.isDirectory() ? 'directory' : 'file', mode: modeBits(info.mode, target), ...(info.isFile() ? { size: info.size } : {}) })
    if (info.isDirectory()) for (const name of (await readdir(absolute)).sort()) await visit(path ? `${path}/${name}` : name)
  }
  await visit('')
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return await mapSidecarFiles(entries, async entry => entry.kind === 'file'
    ? { ...entry, sha256: await hashSidecarFile(join(root, entry.path)) } : entry)
}

/** Hash actual build inputs, including allowed untracked/ignored backend files, without UI sources. */
export async function desktopSidecarFingerprint(repoRoot: string, targetValue: string, compatibility: string): Promise<string> {
  const target = desktopTarget(targetValue)
  if (!compatibility) throw new Error('desktop cache compatibility identity is required')
  const lock = await runtimeLock(repoRoot, target)
  const files = [...new Set([...fixedInputs, lock.targets[target].requirementsLock, ...Object.keys(lock.requirements)])].sort()
  const hash = createHash('sha256').update(JSON.stringify(['investment-desktop-sidecar-v1', target, compatibility]))
  for (const file of files) {
    safePath(file)
    const path = join(repoRoot, file)
    await regularFile(path)
    const info = await lstat(path)
    hash.update(JSON.stringify([file, modeBits(info.mode, target), await hashSidecarFile(path)]))
  }
  hash.update(JSON.stringify(['frontend/patches', await walk(join(repoRoot, 'frontend/patches'), target)]))
  for (const backend of backends) {
    const entries = await walk(join(repoRoot, 'backend', backend), target,
      (path, directory) => backendPathAllowed(backend, path, directory))
    hash.update(JSON.stringify([backend, entries]))
  }
  return hash.digest('hex')
}

async function expectedInputs(options: DesktopSidecarOptions): Promise<ExpectedInputs> {
  const target = desktopTarget(options.target)
  const lock = await runtimeLock(options.repoRoot, target)
  const targetLock = lock.targets[target]
  const [platform, arch] = target.split('-') as [string, string]
  return {
    fingerprint: await desktopSidecarFingerprint(options.repoRoot, target, options.compatibility),
    target, compatibility: options.compatibility,
    python: { version: targetLock.pythonVersion, platform, arch, executable: `runtime/${targetLock.archiveExecutable.slice(targetLock.archiveRuntimeRoot.length + 1)}` },
  }
}

async function checkedInventory(payload: string, expected: ExpectedInputs): Promise<Entry[]> {
  const entries = await walk(payload, expected.target)
  if (entries[0]?.kind !== 'directory') throw new Error('sidecar payload must be a directory')
  const executable = entries.find(entry => entry.path === expected.python.executable)
  if (executable?.kind !== 'file' || (!expected.target.startsWith('win32-') && (executable.mode & 0o111) === 0)) {
    throw new Error('sidecar Python executable missing or not executable')
  }
  const descriptorEntry = entries.find(entry => entry.path === 'runtime.json')
  if (descriptorEntry?.kind !== 'file') throw new Error('sidecar descriptor missing')
  const descriptor = JSON.parse(await readFile(join(payload, 'runtime.json'), 'utf8')) as unknown
  // Preserve the builder's nested runtime.json exclusion; the cache inventory hashes every file.
  const descriptorFiles = entries.filter(entry => entry.kind === 'file' && posix.basename(entry.path) !== 'runtime.json')
    .map(({ path, sha256 }) => ({ path, sha256 }))
  const expectedDescriptor = { schemaVersion: 1, python: expected.python, sitePackages: 'site-packages', backends: backendDescriptor, files: descriptorFiles }
  if (!isDeepStrictEqual(descriptor, expectedDescriptor)) throw new Error('sidecar descriptor does not match locked target and complete file inventory')
  await scanPackagedBackends(payload)
  return entries
}

async function validate(cacheRoot: string, expected: ExpectedInputs): Promise<boolean> {
  try {
    if (!(await lstat(cacheRoot)).isDirectory()) return false
    if (JSON.stringify((await readdir(cacheRoot)).sort()) !== JSON.stringify(['investment-python', 'metadata.json'])) return false
    const metadataPath = join(cacheRoot, 'metadata.json')
    await regularFile(metadataPath)
    if ((await lstat(metadataPath)).size > 16 * 1024 * 1024) return false
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
    const entries = await checkedInventory(join(cacheRoot, 'investment-python'), expected)
    return isDeepStrictEqual(metadata, { version: 1, ...expected, entries })
  } catch {
    // A missing, malformed, stale or damaged cache is rebuilt by the locked builder.
    return false
  }
}

/** Validate the exact input identity, all actual files/directories, hashes, modes and backend privacy. */
export async function validateDesktopSidecarCache(options: DesktopSidecarOptions): Promise<boolean> {
  return await validate(resolve(options.cacheRoot), await expectedInputs(options))
}

function containsPath(parent: string, child: string): boolean {
  const distance = relative(parent, child)
  return distance === '' || (!distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance))
}

async function canonicalFuturePath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    let missing = false
    try {
      await lstat(path)
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      missing = true
    }
    if (!missing) throw new Error('unresolvable desktop cache download path')
    return join(await canonicalFuturePath(dirname(path)), basename(path))
  }
}

async function dedicatedCacheRoot(options: DesktopSidecarOptions): Promise<string> {
  const root = resolve(options.cacheRoot)
  if (basename(root) !== 'investment-desktop-sidecar') throw new Error('desktop cache requires its dedicated directory')
  const parent = dirname(root)
  const canonicalParent = await realpath(parent)
  const equal = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equal(parent, canonicalParent)) throw new Error('desktop cache parent must not traverse a link')
  const repo = await realpath(options.repoRoot)
  const downloads = await canonicalFuturePath(resolve(options.downloadCache))
  if ([repo, downloads].some(path => containsPath(root, path) || containsPath(path, root))) {
    throw new Error('desktop cache must not overlap source or download directories')
  }
  await mkdir(root, { recursive: true })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('desktop cache root must be a real directory')
  return root
}

async function assertUnchangedInputs(options: DesktopSidecarOptions, expected: ExpectedInputs): Promise<void> {
  if (!isDeepStrictEqual(await expectedInputs(options), expected)) throw new Error('desktop sidecar inputs changed during preparation')
}

/** Build on cache miss; publish metadata only after complete validation. The workflow alone may save remotely. */
export async function prepareDesktopSidecar(
  options: DesktopSidecarOptions,
  dependencies: { build?: (options: BuildInvestmentSidecarOptions) => Promise<unknown> } = {},
): Promise<'hit' | 'built'> {
  const started = Date.now()
  const cacheRoot = await dedicatedCacheRoot(options)
  const expected = await expectedInputs(options)
  if (await validate(cacheRoot, expected)) {
    await assertUnchangedInputs(options, expected)
    console.info(`Desktop Python sidecar cache: verified hit ${expected.fingerprint} after ${Date.now() - started}ms`)
    return 'hit'
  }
  console.info(`Desktop Python sidecar cache: miss or invalid ${expected.fingerprint}; running locked builder`)
  // Only this dedicated, non-linked root is disposable. rm unlinks child links without following them.
  for (const name of await readdir(cacheRoot)) await rm(join(cacheRoot, name), { recursive: true, force: true })
  const output = join(cacheRoot, 'investment-python')
  const build = dependencies.build ?? (await import('./build-investment-python-sidecar.ts')).buildInvestmentPythonSidecar
  await build({ target: options.target, output, cache: options.downloadCache })
  const entries = await checkedInventory(output, expected)
  await assertUnchangedInputs(options, expected)
  if (JSON.stringify(await readdir(cacheRoot)) !== JSON.stringify(['investment-python'])) throw new Error('unexpected cache root contents after build')
  const temporary = join(cacheRoot, `.metadata-${randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...expected, entries })}\n`, { flag: 'wx' })
    await rename(temporary, join(cacheRoot, 'metadata.json'))
  } finally {
    await rm(temporary, { force: true })
  }
  console.info(`Desktop Python sidecar cache: built candidate ${expected.fingerprint} after ${Date.now() - started}ms`)
  return 'built'
}

function runnerCompatibility(): string {
  const { ImageOS, ImageVersion } = process.env
  if (!ImageOS || !ImageVersion) throw new Error('desktop cache requires a versioned runner image')
  return JSON.stringify({ imageOS: ImageOS, imageVersion: ImageVersion, node: process.version })
}

async function cli(args: string[]): Promise<void> {
  const [command, target, cacheRoot, downloadCache] = args
  if (!target || target !== `${process.platform}-${process.arch}`) throw new Error('desktop cache target must match native runner')
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const compatibility = runnerCompatibility()
  if (command === 'fingerprint' && args.length === 2) {
    const fingerprint = await desktopSidecarFingerprint(repoRoot, target, compatibility)
    console.info(`Desktop Python sidecar inputs: ${fingerprint}; runner ${compatibility}`)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\nprefix=investment-desktop-sidecar-v1-${target}-${fingerprint}-\n`)
    return
  }
  if (!cacheRoot) throw new Error('desktop cache directory is required')
  const options = { repoRoot, target, compatibility, cacheRoot, downloadCache: downloadCache ?? '' }
  if (command === 'build' && args.length === 4 && downloadCache) {
    const result = await prepareDesktopSidecar(options)
    if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `INVESTMENT_DESKTOP_SIDECAR_BUILT=${result === 'built' ? 'true' : 'false'}\n`)
    return
  }
  if (command === 'validate' && args.length === 3) {
    if (!await validateDesktopSidecarCache(options)) throw new Error('desktop cache candidate failed post-package validation')
    console.info('Desktop Python sidecar cache: post-package source validation passed')
    return
  }
  throw new Error('usage: desktop-sidecar-cache fingerprint <target> | build <target> <cache> <downloads> | validate <target> <cache>')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await cli(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'desktop cache failed'}\n`)
    process.exitCode = 1
  }
}
