import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path, { dirname } from 'node:path'
import type { PlatformPath } from 'node:path'
import type { InvestmentBackendId } from './types.ts'

const BACKEND_MODULES = {
  'trading-core': 'adapter.app:app',
  'market-watch': 'market_watch.app:app',
  'industry-chain': 'industry_chain.app:app',
} as const satisfies Readonly<Record<InvestmentBackendId, string>>

/** One immutable file entry verified before a bundled Runtime is used. */
export interface InvestmentRuntimeFileDescriptor {
  /** Canonical POSIX-style path relative to the sidecar root. */
  readonly path: string
  /** Lowercase SHA-256 digest of the complete file. */
  readonly sha256: string
}

/** Closed descriptor written by the investment sidecar build. */
export interface InvestmentRuntimeDescriptor {
  /** Descriptor schema version. */
  readonly schemaVersion: 1
  /** Bundled Python identity and executable. */
  readonly python: Readonly<{
    version: string
    platform: NodeJS.Platform
    arch: string
    executable: string
  }>
  /** Preinstalled import root relative to the sidecar root. */
  readonly sitePackages: string
  /** Fixed backend directories and import modules. */
  readonly backends: Readonly<Record<InvestmentBackendId, Readonly<{
    projectDir: string
    module: typeof BACKEND_MODULES[InvestmentBackendId]
  }>>>
  /** Stable, complete build-produced file digest list. */
  readonly files: readonly InvestmentRuntimeFileDescriptor[]
}

/** Verified absolute paths shared by every bundled backend resolution. */
export interface VerifiedInvestmentRuntime {
  /** Parsed descriptor. */
  readonly descriptor: InvestmentRuntimeDescriptor
  /** Absolute sidecar root containing `runtime.json`. */
  readonly root: string
  /** Absolute bundled interpreter. */
  readonly pythonExecutable: string
  /** Absolute bundled import root. */
  readonly sitePackages: string
  /** Absolute bundled backend directories. */
  readonly projectDirs: Readonly<Record<InvestmentBackendId, string>>
}

/** Injectable descriptor I/O used by platform and corruption tests. */
export interface InvestmentRuntimeDescriptorOptions {
  /** Target Node platform. */
  readonly platform?: NodeJS.Platform
  /** Target Node architecture. */
  readonly arch?: string
  /** Path implementation matching the target platform. */
  readonly pathApi?: PlatformPath
  /** Read a descriptor or bundled file. */
  readonly readFile?: (candidate: string) => Uint8Array
  /** Return whether a candidate is an existing regular file. */
  readonly isFile?: (candidate: string) => boolean
  /** Return whether a candidate is an existing directory. */
  readonly isDirectory?: (candidate: string) => boolean
  /** List canonical relative regular files below the sidecar root. */
  readonly listFiles?: (root: string) => readonly string[]
}

function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function directoryExists(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function listRuntimeFiles(root: string): readonly string[] {
  const files: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw invalid(`symbolic link: ${relative}`)
      if (entry.isDirectory()) visit(absolute, relative)
      else if (entry.isFile() && relative !== 'runtime.json') files.push(relative)
      else if (!entry.isFile()) throw invalid(`unsupported file: ${relative}`)
    }
  }
  visit(root, '')
  return files.sort()
}

function invalid(detail: string): Error {
  return new Error(`investment Python packaged runtime is invalid (${detail}); reinstall the application`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseRelativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) throw invalid(`${field} path`)
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.normalize(value) !== value) {
    throw invalid(`${field} path`)
  }
  if (value === '.' || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`${field} path`)
  }
  return value
}

function parseBackend(value: unknown, id: InvestmentBackendId): InvestmentRuntimeDescriptor['backends'][InvestmentBackendId] {
  if (!isRecord(value) || !exactKeys(value, ['projectDir', 'module'])) throw invalid(`${id} backend`)
  const projectDir = parseRelativePath(value.projectDir, `${id} projectDir`)
  if (value.module !== BACKEND_MODULES[id]) throw invalid(`${id} module`)
  return Object.freeze({ projectDir, module: BACKEND_MODULES[id] })
}

