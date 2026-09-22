import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BackupService } from '../src/backup-service.ts'
import type { BackupBackendRequest } from '../src/backup-service.ts'
import { inspectBackupArchive } from '../src/backup-archive.ts'

const faults = vi.hoisted(() => ({ verifiedWrite: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (from: string, to: string) => {
    if (faults.verifiedWrite && to.includes('/export-receipts/') && to.endsWith('.json')
      && JSON.parse(await fs.readFile(from, 'utf8')).phase === 'verified') {
      throw Object.assign(new Error('simulated receipt disk error'), { code: 'EIO' })
    }
    return fs.rename(from, to)
  } }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { faults.verifiedWrite = false; for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0 })

async function setup() {
  const dshHome = await mkdtemp(join(tmpdir(), 'backup-export-history-'))
  cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
  const delivered: Record<string, unknown>[] = []
  let unavailable = false
  const receipts = join(dshHome, 'investment-research', 'transfer-transactions', 'export-receipts')
  const request = vi.fn<BackupBackendRequest>(async (_backend, operation, input) => {
    if (operation === 'export') return {
      schemaVersion: 1, backend: 'trading-core', revision: 'test', categories: Object.fromEntries(
        (input.categories as string[]).map(category => [category, {count: 0, collections: {[category]: {default: []}}}]),
      ),
    }
    if (operation === 'export-completed') {
      const receipt = JSON.parse(await readFile(join(receipts, `${input.operation_id}.json`), 'utf8'))
      expect(receipt.phase).toBe('verified')
      delivered.push(receipt)
      if (unavailable) throw new Error('simulated lost acknowledgement')
      return {status: 'recorded', operation_id: input.operation_id}
    }
    throw new Error(`unexpected ${operation}`)
  })
  const createService = (exportAckTimeoutMs = 10_000) => {
    const service = new BackupService({dshHome, appVersion: 'test', request, exportAckTimeoutMs, now: () => new Date('2026-09-21T05:00:00.000Z')})
    cleanups.push(() => service.dispose())
    return service
  }
  return {dshHome, receipts, delivered, request, createService, unavailable: (value: boolean) => {unavailable = value}}
}

it('records only a verified holdings backup, retaining purpose without conflating downloads', async () => {
  const fixture = await setup()
  const service = fixture.createService()
  const created = await service.create({categories: ['holdings'], reason: 'pre-import'})
  expect(fixture.delivered).toHaveLength(1)
  expect(fixture.delivered[0]).toMatchObject({reason: 'pre-import', categories: ['holdings']})
  expect(inspectBackupArchive(await readFile(created.path)).manifest).toEqual(created.manifest)
  const download = await service.beginDownload(created.filename)
  service.cancelDownload(download.id)
  await service.create({categories: ['preferences'], reason: 'manual'})
  expect(fixture.delivered).toHaveLength(1)
})

it('keeps distinct files and receipts for simultaneous same-second backups', async () => {
  const fixture = await setup()
  const service = fixture.createService()
  const outputs = await Promise.all(Array.from({length: 3}, () => service.create({categories: ['holdings'], reason: 'manual'})))
  expect(new Set(outputs.map(output => output.path)).size).toBe(3)
  expect(new Set(fixture.delivered.map(receipt => receipt.operationId)).size).toBe(3)
  for (const output of outputs) expect(inspectBackupArchive(await readFile(output.path)).manifest).toEqual(output.manifest)
})

it('recovers a verified receipt with the same identity after lost acknowledgement and file deletion', async () => {
  const fixture = await setup()
  const service = fixture.createService()
  fixture.unavailable(true)
  await expect(service.create({categories: ['holdings'], reason: 'manual'})).rejects.toThrow('备份文件已生成，操作留痕待恢复')
  expect(fixture.delivered).toHaveLength(1)
  const original = fixture.delivered[0]!
  await unlink(String(original.archivePath))
  await service.setDirectory(join(fixture.dshHome, 'new-directory'))
  await service.dispose()
  fixture.unavailable(false)
  const restarted = fixture.createService()
  await restarted.recoverPendingTransactions()
  expect(fixture.delivered[1]).toEqual(original)
  expect(await readdir(fixture.receipts)).toEqual([])
})

it('recovers a published file after verified-receipt persistence fails without overwriting it', async () => {
  const fixture = await setup()
  const service = fixture.createService()
  faults.verifiedWrite = true
  await expect(service.create({categories: ['holdings'], reason: 'manual'})).rejects.toThrow('备份文件已生成，操作留痕待恢复')
  const names = await readdir(fixture.receipts)
  expect(names).toHaveLength(1)
  const pending = JSON.parse(await readFile(join(fixture.receipts, names[0]!), 'utf8'))
  expect(pending.phase).toBe('preparing')
  const bytes = await readFile(pending.archivePath)
  expect(fixture.delivered).toEqual([])
  await service.dispose()
  faults.verifiedWrite = false
  await fixture.createService().recoverPendingTransactions()
  expect(fixture.delivered).toHaveLength(1)
  expect(fixture.delivered[0]).toMatchObject({operationId: pending.operationId, archivePath: pending.archivePath})
  expect(await readFile(pending.archivePath)).toEqual(bytes)
})

it.each(['changed', 'symlink'] as const)('fails closed on %s staging bytes and retains all evidence', async (mode) => {
  const fixture = await setup()
  const service = fixture.createService()
  faults.verifiedWrite = true
  await expect(service.create({categories: ['holdings'], reason: 'manual'})).rejects.toThrow()
  const names = await readdir(fixture.receipts)
  const path = join(fixture.receipts, names[0]!)
  const original = await readFile(path)
  const pending = JSON.parse(original.toString())
  if (mode === 'changed') {
    const bytes = await readFile(pending.stagingPath)
    bytes[0] = bytes[0]! ^ 0xff // Same inode and size: the full digest must reject this.
    await writeFile(pending.stagingPath, bytes)
  }
  else {
    await unlink(pending.stagingPath)
    await symlink(pending.archivePath, pending.stagingPath)
  }
  await service.dispose()
  faults.verifiedWrite = false
  await expect(fixture.createService().recoverPendingTransactions()).rejects.toThrow('待恢复')
  expect(await readFile(path)).toEqual(original)
  expect(fixture.delivered).toEqual([])
})

it('does not overwrite another file that occupied the persisted target before recovery', async () => {
  const fixture = await setup()
  faults.verifiedWrite = true
  const service = fixture.createService()
  await expect(service.create({categories: ['holdings'], reason: 'manual'})).rejects.toThrow()
  const names = await readdir(fixture.receipts)
  const pending = JSON.parse(await readFile(join(fixture.receipts, names[0]!), 'utf8'))
  await unlink(pending.archivePath)
  await writeFile(pending.archivePath, 'another users backup')
  await service.dispose()
  faults.verifiedWrite = false
  await fixture.createService().recoverPendingTransactions()
  expect(await readFile(pending.archivePath, 'utf8')).toBe('another users backup')
  expect(fixture.delivered[0]!.archivePath === pending.archivePath).toBe(false)
})

it('retries privately on startup without another user action and stops acquiring after disposal', async () => {
  const fixture = await setup()
  const service = fixture.createService()
  fixture.unavailable(true)
  await expect(service.create({categories: ['holdings'], reason: 'manual'})).rejects.toThrow()
  await service.dispose()
  fixture.unavailable(false)
  const restarted = fixture.createService()
  restarted.startExportRecovery(10)
  await vi.waitFor(async () => expect(await readdir(fixture.receipts)).toEqual([]))
  await restarted.dispose()
  const calls = fixture.request.mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(fixture.request).toHaveBeenCalledTimes(calls)
})

it('bounds a stuck acknowledgement and preserves the verified receipt for retry', async () => {
  const fixture = await setup()
  const original = fixture.request.getMockImplementation()!
  fixture.request.mockImplementation(async (backend, operation, input, signal) => {
    if (operation !== 'export-completed') return original(backend, operation, input, signal)
    return new Promise((_, reject) => {
      signal!.throwIfAborted()
      signal!.addEventListener('abort', () => reject(signal!.reason), {once: true})
    })
  })
  await expect(fixture.createService(10).create({categories: ['holdings'], reason: 'manual'})).rejects.toThrow('留痕待恢复')
  const names = await readdir(fixture.receipts)
  expect(names).toHaveLength(1)
  expect(JSON.parse(await readFile(join(fixture.receipts, names[0]!), 'utf8')).phase).toBe('verified')
})
