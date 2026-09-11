import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalizeWatchPath, resolveDshInstanceLayout } from '@deepseek-ai/dsh-home-paths'
import type { DshInstanceLayout } from '@deepseek-ai/dsh-home-paths'

const LAYOUT_VERSION = 1
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const SQLITE_HEADER = Buffer.from('SQLite format 3\0')
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const BACKUP_SETTINGS_PATH = join('investment-research', 'backup-settings.json')
const HOST_SNAPSHOT_PATHS = new Set(['sessions', join('attachments', 'v1')])
const DURABLE_PATHS = [
  'settings.yaml',
  'cordis.patch.yml',
  'profiles',
  'sessions',
  join('attachments', 'v1'),
  'storages',
  BACKUP_SETTINGS_PATH,
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

/** One file found by the zero-write migration planner. */
export interface PlannedInstanceFile {
  readonly relativePath: string
  readonly bytes: number
  readonly strategy: 'copy' | 'rewrite-backup-settings' | 'sqlite-backup'
}

/** A deliberately omitted rebuildable or live-runtime path. */
export interface ExcludedInstanceEntry {
  readonly relativePath: string
  readonly reason: 'managed profile dependency' | 'live SQLite sidecar'
}

/** A condition that prevents the inspected migration from running safely. */
export interface InstanceMigrationRejection {
  readonly relativePath?: string
  readonly reason: string
}

/** Read-only inventory and safety decision for one proposed migration. */
export interface DshInstanceMigrationPlan {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly layoutVersion: typeof LAYOUT_VERSION
  readonly mode: 'quiesced' | 'online'
  readonly publicationStrategy: 'target-internal-transaction'
  readonly files: readonly PlannedInstanceFile[]
  readonly excluded: readonly ExcludedInstanceEntry[]
  readonly rejections: readonly InstanceMigrationRejection[]
  readonly totalBytes: number
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
  /** Test and audit hook invoked before each top-level target entry is published. */
  readonly beforePublish?: (relativePath: string) => Promise<void> | void
}

/** Result of one transactionally published migration. */
export interface MigrateDshInstanceResult {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly layoutVersion: typeof LAYOUT_VERSION
  readonly files: readonly MigratedInstanceFile[]
  readonly excluded: readonly ExcludedInstanceEntry[]
}

interface MigrationRoots {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly physicalSourceRoot: string
  readonly physicalTargetRoot: string
  readonly sourceDevice: number
  readonly sourceInode: number
  readonly targetKind: 'missing' | 'empty-directory' | 'non-empty'
}

interface MigrationInspection {
  readonly plan: DshInstanceMigrationPlan
  readonly roots: MigrationRoots
  readonly presentDurablePaths: ReadonlySet<string>
}

interface DirectoryIdentity {
  readonly device: number
  readonly inode: number
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

function assertAbsoluteRoots(sourceRoot: string, targetRoot: string): void {
  if (!isAbsolute(sourceRoot) || !isAbsolute(targetRoot)) {
    throw new Error('instance migration sourceRoot and targetRoot must be absolute')
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const suffix = relative(parent, candidate)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function rootsAreSeparate(source: string, target: string): boolean {
  return !containsPath(source, target) && !containsPath(target, source)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function isManagedProfileDependency(relativePath: string): boolean {
  const parts = relativePath.split(sep)
  return parts[0] === 'profiles' && parts.at(-1) === 'node_modules'
}

function isSqliteSidecar(path: string): boolean {
  const lower = path.toLowerCase()
  return SQLITE_SIDECAR_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

async function hasSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER)
  } finally {
    await handle.close()
  }
}

async function isSqlite(path: string): Promise<boolean> {
  return SQLITE_EXTENSIONS.has(extname(path).toLowerCase()) || await hasSqliteHeader(path)
}

async function sourceLayoutRejection(root: string): Promise<InstanceMigrationRejection | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(root, '.dsh-instance.json'), 'utf8')) as { schemaVersion?: unknown }
    if (parsed.schemaVersion !== LAYOUT_VERSION) {
      return { reason: `unsupported source instance layout version: ${String(parsed.schemaVersion)}` }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return { reason: 'source instance layout marker is invalid' }
    throw error
  }
  return undefined
}

