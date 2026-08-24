import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const
const BACKENDS = ['dsh-trading-core', 'market-watch'] as const
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const EXCLUDED_SEGMENTS = new Set(['.git', '__pycache__', 'data', 'env', 'logs', 'tests'])

export type InvestmentSidecarTarget = typeof TARGETS[number]

export interface InvestmentSidecarTargetLock {
  readonly pythonVersion: string
  readonly archiveUrl: string
  readonly archiveSha256: string
  readonly archiveRuntimeRoot: string
  readonly archiveExecutable: string
  readonly requirementsLock: string
  readonly requirementsSha256: string
}

export interface InvestmentSidecarLock {
  readonly schemaVersion: 1
  readonly requirements: Readonly<Record<string, string>>
  readonly targets: Readonly<Record<InvestmentSidecarTarget, InvestmentSidecarTargetLock>>
}

export interface BuildInvestmentSidecarOptions {
  readonly target: string
  readonly output: string
  readonly cache: string
  readonly offline?: boolean
}

export interface BuildInvestmentSidecarDependencies {
  readonly repoRoot?: string
  readonly lock?: InvestmentSidecarLock
  readonly download?: (url: string, destination: string) => Promise<void>
  readonly listArchive?: (archive: string) => Promise<readonly string[]>
  readonly extractArchive?: (archive: string, destination: string) => Promise<void>
  readonly runCommand?: (command: string, args: readonly string[], cwd: string) => Promise<number>
  readonly descriptorFileSha256?: (path: string) => Promise<string>
}

interface RuntimeDescriptor {
  readonly schemaVersion: 1
  readonly python: {
    readonly version: string
    readonly platform: 'darwin' | 'win32'
    readonly arch: 'arm64' | 'x64'
    readonly executable: string
  }
  readonly sitePackages: 'site-packages'
  readonly backends: {
    readonly 'trading-core': { readonly projectDir: 'backends/dsh-trading-core'; readonly module: 'adapter.app:app' }
    readonly 'market-watch': { readonly projectDir: 'backends/market-watch'; readonly module: 'market_watch.app:app' }
  }
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function safeArchivePath(value: string): string {
  const normalized = value.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (normalized === '' || value.includes('\\') || posix.isAbsolute(normalized)) {
    throw new Error(`unsafe archive entry: ${JSON.stringify(value)}`)
  }
  if (posix.normalize(normalized) !== normalized || normalized.split('/').some(segment => segment === '..')) {
    throw new Error(`unsafe archive entry: ${JSON.stringify(value)}`)
  }
  return normalized
}

function safeLockPath(value: string, label: string): string {
  const normalized = safeArchivePath(value)
  if (normalized === '.') throw new Error(`${label} must name a relative path`)
  return normalized
}

function parseTarget(value: string): InvestmentSidecarTarget {
  if (!TARGETS.includes(value as InvestmentSidecarTarget)) {
    throw new Error(`unsupported investment Python sidecar target: ${value}`)
  }
  return value as InvestmentSidecarTarget
}

function validateLock(lock: InvestmentSidecarLock, target: InvestmentSidecarTarget): InvestmentSidecarTargetLock {
  if (lock.schemaVersion !== 1) throw new Error('unsupported investment Python runtime lock schema')
  const targetLock = lock.targets[target]
  if (targetLock === undefined) throw new Error(`investment Python runtime lock has no target ${target}`)
  if (!/^3\.10\.\d+$/u.test(targetLock.pythonVersion)) throw new Error(`${target} must lock an exact Python 3.10 patch`)
  if (!HASH_PATTERN.test(targetLock.archiveSha256)) {
    throw new Error(`${target} archive SHA-256 is not release-ready`)
  }
  safeLockPath(targetLock.archiveRuntimeRoot, `${target} runtime root`)
  const executable = safeLockPath(targetLock.archiveExecutable, `${target} executable`)
  if (!executable.startsWith(`${targetLock.archiveRuntimeRoot}/`)) {
    throw new Error(`${target} executable must be inside its runtime root`)
  }
  safeLockPath(targetLock.requirementsLock, `${target} requirements lock`)
  if (!HASH_PATTERN.test(targetLock.requirementsSha256)) {
    throw new Error(`${target} requirements lock has an invalid SHA-256`)
  }
  for (const [path, hash] of Object.entries(lock.requirements)) {
    safeLockPath(path, 'requirements path')
    if (!HASH_PATTERN.test(hash)) throw new Error(`${path} has an invalid SHA-256`)
  }
  return targetLock
}

function verifyExactRequirements(value: string, target: InvestmentSidecarTarget): void {
  const requirements = value.split(/\r?\n/u).filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
  if (requirements.length === 0) throw new Error(`${target} requirements lock is not release-ready`)
  for (const requirement of requirements) {
    if (!/^[a-zA-Z0-9_.-]+(?:\[[^\]]+\])?==[^\s]+$/u.test(requirement)) {
      throw new Error(`${target} requirements lock contains a non-exact entry: ${requirement}`)
    }
  }
}

