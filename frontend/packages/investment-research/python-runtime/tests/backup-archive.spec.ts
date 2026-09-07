import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import {
  createBackupArchive,
  inspectBackupArchive,
  readableBackupFilename,
} from '../src/backup-archive.ts'

const CREATED_AT = new Date('2026-09-07T06:35:20.000Z')
const tradingSnapshot = {
  schemaVersion: 1,
  backend: 'trading-core',
  categories: {
    holdings: {
      count: 1,
      collections: { holdings: { default: [{ ticker: '600519', quantity: 100 }] } },
    },
  },
  revision: 'trading-revision',
}

describe('investment backup archive', () => {
  it('creates a standard zip with a readable filename and verified manifest', () => {
    const filename = readableBackupFilename({
      reason: 'manual',
      categoryLabels: ['持仓'],
      createdAt: CREATED_AT,
      timezoneOffsetMinutes: 0,
    })
    const created = createBackupArchive({
      createdAt: CREATED_AT.toISOString(),
      createdByAppVersion: '0.1.0-rc.11',
      reason: 'manual',
      categories: ['holdings'],
      snapshots: { 'trading-core': tradingSnapshot },
    })

    expect(filename).toBe('投研备份-持仓-2026-09-07_06-35-20.pabackup')
    expect([...created.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(Object.keys(unzipSync(created.bytes)).sort()).toEqual([
      'domains/market-watch.json',
      'domains/trading-core.json',
      'manifest.json',
    ])
    expect(inspectBackupArchive(created.bytes)).toEqual({
      manifest: created.manifest,
      snapshots: {
        'market-watch': { schemaVersion: 1, backend: 'market-watch', categories: {} },
        'trading-core': tradingSnapshot,
      },
    })
  })

  it('rejects a domain whose bytes no longer match the manifest checksum', () => {
    const created = createBackupArchive({
      createdAt: CREATED_AT.toISOString(),
      createdByAppVersion: '0.1.0-rc.11',
      reason: 'manual',
      categories: ['holdings'],
      snapshots: { 'trading-core': tradingSnapshot },
    })
    const entries = unzipSync(created.bytes)
    entries['domains/trading-core.json'] = strToU8(JSON.stringify({ changed: true }))
    const tampered = zipSync(entries)

    expect(() => inspectBackupArchive(tampered)).toThrow(/校验和/)
  })

  it('rejects newer formats and archive paths outside the fixed allowlist', () => {
    const domain = strToU8(JSON.stringify(tradingSnapshot))
    const sha256 = createHash('sha256').update(domain).digest('hex')
    const manifest = {
      format: 'pa-investment-backup',
      formatVersion: 2,
      createdAt: CREATED_AT.toISOString(),
      createdByAppVersion: 'future',
      reason: 'manual',
      scope: ['holdings'],
      contents: [{ category: 'holdings', count: 1 }],
      domains: [{
        id: 'trading-core',
        schemaVersion: 1,
        path: 'domains/trading-core.json',
        bytes: domain.byteLength,
        sha256,
      }],
    }
    const newer = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'domains/trading-core.json': domain,
    })
    expect(() => inspectBackupArchive(newer)).toThrow(/更新版本/)

    const unsafe = zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...manifest, formatVersion: 1 })),
      'domains/trading-core.json': domain,
      '../credentials.yaml': strToU8('secret'),
    })
    expect(() => inspectBackupArchive(unsafe)).toThrow(/未授权条目/)
  })

  it('rejects domain data that is not disclosed by the manifest scope', () => {
    expect(() => createBackupArchive({
      createdAt: CREATED_AT.toISOString(),
      createdByAppVersion: '0.1.0-rc.12',
      reason: 'manual',
      categories: ['holdings'],
      snapshots: {
        'trading-core': {
          ...tradingSnapshot,
          categories: {
            ...tradingSnapshot.categories,
            preferences: { count: 1, collections: { preferences: { default: { theme: 'hidden' } } } },
          },
        },
      },
    })).toThrow(/声明范围/)
  })
})