async function backupSettingsRewrite(
  sourcePath: string,
  roots: MigrationRoots,
): Promise<Buffer | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const directory = (parsed as Record<string, unknown>).directory
  if (typeof directory !== 'string' || !isAbsolute(directory)) return undefined
  const physicalDirectory = await canonicalizeWatchPath(directory)
  if (!containsPath(roots.physicalSourceRoot, physicalDirectory)) return undefined
  const rebased = join(roots.targetRoot, relative(roots.physicalSourceRoot, physicalDirectory))
  return Buffer.from(`${JSON.stringify({ ...parsed, directory: rebased }, null, 2)}\n`)
}

async function inspectEntry(
  sourcePath: string,
  relativePath: string,
  options: MigrateDshInstanceOptions,
  roots: MigrationRoots,
  files: PlannedInstanceFile[],
  excluded: ExcludedInstanceEntry[],
  rejections: InstanceMigrationRejection[],
): Promise<void> {
  if (isManagedProfileDependency(relativePath)) {
    excluded.push({ relativePath, reason: 'managed profile dependency' })
    return
  }
  const info = await lstat(sourcePath)
  if (info.isSymbolicLink()) {
    rejections.push({ relativePath, reason: `instance migration refuses symbolic link: ${relativePath}` })
    return
  }
  if (info.isDirectory()) {
    const children = (await readdir(sourcePath)).sort()
    if (options.mode === 'online' && HOST_SNAPSHOT_PATHS.has(relativePath) && children.length > 0) {
      rejections.push({
        relativePath,
        reason: `online migration requires a common Host snapshot for ${relativePath}`,
      })
      return
    }
    for (const child of children) {
      await inspectEntry(
        join(sourcePath, child),
        join(relativePath, child),
        options,
        roots,
        files,
        excluded,
        rejections,
      )
    }
    return
  }
  if (!info.isFile()) {
    rejections.push({ relativePath, reason: `instance migration refuses special file: ${relativePath}` })
    return
  }
  if (options.mode === 'online' && isSqliteSidecar(sourcePath)) {
    excluded.push({ relativePath, reason: 'live SQLite sidecar' })
    return
  }
  const sqlite = options.mode === 'online' && await isSqlite(sourcePath)
  const rewrite = relativePath === BACKUP_SETTINGS_PATH
    ? await backupSettingsRewrite(sourcePath, roots)
    : undefined
  const strategy = sqlite ? 'sqlite-backup' : rewrite === undefined ? 'copy' : 'rewrite-backup-settings'
  if (sqlite && options.backupSqlite === undefined) {
    rejections.push({
      relativePath,
      reason: `online SQLite migration requires a consistency backup: ${relativePath}`,
    })
  }
  files.push({ relativePath, bytes: rewrite?.byteLength ?? info.size, strategy })
}

