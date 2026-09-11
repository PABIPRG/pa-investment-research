import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveDshInstanceLayout } from '@deepseek-ai/dsh-home-paths'
import type { DshInstanceLayout } from '@deepseek-ai/dsh-home-paths'

const LAYOUT_VERSION = 1
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const DURABLE_PATHS = [
  'settings.yaml',
  'cordis.patch.yml',
  'profiles',
  'sessions',
  join('attachments', 'v1'),
  'storages',
  join('investment-research', 'backup-settings.json'),
  join('investment-research', 'backups'),
  ...['trading-core', 'market-watch', 'industry-chain'].flatMap(id => [
    join('investment-research', id, 'data'),
    join('investment-research', id, 'state'),
    join('investment-research', id, 'user-config'),
  ]),
] as const

/** A copied file and the checksum verified in the published target. */
export interface MigratedInstanceFile {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}

/** Online SQLite consistency copier, implemented by the deployment runtime. */
export type SqliteBackup = (sourcePath: string, destinationPath: string) => Promise<void>

/** Options for an explicit, copy-only DSH instance migration. */
export interface MigrateDshInstanceOptions {
  readonly sourceRoot: string
  readonly targetRoot: string
  /** Quiesced sources may be copied; online SQLite files require `backupSqlite`. */
  readonly mode: 'quiesced' | 'online'
  readonly backupSqlite?: SqliteBackup
  /** Test and audit hook invoked before each file is copied. */
  readonly beforeCopy?: (relativePath: string) => Promise<void> | void
}

/** Result of one atomically published migration. */
export interface MigrateDshInstanceResult {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly layoutVersion: typeof LAYOUT_VERSION
  readonly files: readonly MigratedInstanceFile[]
}

async function pathKind(path: string): Promise<'missing' | 'empty-directory' | 'non-empty'> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return 'non-empty'
    return (await readdir(path)).length === 0 ? 'empty-directory' : 'non-empty'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function assertRoots(sourceRoot: string, targetRoot: string): void {
  if (!isAbsolute(sourceRoot) || !isAbsolute(targetRoot)) {
    throw new Error('instance migration sourceRoot and targetRoot must be absolute')
  }
  const source = resolve(sourceRoot)
  const target = resolve(targetRoot)
  if (source === target || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) {
    throw new Error('instance migration source and target roots must be separate trees')
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function isSqlite(path: string): boolean {
  return SQLITE_EXTENSIONS.has(extname(path).toLowerCase())
}

function isSqliteSidecar(path: string): boolean {
  return path.endsWith('-wal') || path.endsWith('-shm')
}

async function copyDurableEntry(
  source: string,
  destination: string,
  relativePath: string,
  options: MigrateDshInstanceOptions,
  files: MigratedInstanceFile[],
): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    throw new Error(`instance migration refuses symbolic link: ${relativePath}`)
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 })
    for (const child of (await readdir(source)).sort()) {
      await copyDurableEntry(
        join(source, child),
        join(destination, child),
        join(relativePath, child),
        options,
        files,
      )
    }
    return
  }
  if (!info.isFile()) throw new Error(`instance migration refuses special file: ${relativePath}`)
  if (options.mode === 'online' && isSqliteSidecar(source)) return
  await options.beforeCopy?.(relativePath)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (options.mode === 'online' && isSqlite(source)) {
    if (options.backupSqlite === undefined) {
      throw new Error(`online SQLite migration requires a consistency backup: ${relativePath}`)
    }
    await options.backupSqlite(source, destination)
  } else {
    await copyFile(source, destination)
  }
  const copied = await lstat(destination)
  if (!copied.isFile() || copied.isSymbolicLink()) {
    throw new Error(`instance migration produced an invalid target file: ${relativePath}`)
  }
  await chmod(destination, info.mode & 0o777)
  const targetHash = await sha256(destination)
  if (options.mode !== 'online' || !isSqlite(source)) {
    const sourceHash = await sha256(source)
    if (sourceHash !== targetHash || info.size !== copied.size) {
      throw new Error(`instance migration checksum verification failed: ${relativePath}`)
    }
  }
  files.push({ relativePath, bytes: copied.size, sha256: targetHash })
}

