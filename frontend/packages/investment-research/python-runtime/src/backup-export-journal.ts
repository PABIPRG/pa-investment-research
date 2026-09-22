import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { inspectBackupArchive, MAX_BACKUP_COMPRESSED_BYTES } from './backup-archive.ts'
import type { BackupCategory, BackupReason } from './backup-archive.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CATEGORIES = ['holdings', 'strategies', 'watchlist', 'research', 'preferences', 'notifications']

interface ExportReceipt {
  schemaVersion: 1
  operationId: string
  phase: 'preparing' | 'verified'
  startedAt: string
  verifiedAt?: string
  reason: BackupReason
  categories: BackupCategory[]
  archivePath: string
  stagingPath: string
  fileDevice: number
  fileInode: number
  size: number
  sha256: string
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return // Windows has no directory fsync; retain file fsync + no-clobber publication.
  const handle = await open(path, 'r')
  try { await handle.sync() }
  finally { await handle.close() }
}

async function ensureDirectory(path: string): Promise<void> {
  const first = await mkdir(path, { recursive: true, mode: 0o700 })
  if (first === undefined) return
  for (let current = path; ; current = dirname(current)) {
    await syncDirectory(current)
    if (current === dirname(first)) break
  }
}

async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  }
  finally { await handle.close() }
  try {
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  }
  finally { await unlink(temporary).catch(() => undefined) }
}

async function boundedRead(path: string, limit: number, receipt?: ExportReceipt): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.size < 1 || before.size > limit) throw new Error('导出恢复文件无效')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || (receipt && (opened.dev !== receipt.fileDevice || opened.ino !== receipt.fileInode || opened.size !== receipt.size))) {
      throw new Error('导出恢复文件身份不符')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error('导出恢复文件不完整')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('导出恢复文件读取时发生变化')
    }
    if (receipt && createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw new Error('导出恢复文件校验失败')
    return bytes
  }
  finally { await handle.close() }
}

