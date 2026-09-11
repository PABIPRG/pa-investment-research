import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { appendFile, lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, basename, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  createBackupArchive,
  inspectBackupArchive,
  readableBackupFilename,
  validateDomainSnapshot,
  MAX_BACKUP_COMPRESSED_BYTES,
} from './backup-archive.ts'
import type {
  BackupCategory,
  BackupManifest,
  BackupReason,
  DomainSnapshot,
} from './backup-archive.ts'

const MAX_COMPRESSED_BYTES = MAX_BACKUP_COMPRESSED_BYTES
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000
const SETTINGS_VERSION = 1
const UPLOAD_CHUNK_BYTES = 256 * 1024
const MAX_ACTIVE_PREVIEWS = 2
const MAX_ACTIVE_DOWNLOADS = 2
const DOWNLOAD_TTL_MS = PREVIEW_TTL_MS
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type BackupBackend = 'trading-core' | 'market-watch'

/** Transactional operation names supported by each owned Python backend. */
export type BackupBackendOperation = 'export' | 'preview' | 'prepare' | 'reset' | 'commit' | 'rollback' | 'finalize'
/** User-selectable conflict policy applied per logical backup category. */
export type BackupConflictRule = 'keep_both' | 'keep_local' | 'use_import' | 'merge'

/** Host-only adapter that invokes one authenticated backend transfer operation. */
export interface BackupBackendRequest {
  (
    backend: 'trading-core' | 'market-watch',
    operation: BackupBackendOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>
}

interface BackupDomainPreview {
  currentRevision: string
  categories: Record<string, { added: number; conflicts: number; defaultRule: BackupConflictRule }>
}

/** Dependencies and stable application metadata required by {@link BackupService}. */
export interface BackupServiceOptions {
  dshHome: string
  appVersion: string
  request: BackupBackendRequest
  now?: () => Date
}

/** Client-safe metadata for one direct child of the configured backup directory. */
export interface BackupListItem {
  filename: string
  size: number
  modifiedAt: string
  status: 'ready' | 'damaged' | 'unsupported'
  manifest?: BackupManifest
  problem?: string
}

/** Validated, expiring import preview exposed to the settings UI. */
export interface BackupPreview {
  id: string
  filename: string
  manifest: BackupManifest
  domains: Record<string, BackupDomainPreview>
  expiresAt: string
}

interface PreviewEntry {
  readonly preview: BackupPreview
  readonly snapshots: Record<string, DomainSnapshot>
  readonly expiresAtMs: number
}

interface UploadEntry {
  readonly filename: string
  readonly declaredSize: number
  readonly path: string
  receivedSize: number
  touchedAtMs: number
  busy: boolean
}

interface DownloadEntry {
  readonly filename: string
  bytes: Uint8Array | undefined
  offset: number
  touchedAtMs: number
}

interface CoordinatorTransaction {
  schemaVersion: 1
  transactionId: string
  phase: 'preparing' | 'committing' | 'committed'
  targets: BackupBackend[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function domainPreview(value: unknown, backend: string): BackupDomainPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`领域 ${backend} 的导入预览格式无效`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.currentRevision !== 'string' || !record.currentRevision) {
    throw new Error(`领域 ${backend} 的导入预览缺少当前版本`)
  }
  const categoriesValue = record.categories
  if (!categoriesValue || typeof categoriesValue !== 'object' || Array.isArray(categoriesValue)) {
    throw new Error(`领域 ${backend} 的导入预览分类格式无效`)
  }
  const categories: BackupDomainPreview['categories'] = {}
  for (const [category, summaryValue] of Object.entries(categoriesValue)) {
    if (!summaryValue || typeof summaryValue !== 'object' || Array.isArray(summaryValue)) {
      throw new Error(`领域 ${backend} 的 ${category} 预览格式无效`)
    }
    const summary = summaryValue as Record<string, unknown>
    const { added, conflicts, defaultRule } = summary
    if (
      !Number.isSafeInteger(added) || Number(added) < 0
      || !Number.isSafeInteger(conflicts) || Number(conflicts) < 0
      || !['keep_both', 'keep_local', 'use_import', 'merge'].includes(String(defaultRule))
    ) {
      throw new Error(`领域 ${backend} 的 ${category} 预览摘要无效`)
    }
    categories[category] = {
      added: Number(added),
      conflicts: Number(conflicts),
      defaultRule: defaultRule as BackupConflictRule,
    }
  }
  return { currentRevision: record.currentRevision, categories }
}

function ensureFilename(filename: string): void {
  if (filename !== basename(filename) || !filename.endsWith('.pabackup') || filename.includes('\0')) {
    throw new Error('备份文件名无效')
  }
}

/** @internal Read exactly one opened file identity without permitting growth to widen allocation. */
export async function readStableDownloadSnapshot(
  handle: Pick<FileHandle, 'read' | 'stat'>,
  expected: Stats,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const opened = await handle.stat()
  signal?.throwIfAborted()
  if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
    throw new Error('所选备份在下载前发生变化')
  }
  if (opened.size > MAX_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
  const snapshot = Buffer.allocUnsafe(opened.size)
  let readOffset = 0
  while (readOffset < opened.size) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(snapshot, readOffset, opened.size - readOffset, readOffset)
    if (bytesRead === 0) break
    readOffset += bytesRead
  }
  const completed = await handle.stat()
  if (readOffset !== opened.size || completed.size !== opened.size) {
    throw new Error('所选备份在下载时发生变化')
  }
  return snapshot
}