async function readSourceLayoutVersion(root: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(join(root, '.dsh-instance.json'), 'utf8')) as { schemaVersion?: unknown }
    if (parsed.schemaVersion !== LAYOUT_VERSION) {
      throw new Error(`unsupported source instance layout version: ${String(parsed.schemaVersion)}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    if (error instanceof SyntaxError) throw new Error('source instance layout marker is invalid', { cause: error })
    throw error
  }
}

async function writeLayoutMarker(
  root: string,
  kind: 'initialized' | 'migrated',
  files: readonly MigratedInstanceFile[] = [],
): Promise<void> {
  const marker = {
    schemaVersion: LAYOUT_VERSION,
    kind,
    createdAt: new Date().toISOString(),
    files,
  }
  await writeFile(join(root, '.dsh-instance.json'), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Initialize an empty mounted DSH home with every owned directory.
 * Existing non-empty paths are rejected so initialization never adopts or
 * overwrites unclassified data.
 * @param root - absolute instance root.
 * @returns the resolved instance layout.
 */
export async function initializeDshInstance(root: string): Promise<DshInstanceLayout> {
  if (!isAbsolute(root)) throw new Error('instance root must be absolute')
  const targetKind = await pathKind(root)
  if (targetKind === 'non-empty') throw new Error('instance initialization target must be empty')
  const layout = resolveDshInstanceLayout(root)
  const directories = [
    layout.profilesDir,
    layout.sessionsDir,
    layout.attachmentsDir,
    layout.storagesDir,
    layout.investmentResearch.backupsDir,
    ...Object.values(layout.investmentResearch.backends).flatMap(backend => [
      backend.dataDir,
      backend.stateDir,
      backend.userConfigDir,
      backend.cacheDir,
      backend.logsDir,
    ]),
  ]
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeLayoutMarker(layout.root, 'initialized')
  return layout
}

/**
 * Copy the explicit durable inventory from one DSH home and atomically publish it.
 * The source is never changed. A non-empty target, symlink, special file, copy
 * failure, or unhandled online SQLite file aborts before publication.
 * @param options - source, target, quiescence, and SQLite backup policy.
 * @returns the verified copied-file manifest.
 */
export async function migrateDshInstance(options: MigrateDshInstanceOptions): Promise<MigrateDshInstanceResult> {
  assertRoots(options.sourceRoot, options.targetRoot)
  const sourceRoot = resolve(options.sourceRoot)
  const targetRoot = resolve(options.targetRoot)
  const sourceInfo = await lstat(sourceRoot)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error('instance migration source must be a real directory')
  }
  await readSourceLayoutVersion(sourceRoot)
  const targetKind = await pathKind(targetRoot)
  if (targetKind === 'non-empty') throw new Error('instance migration target must be empty')
  await mkdir(dirname(targetRoot), { recursive: true })
  const stagingRoot = join(dirname(targetRoot), `.${basename(targetRoot)}.staging-${randomUUID()}`)
  const files: MigratedInstanceFile[] = []
  let removedEmptyTarget = false
  try {
    await mkdir(stagingRoot, { mode: 0o700 })
    for (const durablePath of DURABLE_PATHS) {
      const source = join(sourceRoot, durablePath)
      try {
        await lstat(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await copyDurableEntry(source, join(stagingRoot, durablePath), durablePath, options, files)
    }
    await writeLayoutMarker(stagingRoot, 'migrated', files)
    if (targetKind === 'empty-directory') {
      await rmdir(targetRoot)
      removedEmptyTarget = true
    }
    await rename(stagingRoot, targetRoot)
    return { sourceRoot, targetRoot, layoutVersion: LAYOUT_VERSION, files }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    if (removedEmptyTarget) await mkdir(targetRoot, { mode: 0o700 })
    throw error
  }
}