function parseReceipt(bytes: Buffer, name: string): ExportReceipt {
  const value: ExportReceipt = JSON.parse(bytes.toString('utf8'))
  if (!value || value.schemaVersion !== 1 || !UUID.test(value.operationId) || name !== `${value.operationId}.json`
    || !['preparing', 'verified'].includes(value.phase)
    || !['manual', 'pre-import', 'pre-reset'].includes(value.reason)
    || !Array.isArray(value.categories) || !value.categories.length || new Set(value.categories).size !== value.categories.length
    || !value.categories.every(category => CATEGORIES.includes(category))
    || !Number.isFinite(Date.parse(value.startedAt))
    || (value.phase === 'verified' && (!value.verifiedAt || !Number.isFinite(Date.parse(value.verifiedAt)) || Date.parse(value.verifiedAt) < Date.parse(value.startedAt)))
    || typeof value.archivePath !== 'string' || !isAbsolute(value.archivePath) || !value.archivePath.endsWith('.pabackup')
    || value.stagingPath !== join(dirname(value.archivePath), `.pab-export-${value.operationId}.part`)
    || !Number.isSafeInteger(value.fileDevice) || !Number.isSafeInteger(value.fileInode)
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_BACKUP_COMPRESSED_BYTES
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error('导出恢复回执无效')
  return value
}

/** Private durable outbox owned by BackupService; public reads never enter this coordinator. */
export class BackupExportJournal {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly now: () => Date,
    private readonly signal: AbortSignal,
    private readonly deliver: (operationId: string) => Promise<unknown>,
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { this.signal.throwIfAborted(); return operation() })
    this.queue = result.catch(() => undefined)
    return result
  }

  /** Wait for queued file work after the owner's cancellation signal has been aborted. */
  async drain(): Promise<void> { await this.queue }

  private async write(receipt: ExportReceipt): Promise<void> {
    await ensureDirectory(this.directory)
    await durableWrite(join(this.directory, `${receipt.operationId}.json`), Buffer.from(JSON.stringify(receipt)))
  }

  private async verifyAndPublish(receipt: ExportReceipt): Promise<void> {
    const bytes = await boundedRead(receipt.stagingPath, MAX_BACKUP_COMPRESSED_BYTES, receipt)
    inspectBackupArchive(bytes)
    const desired = receipt.archivePath
    const stem = desired.slice(0, -'.pabackup'.length)
    for (let index = 1; index < 10_000; index += 1) {
      this.signal.throwIfAborted()
      receipt.archivePath = index === 1 ? desired : `${stem}-${index}.pabackup`
      await this.write(receipt) // Persist the target before publishing, including collision retries.
      try { await link(receipt.stagingPath, receipt.archivePath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await lstat(receipt.archivePath)
        if (!existing.isFile() || existing.dev !== receipt.fileDevice || existing.ino !== receipt.fileInode) continue
      }
      await syncDirectory(dirname(receipt.archivePath))
      inspectBackupArchive(await boundedRead(receipt.archivePath, MAX_BACKUP_COMPRESSED_BYTES, receipt))
      receipt.phase = 'verified'
      receipt.verifiedAt = this.now().toISOString()
      if (Date.parse(receipt.verifiedAt) < Date.parse(receipt.startedAt)) throw new Error('导出校验时钟早于开始时间')
      await this.write(receipt)
      return
    }
    throw new Error('无法生成唯一的备份文件名')
  }

  private async acknowledge(receipt: ExportReceipt): Promise<void> {
    // Verified is historical proof; deleting/moving a backup later does not erase the operation.
    const staging = await lstat(receipt.stagingPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (staging?.isFile() && staging.dev === receipt.fileDevice && staging.ino === receipt.fileInode) {
      await unlink(receipt.stagingPath)
      await syncDirectory(dirname(receipt.stagingPath))
    }
    if (receipt.categories.includes('holdings')) {
      this.signal.throwIfAborted()
      const response = await this.deliver(receipt.operationId) as Record<string, unknown> | null
      if (!response || response.status !== 'recorded' || response.operation_id !== receipt.operationId) {
        throw new Error('导出留痕未获确认')
      }
    }
    await unlink(join(this.directory, `${receipt.operationId}.json`))
    await syncDirectory(this.directory)
  }

  /** Resume fixed original bytes, then retry the same verified identity until acknowledged. */
  recover(): Promise<void> {
    return this.serial(async () => {
      const names = await readdir(this.directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      let failure: unknown
      for (const name of names.filter(name => name.endsWith('.json')).sort()) {
        try {
          const receipt = parseReceipt(await boundedRead(join(this.directory, name), 16 * 1024), name)
          if (receipt.phase === 'preparing') await this.verifyAndPublish(receipt)
          await this.acknowledge(receipt)
        }
        catch (error) { failure ??= error }
      }
      if (failure) throw failure
    })
  }

  /** Persist immutable archive bytes without overwriting an existing backup. */
  create(input: { path: string; bytes: Uint8Array; startedAt: string; reason: BackupReason; categories: BackupCategory[] }): Promise<string> {
    return this.serial(async () => {
      await ensureDirectory(dirname(input.path))
      const operationId = randomUUID()
      const stagingPath = join(dirname(input.path), `.pab-export-${operationId}.part`)
      const handle = await open(stagingPath, 'wx', 0o600)
      let identity
      try {
        await handle.writeFile(input.bytes)
        await handle.sync()
        identity = await handle.stat()
      }
      finally { await handle.close() }
      await syncDirectory(dirname(stagingPath))
      const receipt: ExportReceipt = {
        schemaVersion: 1, operationId, phase: 'preparing', startedAt: input.startedAt,
        reason: input.reason, categories: input.categories, archivePath: input.path, stagingPath,
        fileDevice: identity.dev, fileInode: identity.ino, size: input.bytes.byteLength,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
      }
      try { await this.verifyAndPublish(receipt) }
      catch (cause) {
        // Verification already succeeded even if persisting the verified receipt failed.
        if (receipt.phase === 'verified') throw new ExportAuditPendingError(cause)
        throw cause
      }
      try { await this.acknowledge(receipt) }
      catch (cause) { throw new ExportAuditPendingError(cause) }
      return receipt.archivePath
    })
  }
}

/** The archive succeeded; only durable acknowledgement is pending. */
export class ExportAuditPendingError extends Error {
  constructor(cause: unknown) { super('备份文件已生成，操作留痕待恢复；请勿重复创建。', { cause }) }
}