async function loadDefaultLock(repoRoot: string): Promise<InvestmentSidecarLock> {
  const path = join(repoRoot, 'frontend', 'config', 'investment-python-runtime-lock.json')
  return JSON.parse(await readFile(path, 'utf8')) as InvestmentSidecarLock
}

async function defaultDownload(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || response.body === null) throw new Error(`download failed (${response.status}): ${url}`)
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(destination, { flags: 'wx' }),
  )
}

async function defaultListArchive(archive: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync('tar', ['-tf', archive], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.split(/\r?\n/u).filter(Boolean)
}

async function defaultRunCommand(command: string, args: readonly string[], cwd: string): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => { resolveExit(code ?? 1) })
  })
}

async function defaultExtractArchive(archive: string, destination: string): Promise<void> {
  const exitCode = await defaultRunCommand('tar', ['-xf', archive, '-C', destination], destination)
  if (exitCode !== 0) throw new Error(`tar extraction failed with exit code ${exitCode}`)
}

function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u)
  const name = segments.at(-1)?.toLowerCase() ?? ''
  return segments.some(segment => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))
    || name === '.env'
    || name.endsWith('.pyc')
    || name.endsWith('.log')
}

async function copyBackend(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: candidate => {
      const rel = relative(source, candidate)
      return rel === '' || !shouldExclude(rel)
    },
  })
  const pending = [destination]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`backend source contains a symlink: ${path}`)
      if (entry.isDirectory()) pending.push(path)
    }
  }
}