function parseDescriptor(value: unknown): InvestmentRuntimeDescriptor {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'python', 'sitePackages', 'backends', 'files'])) {
    throw invalid('descriptor fields')
  }
  if (value.schemaVersion !== 1) throw invalid('schemaVersion')
  if (!isRecord(value.python) || !exactKeys(value.python, ['version', 'platform', 'arch', 'executable'])) {
    throw invalid('python fields')
  }
  if (typeof value.python.version !== 'string' || !/^3\.10\.\d+$/u.test(value.python.version)) {
    throw invalid('Python version')
  }
  if (typeof value.python.platform !== 'string' || typeof value.python.arch !== 'string') throw invalid('Python target')
  const executable = parseRelativePath(value.python.executable, 'python executable')
  const sitePackages = parseRelativePath(value.sitePackages, 'sitePackages')
  if (!isRecord(value.backends) || !exactKeys(value.backends, Object.keys(BACKEND_MODULES))) {
    throw invalid('backends')
  }
  if (!Array.isArray(value.files) || value.files.length === 0) throw invalid('files')
  const files = value.files.map((entry, index): InvestmentRuntimeFileDescriptor => {
    if (!isRecord(entry) || !exactKeys(entry, ['path', 'sha256'])) throw invalid(`files[${index}]`)
    const filePath = parseRelativePath(entry.path, `files[${index}]`)
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) throw invalid(`files[${index}] hash`)
    return Object.freeze({ path: filePath, sha256: entry.sha256 })
  })
  const filePaths = files.map(entry => entry.path)
  const filesOutOfOrder = filePaths.some((entry, index) => {
    const previous = index === 0 ? undefined : filePaths[index - 1]
    return previous !== undefined && previous >= entry
  })
  if (new Set(filePaths).size !== filePaths.length || filesOutOfOrder) {
    throw invalid('files order')
  }
  if (!filePaths.includes(executable)) throw invalid('unhashed Python executable')
  const backends = Object.freeze({
    'trading-core': parseBackend(value.backends['trading-core'], 'trading-core'),
    'market-watch': parseBackend(value.backends['market-watch'], 'market-watch'),
    'industry-chain': parseBackend(value.backends['industry-chain'], 'industry-chain'),
  })
  return Object.freeze({
    schemaVersion: 1,
    python: Object.freeze({
      version: value.python.version,
      platform: value.python.platform as NodeJS.Platform,
      arch: value.python.arch,
      executable,
    }),
    sitePackages,
    backends,
    files: Object.freeze(files),
  })
}

function resolveRelative(root: string, relative: string, pathApi: PlatformPath): string {
  const resolved = pathApi.resolve(root, ...relative.split('/'))
  const relation = pathApi.relative(root, resolved)
  if (relation === '' || relation === '..' || relation.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relation)) {
    throw invalid(`escaped path ${relative}`)
  }
  return resolved
}

/**
 * Parse and verify a packaged investment Python Runtime descriptor.
 * @param descriptorPath - absolute `runtime.json` path.
 * @param options - target and I/O facts used for verification.
 * @returns immutable descriptor plus verified absolute paths.
 */
export function verifyInvestmentRuntimeDescriptor(
  descriptorPath: string,
  options: InvestmentRuntimeDescriptorOptions = {},
): VerifiedInvestmentRuntime {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const pathApi = options.pathApi ?? path
  const readFile = options.readFile ?? readFileSync
  const isFile = options.isFile ?? fileExists
  const isDirectory = options.isDirectory ?? directoryExists
  const listFiles = options.listFiles ?? listRuntimeFiles
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(readFile(descriptorPath)).toString('utf8'))
  } catch {
    throw invalid('runtime.json')
  }
  const descriptor = parseDescriptor(decoded)
  if (descriptor.python.platform !== platform || descriptor.python.arch !== arch) throw invalid('platform or architecture')
  const root = dirname(descriptorPath)
  const pythonExecutable = resolveRelative(root, descriptor.python.executable, pathApi)
  const sitePackages = resolveRelative(root, descriptor.sitePackages, pathApi)
  const projectDirs = Object.freeze({
    'trading-core': resolveRelative(root, descriptor.backends['trading-core'].projectDir, pathApi),
    'market-watch': resolveRelative(root, descriptor.backends['market-watch'].projectDir, pathApi),
    'industry-chain': resolveRelative(root, descriptor.backends['industry-chain'].projectDir, pathApi),
  })
  if (!isFile(pythonExecutable)) throw invalid('Python executable missing')
  if (!isDirectory(sitePackages)) throw invalid('sitePackages missing')
  for (const [id, projectDir] of Object.entries(projectDirs)) {
    if (!isDirectory(projectDir)) throw invalid(`${id} backend missing`)
  }
  for (const entry of descriptor.files) {
    const absolute = resolveRelative(root, entry.path, pathApi)
    if (!isFile(absolute)) throw invalid(`file missing: ${entry.path}`)
    const actual = createHash('sha256').update(readFile(absolute)).digest('hex')
    if (actual !== entry.sha256) throw invalid(`hash mismatch: ${entry.path}`)
  }
  const actualFiles = listFiles(root)
  const declaredFiles = descriptor.files.map(entry => entry.path)
  if (actualFiles.length !== declaredFiles.length || actualFiles.some((entry, index) => entry !== declaredFiles[index])) {
    throw invalid('incomplete file list')
  }
  return Object.freeze({ descriptor, root, pythonExecutable, sitePackages, projectDirs })
}
