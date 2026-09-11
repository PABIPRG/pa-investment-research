import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupService, readStableDownloadSnapshot } from '../src/backup-service.ts'
import type { BackupBackendOperation } from '../src/backup-service.ts'
import type { DomainSnapshot } from '../src/backup-archive.ts'

const homes: string[] = []

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'investment-backup-service-'))
  homes.push(path)
  return path
}

afterEach(async () => {
  vi.useRealTimers()
  const { rm } = await import('node:fs/promises')
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function requestCategories(input: Record<string, unknown>): string[] {
  const categories = input.categories
  if (!Array.isArray(categories) || !categories.every(category => typeof category === 'string')) {
    throw new Error('test expected categories')
  }
  return categories
}

function requestSnapshot(input: Record<string, unknown>): DomainSnapshot {
  const snapshot = input.snapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('test expected snapshot')
  }
  return snapshot as DomainSnapshot
}

function tradingSnapshot(categories: string[]): DomainSnapshot {
  return {
    schemaVersion: 1,
    backend: 'trading-core',
    categories: Object.fromEntries(categories.map(category => [category, {
      count: 1,
      collections: { [category]: { default: [{ id: `${category}-1` }] } },
    }])),
    revision: 'revision-1',
  }
}

describe('BackupService storage', () => {
  it('rejects growth observed after opening before allocating or reading the file', async () => {
    const expected = { dev: 1, ino: 2, size: 4, isFile: () => true }
    const handle = {
      stat: vi.fn(async () => ({ ...expected, size: 64 * 1024 * 1024 + 1 })),
      read: vi.fn(),
    }

    await expect(readStableDownloadSnapshot(handle as never, expected as never)).rejects.toThrow(/下载前发生变化/)
    expect(handle.read).not.toHaveBeenCalled()
  })

  it('uses the DSH home default, persists an explicit directory, and scans readable and damaged backups', async () => {
    const dshHome = await home()
    const request = vi.fn(async (_backend: 'trading-core' | 'market-watch', operation: BackupBackendOperation, input: Record<string, unknown>) => {
      if (operation === 'export') return tradingSnapshot(requestCategories(input))
      throw new Error(`unexpected ${operation}`)
    })
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })

    expect((await service.describe()).directory).toBe(join(dshHome, 'investment-research', 'backups'))
    const custom = join(dshHome, '共享备份')
    await service.setDirectory(custom)
    expect((await new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request }).describe()).directory)
      .toBe(custom)

    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    expect(created.filename).toMatch(/^投研备份-持仓-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.pabackup$/)
    await writeFile(join(custom, '损坏备份.pabackup'), 'not-a-zip')

    const list = await service.list()
    const statuses = list
      .map(item => ({ filename: item.filename, status: item.status }))
      .sort((left, right) => left.filename.localeCompare(right.filename))
    expect(statuses).toEqual([
      { filename: '损坏备份.pabackup', status: 'damaged' },
      { filename: created.filename, status: 'ready' },
    ].sort((left, right) => left.filename.localeCompare(right.filename)))
  })

  it('maps a file-level archive read failure to a stable path-free list problem', async () => {
    const dshHome = await home()
    const directory = join(dshHome, 'investment-research', 'backups')
    const filename = '权限失败.pabackup'
    const path = join(directory, filename)
    await mkdir(directory, { recursive: true })
    await writeFile(path, 'placeholder')
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      request: async () => { throw new Error('unexpected backend request') },
      fileOperations: {
        readArchive: async () => { throw new Error(`EACCES: permission denied, open '${path}'`) },
      },
    })

    const items = await service.list()

    expect(items).toEqual([{
      filename,
      size: 11,
      modifiedAt: expect.any(String),
      status: 'damaged',
      problem: '无法读取或验证备份文件',
    }])
    expect(JSON.stringify(items)).not.toContain(directory)
    expect(JSON.stringify(items)).not.toContain('EACCES')
  })

  it('deletes only an explicitly named direct backup file', async () => {
    const dshHome = await home()
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      request: async (_backend, operation, input) => {
        if (operation === 'export') return tradingSnapshot(requestCategories(input))
        throw new Error(`unexpected ${operation}`)
      },
    })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    await expect(service.delete('../secrets.pabackup')).rejects.toThrow(/文件名/)
    await service.delete(created.filename)
    await expect(stat(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('downloads only a validated direct backup through bounded ordered chunks', async () => {
    const dshHome = await home()
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      request: async (_backend, operation, input) => {
        if (operation === 'export') return tradingSnapshot(requestCategories(input))
        throw new Error(`unexpected ${operation}`)
      },
    })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    const expected = await readFile(created.path)
    const download = await service.beginDownload(created.filename)
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < download.size) {
      const chunk = service.downloadChunk({ id: download.id, offset })
      chunks.push(Buffer.from(chunk.base64, 'base64'))
      offset = chunk.nextOffset
    }
    expect(Buffer.concat(chunks)).toEqual(expected)
    expect(() => service.downloadChunk({ id: download.id, offset })).toThrow(/失效/)
    const invalid = await service.beginDownload(created.filename)
    expect(() => service.downloadChunk({ id: invalid.id, offset: 1 })).toThrow(/位置无效/)
    expect(() => service.downloadChunk({ id: invalid.id, offset: 0 })).toThrow(/失效/)
    await expect(service.beginDownload('../escape.pabackup')).rejects.toThrow(/文件名/)
    await service.dispose()
  })

  it('reserves download capacity atomically and actively expires abandoned snapshots', async () => {
    vi.useFakeTimers()
    let nowMs = Date.parse('2026-09-11T00:00:00.000Z')
    const dshHome = await home()
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      now: () => new Date(nowMs),
      request: async (_backend, operation, input) => {
        if (operation === 'export') return tradingSnapshot(requestCategories(input))
        throw new Error(`unexpected ${operation}`)
      },
    })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })

    const starts = await Promise.allSettled([
      service.beginDownload(created.filename),
      service.beginDownload(created.filename),
      service.beginDownload(created.filename),
    ])
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(starts.filter(result => result.status === 'rejected')).toHaveLength(1)
    const active = starts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    service.cancelDownload(active[0]!.id)
    service.cancelDownload(active[1]!.id)

    await expect(service.beginDownload('missing.pabackup')).rejects.toThrow()
    const abandoned = await service.beginDownload(created.filename)
    nowMs += 15 * 60 * 1000 + 1
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1)
    expect(() => service.downloadChunk({ id: abandoned.id, offset: 0 })).toThrow(/失效/)
    await service.dispose()
  })

  it('streams an external backup through a bounded temporary file and enforces chunk order', async () => {
    const dshHome = await home()
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      request: async (_backend, operation, input) => {
        if (operation === 'export') return tradingSnapshot(requestCategories(input))
        if (operation === 'preview') return {
          currentRevision: 'local-revision',
          categories: { holdings: { added: 1, conflicts: 0, defaultRule: 'keep_local' } },
        }
        throw new Error(`unexpected ${operation}`)
      },
    })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    const bytes = await readFile(created.path)
    const upload = await service.beginUpload({ filename: '来自另一台电脑.pabackup', size: bytes.byteLength })

    await expect(service.appendUploadChunk({ id: upload.id, offset: 1, base64: bytes.toString('base64') }))
      .rejects.toThrow(/顺序/)
    await service.appendUploadChunk({ id: upload.id, offset: 0, base64: bytes.toString('base64') })
    const preview = await service.inspectUpload(upload.id)

    expect(preview.filename).toBe('来自另一台电脑.pabackup')
    expect(preview.manifest.scope).toEqual(['holdings'])
    await expect(stat(join(dshHome, 'investment-research', 'backup-uploads', `${upload.id}.part`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an oversized RPC upload chunk before appending it', async () => {
    const dshHome = await home()
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      request: async () => { throw new Error('unexpected backend request') },
    })
    const upload = await service.beginUpload({ filename: '大分块.pabackup', size: 300_000 })
    const oversized = Buffer.alloc(256 * 1024 + 1).toString('base64')

    await expect(service.appendUploadChunk({ id: upload.id, offset: 0, base64: oversized }))
      .rejects.toThrow(/256 KiB/)
    await service.cancelUpload(upload.id)
  })

  it('atomically limits concurrent uploads and reserved bytes, then releases files on cancel, expiry, and disposal', async () => {
    vi.useFakeTimers()
    let nowMs = Date.parse('2026-09-11T00:00:00.000Z')
    const dshHome = await home()
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      now: () => new Date(nowMs),
      request: async () => { throw new Error('unexpected backend request') },
    })

    const starts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => (
      service.beginUpload({ filename: `并发-${index}.pabackup`, size: 1 })
    )))
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(4)
    expect(starts.filter(result => result.status === 'rejected')).toHaveLength(1)
    const active = starts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    await Promise.all(active.map(upload => service.cancelUpload(upload.id)))

    const first = await service.beginUpload({ filename: '预算-1.pabackup', size: 64 * 1024 * 1024 })
    const second = await service.beginUpload({ filename: '预算-2.pabackup', size: 64 * 1024 * 1024 })
    await expect(service.beginUpload({ filename: '预算-3.pabackup', size: 1 }))
      .rejects.toMatchObject({ code: 'resource-exhausted' })
    await service.cancelUpload(first.id)
    await service.cancelUpload(second.id)

    const expiredUpload = await service.beginUpload({ filename: '过期.pabackup', size: 1 })
    const expiredPath = join(dshHome, 'investment-research', 'backup-uploads', `${expiredUpload.id}.part`)
    nowMs += 15 * 60 * 1000 + 1
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1)
    await vi.waitFor(async () => {
      await expect(stat(expiredPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(service.appendUploadChunk({ id: expiredUpload.id, offset: 0, base64: 'YQ==' }))
      .rejects.toMatchObject({ code: 'resource-expired' })

    const disposedUpload = await service.beginUpload({ filename: '释放.pabackup', size: 1 })
    const disposedPath = join(dshHome, 'investment-research', 'backup-uploads', `${disposedUpload.id}.part`)
    await service.dispose()
    await expect(stat(disposedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for in-flight upload and preview creation before disposal and rejects later transfers', async () => {
    const dshHome = await home()
    let enterUpload: (() => void) | undefined
    const uploadEntered = new Promise<void>((resolve) => { enterUpload = resolve })
    let releaseUpload: (() => void) | undefined
    const uploadBarrier = new Promise<void>((resolve) => { releaseUpload = resolve })
    let enterPreview: (() => void) | undefined
    const previewEntered = new Promise<void>((resolve) => { enterPreview = resolve })
    let releasePreview: (() => void) | undefined
    const previewBarrier = new Promise<void>((resolve) => { releasePreview = resolve })
    const service = new BackupService({
      dshHome,
      appVersion: '0.1.0-rc.12',
      request: async (_backend, operation, input) => {
        if (operation === 'export') return tradingSnapshot(requestCategories(input))
        if (operation === 'preview') {
          enterPreview?.()
          await previewBarrier
          return {
            currentRevision: 'local-revision',
            categories: { holdings: { added: 1, conflicts: 0, defaultRule: 'keep_local' } },
          }
        }
        throw new Error(`unexpected ${operation}`)
      },
      fileOperations: {
        initializeUpload: async (path) => {
          enterUpload?.()
          await uploadBarrier
          await writeFile(path, new Uint8Array(), { flag: 'wx', mode: 0o600 })
        },
      },
    })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    const bytes = await readFile(created.path)
    const upload = service.beginUpload({ filename: '并发释放.pabackup', size: 1 })
    const preview = service.previewBytes(bytes)
    const uploadRejected = expect(upload).rejects.toMatchObject({ code: 'resource-expired' })
    const previewRejected = expect(preview).rejects.toMatchObject({ code: 'resource-expired' })
    await Promise.all([uploadEntered, previewEntered])

    let disposed = false
    const disposing = service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseUpload?.()
    releasePreview?.()

    await uploadRejected
    await previewRejected
    await disposing
    expect(disposed).toBe(true)
    const uploadDirectory = join(dshHome, 'investment-research', 'backup-uploads')
    expect((await readdir(uploadDirectory)).filter(name => name.endsWith('.part'))).toEqual([])
    await expect(service.beginUpload({ filename: '关闭后.pabackup', size: 1 }))
      .rejects.toMatchObject({ code: 'resource-expired' })
    await expect(service.previewBytes(bytes)).rejects.toMatchObject({ code: 'resource-expired' })
    await expect(service.previewFile(created.path)).rejects.toMatchObject({ code: 'resource-expired' })
    await expect(service.beginDownload(created.filename)).rejects.toMatchObject({ code: 'resource-expired' })
  })

  it('reserves preview capacity before reading a third archive and actively releases expired previews', async () => {
    vi.useFakeTimers()
    let nowMs = Date.parse('2026-09-11T00:00:00.000Z')
    const dshHome = await home()
    const previewResolvers: Array<() => void> = []
    const request = vi.fn(async (_backend: 'trading-core' | 'market-watch', operation: BackupBackendOperation, input: Record<string, unknown>) => {
      if (operation === 'export') return tradingSnapshot(requestCategories(input))
      if (operation === 'preview') {
        await new Promise<void>(resolve => { previewResolvers.push(resolve) })
        return {
          currentRevision: 'local-revision',
          categories: { holdings: { added: 1, conflicts: 0, defaultRule: 'keep_local' } },
        }
      }
      throw new Error(`unexpected ${operation}`)
    })
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', now: () => new Date(nowMs), request })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    const first = service.previewFile(created.path)
    const second = service.previewFile(created.path)
    await vi.waitFor(() => { expect(previewResolvers).toHaveLength(2) })
    const damaged = join(dshHome, 'damaged-before-read.pabackup')
    await writeFile(damaged, 'not a zip')

    await expect(service.previewFile(damaged)).rejects.toMatchObject({ code: 'resource-exhausted' })
    previewResolvers.splice(0).forEach(resolve => resolve())
    const previews = await Promise.all([first, second])
    nowMs += 15 * 60 * 1000 + 1
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1)
    await expect(service.importPreview(previews[0]!.id)).rejects.toMatchObject({ code: 'resource-expired' })
    expect(() => service.cancelPreview(previews[1]!.id)).not.toThrow()
    await service.dispose()
  })

  it('keeps cloud managed storage isolated from a stale local custom directory', async () => {
    const dshHome = await home()
    const request = vi.fn(async (_backend: 'trading-core' | 'market-watch', operation: BackupBackendOperation, input: Record<string, unknown>) => {
      if (operation === 'export') return tradingSnapshot(requestCategories(input))
      if (operation === 'preview') return {
        currentRevision: 'local-revision',
        categories: { holdings: { added: 1, conflicts: 0, defaultRule: 'keep_local' } },
      }
      if (operation === 'prepare') return { status: 'prepared' }
      if (operation === 'commit') return { status: 'applied' }
      if (operation === 'finalize') return { status: 'finalized' }
      throw new Error(`unexpected ${operation}`)
    })
    const local = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })
    const custom = join(dshHome, 'old-local-backups')
    await local.setDirectory(custom)
    const localBackup = await local.create({ categories: ['holdings'], reason: 'manual' })

    const managed = new BackupService({
      dshHome, appVersion: '0.1.0-rc.12', request, managedStorage: true,
    })
    const managedDirectory = join(dshHome, 'investment-research', 'backups')
    expect((await managed.describe()).directory).toBe(managedDirectory)
    expect(await managed.list()).toEqual([])
    const created = await managed.create({ categories: ['holdings'], reason: 'manual' })
    expect(created.path).toBe(join(managedDirectory, created.filename))
    const download = await managed.beginDownload(created.filename)
    managed.cancelDownload(download.id)
    const preview = await managed.previewStored(created.filename)
    await managed.importPreview(preview.id, { holdings: 'keep_local' })
    await managed.delete(created.filename)
    expect(await readFile(localBackup.path)).toBeTruthy()

    const restoredLocal = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })
    expect((await restoredLocal.describe()).directory).toBe(custom)
    expect((await restoredLocal.list()).map(item => item.filename)).toContain(localBackup.filename)
    await Promise.all([local.dispose(), managed.dispose(), restoredLocal.dispose()])
  })
})