async function inspectMigration(options: MigrateDshInstanceOptions): Promise<MigrationInspection> {
  assertAbsoluteRoots(options.sourceRoot, options.targetRoot)
  const sourceRoot = resolve(options.sourceRoot)
  const targetRoot = resolve(options.targetRoot)
  const sourceInfo = await lstat(sourceRoot)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error('instance migration source must be a real directory')
  }
  const [physicalSourceRoot, physicalTargetRoot, targetKind] = await Promise.all([
    realpath(sourceRoot),
    canonicalizeWatchPath(targetRoot),
    pathKind(targetRoot),
  ])
  const roots: MigrationRoots = {
    sourceRoot,
    targetRoot,
    physicalSourceRoot,
    physicalTargetRoot,
    sourceDevice: sourceInfo.dev,
    sourceInode: sourceInfo.ino,
    targetKind,
  }
  const files: PlannedInstanceFile[] = []
  const excluded: ExcludedInstanceEntry[] = []
  const rejections: InstanceMigrationRejection[] = []
  const presentDurablePaths = new Set<string>()
  if (!rootsAreSeparate(physicalSourceRoot, physicalTargetRoot)) {
    rejections.push({ reason: 'source and target physical roots must be separate trees' })
  }
  if (targetKind === 'non-empty') rejections.push({ reason: 'instance migration target must be empty' })
  const versionRejection = await sourceLayoutRejection(sourceRoot)
  if (versionRejection !== undefined) rejections.push(versionRejection)
  for (const durablePath of DURABLE_PATHS) {
    const sourcePath = join(sourceRoot, durablePath)
    try {
      await lstat(sourcePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    presentDurablePaths.add(durablePath)
    await inspectEntry(sourcePath, durablePath, options, roots, files, excluded, rejections)
  }
  return {
    roots,
    presentDurablePaths,
    plan: {
      sourceRoot,
      targetRoot,
      layoutVersion: LAYOUT_VERSION,
      mode: options.mode,
      publicationStrategy: 'target-internal-transaction',
      files,
      excluded,
      rejections,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    },
  }
}

function rejectionError(plan: DshInstanceMigrationPlan): Error {
  const details = plan.rejections
    .map(rejection => `${rejection.relativePath === undefined ? '' : `${rejection.relativePath}: `}${rejection.reason}`)
    .join('; ')
  return new Error(`instance migration rejected: ${details}`)
}

function planFingerprint(plan: DshInstanceMigrationPlan): string {
  return JSON.stringify({ files: plan.files, excluded: plan.excluded, rejections: plan.rejections })
}

function assertCopiedInventory(plan: DshInstanceMigrationPlan, files: readonly MigratedInstanceFile[]): void {
  const plannedPaths = plan.files.map(file => file.relativePath).sort()
  const copiedPaths = files.map(file => file.relativePath).sort()
  if (JSON.stringify(plannedPaths) !== JSON.stringify(copiedPaths)) {
    throw new Error('instance migration source inventory changed during copy')
  }
}

async function copyDurableEntry(
  source: string,
  destination: string,
  relativePath: string,
  options: MigrateDshInstanceOptions,
  roots: MigrationRoots,
  files: MigratedInstanceFile[],
): Promise<void> {
  if (isManagedProfileDependency(relativePath)) return
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error(`instance migration refuses symbolic link: ${relativePath}`)
  if (info.isDirectory()) {
    const children = (await readdir(source)).sort()
    if (options.mode === 'online' && HOST_SNAPSHOT_PATHS.has(relativePath) && children.length > 0) {
      throw new Error(`online migration requires a common Host snapshot for ${relativePath}`)
    }
    await mkdir(destination, { recursive: true, mode: 0o700 })
    for (const child of children) {
      await copyDurableEntry(
        join(source, child),
        join(destination, child),
        join(relativePath, child),
        options,
        roots,
        files,
      )
    }
    return
  }
  if (!info.isFile()) throw new Error(`instance migration refuses special file: ${relativePath}`)
  if (options.mode === 'online' && isSqliteSidecar(source)) return
  await options.beforeCopy?.(relativePath)
  await assertSourceIdentity(roots)
  const confirmedSource = await lstat(source)
  if (
    !confirmedSource.isFile()
    || confirmedSource.isSymbolicLink()
    || confirmedSource.dev !== info.dev
    || confirmedSource.ino !== info.ino
  ) {
    throw new Error(`instance migration source changed during copy: ${relativePath}`)
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const physicalDestinationParent = await realpath(dirname(destination))
  if (
    !containsPath(roots.physicalTargetRoot, physicalDestinationParent)
    || !rootsAreSeparate(roots.physicalSourceRoot, physicalDestinationParent)
  ) {
    throw new Error(`instance migration target escaped during copy: ${relativePath}`)
  }
  const sqlite = options.mode === 'online' && await isSqlite(source)
  const rewrite = relativePath === BACKUP_SETTINGS_PATH
    ? await backupSettingsRewrite(source, roots)
    : undefined
  if (sqlite) {
    if (options.backupSqlite === undefined) {
      throw new Error(`online SQLite migration requires a consistency backup: ${relativePath}`)
    }
    await options.backupSqlite(source, destination)
  } else if (rewrite !== undefined) {
    await writeFile(destination, rewrite)
  } else {
    await copyFile(source, destination)
  }
  const copied = await lstat(destination)
  if (!copied.isFile() || copied.isSymbolicLink()) {
    throw new Error(`instance migration produced an invalid target file: ${relativePath}`)
  }
  await chmod(destination, info.mode & 0o777)
  const targetHash = await sha256(destination)
  if (!sqlite && rewrite === undefined) {
    const sourceHash = await sha256(source)
    if (sourceHash !== targetHash || info.size !== copied.size) {
      throw new Error(`instance migration checksum verification failed: ${relativePath}`)
    }
  }
  files.push({ relativePath, bytes: copied.size, sha256: targetHash })
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

async function writeTransactionJournal(stagingRoot: string, published: readonly string[]): Promise<void> {
  const temporary = join(stagingRoot, 'transaction.json.tmp')
  const journal = join(stagingRoot, 'transaction.json')
  await writeFile(temporary, `${JSON.stringify({ version: 1, published }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, journal)
}

async function revalidateRoots(inspection: MigrationInspection): Promise<DirectoryIdentity> {
  const { roots } = inspection
  const [sourceInfo, physicalSourceRoot, physicalTargetRoot] = await Promise.all([
    lstat(roots.sourceRoot),
    realpath(roots.sourceRoot),
    realpath(roots.targetRoot),
  ])
  if (
    sourceInfo.dev !== roots.sourceDevice
    || sourceInfo.ino !== roots.sourceInode
    || physicalSourceRoot !== roots.physicalSourceRoot
    || physicalTargetRoot !== roots.physicalTargetRoot
    || !rootsAreSeparate(physicalSourceRoot, physicalTargetRoot)
  ) {
    throw new Error('instance migration physical roots changed during validation')
  }
  const targetInfo = await lstat(roots.targetRoot)
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new Error('instance migration target must be a real directory')
  }
  return { device: targetInfo.dev, inode: targetInfo.ino }
}

async function assertTargetIdentity(roots: MigrationRoots, identity: DirectoryIdentity): Promise<void> {
  const [info, physicalTargetRoot] = await Promise.all([lstat(roots.targetRoot), realpath(roots.targetRoot)])
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.dev !== identity.device
    || info.ino !== identity.inode
    || physicalTargetRoot !== roots.physicalTargetRoot
  ) {
    throw new Error('instance migration target root changed during publication')
  }
}

async function assertSourceIdentity(roots: MigrationRoots): Promise<void> {
  const [info, physicalSourceRoot] = await Promise.all([lstat(roots.sourceRoot), realpath(roots.sourceRoot)])
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.dev !== roots.sourceDevice
    || info.ino !== roots.sourceInode
    || physicalSourceRoot !== roots.physicalSourceRoot
  ) {
    throw new Error('instance migration source root changed during copy')
  }
}

/**
 * Inspect a proposed migration without creating, chmodding, copying, or publishing anything.
 * @param options - source, target, quiescence, and SQLite backup policy.
 * @returns files, exclusions, byte count, publication policy, and blocking rejections.
 */
export async function dryRunDshInstanceMigration(
  options: MigrateDshInstanceOptions,
): Promise<DshInstanceMigrationPlan> {
  return (await inspectMigration(options)).plan
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
  await mkdir(layout.root, { recursive: true, mode: 0o700 })
  await chmod(layout.root, 0o700)
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
 * Copy the explicit durable inventory into a target-internal staging directory,
 * publish top-level entries transactionally, and write the instance marker last.
 * The source is never changed and an existing target directory is never replaced.
 * @param options - source, target, quiescence, and SQLite backup policy.
 * @returns the verified copied-file manifest and deliberate exclusions.
 */
export async function migrateDshInstance(options: MigrateDshInstanceOptions): Promise<MigrateDshInstanceResult> {
  let inspection = await inspectMigration(options)
  if (inspection.plan.rejections.length > 0) throw rejectionError(inspection.plan)
  const { roots } = inspection
  let createdTarget = false
  let stagingRoot: string | undefined
  const published: string[] = []
  try {
    if (roots.targetKind === 'missing') {
      await mkdir(roots.targetRoot, { recursive: true, mode: 0o700 })
      createdTarget = true
    }
    await chmod(roots.targetRoot, 0o700)
    const targetIdentity = await revalidateRoots(inspection)
    const confirmed = await inspectMigration(options)
    if (confirmed.plan.rejections.length > 0) throw rejectionError(confirmed.plan)
    if (planFingerprint(inspection.plan) !== planFingerprint(confirmed.plan)) {
      throw new Error('instance migration source changed after dry-run inspection')
    }
    inspection = confirmed
    stagingRoot = join(roots.targetRoot, `.dsh-migration-${randomUUID()}`)
    const payloadRoot = join(stagingRoot, 'payload')
    await mkdir(payloadRoot, { recursive: true, mode: 0o700 })
    const physicalStagingRoot = await realpath(stagingRoot)
    if (
      !containsPath(roots.physicalTargetRoot, physicalStagingRoot)
      || !rootsAreSeparate(roots.physicalSourceRoot, physicalStagingRoot)
    ) {
      throw new Error('instance migration staging directory escaped the physical target root')
    }
    const targetEntries = await readdir(roots.targetRoot)
    if (targetEntries.length !== 1 || targetEntries[0] !== basename(stagingRoot)) {
      throw new Error('instance migration target changed after validation')
    }
    const files: MigratedInstanceFile[] = []
    for (const durablePath of inspection.presentDurablePaths) {
      await copyDurableEntry(
        join(roots.sourceRoot, durablePath),
        join(payloadRoot, durablePath),
        durablePath,
        options,
        roots,
        files,
      )
    }
    assertCopiedInventory(inspection.plan, files)
    await writeLayoutMarker(payloadRoot, 'migrated', files)
    await writeTransactionJournal(stagingRoot, published)
    const entries = (await readdir(payloadRoot)).sort((left, right) => {
      if (left === '.dsh-instance.json') return 1
      if (right === '.dsh-instance.json') return -1
      return left.localeCompare(right)
    })
    for (const entry of entries) {
      await assertTargetIdentity(roots, targetIdentity)
      await options.beforePublish?.(entry)
      await assertTargetIdentity(roots, targetIdentity)
      await rename(join(payloadRoot, entry), join(roots.targetRoot, entry))
      published.push(entry)
      await writeTransactionJournal(stagingRoot, published)
    }
    await rm(stagingRoot, { recursive: true })
    return {
      sourceRoot: roots.sourceRoot,
      targetRoot: roots.targetRoot,
      layoutVersion: LAYOUT_VERSION,
      files,
      excluded: inspection.plan.excluded,
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    if (stagingRoot !== undefined) {
      const payloadRoot = join(stagingRoot, 'payload')
      for (const entry of [...published].reverse()) {
        try {
          await rename(join(roots.targetRoot, entry), join(payloadRoot, entry))
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length === 0) {
        try {
          await rm(stagingRoot, { recursive: true, force: true })
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    if (createdTarget && rollbackErrors.length === 0) {
      try {
        await rmdir(roots.targetRoot)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'instance migration failed and rollback was incomplete')
    }
    throw error
  }
}