function selectedForBackend(
  backend: 'trading-core' | 'market-watch',
  categories: readonly BackupCategory[],
): BackupCategory[] {
  if (backend === 'market-watch') return categories.includes('watchlist') ? ['watchlist'] : []
  return [...categories]
}

function rulesForSnapshot(
  snapshot: DomainSnapshot,
  rules: Partial<Record<BackupCategory, BackupConflictRule>>,
): Partial<Record<BackupCategory, BackupConflictRule>> {
  return Object.fromEntries(
    Object.keys(snapshot.categories)
      .filter(category => category in rules)
      .map(category => [category, rules[category as BackupCategory]]),
  )
}

/** Host-owned backup, import, reset, upload, and recovery coordinator. */
export class BackupService {
  private readonly dshHome: string
  private readonly appVersion: string
  private readonly request: BackupBackendRequest
  private readonly now: () => Date
  private readonly previews = new Map<string, PreviewEntry>()
  private readonly uploads = new Map<string, UploadEntry>()
  private readonly downloads = new Map<string, DownloadEntry>()
  private downloadCleanupTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: BackupServiceOptions) {
    this.dshHome = resolve(options.dshHome)
    this.appVersion = options.appVersion
    this.request = options.request
    this.now = options.now ?? (() => new Date())
  }

  private get settingsPath(): string {
    return join(this.dshHome, 'investment-research', 'backup-settings.json')
  }

  private get defaultDirectory(): string {
    return join(this.dshHome, 'investment-research', 'backups')
  }

  private get uploadDirectory(): string {
    return join(this.dshHome, 'investment-research', 'backup-uploads')
  }

  private get transactionDirectory(): string {
    return join(this.dshHome, 'investment-research', 'transfer-transactions')
  }

  private async directory(): Promise<string> {
    try {
      const value = JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown
      const directory = (value as Record<string, unknown> | undefined)?.directory
      if (
        value && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>).version === SETTINGS_VERSION
        && typeof directory === 'string'
        && isAbsolute(directory)
      ) {
        return resolve(directory)
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return this.defaultDirectory
  }

  /**
   * Read the configured backup directory and stable feature capabilities.
   * @returns User-visible configuration without internal temporary paths.
   */
  async describe(): Promise<{ directory: string; format: 'pabackup'; scheduledBackup: false }> {
    return { directory: await this.directory(), format: 'pabackup', scheduledBackup: false }
  }

  /**
   * Persist and initialize an absolute user-selected backup directory.
   * @param directory - Absolute local directory selected by the user.
   * @returns The normalized directory persisted by the service.
   */
  async setDirectory(directory: string): Promise<{ directory: string }> {
    if (!isAbsolute(directory)) throw new Error('备份位置必须是绝对路径')
    const normalized = resolve(directory)
    await mkdir(normalized, { recursive: true, mode: 0o700 })
    await writeFileAtomic(
      this.settingsPath,
      `${JSON.stringify({ version: SETTINGS_VERSION, directory: normalized }, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
    return { directory: normalized }
  }

  /**
   * Export selected categories and durably create a validated backup archive.
   * @param input - Selected categories and the manifest reason.
   * @returns The readable filename, local path, and validated manifest.
   */
  async create(input: {
    categories: BackupCategory[]
    reason: BackupReason
  }): Promise<{ filename: string; path: string; manifest: BackupManifest }> {
    await this.recoverPendingTransactions()
    const categories = [...new Set(input.categories)]
    if (!categories.length) throw new Error('至少选择一个备份分类')
    const createdAt = this.now()
    const snapshots: Record<string, DomainSnapshot> = {}
    for (const backend of ['trading-core', 'market-watch'] as const) {
      const selected = selectedForBackend(backend, categories)
      if (!selected.length) continue
      const snapshot = await this.request(backend, 'export', { categories: selected })
      validateDomainSnapshot(snapshot, backend)
      snapshots[backend] = snapshot
    }
    const archive = createBackupArchive({
      createdAt: createdAt.toISOString(),
      createdByAppVersion: this.appVersion,
      reason: input.reason,
      categories,
      snapshots,
    })
    const directory = await this.directory()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const desired = readableBackupFilename({
      reason: input.reason,
      categories,
      createdAt,
    })
    const filename = await this.availableFilename(directory, desired)
    const path = join(directory, filename)
    await writeFileAtomic(path, archive.bytes, { mode: 0o600, dirMode: 0o700 })
    try {
      inspectBackupArchive(await readFile(path))
    }
    catch (error) {
      await unlink(path).catch(() => undefined)
      throw new Error(`备份写入后校验失败：${errorMessage(error)}`)
    }
    return { filename, path, manifest: archive.manifest }
  }

  private async availableFilename(directory: string, desired: string): Promise<string> {
    const stem = desired.slice(0, -'.pabackup'.length)
    for (let index = 1; index < 10_000; index += 1) {
      const filename = index === 1 ? desired : `${stem}-${index}.pabackup`
      try {
        await lstat(join(directory, filename))
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return filename
        throw error
      }
    }
    throw new Error('无法生成唯一的备份文件名')
  }

  /**
   * Inspect every direct `.pabackup` file in the configured directory.
   * @returns Newest-first metadata including damaged and unsupported entries.
   */
  async list(): Promise<BackupListItem[]> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const names = (await readdir(directory)).filter(name => name.endsWith('.pabackup'))
    const items: BackupListItem[] = []
    for (const filename of names) {
      const path = join(directory, filename)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        items.push({
          filename,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          status: 'damaged',
          problem: '备份列表不支持符号链接',
        })
        continue
      }
      if (!info.isFile()) continue
      const base = { filename, size: info.size, modifiedAt: info.mtime.toISOString() }
      if (info.size > MAX_COMPRESSED_BYTES) {
        items.push({ ...base, status: 'damaged', problem: '备份文件超过 64 MiB 限制' })
        continue
      }
      try {
        const { manifest } = inspectBackupArchive(await readFile(path))
        items.push({ ...base, status: 'ready', manifest })
      }
      catch (error) {
        const problem = errorMessage(error)
        items.push({
          ...base,
          status: /更新版本/.test(problem) ? 'unsupported' : 'damaged',
          problem,
        })
      }
    }
    return items
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.filename.localeCompare(right.filename))
  }

  /**
   * Delete one explicit backup filename from the configured directory.
   * @param filename - Direct child filename selected and confirmed by the user.
   */
  async delete(filename: string): Promise<void> {
    ensureFilename(filename)
    const directory = await this.directory()
    await unlink(join(directory, filename))
  }

  /** Allocate an immutable, bounded browser download for one validated stored backup. */
  async beginDownload(filename: string, signal?: AbortSignal): Promise<{ id: string; filename: string; size: number; chunkSize: number }> {
    signal?.throwIfAborted()
    ensureFilename(filename)
    this.cleanupDownloads()
    if (this.downloads.size >= MAX_ACTIVE_DOWNLOADS) throw new Error('已有过多下载，请先完成或取消当前下载')
    // Reserve before the first await: concurrent starts cannot all pass the
    // capacity check and then over-allocate immutable archive snapshots.
    const id = randomUUID()
    const entry: DownloadEntry = {
      filename, bytes: undefined, offset: 0, touchedAtMs: this.now().getTime(),
    }
    this.downloads.set(id, entry)
    this.scheduleDownloadCleanup()
    try {
      const path = join(await this.directory(), filename)
      signal?.throwIfAborted()
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('所选备份不是可下载的普通文件')
      if (info.size > MAX_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
      const handle = await open(path, 'r')
      let bytes: Uint8Array
      try {
        bytes = await readStableDownloadSnapshot(handle, info, signal)
      }
      finally { await handle.close() }
      signal?.throwIfAborted()
      inspectBackupArchive(bytes)
      if (!this.downloads.has(id)) throw new Error('下载会话已失效，请重新下载')
      entry.bytes = bytes
      entry.touchedAtMs = this.now().getTime()
      this.scheduleDownloadCleanup()
      return { id, filename, size: bytes.byteLength, chunkSize: UPLOAD_CHUNK_BYTES }
    }
    catch (error) {
      this.deleteDownload(id)
      throw error
    }
  }

  /** Read one ordered chunk from a previously validated immutable download. */
  downloadChunk(input: { id: string; offset: number }, signal?: AbortSignal): { base64: string; nextOffset: number; done: boolean } {
    signal?.throwIfAborted()
    this.cleanupDownloads()
    const download = this.downloads.get(input.id)
    if (!download || download.bytes === undefined) throw new Error('下载会话已失效，请重新下载')
    if (!Number.isSafeInteger(input.offset) || input.offset !== download.offset) {
      this.deleteDownload(input.id)
      throw new Error('下载分块位置无效')
    }
    const nextOffset = Math.min(input.offset + UPLOAD_CHUNK_BYTES, download.bytes.byteLength)
    const base64 = Buffer.from(download.bytes.subarray(input.offset, nextOffset)).toString('base64')
    download.offset = nextOffset
    download.touchedAtMs = this.now().getTime()
    const done = nextOffset === download.bytes.byteLength
    if (done) this.deleteDownload(input.id)
    else this.scheduleDownloadCleanup()
    return { base64, nextOffset, done }
  }

  /** Release an incomplete browser download. */
  cancelDownload(id: string): void { this.deleteDownload(id) }

  /** Release every active transfer resource and stop the expiry timer. */
  dispose(): void {
    if (this.downloadCleanupTimer !== undefined) clearTimeout(this.downloadCleanupTimer)
    this.downloadCleanupTimer = undefined
    this.downloads.clear()
  }

  /**
   * Create an immutable import preview for a stored backup.
   * @param filename - Direct child filename selected from the backup list.
   * @returns Validated counts, conflicts, defaults, and an expiring preview id.
   */
  async previewStored(filename: string, signal?: AbortSignal): Promise<BackupPreview> {
    signal?.throwIfAborted()
    ensureFilename(filename)
    return this.previewFile(join(await this.directory(), filename), signal)
  }

  /**
   * Create an immutable import preview for a local backup path.
   * @param path - Exact local archive path selected by the Host.
   * @returns Validated counts, conflicts, defaults, and an expiring preview id.
   */
  async previewFile(path: string, signal?: AbortSignal): Promise<BackupPreview> {
    signal?.throwIfAborted()
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('不支持通过符号链接读取备份文件')
    if (!info.isFile()) throw new Error('所选路径不是备份文件')
    if (info.size > MAX_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
    return this.previewBytes(await readFile(path, { signal }), basename(path), signal)
  }

  /**
   * Create an immutable import preview from complete in-memory archive bytes.
   * @param bytes - Complete compressed archive bytes.
   * @param filename - User-visible source filename.
   * @returns Validated counts, conflicts, defaults, and an expiring preview id.
   */
  async previewBytes(bytes: Uint8Array, filename = '外部备份.pabackup', signal?: AbortSignal): Promise<BackupPreview> {
    signal?.throwIfAborted()
    await this.recoverPendingTransactions()
    signal?.throwIfAborted()
    if (bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
    const { manifest, snapshots } = inspectBackupArchive(bytes)
    this.cleanupPreviews()
    if (this.previews.size >= MAX_ACTIVE_PREVIEWS) {
      throw new Error('已有过多导入预览，请先完成或取消当前导入')
    }
    const domains: BackupPreview['domains'] = {}
    for (const [backend, snapshot] of Object.entries(snapshots)) {
      if (backend !== 'trading-core' && backend !== 'market-watch') continue
      if (Object.keys(snapshot.categories).length > 0) {
        domains[backend] = domainPreview(await this.request(backend, 'preview', { snapshot }, signal), backend)
        signal?.throwIfAborted()
      }
    }
    const id = randomUUID()
    const expiresAtMs = this.now().getTime() + PREVIEW_TTL_MS
    const preview: BackupPreview = {
      id,
      filename,
      manifest,
      domains,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    signal?.throwIfAborted()
    this.previews.set(id, { preview, snapshots, expiresAtMs })
    return preview
  }

  /**
   * Atomically apply an import preview while preserving its source archive.
   * @param previewId - Expiring preview id returned by a preview operation.
   * @param rules - User-selected category conflict rules.
   * @param backupBefore - Whether to create a blocking safety backup first.
   * @returns Applied status and logical categories committed across domains.
   */
  async importPreview(
    previewId: string,
    rules: Partial<Record<BackupCategory, BackupConflictRule>> = {},
    backupBefore = false,
  ): Promise<{ status: 'applied'; categories: BackupCategory[] }> {
    await this.recoverPendingTransactions()
    this.cleanupPreviews()
    const entry = this.previews.get(previewId)
    if (!entry) throw new Error('导入预览已失效，请重新选择备份')
    if (backupBefore) {
      await this.create({ categories: [...entry.preview.manifest.scope], reason: 'pre-import' })
    }
    const domainEntries = Object.entries(entry.snapshots)
      .filter((candidate): candidate is [BackupBackend, DomainSnapshot] => (
        (candidate[0] === 'trading-core' || candidate[0] === 'market-watch')
        && Object.keys(candidate[1].categories).length > 0
      ))
    await this.executeTransaction(domainEntries.map(([backend, snapshot]) => {
      const currentRevision = entry.preview.domains[backend]?.currentRevision
      if (!currentRevision) throw new Error(`领域 ${backend} 缺少导入版本摘要`)
      return {
        backend,
        operation: 'prepare' as const,
        input: {
          snapshot,
          expected_revision: currentRevision,
          rules: rulesForSnapshot(snapshot, rules),
        },
      }
    }))
    this.previews.delete(previewId)
    return { status: 'applied', categories: [...entry.preview.manifest.scope] }
  }

  /**
   * Atomically clear selected current-state categories without deleting backups.
   * @param input - Categories to clear and whether to create a safety backup first.
   * @returns Reset status and logical categories committed across domains.
   */
  async reset(input: {
    categories: BackupCategory[]
    backupBefore: boolean
  }): Promise<{ status: 'reset'; categories: BackupCategory[] }> {
    await this.recoverPendingTransactions()
    const categories = [...new Set(input.categories)]
    if (!categories.length) throw new Error('至少选择一个清空分类')
    if (input.backupBefore) await this.create({ categories, reason: 'pre-reset' })
    const targets: Array<{
      backend: 'trading-core' | 'market-watch'
      categories: BackupCategory[]
      snapshot: DomainSnapshot
    }> = []
    for (const backend of ['trading-core', 'market-watch'] as const) {
      const selected = selectedForBackend(backend, categories)
      if (!selected.length) continue
      targets.push({
        backend,
        categories: selected,
        snapshot: await this.exportSnapshot(backend, selected),
      })
    }
    await this.executeTransaction(targets.map(target => ({
      backend: target.backend,
      operation: 'reset' as const,
      input: {
        categories: target.categories,
        expected_revision: target.snapshot.revision,
      },
    })))
    return { status: 'reset', categories }
  }

  /**
   * Allocate a bounded temporary upload for one external archive.
   * @param input - Original filename and exact compressed byte size.
   * @returns An opaque upload id and maximum raw chunk size.
   */
  async beginUpload(input: { filename: string; size: number }, signal?: AbortSignal): Promise<{ id: string; chunkSize: number }> {
    signal?.throwIfAborted()
    await this.cleanupUploads()
    signal?.throwIfAborted()
    if (!input.filename.endsWith('.pabackup')) throw new Error('请选择 .pabackup 备份文件')
    if (!Number.isSafeInteger(input.size) || input.size <= 0) throw new Error('备份文件不能为空')
    if (input.size > MAX_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
    const id = randomUUID()
    const path = join(this.uploadDirectory, `${id}.part`)
    try {
      await mkdir(this.uploadDirectory, { recursive: true, mode: 0o700 })
      signal?.throwIfAborted()
      await writeFile(path, new Uint8Array(), { flag: 'wx', mode: 0o600, signal })
      signal?.throwIfAborted()
      this.uploads.set(id, {
        filename: basename(input.filename),
        declaredSize: input.size,
        path,
        receivedSize: 0,
        touchedAtMs: this.now().getTime(),
        busy: false,
      })
      return { id, chunkSize: UPLOAD_CHUNK_BYTES }
    }
    catch (error) {
      await unlink(path).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
      })
      throw error
    }
  }

  /**
   * Append one strictly ordered Base64 upload chunk.
   * @param input - Upload id, expected raw offset, and encoded bytes.
   * @returns The total raw bytes durably received.
   */
  async appendUploadChunk(input: { id: string; offset: number; base64: string }, signal?: AbortSignal): Promise<{ received: number }> {
    signal?.throwIfAborted()
    await this.cleanupUploads()
    signal?.throwIfAborted()
    const upload = this.uploads.get(input.id)
    if (!upload) throw new Error('上传会话已失效，请重新选择文件')
    if (upload.busy) throw new Error('上传会话正忙，请稍后重试')
    if (input.offset !== upload.receivedSize) throw new Error('上传分块顺序无效')
    if (input.base64.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 4) {
      throw new Error('上传分块超过 256 KiB 限制')
    }
    const bytes = Uint8Array.from(Buffer.from(input.base64, 'base64'))
    if (!bytes.byteLength) throw new Error('上传分块不能为空')
    if (bytes.byteLength > UPLOAD_CHUNK_BYTES) throw new Error('上传分块超过 256 KiB 限制')
    if (upload.receivedSize + bytes.byteLength > upload.declaredSize) throw new Error('上传内容超过声明大小')
    upload.busy = true
    try {
      await appendFile(upload.path, bytes)
      signal?.throwIfAborted()
      upload.receivedSize += bytes.byteLength
      upload.touchedAtMs = this.now().getTime()
      return { received: upload.receivedSize }
    }
    finally {
      upload.busy = false
    }
  }

  /**
   * Validate a complete upload and convert it into an import preview.
   * @param id - Opaque upload id returned by {@link beginUpload}.
   * @returns Validated counts, conflicts, defaults, and an expiring preview id.
   */
  async inspectUpload(id: string, signal?: AbortSignal): Promise<BackupPreview> {
    signal?.throwIfAborted()
    await this.cleanupUploads()
    signal?.throwIfAborted()
    const upload = this.uploads.get(id)
    if (!upload) throw new Error('上传会话已失效，请重新选择文件')
    if (upload.busy) throw new Error('上传会话正忙，请稍后重试')
    if (upload.receivedSize !== upload.declaredSize) throw new Error('备份文件尚未上传完整')
    this.uploads.delete(id)
    try {
      return await this.previewBytes(await readFile(upload.path, { signal }), upload.filename, signal)
    }
    finally {
      await unlink(upload.path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  /**
   * Release one incomplete upload and remove its temporary file.
   * @param id - Opaque upload id returned by {@link beginUpload}.
   */
  async cancelUpload(id: string): Promise<void> {
    const upload = this.uploads.get(id)
    if (!upload) return
    this.uploads.delete(id)
    await unlink(upload.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  /**
   * Release one in-memory preview without mutating its source archive.
   * @param previewId - Expiring preview id returned by a preview operation.
   */
  cancelPreview(previewId: string): void {
    this.previews.delete(previewId)
  }

  private cleanupPreviews(): void {
    const now = this.now().getTime()
    for (const [id, entry] of this.previews) {
      if (entry.expiresAtMs <= now) this.previews.delete(id)
    }
  }

  private cleanupDownloads(): void {
    const threshold = this.now().getTime() - DOWNLOAD_TTL_MS
    for (const [id, download] of this.downloads) {
      if (download.touchedAtMs <= threshold) this.downloads.delete(id)
    }
    this.scheduleDownloadCleanup()
  }

  private deleteDownload(id: string): void {
    this.downloads.delete(id)
    this.scheduleDownloadCleanup()
  }

  private scheduleDownloadCleanup(): void {
    if (this.downloadCleanupTimer !== undefined) clearTimeout(this.downloadCleanupTimer)
    this.downloadCleanupTimer = undefined
    if (this.downloads.size === 0) return
    const expiresAt = Math.min(...[...this.downloads.values()].map(entry => entry.touchedAtMs + DOWNLOAD_TTL_MS))
    const delay = Math.max(1, expiresAt - this.now().getTime())
    this.downloadCleanupTimer = setTimeout(() => {
      this.downloadCleanupTimer = undefined
      this.cleanupDownloads()
    }, delay)
    this.downloadCleanupTimer.unref()
  }

  private async cleanupUploads(): Promise<void> {
    const threshold = this.now().getTime() - PREVIEW_TTL_MS
    const expiredPaths: string[] = []
    for (const [id, upload] of this.uploads) {
      if (upload.touchedAtMs <= threshold && !upload.busy) {
        this.uploads.delete(id)
        expiredPaths.push(upload.path)
      }
    }
    await Promise.all(expiredPaths.map(path => unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })))
    await mkdir(this.uploadDirectory, { recursive: true, mode: 0o700 })
    const activePaths = new Set([...this.uploads.values()].map(upload => upload.path))
    for (const name of await readdir(this.uploadDirectory)) {
      if (!name.endsWith('.part')) continue
      const path = join(this.uploadDirectory, name)
      if (activePaths.has(path)) continue
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > threshold) continue
      await unlink(path)
    }
  }

  private coordinatorPath(transactionId: string): string {
    return join(this.transactionDirectory, `${transactionId}.json`)
  }

  private async writeCoordinator(transaction: CoordinatorTransaction): Promise<void> {
    await writeFileAtomic(
      this.coordinatorPath(transaction.transactionId),
      `${JSON.stringify(transaction, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
  }

  private async removeCoordinator(transactionId: string): Promise<void> {
    await unlink(this.coordinatorPath(transactionId)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  /** Recover unfinished durable transactions using the persisted Host decision. */
  async recoverPendingTransactions(): Promise<void> {
    await mkdir(this.transactionDirectory, { recursive: true, mode: 0o700 })
    const names = (await readdir(this.transactionDirectory)).filter(name => name.endsWith('.json'))
    for (const name of names) {
      const value: unknown = JSON.parse(await readFile(join(this.transactionDirectory, name), 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`数据事务协调日志无效：${name}`)
      }
      const record = value as Record<string, unknown>
      const transactionId = record.transactionId
      const phase = record.phase
      const targets = record.targets
      if (
        record.schemaVersion !== 1
        || typeof transactionId !== 'string'
        || !TRANSACTION_ID_PATTERN.test(transactionId)
        || name !== `${transactionId}.json`
        || !['preparing', 'committing', 'committed'].includes(String(phase))
        || !Array.isArray(targets)
        || !targets.every(target => target === 'trading-core' || target === 'market-watch')
        || new Set(targets).size !== targets.length
      ) {
        throw new Error(`数据事务协调日志无效：${name}`)
      }
      const verifiedTargets: BackupBackend[] = []
      for (const target of targets as unknown[]) {
        if (target === 'trading-core' || target === 'market-watch') verifiedTargets.push(target)
      }
      const operation = phase === 'committed' ? 'finalize' : 'rollback'
      for (const backend of [...verifiedTargets].reverse()) {
        await this.request(backend, operation, { transaction_id: transactionId })
      }
      if (phase !== 'committed') {
        for (const backend of verifiedTargets) {
          await this.request(backend, 'finalize', { transaction_id: transactionId })
        }
      }
      await this.removeCoordinator(transactionId)
    }
  }

  private async executeTransaction(targets: Array<{
    backend: BackupBackend
    operation: 'prepare' | 'reset'
    input: Record<string, unknown>
  }>): Promise<void> {
    const transactionId = randomUUID()
    const coordinator: CoordinatorTransaction = {
      schemaVersion: 1,
      transactionId,
      phase: 'preparing',
      targets: targets.map(target => target.backend),
    }
    await this.writeCoordinator(coordinator)
    let committedDecision = false
    try {
      for (const target of targets) {
        await this.request(target.backend, target.operation, {
          ...target.input,
          transaction_id: transactionId,
        })
      }
      coordinator.phase = 'committing'
      await this.writeCoordinator(coordinator)
      for (const target of targets) {
        await this.request(target.backend, 'commit', { transaction_id: transactionId })
      }
      coordinator.phase = 'committed'
      await this.writeCoordinator(coordinator)
      committedDecision = true
      for (const target of targets) {
        await this.request(target.backend, 'finalize', { transaction_id: transactionId })
      }
      await this.removeCoordinator(transactionId)
    }
    catch (error) {
      if (committedDecision) {
        throw new Error(`数据已提交，但事务清理尚未完成：${errorMessage(error)}`)
      }
      const rollbackErrors: string[] = []
      for (const target of [...targets].reverse()) {
        try {
          await this.request(target.backend, 'rollback', { transaction_id: transactionId })
          await this.request(target.backend, 'finalize', { transaction_id: transactionId })
        }
        catch (rollbackError) {
          rollbackErrors.push(`${target.backend}: ${errorMessage(rollbackError)}`)
        }
      }
      if (!rollbackErrors.length) await this.removeCoordinator(transactionId)
      if (rollbackErrors.length) {
        throw new Error(`操作失败，且部分持久事务回滚失败：${errorMessage(error)}；${rollbackErrors.join('；')}`)
      }
      throw error
    }
  }

  private async exportSnapshot(
    backend: 'trading-core' | 'market-watch',
    categories: BackupCategory[],
  ): Promise<DomainSnapshot> {
    const snapshot = await this.request(backend, 'export', { categories })
    validateDomainSnapshot(snapshot, backend)
    return snapshot
  }
}