describe('BackupService import safety', () => {
  it('recovers an interrupted coordinator transaction before accepting new work', async () => {
    const dshHome = await home()
    const operations: Array<{ backend: string; operation: BackupBackendOperation }> = []
    const request = vi.fn(async (
      backend: 'trading-core' | 'market-watch',
      operation: BackupBackendOperation,
    ) => {
      operations.push({ backend, operation })
      if (operation === 'rollback') return { status: 'rolled_back' }
      if (operation === 'finalize') return { status: 'finalized' }
      throw new Error(`unexpected ${operation}`)
    })
    const directory = join(dshHome, 'investment-research', 'transfer-transactions')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '77777777-7777-4777-8777-777777777777.json'), JSON.stringify({
      schemaVersion: 1,
      transactionId: '77777777-7777-4777-8777-777777777777',
      phase: 'committing',
      targets: ['trading-core', 'market-watch'],
    }))
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })

    await service.recoverPendingTransactions()

    expect(operations).toEqual([
      { backend: 'market-watch', operation: 'rollback' },
      { backend: 'trading-core', operation: 'rollback' },
      { backend: 'trading-core', operation: 'finalize' },
      { backend: 'market-watch', operation: 'finalize' },
    ])
    await expect(stat(join(directory, '77777777-7777-4777-8777-777777777777.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('previews and imports without changing or consuming the source backup', async () => {
    const dshHome = await home()
    const calls: string[] = []
    const request = vi.fn(async (_backend: 'trading-core' | 'market-watch', operation: BackupBackendOperation, input: Record<string, unknown>) => {
      calls.push(operation)
      if (operation === 'export') return tradingSnapshot(requestCategories(input))
      if (operation === 'preview') return {
        currentRevision: 'local-revision',
        categories: { holdings: { added: 1, conflicts: 0, defaultRule: 'keep_local' } },
      }
      if (operation === 'prepare') return { status: 'prepared', categories: ['holdings'] }
      if (operation === 'commit') return { status: 'applied', categories: ['holdings'] }
      if (operation === 'finalize') return { status: 'finalized', categories: ['holdings'] }
      throw new Error(`unexpected ${operation}`)
    })
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    const before = await readFile(created.path)

    const preview = await service.previewFile(created.path)
    await service.importPreview(preview.id, { holdings: 'keep_local' })

    expect(await readFile(created.path)).toEqual(before)
    expect(calls).toEqual(['export', 'preview', 'prepare', 'commit', 'finalize'])
    expect((await service.list()).some(item => item.filename === created.filename)).toBe(true)
  })

  it('stops an import before apply when its default-on safety backup fails', async () => {
    const dshHome = await home()
    const calls: string[] = []
    const request = vi.fn(async (_backend: 'trading-core' | 'market-watch', operation: BackupBackendOperation, input: Record<string, unknown>) => {
      calls.push(operation)
      if (operation === 'export') return tradingSnapshot(requestCategories(input))
      if (operation === 'preview') return {
        currentRevision: 'local-revision',
        categories: { holdings: { added: 1, conflicts: 0, defaultRule: 'keep_local' } },
      }
      if (operation === 'prepare') return { status: 'prepared' }
      throw new Error(`unexpected ${operation}`)
    })
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })
    const preview = await service.previewFile(created.path)
    const blockedDirectory = join(dshHome, 'blocked-backup-location')
    await service.setDirectory(blockedDirectory)
    await rm(blockedDirectory, { recursive: true })
    await writeFile(blockedDirectory, 'not a directory')

    await expect(service.importPreview(preview.id, {}, true)).rejects.toThrow()
    expect(calls.filter(operation => operation === 'prepare')).toHaveLength(0)
    expect(await readFile(created.path)).toBeTruthy()
  })

  it('rolls back an already-applied domain when a later domain fails', async () => {
    const dshHome = await home()
    const calls: Array<{
      backend: 'trading-core' | 'market-watch'
      operation: BackupBackendOperation
      input: Record<string, unknown>
    }> = []
    let failTradingCommit = false
    const request = vi.fn(async (
      backend: 'trading-core' | 'market-watch',
      operation: BackupBackendOperation,
      input: Record<string, unknown>,
    ) => {
      calls.push({ backend, operation, input })
      if (operation === 'export') {
        return {
          schemaVersion: 1,
          backend,
          categories: Object.fromEntries(requestCategories(input).map(category => [category, {
            count: 1,
            collections: { [category]: { default: [{ id: `${backend}-${category}-local` }] } },
          }])),
          revision: `${backend}-revision`,
        }
      }
      if (operation === 'preview') {
        const snapshot = requestSnapshot(input)
        return {
          currentRevision: `${backend}-current`,
          categories: Object.fromEntries(Object.keys(snapshot.categories).map(category => [category, {
            added: 1,
            conflicts: 0,
            defaultRule: category === 'watchlist' ? 'merge' : 'keep_local',
          }])),
        }
      }
      if (operation === 'prepare') return { status: 'prepared' }
      if (operation === 'rollback') return { status: 'rolled_back' }
      if (operation === 'finalize') return { status: 'finalized' }
      if (operation === 'commit') {
        if (backend === 'trading-core' && failTradingCommit) throw new Error('trading commit failed')
        return { status: 'applied' }
      }
      throw new Error(`unexpected ${operation}`)
    })
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })
    const created = await service.create({ categories: ['holdings', 'watchlist'], reason: 'manual' })
    const preview = await service.previewFile(created.path)
    failTradingCommit = true

    await expect(service.importPreview(preview.id)).rejects.toThrow(/trading commit failed/)

    const marketCalls = calls.filter(call => call.backend === 'market-watch')
    expect(marketCalls.slice(-4).map(call => call.operation)).toEqual(['prepare', 'commit', 'rollback', 'finalize'])
    expect(await readFile(created.path)).toBeTruthy()
  })

  it('keeps existing backups after reset and blocks reset when the safety backup fails', async () => {
    const dshHome = await home()
    const operations: string[] = []
    const request = vi.fn(async (_backend: 'trading-core' | 'market-watch', operation: BackupBackendOperation, input: Record<string, unknown>) => {
      operations.push(operation)
      if (operation === 'export') return tradingSnapshot(requestCategories(input))
      if (operation === 'reset') return { status: 'prepared' }
      if (operation === 'commit') return { status: 'reset' }
      if (operation === 'finalize') return { status: 'finalized' }
      throw new Error(`unexpected ${operation}`)
    })
    const service = new BackupService({ dshHome, appVersion: '0.1.0-rc.12', request })
    const created = await service.create({ categories: ['holdings'], reason: 'manual' })

    await service.reset({ categories: ['holdings'], backupBefore: false })
    expect(await readFile(created.path)).toBeTruthy()

    const blockedDirectory = join(dshHome, 'blocked-reset-backup-location')
    await mkdir(blockedDirectory)
    await service.setDirectory(blockedDirectory)
    await rm(blockedDirectory, { recursive: true })
    await writeFile(blockedDirectory, 'not a directory')
    const resetCountBefore = operations.filter(operation => operation === 'reset').length

    await expect(service.reset({ categories: ['holdings'], backupBefore: true })).rejects.toThrow()
    expect(operations.filter(operation => operation === 'reset')).toHaveLength(resetCountBefore)
    expect(await readFile(created.path)).toBeTruthy()
  })
})