async function collectFiles(
  root: string,
  hashFile: (path: string) => Promise<string>,
): Promise<RuntimeDescriptor['files']> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`sidecar output contains a symlink: ${absolute}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name !== 'runtime.json') files.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  await visit(root)
  files.sort()
  const descriptors: { path: string; sha256: string }[] = []
  for (const path of files) {
    descriptors.push({ path, sha256: await hashFile(join(root, ...path.split('/'))) })
  }
  return descriptors
}

async function prepareArchive(
  cache: string,
  target: InvestmentSidecarTarget,
  targetLock: InvestmentSidecarTargetLock,
  offline: boolean,
  download: (url: string, destination: string) => Promise<void>,
): Promise<string> {
  await mkdir(cache, { recursive: true })
  const archive = join(cache, `${target}-${basename(new URL(targetLock.archiveUrl).pathname)}`)
  let present = false
  try {
    present = (await stat(archive)).isFile()
  } catch {
    // A cache miss is handled below.
  }
  if (present && await fileSha256(archive) === targetLock.archiveSha256) return archive
  if (offline) throw new Error(`offline cache miss or hash mismatch for ${target}`)
  await rm(archive, { force: true })
  const temporary = `${archive}.download-${process.pid}`
  await rm(temporary, { force: true })
  try {
    await download(targetLock.archiveUrl, temporary)
    if (await fileSha256(temporary) !== targetLock.archiveSha256) throw new Error(`${target} archive hash mismatch`)
    await rename(temporary, archive)
  } finally {
    await rm(temporary, { force: true })
  }
  return archive
}

/** Build one immutable investment Python sidecar for an explicit platform target. */
export async function buildInvestmentPythonSidecar(
  options: BuildInvestmentSidecarOptions,
  dependencies: BuildInvestmentSidecarDependencies = {},
): Promise<RuntimeDescriptor> {
  const target = parseTarget(options.target)
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot()
  const lock = dependencies.lock ?? await loadDefaultLock(repoRoot)
  const targetLock = validateLock(lock, target)
  const requirementEntries = Object.entries(lock.requirements).sort(([left], [right]) => left.localeCompare(right, 'en'))
  for (const [path, expected] of requirementEntries) {
    const actual = await fileSha256(join(repoRoot, ...path.split('/')))
    if (actual !== expected) throw new Error(`requirements drift: ${path}`)
  }
  const requirementsLockPath = join(repoRoot, ...targetLock.requirementsLock.split('/'))
  if (await fileSha256(requirementsLockPath) !== targetLock.requirementsSha256) {
    throw new Error(`requirements lock drift: ${targetLock.requirementsLock}`)
  }
  const requirementsLock = await readFile(requirementsLockPath, 'utf8')
  verifyExactRequirements(requirementsLock, target)

  const archive = await prepareArchive(
    resolve(options.cache), target, targetLock, options.offline === true, dependencies.download ?? defaultDownload,
  )
  const entries = await (dependencies.listArchive ?? defaultListArchive)(archive)
  entries.forEach(safeArchivePath)

  const output = resolve(options.output)
  const parent = dirname(output)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, '.investment-python-build-'))
  try {
    const extracted = join(staging, '.archive')
    await mkdir(extracted)
    await (dependencies.extractArchive ?? defaultExtractArchive)(archive, extracted)
    const runtimeSource = join(extracted, ...targetLock.archiveRuntimeRoot.split('/'))
    const executableTail = targetLock.archiveExecutable.slice(targetLock.archiveRuntimeRoot.length + 1)
    const runtimeDestination = join(staging, 'runtime')
    if (!(await lstat(runtimeSource)).isDirectory()) throw new Error(`${target} archive runtime root is missing`)
    await cp(runtimeSource, runtimeDestination, { recursive: true, dereference: true })
    await rm(extracted, { recursive: true, force: true })

    const sitePackages = join(staging, 'site-packages')
    await mkdir(sitePackages)
    const pythonExecutable = join(runtimeDestination, ...executableTail.split('/'))
    const runCommand = dependencies.runCommand ?? defaultRunCommand
    const pipExit = await runCommand(pythonExecutable, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile',
      '--target', sitePackages, '-r', requirementsLockPath,
    ], staging)
    if (pipExit !== 0) throw new Error(`locked dependency installation failed with exit code ${pipExit}`)

    await mkdir(join(staging, 'backends'))
    for (const backend of BACKENDS) {
      await copyBackend(join(repoRoot, 'backend', backend), join(staging, 'backends', backend))
    }
    const [platform, arch] = target.split('-') as ['darwin' | 'win32', 'arm64' | 'x64']
    const descriptor: RuntimeDescriptor = {
      schemaVersion: 1,
      python: {
        version: targetLock.pythonVersion,
        platform,
        arch,
        executable: `runtime/${executableTail}`,
      },
      sitePackages: 'site-packages',
      backends: {
        'trading-core': { projectDir: 'backends/dsh-trading-core', module: 'adapter.app:app' },
        'market-watch': { projectDir: 'backends/market-watch', module: 'market_watch.app:app' },
      },
      files: await collectFiles(staging, dependencies.descriptorFileSha256 ?? fileSha256),
    }
    await writeFile(join(staging, 'runtime.json'), `${JSON.stringify(descriptor, undefined, 2)}\n`, 'utf8')
    await rm(output, { recursive: true, force: true })
    await rename(staging, output)
    return descriptor
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function parseCli(argv: readonly string[]): BuildInvestmentSidecarOptions {
  const values = new Map<string, string>()
  let offline = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--offline') {
      offline = true
      continue
    }
    if (!['--target', '--output', '--cache'].includes(argument)) throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${argument}`)
    values.set(argument, value)
    index += 1
  }
  const target = values.get('--target')
  const output = values.get('--output')
  const cache = values.get('--cache')
  if (target === undefined || output === undefined || cache === undefined) {
    throw new Error('usage: build-investment-python-sidecar --target <target> --output <dir> --cache <dir> [--offline]')
  }
  return { target, output, cache, offline }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await buildInvestmentPythonSidecar(parseCli(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
